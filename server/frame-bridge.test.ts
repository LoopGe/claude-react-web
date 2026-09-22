// Unit tests for the transport-agnostic frame bridge.
//
// Unlike server/ws.test.ts (which drives a real socket), this exercises
// SessionConnection directly against an in-memory FrameSink and a hand-rolled
// fake SessionBroadcaster. That locks the bridge's contract independently of
// any transport, and gives the desktop (IPC) path a reusable harness.

import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { SessionConnection, type FrameSink } from './frame-bridge.js'
import type {
  DialogEvent,
  ElicitationEvent,
  ElicitationRequestUi,
  GlobalSessionEvent,
  PermissionEvent,
  PermissionRequestSnapshot,
  SessionBroadcaster,
  SessionInfo,
  UserDialogRequestUi,
} from './session-types.js'
import type { WsClientFrame, WsServerFrame } from './ws-protocol.js'

const tick = () => new Promise<void>((r) => setImmediate(r))

/** Minimal async channel used to fake the SessionManager's iterables. */
interface Chan<T> {
  iterable: AsyncIterable<T>
  push: (v: T) => void
  end: () => void
}

function chan<T>(): Chan<T> {
  const q: T[] = []
  let waiter: ((r: IteratorResult<T>) => void) | null = null
  let done = false
  return {
    push(v) {
      if (done) return
      if (waiter) { const w = waiter; waiter = null; w({ value: v, done: false }) }
      else q.push(v)
    },
    end() {
      done = true
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined as never, done: true }) }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (q.length) return Promise.resolve({ value: q.shift()!, done: false })
            if (done) return Promise.resolve({ value: undefined as never, done: true })
            return new Promise((r) => { waiter = r })
          },
          return(): Promise<IteratorResult<T>> {
            done = true
            return Promise.resolve({ value: undefined as never, done: true })
          },
        }
      },
    },
  }
}

/** In-memory FrameSink: records frames, counts the shared-JSON hot path,
 *  and mirrors close() so the bridge's teardown is observable. */
class FakeSink implements FrameSink {
  frames: WsServerFrame[] = []
  rawCount = 0
  closed = false
  send(frame: WsServerFrame): void {
    if (!this.closed) this.frames.push(frame)
  }
  sendRaw(data: string, _kind?: string): void {
    this.rawCount++
    if (!this.closed) this.frames.push(JSON.parse(data) as WsServerFrame)
  }
  close(): void {
    this.closed = true
  }
  kinds(kind: WsServerFrame['kind']): WsServerFrame[] {
    return this.frames.filter((f) => f.kind === kind)
  }
}

interface FakeSession {
  running: boolean
  slept: boolean
  terminatedReason?: string
  error?: string
  history: SDKMessage[]
  messages: Chan<SDKMessage>
  perms: Chan<PermissionEvent>
  elicits: Chan<ElicitationEvent>
  dialogs: Chan<DialogEvent>
}

/** Hand-rolled SessionBroadcaster. Only the channels the bridge actually
 *  wires are implemented; the optional per-session channels return null,
 *  which the bridge is contractually required to tolerate. */
class FakeBroadcaster implements SessionBroadcaster {
  global = chan<GlobalSessionEvent>()
  globalSnapshot: SessionInfo[] = []
  resumed: string[] = []
  globalUnsubs = 0
  private sessions = new Map<string, FakeSession>()

  addSession(
    id: string,
    opts: {
      running?: boolean
      slept?: boolean
      terminatedReason?: string
      error?: string
      history?: SDKMessage[]
    } = {},
  ): FakeSession {
    const s: FakeSession = {
      running: opts.running ?? false,
      slept: opts.slept ?? false,
      terminatedReason: opts.terminatedReason,
      error: opts.error,
      history: opts.history ?? [],
      messages: chan<SDKMessage>(),
      perms: chan<PermissionEvent>(),
      elicits: chan<ElicitationEvent>(),
      dialogs: chan<DialogEvent>(),
    }
    this.sessions.set(id, s)
    return s
  }

