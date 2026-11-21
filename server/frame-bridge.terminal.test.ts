// Unit tests for the frame bridge's terminal channel (embedded terminal).
//
// Follows frame-bridge.test.ts's subagent-transcript pattern: drive
// SessionConnection directly against an in-memory FrameSink and a
// scriptable terminal broadcaster fake. The fake implements ONLY the
// terminal surface of SessionBroadcaster (cast): the terminal channel is
// independent of the message channel, so if the bridge's terminal path
// ever touches get/subscribe/resume, these tests fail loudly with a
// TypeError instead of silently attaching a transcript.

import { describe, expect, it } from 'vitest'
import { SessionConnection, type FrameSink } from './frame-bridge.js'
import { createPushable, type Pushable } from './pushable.js'
import { HttpError } from './errors.js'
import type { SessionBroadcaster } from './session-types.js'
import type { TerminalSnapshot, TerminalState } from '../shared/terminal.js'
import type {
  WsClientFrame,
  WsServerFrame,
  WsTerminalOutput,
  WsTerminalSnapshot,
  WsTerminalState,
} from './ws-protocol.js'

const tick = () => new Promise<void>((r) => setImmediate(r))

type TerminalFrame = WsTerminalSnapshot | WsTerminalOutput | WsTerminalState

/** In-memory FrameSink (same shape as frame-bridge.test.ts's). */
class FakeSink implements FrameSink {
  frames: WsServerFrame[] = []
  closed = false
  send(frame: WsServerFrame): void {
    if (!this.closed) this.frames.push(frame)
  }
  sendRaw(data: string, _kind?: string): void {
    if (!this.closed) this.frames.push(JSON.parse(data) as WsServerFrame)
  }
  close(): void {
    this.closed = true
  }
  kinds(kind: WsServerFrame['kind']): WsServerFrame[] {
    return this.frames.filter((f) => f.kind === kind)
  }
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

const state = (status: TerminalState['status'], cols = 80, rows = 24): TerminalState =>
  ({ status, shell: 'cmd.exe', cwd: 'D:/repo', cols, rows })
const idleSnapshot = (): TerminalSnapshot =>
  ({ terminalId: '', seq: 0, screen: '', state: state('idle'), restored: false })
const runningSnapshot = (cols = 80, rows = 24): TerminalSnapshot =>
  ({ terminalId: 't-live', seq: 0, screen: '', state: state('running', cols, rows), restored: false })

/** Scriptable stand-in for the manager's terminal surface (Task 7).
 *  Mirrors its contracts: capability gate on every op, null for unknown
 *  sessions, per-subscriber pushables, complete wire frames fanned to every
 *  subscriber, monotonic per-generation output seq, stale-generation 409. */
class FakeTerminalBroadcaster {
  unsupported = false
  /** When set, terminalInput throws this for a non-current terminalId. */
  staleInputError: Error | null = null
  snapshots = new Map<string, TerminalSnapshot>()
  calls: string[] = []
  subscribes = 0
  unsubscribes = 0
  private sessions = new Set<string>()
  private channels = new Map<string, Set<Pushable<TerminalFrame>>>()
  private seqs = new Map<string, number>()

  addSession(id: string, snapshot: TerminalSnapshot = idleSnapshot()): void {
    this.sessions.add(id)
    this.snapshots.set(id, snapshot)
  }

  private gate(): void {
    if (this.unsupported) throw new HttpError(400, 'terminal not supported')
  }

  private fan(id: string, frame: TerminalFrame): void {
    for (const p of this.channels.get(id) ?? []) p.push(frame)
  }

  private current(id: string): TerminalSnapshot {
    return this.snapshots.get(id) ?? idleSnapshot()
  }

  /** Manager-side teardown (unload/sleep): end every subscriber's pushable
   *  and drop the set — mirrors endTerminalSubscribers. */
  endAll(id: string): void {
    for (const p of this.channels.get(id) ?? []) p.end()
    this.channels.delete(id)
  }

  subscribeTerminal(id: string) {
    this.gate()
    if (!this.sessions.has(id)) return null
    this.subscribes++
    const p = createPushable<TerminalFrame>(`term-${id}`)
    let set = this.channels.get(id)
    if (!set) {
      set = new Set()
      this.channels.set(id, set)
    }
    set.add(p)
    return {
      iterable: p.iterable,
      snapshot: this.current(id),
      unsubscribe: () => {
        this.unsubscribes++
        set.delete(p)
        p.end()
      },
    }
  }

