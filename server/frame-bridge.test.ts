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
import type { WsClientDebugRequest, WsClientFrame, WsMessageConsumed, WsMessageSteered, WsMessagesEvicted, WsMessagesWithdrawn, WsServerFrame } from './ws-protocol.js'

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
            // Cleanup-driven return (driver stop / unsubscribe) ends THIS
            // iterator only — NOT the shared channel. A re-subscribe to the
            // same fake session must keep working (a real SessionManager
            // hands each subscriber its own channel; ending the shared one
            // here would make the next subscribe's driver exit instantly
            // and emit a spurious `closed` ack).
            return Promise.resolve({ value: undefined as never, done: true })
          },
        }
      },
    },
  }
}

/** A test-controlled per-session side channel (handed out by
 *  FakeBroadcaster.subscribeSessionCleared / subscribeCommandChanges) that
 *  counts how the bridge drives it: `next()` pulls, `return()` calls and
 *  `unsubscribe()` calls. */
interface CountedSub<T> {
  sub: { iterable: AsyncIterable<T>; unsubscribe: () => void }
  nextCalls: number
  returnCalls: number
  unsubscribes: number
}

/** Wrap a live chan so the bridge's pulls / teardown on it are counted. */
function countedSub<T>(c: Chan<T>): CountedSub<T> {
  const state: CountedSub<T> = {
    nextCalls: 0,
    returnCalls: 0,
    unsubscribes: 0,
    sub: {
      iterable: {
        [Symbol.asyncIterator]() {
          const inner = c.iterable[Symbol.asyncIterator]()
          return {
            next() { state.nextCalls++; return inner.next() },
            return() { state.returnCalls++; return inner.return!() },
          }
        },
      },
      unsubscribe: () => { state.unsubscribes++ },
    },
  }
  return state
}

/** An idle side channel whose `next()` hands back ONE never-settling native
 *  promise with an instrumented own `then`. `await` on a native promise
 *  never looks `then` up (PromiseResolve returns it as-is), while
 *  `Promise.race` invokes `then` on every input on every call — so
 *  `thenCalls` counts the reactions anything other than one awaiting loop
 *  attaches to the idle channel's pending pull. */
function idleSub(): CountedSub<never> & { thenCalls: number } {
  const pending = new Promise<IteratorResult<never>>(() => { /* never settles */ })
  const origThen = pending.then.bind(pending)
  const state: CountedSub<never> & { thenCalls: number } = {
    thenCalls: 0,
    nextCalls: 0,
    returnCalls: 0,
    unsubscribes: 0,
    sub: {
      iterable: {
        [Symbol.asyncIterator]() {
          return {
            next() { state.nextCalls++; return pending },
            return() {
              state.returnCalls++
              return Promise.resolve({ value: undefined as never, done: true as const })
            },
          }
        },
      },
      unsubscribe: () => { state.unsubscribes++ },
    },
  }
  Object.defineProperty(pending, 'then', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof origThen>) => { state.thenCalls++; return origThen(...args) },
  })
  return state
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
  /** Clear the recording buffers (keeps closed state). */
  reset(): void {
    this.frames.length = 0
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
  msgstat: Chan<WsMessageConsumed | WsMessageSteered | WsMessagesWithdrawn | WsMessagesEvicted>
  /** unsubscribe() calls per core channel, so teardown is observable. */
  unsubs: { msg: number; perm: number; elicit: number; dialog: number }
}

/** Hand-rolled SessionBroadcaster. Only the channels the bridge actually
 *  wires are implemented; the optional per-session channels return null,
 *  which the bridge is contractually required to tolerate. */
class FakeBroadcaster implements SessionBroadcaster {
  global = chan<GlobalSessionEvent>()
  clientDebug = chan<WsClientDebugRequest>()
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
      msgstat: chan(),
      unsubs: { msg: 0, perm: 0, elicit: 0, dialog: 0 },
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