  private require(id: string): FakeSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`session ${id} not found`)
    return s
  }

  subscribeGlobal() {
    return {
      iterable: this.global.iterable,
      snapshot: this.globalSnapshot,
      unsubscribe: () => { this.globalUnsubs++ },
    }
  }

  get(id: string): SessionInfo {
    const s = this.require(id)
    return {
      running: s.running,
      slept: s.slept,
      terminatedReason: s.terminatedReason,
      error: s.error,
    } as unknown as SessionInfo
  }

  async resume(id: string): Promise<SessionInfo> {
    this.resumed.push(id)
    this.require(id).running = true
    return this.get(id)
  }

  getHistory(id: string): SDKMessage[] | null {
    return this.sessions.get(id)?.history ?? null
  }

  subscribe(sessionId: string) {
    const s = this.require(sessionId)
    if (!s.running) throw new Error(`session ${sessionId} not found`)
    return { iterable: s.messages.iterable, history: s.history, unsubscribe: () => s.messages.end() }
  }

  subscribePermissions(sessionId: string) {
    const s = this.require(sessionId)
    return { iterable: s.perms.iterable, snapshot: [] as PermissionRequestSnapshot[], unsubscribe: () => s.perms.end() }
  }

  subscribeElicitation(sessionId: string) {
    const s = this.require(sessionId)
    return { iterable: s.elicits.iterable, snapshot: [] as ElicitationRequestUi[], unsubscribe: () => s.elicits.end() }
  }

  subscribeDialog(sessionId: string) {
    const s = this.require(sessionId)
    return { iterable: s.dialogs.iterable, snapshot: [] as UserDialogRequestUi[], unsubscribe: () => s.dialogs.end() }
  }

  subscribeContextUsage() { return null }
  subscribePromptSuggestion() { return null }
  subscribeTasks() { return null }
  subscribeGitStatus() { return null }
  subscribeMessageStatus() { return null }
  subscribeCommandChanges() { return null }
  subscribeHookRuns() { return null }
  subscribeSessionRecap() { return null }
  subscribeSessionCleared() { return null }
  broadcastGitStatusChanged() { /* noop */ }
  gitGroupKeyOf() { return null }
  gitGroupLivePeer() { return null }
  broadcastSessionCleared() { /* noop */ }
}