  terminalCreate(id: string, cols: number, rows: number): TerminalSnapshot {
    this.gate()
    this.calls.push(`create:${id}:${cols}x${rows}`)
    const snap = runningSnapshot(cols, rows)
    this.snapshots.set(id, snap)
    this.fan(id, { kind: 'terminal-state', sessionId: id, terminalId: snap.terminalId, state: snap.state })
    return snap
  }

  terminalInput(id: string, terminalId: string, data: string): void {
    this.gate()
    this.calls.push(`input:${id}:${terminalId}`)
    if (this.staleInputError && terminalId !== this.current(id).terminalId) throw this.staleInputError
    const seq = (this.seqs.get(id) ?? 0) + 1
    this.seqs.set(id, seq)
    this.fan(id, { kind: 'terminal-output', sessionId: id, terminalId, seq, data })
  }

  terminalResize(id: string, terminalId: string, cols: number, rows: number): void {
    this.gate()
    this.calls.push(`resize:${id}:${terminalId}:${cols}x${rows}`)
  }

  terminalClose(id: string): void {
    this.gate()
    this.calls.push(`close:${id}`)
    const snap = idleSnapshot()
    this.snapshots.set(id, snap)
    this.fan(id, { kind: 'terminal-state', sessionId: id, terminalId: '', state: snap.state })
  }