  subscribeClientDebug() {
    return {
      iterable: this.clientDebug.iterable,
      unsubscribe: () => this.clientDebug.end(),
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
    return { iterable: s.messages.iterable, history: s.history, unsubscribe: () => { s.unsubs.msg++; s.messages.end() } }
  }

  subscribePermissions(sessionId: string) {
    const s = this.require(sessionId)
    return { iterable: s.perms.iterable, snapshot: this.pendingPerms, unsubscribe: () => { s.unsubs.perm++; s.perms.end() } }
  }

  subscribeElicitation(sessionId: string) {
    const s = this.require(sessionId)
    return { iterable: s.elicits.iterable, snapshot: this.pendingElicitations, unsubscribe: () => { s.unsubs.elicit++; s.elicits.end() } }
  }

  subscribeDialog(sessionId: string) {
    const s = this.require(sessionId)
    return { iterable: s.dialogs.iterable, snapshot: this.pendingDialogs, unsubscribe: () => { s.unsubs.dialog++; s.dialogs.end() } }
  }

  pendingPerms: PermissionRequestSnapshot[] = []
  pendingElicitations: ElicitationRequestUi[] = []
  pendingDialogs: UserDialogRequestUi[] = []
  listPending() { return this.pendingPerms }
  listPendingElicitation() { return this.pendingElicitations }
  listPendingDialogs() { return this.pendingDialogs }

  subscribeContextUsage() { return this.ctxUsageSub }
  /** When non-null, subscribeContextUsage hands this to the connection (the
   *  cached-snapshot seeding path); null = no context channel at all. */
  ctxUsageSub: {
    iterable: AsyncIterable<never>
    snapshot?: import('./session-pump.js').LiteContextUsage
    unsubscribe: () => void
  } | null = null
  ensureContextUsageSeeds: string[] = []
  ensureContextUsageSeed(sessionId: string) { this.ensureContextUsageSeeds.push(sessionId) }
  subscribePromptSuggestion() { return null }
  subscribeTasks() { return null }
  subscribeGitStatus() { return null }
  /** When non-null, handed out as the session's tasklist channel. */
  tasklistSub: CountedSub<never> | null = null
  subscribeTaskList() { return this.tasklistSub?.sub ?? null }
  /** Seq-space fixtures for the attached / seq-stamping tests. Empty by
   *  default = "no seq store", which the bridge must tolerate. */
  heads = new Map<string, { generation: number; headSeq: number }>()
  transcriptHead(id: string): { generation: number; headSeq: number } | null {
    return this.heads.get(id) ?? null
  }
  seqs = new WeakMap<object, number>()
  transcriptSeqOf(_sessionId: string, message: object): number | undefined {
    return this.seqs.get(message)
  }
  subscribeMessageStatus(sessionId: string) {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    return { iterable: s.msgstat.iterable, unsubscribe: () => s.msgstat.end() }
  }
  /** When non-null, handed out as the session's command-changes channel. */
  cmdSub: CountedSub<unknown> | null = null
  subscribeCommandChanges() { return this.cmdSub?.sub ?? null }
  subscribeHookRuns() { return null }
  subscribeSessionRecap() { return null }
  /** When non-null, handed out as the session's session-cleared channel. */
  clearedSub: CountedSub<unknown> | null = null
  subscribeSessionCleared() { return this.clearedSub?.sub ?? null }
  broadcastGitStatusChanged() { /* noop */ }
  broadcastTaskListChanged() { /* noop */ }
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

  it('fans a client-debug-request from the dedicated channel out verbatim', async () => {
    const { sm, sink, conn } = setup()
    conn.start()
    sm.clientDebug.push({
      kind: 'client-debug-request', id: 'req-1', op: 'dom_query', params: { selector: 'h1' },
    })
    await tick()
    const frame = await waitForFrame(sink, (f) => f.kind === 'client-debug-request')
    expect(frame).toMatchObject({ kind: 'client-debug-request', id: 'req-1', op: 'dom_query', params: { selector: 'h1' } })
  })

  it('serves ack + pending-request re-broadcast on subscribe, then streams live messages via sendRaw', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    sm.pendingPerms = [{ id: 'p1' } as unknown as PermissionRequestSnapshot]
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    // The running path has no await before it finishes, so frames are queued
    // synchronously; a tick makes that deterministic regardless.
    await tick()

    // No transcript history is served on subscribe (seq-window protocol:
    // history pages over REST) — only the pending-request re-broadcast.
    expect(
      sink.frames.some((f) => {
        const kind = (f as { kind: string }).kind
        return kind === 'replay' || kind === 'replay-done'
      }),
    ).toBe(false)
    const permReq = await waitForFrame(sink, (f) => f.kind === 'permission-request')
    expect(permReq).toMatchObject({ kind: 'permission-request', sessionId: 's1' })
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: true, reason: 'served' })