/** Poll `sink.frames` until `pred` matches, or fail after a timeout. */
async function waitForFrame(
  sink: FakeSink,
  pred: (f: WsServerFrame) => boolean,
  timeoutMs = 500,
): Promise<WsServerFrame> {
  const start = Date.now()
  for (;;) {
    const hit = sink.frames.find(pred)
    if (hit) return hit
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out; frames=${JSON.stringify(sink.frames.map((f) => f.kind))}`)
    }
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

function setup(sm = new FakeBroadcaster()) {
  const sink = new FakeSink()
  const conn = new SessionConnection({ sm }, sink)
  return { sm, sink, conn }
}

const assistant = (text: string, uuid?: string): SDKMessage =>
  ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) as unknown as SDKMessage

const send = (conn: SessionConnection, frame: WsClientFrame) => conn.handleClientFrame(frame)

describe('SessionConnection (in-memory sink)', () => {
  it('emits the global sessions-snapshot on start', () => {
    const sm = new FakeBroadcaster()
    sm.globalSnapshot = [{ id: 'a' }, { id: 'b' }] as unknown as SessionInfo[]
    const { sink, conn } = setup(sm)
    conn.start()
    const snap = sink.kinds('sessions-snapshot')[0]
    expect(snap).toMatchObject({ kind: 'sessions-snapshot' })
    if (snap?.kind !== 'sessions-snapshot') throw new Error('narrowing')
    expect(snap.sessions).toHaveLength(2)
  })

  it('fans global update/created/removed events out as frames', async () => {
    const { sm, sink, conn } = setup()
    conn.start()
    sm.global.push({ kind: 'created', session: { id: 'x' } as unknown as SessionInfo })
    sm.global.push({ kind: 'removed', id: 'x' })
    await tick()
    expect(sink.kinds('session-created')).toHaveLength(1)
    expect(sink.kinds('session-removed')).toHaveLength(1)
  })

  it('serves replay + ack on subscribe, then streams live messages via sendRaw', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    // The running path has no await before it finishes, so frames are queued
    // synchronously; a tick makes that deterministic regardless.
    await tick()

    const replay = await waitForFrame(sink, (f) => f.kind === 'replay')
    if (replay.kind !== 'replay') throw new Error('narrowing')
    expect(replay.sessionId).toBe('s1')
    expect(replay.messages).toHaveLength(1)
    await waitForFrame(sink, (f) => f.kind === 'replay-done')
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: true, reason: 'served' })

    const rawBefore = sink.rawCount
    sess.messages.push(assistant('live', 'u2'))
    const live = await waitForFrame(sink, (f) => f.kind === 'message' && f.sessionId === 's1')
    if (live.kind !== 'message') throw new Error('narrowing')
    expect((live.message as { uuid?: string }).uuid).toBe('u2')
    expect(sink.rawCount).toBeGreaterThan(rawBefore)
  })

  it('re-serves the replay with already-live on a duplicate subscribe', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    sink.frames.length = 0
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: true, reason: 'already-live' })
    const replay = await waitForFrame(sink, (f) => f.kind === 'replay')
    expect(replay.kind === 'replay' && replay.messages).toHaveLength(1)
  })

  it('replies to ping with pong echoing the nonce', () => {
    const { sink, conn } = setup()
    send(conn, { kind: 'ping', nonce: 7 })
    const pong = sink.kinds('pong')[0]
    if (pong?.kind !== 'pong') throw new Error('narrowing')
    expect(pong.nonce).toBe(7)
  })

  it('answers a malformed JSON string with an error and stays usable', () => {
    const { sink, conn } = setup()
    conn.handleClientFrame('{not json')
    expect(sink.kinds('error')[0]).toMatchObject({ message: expect.stringMatching(/invalid json/i) })
    // Still alive: a ping is answered.
    send(conn, { kind: 'ping', nonce: 1 })
    expect(sink.kinds('pong')).toHaveLength(1)
  })

  it('rejects a frame with no kind', () => {
    const { sink, conn } = setup()
    conn.handleClientFrame({} as WsClientFrame)
    expect(sink.kinds('error')[0]).toMatchObject({ message: 'frame missing kind' })
  })

  it('rejects an unknown client frame kind', () => {
    const { sink, conn } = setup()
    conn.handleClientFrame({ kind: 'nope' } as unknown as WsClientFrame)
    expect(sink.kinds('error')[0]).toMatchObject({ message: 'unknown kind: nope' })
  })

  it('answers an unknown session with error + replay-done + refused (no throw)', async () => {
    const { sink, conn } = setup()
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 'ghost' })
    await tick()
    expect(sink.kinds('error')[0]).toMatchObject({ message: expect.stringMatching(/not found/i) })
    expect(sink.kinds('replay-done')).toHaveLength(1)
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('auto-resumes a known-but-dormant session and serves a replay', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: false, history: [assistant('old', 'u1')] })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await waitForFrame(sink, (f) => f.kind === 'replay-done')
    expect(sm.resumed).toEqual(['s1'])
    expect(sink.kinds('error')).toHaveLength(0)
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: true, reason: 'served' })
  })

  it('does NOT resume a slept session — it is refused', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: false, slept: true })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    expect(sm.resumed).toEqual([])
    expect(sink.kinds('error')[0]).toMatchObject({ message: expect.stringMatching(/not found/i) })
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('does NOT auto-resume a spawn_failed session — subscribe must not storm-respawn it', async () => {
    // Every WS subscribe used to sm.resume() a dormant session. Combined
    // with unloadSpawnFailed (which returns it to dormant), a permanently
    // failing spawn produced hundreds of ENOENT spawns per open tab. Only
    // an explicit POST /resume may retry a spawn_failed session.
    const sm = new FakeBroadcaster()
    sm.addSession('s1', {
      running: false,
      terminatedReason: 'spawn_failed',
      error: 'Working directory not found: /gone',
      history: [assistant('old', 'u1')],
    })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    expect(sm.resumed).toEqual([])
    // The recorded spawn error is what the user needs to see — not a
    // generic "not found" for a session sitting in their sidebar.
    expect(sink.kinds('error')[0]).toMatchObject({
      message: expect.stringMatching(/Working directory not found/),
    })
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('stops the per-session stream on client unsubscribe without a closed ack', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    sink.frames.length = 0

    send(conn, { kind: 'unsubscribe', sessionId: 's1' })
    await tick()

    expect(sink.frames.filter((f) => f.kind === 'subscribe-result')).toHaveLength(0)
    const before = sink.frames.length
    sess.messages.push(assistant('after', 'u3'))
    await tick()
    expect(sink.frames.slice(before).filter((f) => f.kind === 'message')).toHaveLength(0)
  })

  it('close() unsubscribes the global channel and the sink, and is idempotent', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true })
    const { sink, conn } = setup(sm)
    conn.start()

    conn.close()
    expect(sink.closed).toBe(true)
    expect(sm.globalUnsubs).toBe(1)
    // Second close is a no-op — no double unsubscribe.
    conn.close()
    expect(sm.globalUnsubs).toBe(1)
  })
})