  terminalSnapshot(id: string): TerminalSnapshot {
    this.gate()
    this.calls.push(`snapshot:${id}`)
    return this.current(id)
  }
}

function setup(fake = new FakeTerminalBroadcaster()) {
  const sink = new FakeSink()
  const conn = new SessionConnection({ sm: fake as unknown as SessionBroadcaster }, sink)
  return { fake, sink, conn }
}

const send = (conn: SessionConnection, frame: WsClientFrame) => conn.handleClientFrame(frame)

describe('SessionConnection: terminal channel', () => {
  it('(a) answers terminal-subscribe with the current snapshot as the FIRST frame', async () => {
    const { fake, sink, conn } = setup()
    const seed = idleSnapshot()
    fake.addSession('s1', seed)
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    // The snapshot is the channel's seed AND its only synchronous answer —
    // no message-channel handshake rides along (the fake has no get/subscribe).
    expect(sink.frames).toEqual([{ kind: 'terminal-snapshot', sessionId: 's1', snapshot: seed }])
    expect(fake.subscribes).toBe(1)
    conn.close()
  })

  it('(b) create answers a snapshot + running state frame; input fans contiguous-seq output', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1')
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()

    send(conn, { kind: 'terminal-create', sessionId: 's1', cols: 100, rows: 30 })
    // create's direct answer is the running snapshot (synchronous)…
    expect(sink.kinds('terminal-snapshot')[1]).toEqual({
      kind: 'terminal-snapshot', sessionId: 's1', snapshot: runningSnapshot(100, 30),
    })
    // …and the spawn transition rides the live channel.
    const stateFrame = await waitForFrame(sink, (f) => f.kind === 'terminal-state')
    expect(stateFrame).toEqual({
      kind: 'terminal-state', sessionId: 's1', terminalId: 't-live', state: state('running', 100, 30),
    })
    expect(fake.calls).toContain('create:s1:100x30')

    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'echo one\r' })
    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'echo two\r' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-output' && f.seq === 2)
    expect(sink.kinds('terminal-output')).toEqual([
      { kind: 'terminal-output', sessionId: 's1', terminalId: 't-live', seq: 1, data: 'echo one\r' },
      { kind: 'terminal-output', sessionId: 's1', terminalId: 't-live', seq: 2, data: 'echo two\r' },
    ])
    conn.close()
  })

  it('(c) answers terminal-resync with a FRESH snapshot (seq-gap recovery)', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1', runningSnapshot())
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    // Output the viewer missed: the manager's current snapshot advances.
    const advanced: TerminalSnapshot = { ...runningSnapshot(), seq: 7, screen: 'missed output' }
    fake.snapshots.set('s1', advanced)

    send(conn, { kind: 'terminal-resync', sessionId: 's1', terminalId: 't-live' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-snapshot' && f.snapshot.seq === 7)
    const snapshots = sink.kinds('terminal-snapshot')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]).toEqual({ kind: 'terminal-snapshot', sessionId: 's1', snapshot: advanced })
    expect(fake.calls).toContain('snapshot:s1')
    conn.close()
  })

  it('(d) surfaces a stale-generation input as a terminal-error frame; the channel stays live', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1')
    fake.staleInputError = new HttpError(409, 'terminal generation is not live')
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    send(conn, { kind: 'terminal-create', sessionId: 's1', cols: 80, rows: 24 })
    await waitForFrame(sink, (f) => f.kind === 'terminal-state')

    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-dead', data: 'ls\r' })
    const err = await waitForFrame(sink, (f) => f.kind === 'terminal-error')
    expect(err).toEqual({
      kind: 'terminal-error', sessionId: 's1', message: 'terminal-input: terminal generation is not live',
    })
    // Terminal control failures must NEVER ride the prose error frame — the
    // session synchronizer renders that as the persistent chat error bar.
    expect(sink.kinds('error')).toEqual([])

    // The channel survived the error: a valid input's output still arrives.
    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'ls\r' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-output')
    expect(sink.kinds('terminal-output')).toEqual([
      { kind: 'terminal-output', sessionId: 's1', terminalId: 't-live', seq: 1, data: 'ls\r' },
    ])
    conn.close()
  })

  it('(e) terminal-unsubscribe releases the subscription — no further frames', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1', runningSnapshot())
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    const before = sink.frames.length

    send(conn, { kind: 'terminal-unsubscribe', sessionId: 's1' })
    expect(fake.unsubscribes).toBe(1)
    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'x' })
    await tick()
    expect(sink.frames.length).toBe(before)
    conn.close()
  })

  it('(e2) a frame queued but unconsumed at unsubscribe time is never emitted', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1', runningSnapshot())
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick() // the drive loop is parked on next()
    // push resolves the parked next() synchronously, but the loop's
    // continuation runs on a microtask — the unsubscribe lands FIRST, and
    // the identity-guarded stop check must drop the already-handed frame.
    fake.terminalInput('s1', 't-live', 'queued')
    send(conn, { kind: 'terminal-unsubscribe', sessionId: 's1' })
    await tick()
    expect(sink.kinds('terminal-output')).toEqual([])
    conn.close()
  })

  it('(f) rejects terminal frames without a sessionId', async () => {
    const { sink, conn } = setup()
    send(conn, { kind: 'terminal-subscribe', sessionId: '' })
    send(conn, { kind: 'terminal-subscribe', sessionId: 123 } as unknown as WsClientFrame)
    send(conn, { kind: 'terminal-input', sessionId: '', terminalId: 't', data: 'x' })
    await tick()
    // Narrowed by message: the default branch's "unknown kind" error must
    // NOT satisfy these — the shape guards are what's under test.
    expect(sink.kinds('error')).toEqual([
      { kind: 'error', message: 'terminal-subscribe: sessionId required' },
      { kind: 'error', message: 'terminal-subscribe: sessionId required' },
      { kind: 'error', message: 'terminal-input: sessionId/terminalId/data required' },
    ])
    conn.close()
  })

  it('(g) surfaces an unsupported session as a terminal-error frame without crashing the connection', async () => {
    const { fake, sink, conn } = setup()
    fake.unsupported = true
    fake.addSession('s1')
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    const err = await waitForFrame(sink, (f) => f.kind === 'terminal-error')
    expect(err).toEqual({
      kind: 'terminal-error', sessionId: 's1', message: 'terminal subscribe: terminal not supported',
    })
    expect(sink.kinds('terminal-snapshot')).toEqual([])

    // Control ops surface the same capability gate…
    send(conn, { kind: 'terminal-create', sessionId: 's1', cols: 80, rows: 24 })
    await waitForFrame(sink, (f) => f.kind === 'terminal-error' && String(f.message).startsWith('terminal-create:'))
    // …and the connection is still serving frames afterwards.
    send(conn, { kind: 'ping', nonce: 1 })
    await waitForFrame(sink, (f) => f.kind === 'pong')
    expect(sink.kinds('error')).toEqual([])
    conn.close()
  })

  it('(h) fans output to every subscribed connection; one unsubscribing does not affect the other', async () => {
    const fake = new FakeTerminalBroadcaster()
    fake.addSession('s1', runningSnapshot())
    const sink1 = new FakeSink()
    const sink2 = new FakeSink()
    const conn1 = new SessionConnection({ sm: fake as unknown as SessionBroadcaster }, sink1)
    const conn2 = new SessionConnection({ sm: fake as unknown as SessionBroadcaster }, sink2)
    send(conn1, { kind: 'terminal-subscribe', sessionId: 's1' })
    send(conn2, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    expect(fake.subscribes).toBe(2)
    expect(sink1.kinds('terminal-snapshot')).toHaveLength(1)
    expect(sink2.kinds('terminal-snapshot')).toHaveLength(1)

    // Any attached tab may write (shared-terminal semantics); the manager
    // fans the output to EVERY subscriber.
    send(conn1, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'shared\r' })
    await waitForFrame(sink2, (f) => f.kind === 'terminal-output')
    const expected = { kind: 'terminal-output', sessionId: 's1', terminalId: 't-live', seq: 1, data: 'shared\r' }
    expect(sink1.kinds('terminal-output')).toEqual([expected])
    expect(sink2.kinds('terminal-output')).toEqual([expected])

    // conn1 leaves; conn2 keeps receiving.
    send(conn1, { kind: 'terminal-unsubscribe', sessionId: 's1' })
    const before1 = sink1.frames.length
    send(conn2, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'still here\r' })
    await waitForFrame(sink2, (f) => f.kind === 'terminal-output' && f.seq === 2)
    expect(sink1.frames.length).toBe(before1)
    expect(sink2.kinds('terminal-output')).toHaveLength(2)
    conn1.close()
    conn2.close()
  })

  it('answers an unknown session with a terminal-error frame (manager returns null)', async () => {
    const { sink, conn } = setup()
    send(conn, { kind: 'terminal-subscribe', sessionId: 'ghost' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-error')
    expect(sink.kinds('terminal-error')).toEqual([
      { kind: 'terminal-error', sessionId: 'ghost', message: 'terminal subscribe: session ghost not found' },
    ])
    expect(sink.kinds('error')).toEqual([])
    conn.close()
  })

  it('ignores a duplicate terminal-subscribe on one connection', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1')
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    expect(fake.subscribes).toBe(1)
    expect(sink.kinds('terminal-snapshot')).toHaveLength(1)
    conn.close()
  })

  it('connection close releases the terminal subscription', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1')
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    conn.close()
    expect(fake.unsubscribes).toBe(1)
    expect(sink.closed).toBe(true)
  })

  it('a channel ended by the manager releases the entry so a re-subscribe re-wires', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1', runningSnapshot())
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    // Manager-side teardown (unload/sleep) ends every subscriber's pushable.
    fake.endAll('s1')
    await tick()
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    expect(fake.subscribes).toBe(2)
    expect(sink.kinds('terminal-snapshot')).toHaveLength(2)
    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'after\r' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-output')
    conn.close()
  })

  it('a create after a server-side channel end revives the channel (sleep/dispose heal)', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1', runningSnapshot())
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    // Manager-side teardown (sleep / GC dispose) ends the pushable; the
    // bridge releases its entry. The client's overlay stays mounted.
    fake.endAll('s1')
    await tick()

    // The next create re-opens the channel WITHOUT a new terminal-subscribe
    // frame: the revived seed snapshot lands, then the create answer, and
    // live output flows again.
    send(conn, { kind: 'terminal-create', sessionId: 's1', cols: 80, rows: 24 })
    await waitForFrame(sink, (f) => f.kind === 'terminal-state')
    expect(fake.subscribes).toBe(2)
    send(conn, { kind: 'terminal-input', sessionId: 's1', terminalId: 't-live', data: 'revived\r' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-output')
    expect(sink.kinds('terminal-output')).toEqual([
      { kind: 'terminal-output', sessionId: 's1', terminalId: 't-live', seq: 1, data: 'revived\r' },
    ])
    conn.close()
  })

  it('delegates resize and close to the manager; close transitions ride the channel', async () => {
    const { fake, sink, conn } = setup()
    fake.addSession('s1')
    send(conn, { kind: 'terminal-subscribe', sessionId: 's1' })
    await tick()
    send(conn, { kind: 'terminal-create', sessionId: 's1', cols: 80, rows: 24 })
    await waitForFrame(sink, (f) => f.kind === 'terminal-state')

    send(conn, { kind: 'terminal-resize', sessionId: 's1', terminalId: 't-live', cols: 120, rows: 40 })
    send(conn, { kind: 'terminal-close', sessionId: 's1' })
    await waitForFrame(sink, (f) => f.kind === 'terminal-state' && f.terminalId === '')
    expect(fake.calls).toContain('resize:s1:t-live:120x40')
    expect(fake.calls).toContain('close:s1')
    expect(sink.kinds('terminal-state').at(-1)).toEqual({
      kind: 'terminal-state', sessionId: 's1', terminalId: '', state: state('idle'),
    })
    conn.close()
  })
})