    const rawBefore = sink.rawCount
    sess.messages.push(assistant('live', 'u2'))
    const live = await waitForFrame(sink, (f) => f.kind === 'message' && f.sessionId === 's1')
    if (live.kind !== 'message') throw new Error('narrowing')
    expect((live.message as { uuid?: string }).uuid).toBe('u2')
    expect(sink.rawCount).toBeGreaterThan(rawBefore)
  })

  it('re-broadcasts pending requests with already-live on a duplicate subscribe', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    sm.pendingPerms = [{ id: 'p1' } as unknown as PermissionRequestSnapshot]
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    sink.frames.length = 0
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: true, reason: 'already-live' })
    const permReq = await waitForFrame(sink, (f) => f.kind === 'permission-request')
    expect(permReq).toMatchObject({ kind: 'permission-request', sessionId: 's1' })
  })

  it('subscribe with no cached context snapshot requests a zero-turn seed', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    expect(sm.ensureContextUsageSeeds).toEqual(['s1'])
    // No snapshot existed, so no context-usage frame was served either.
    expect(sink.kinds('context-usage')).toHaveLength(0)
  })

  it('subscribe with a cached context snapshot serves it and skips the seed', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true })
    sm.ctxUsageSub = {
      iterable: (async function* () { /* no live frames */ })(),
      snapshot: { totalTokens: 62000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 31, model: 'claude-sonnet-4-5' },
      unsubscribe: () => {},
    }
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    const frame = sink.kinds('context-usage')[0]
    expect(frame).toMatchObject({ kind: 'context-usage', sessionId: 's1' })
    expect(sm.ensureContextUsageSeeds).toEqual([])
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

  it('answers an unknown session with error + refused (no throw)', async () => {
    const { sink, conn } = setup()
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 'ghost' })
    await tick()
    expect(sink.kinds('error')[0]).toMatchObject({ message: expect.stringMatching(/not found/i) })
    expect(sink.kinds('subscribe-result')[0]).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('auto-resumes a known-but-dormant session on subscribe', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: false, history: [assistant('old', 'u1')] })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await waitForFrame(sink, (f) => f.kind === 'subscribe-result')
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


describe('transcript seq handshake (attached / seq / evicted)', () => {
  it('sends the attached handshake after a successful subscribe-result when a seq store exists', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    sm.heads.set('s1', { generation: 2, headSeq: 41 })
    const { sink, conn } = setup(sm)
    conn.start()

    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    const results = sink.kinds('subscribe-result')
    const attached = sink.kinds('attached')
    expect(attached).toHaveLength(1)
    expect(attached[0]).toMatchObject({ kind: 'attached', sessionId: 's1', generation: 2, headSeq: 41 })
    // The handshake lands AFTER the ack, per the brief's ordering.
    expect(sink.frames.indexOf(attached[0])).toBeGreaterThan(sink.frames.indexOf(results[0]))
  })

  it('sends attached again on an already-live re-subscribe', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    sm.heads.set('s1', { generation: 0, headSeq: 7 })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    expect(sink.kinds('attached')).toHaveLength(2)
  })

  it('omits attached when the session has no seq store', async () => {
    const sm = new FakeBroadcaster()
    sm.addSession('s1', { running: true, history: [assistant('old', 'u1')] })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    expect(sink.kinds('subscribe-result')).toHaveLength(1)
    expect(sink.kinds('attached')).toHaveLength(0)
  })

  it('stamps the transcript seq onto live message frames', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    sink.reset()

    const withSeq = assistant('seq’d', 'u-seq')
    sm.seqs.set(withSeq, 17)
    const noSeq = assistant('plain', 'u-plain')
    sess.messages.push(withSeq)
    sess.messages.push(noSeq)

    const f1 = await waitForFrame(sink, (f) => f.kind === 'message' && (f.message as { uuid?: string }).uuid === 'u-seq')
    expect(f1.kind === 'message' && f1.seq).toBe(17)
    const f2 = await waitForFrame(sink, (f) => f.kind === 'message' && (f.message as { uuid?: string }).uuid === 'u-plain')
    expect(f2.kind === 'message' && (f2 as { seq?: number }).seq).toBeUndefined()
    expect(f2.kind === 'message' && (f2 as { generation?: number }).generation).toBeUndefined()
  })

  it('stamps generation onto seq-carrying live message frames (client WINDOW_LIVE needs both)', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    sm.heads.set('s1', { generation: 3, headSeq: 18 })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    sink.reset()

    const withSeq = assistant('seq’d', 'u-seq')
    sm.seqs.set(withSeq, 17)
    sess.messages.push(withSeq)

    const f1 = await waitForFrame(sink, (f) => f.kind === 'message' && (f.message as { uuid?: string }).uuid === 'u-seq')
    // { seq, generation } both present — without generation the client's
    // seq guard falls to the legacy append.
    expect(f1.kind === 'message' && f1.seq).toBe(17)
    expect(f1.kind === 'message' && f1.generation).toBe(3)
  })

  it('forwards a messages-evicted frame from the message-status channel', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    sess.msgstat.push({ kind: 'messages-evicted', sessionId: 's1', seqs: [3, 5, 9], generation: 1 })
    const frame = await waitForFrame(sink, (f) => f.kind === 'messages-evicted')
    expect(frame).toMatchObject({ kind: 'messages-evicted', sessionId: 's1', seqs: [3, 5, 9], generation: 1 })
  })
})

describe('per-session channel drivers', () => {
  /** Wait until `pred()` holds, failing after `timeoutMs`. */
  async function until(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
      await tick()
    }
  }

  it('does not accumulate reactions on an idle channel across 10_000 message frames', async () => {
    const N = 10_000
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const idle = idleSub()
    sm.cmdSub = idle
    sm.clearedSub = countedSub(chan<unknown>())
    const { sink, conn } = setup(sm)
    conn.start()

    // Count `then` calls per receiver promise. A Promise.race over the
    // channels' pending pulls calls `then` on each idle pull once per
    // iteration (one reaction retained per message frame); an awaiting loop
    // never calls it. Restored in `finally` so nothing outside this test sees
    // the patch.
    const perReceiver = new WeakMap<object, number>()
    let maxPerReceiver = 0
    const origThen = Promise.prototype.then
    Promise.prototype.then = function patchedThen(this: Promise<unknown>, ...args: unknown[]) {
      const n = (perReceiver.get(this) ?? 0) + 1
      perReceiver.set(this, n)
      if (n > maxPerReceiver) maxPerReceiver = n
      return (origThen as (...a: unknown[]) => Promise<unknown>).apply(this, args)
    } as typeof Promise.prototype.then
    try {
      send(conn, { kind: 'subscribe', sessionId: 's1' })
      await tick()
      for (let i = 0; i < N; i++) sess.messages.push(assistant(`m${i}`, `u${i}`))
      await until(() => sink.kinds('message').length >= N, `${N} message frames`)
    } finally {
      Promise.prototype.then = origThen
    }

    expect(sink.kinds('message')).toHaveLength(N)
    expect(idle.nextCalls).toBe(1)
    expect(idle.thenCalls).toBeLessThanOrEqual(2)
    // Old Promise.race driver: ~N here (every idle channel's pull promise is
    // raced once per message frame).
    expect(maxPerReceiver).toBeLessThanOrEqual(2)
    conn.close()
  })

  it('keeps per-channel order when message and permission pushes interleave', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    for (let i = 0; i < 20; i++) {
      sess.messages.push(assistant(`m${i}`, `u${i}`))
      sess.perms.push({ kind: 'resolved', pid: `p${i}`, decision: { behavior: 'allow' } } as unknown as PermissionEvent)
      if (i % 3 === 0) await tick()
    }
    await until(
      () => sink.kinds('message').length === 20 && sink.kinds('permission-resolved').length === 20,
      'all interleaved frames',
    )

    expect(sink.kinds('message').map((f) => (f as { message: { uuid?: string } }).message.uuid))
      .toEqual(Array.from({ length: 20 }, (_, i) => `u${i}`))
    expect(sink.kinds('permission-resolved').map((f) => (f as { id: string }).id))
      .toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`))
    conn.close()
  })

  /** Subscribe s1 with one live + two idle side channels (cmd, tasklist)
   *  wired. */
  async function subscribeWithSideChannels() {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const clearedChan = chan<unknown>()
    const cleared = countedSub(clearedChan)
    const idle = idleSub()
    const tasklist = idleSub()
    sm.clearedSub = cleared
    sm.cmdSub = idle
    sm.tasklistSub = tasklist
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    // Every side loop is parked on its first pull.
    expect(cleared.nextCalls).toBe(1)
    expect(idle.nextCalls).toBe(1)
    expect(tasklist.nextCalls).toBe(1)
    return { sm, sess, clearedChan, cleared, idle, tasklist, sink, conn }
  }

  function expectFullyTornDown(
    sess: FakeSession,
    cleared: CountedSub<unknown>,
    idle: CountedSub<never>,
    tasklist: CountedSub<never>,
  ): void {
    expect(sess.unsubs).toEqual({ msg: 1, perm: 1, elicit: 1, dialog: 1 })
    expect(cleared.unsubscribes).toBe(1)
    expect(idle.unsubscribes).toBe(1)
    expect(tasklist.unsubscribes).toBe(1)
    expect(cleared.returnCalls).toBe(1)
    expect(idle.returnCalls).toBe(1)
    expect(tasklist.returnCalls).toBe(1)
  }

  it('client unsubscribe tears every channel down, emits nothing afterwards, and sends no closed ack', async () => {
    const { sess, clearedChan, cleared, idle, tasklist, sink, conn } = await subscribeWithSideChannels()
    sink.reset()

    send(conn, { kind: 'unsubscribe', sessionId: 's1' })
    await tick()
    expectFullyTornDown(sess, cleared, idle, tasklist)

    sess.messages.push(assistant('after', 'u-after'))
    sess.perms.push({ kind: 'resolved', pid: 'p-after', decision: { behavior: 'allow' } } as unknown as PermissionEvent)
    // Wakes the cleared loop's parked pull: it must see the stop and exit.
    clearedChan.push({})
    for (let i = 0; i < 5; i++) await tick()

    expect(sink.frames).toEqual([])
    // The woken loop exited instead of pulling again.
    expect(cleared.nextCalls).toBe(1)
  })

  it('conn.close() tears every channel down and emits nothing afterwards', async () => {
    const { sess, clearedChan, cleared, idle, tasklist, sink, conn } = await subscribeWithSideChannels()
    sink.reset()

    conn.close()
    await tick()
    expectFullyTornDown(sess, cleared, idle, tasklist)

    clearedChan.push({})
    for (let i = 0; i < 5; i++) await tick()
    expect(sink.frames).toEqual([])
    expect(cleared.nextCalls).toBe(1)
  })

  it('a side channel ending on its own leaves the session channel live', async () => {
    const { sess, clearedChan, cleared, sink } = await subscribeWithSideChannels()
    sink.reset()

    clearedChan.end()
    for (let i = 0; i < 3; i++) await tick()
    expect(cleared.unsubscribes).toBe(0)
    expect(sess.unsubs.msg).toBe(0)

    sess.messages.push(assistant('still-live', 'u-live'))
    await waitForFrame(sink, (f) => f.kind === 'message')
    expect(sink.kinds('subscribe-result')).toHaveLength(0)
  })

  it('the message channel ending tears everything down with exactly one closed ack', async () => {
    const { sess, cleared, idle, tasklist, sink } = await subscribeWithSideChannels()
    sink.reset()

    // The overflow path: async-subscription ends the subscriber's queue.
    sess.messages.end()
    await until(() => sink.kinds('subscribe-result').length > 0, 'closed ack')
    for (let i = 0; i < 5; i++) await tick()

    expectFullyTornDown(sess, cleared, idle, tasklist)
    expect(sink.kinds('subscribe-result')).toEqual([
      { kind: 'subscribe-result', sessionId: 's1', ok: false, reason: 'closed' },
    ])
  })

  it('a throwing side channel sends one subscription error and tears the session down', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    let fail: (err: Error) => void = () => {}
    sm.cmdSub = {
      nextCalls: 0,
      returnCalls: 0,
      unsubscribes: 0,
      sub: {
        iterable: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>((_, reject) => { fail = reject }),
              return: () => Promise.resolve({ value: undefined, done: true as const }),
            }
          },
        },
        unsubscribe: () => {},
      },
    }
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()
    sink.reset()

    fail(new Error('boom'))
    await until(() => sink.kinds('subscribe-result').length > 0, 'closed ack')
    for (let i = 0; i < 3; i++) await tick()

    expect(sink.kinds('error')).toEqual([{ kind: 'error', sessionId: 's1', message: 'subscription: boom' }])
    expect(sink.kinds('subscribe-result')).toEqual([
      { kind: 'subscribe-result', sessionId: 's1', ok: false, reason: 'closed' },
    ])
    expect(sess.unsubs).toEqual({ msg: 1, perm: 1, elicit: 1, dialog: 1 })
  })

  it('a subscribe that fails after the tasklist channel is wired unsubscribes it', async () => {
    const sm = new FakeBroadcaster()
    const sess = sm.addSession('s1', { running: true })
    const tasklist = idleSub()
    sm.tasklistSub = tasklist
    // Throws after every channel (tasklist last) has been subscribed, but
    // before the loops start.
    sm.ensureContextUsageSeed = () => { throw new Error('seed boom') }
    const { sink, conn } = setup(sm)
    conn.start()
    send(conn, { kind: 'subscribe', sessionId: 's1' })
    await tick()

    expect(tasklist.unsubscribes).toBe(1)
    expect(tasklist.nextCalls).toBe(0)
    expect(sess.unsubs).toEqual({ msg: 1, perm: 1, elicit: 1, dialog: 1 })
    expect(sink.kinds('error')).toEqual([{ kind: 'error', sessionId: 's1', message: 'seed boom' }])
    expect(sink.kinds('subscribe-result')).toEqual([
      { kind: 'subscribe-result', sessionId: 's1', ok: false, reason: 'refused' },
    ])
  })
})

