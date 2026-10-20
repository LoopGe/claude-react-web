import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WsHubProvider, useWsHub, useWsHubStatus } from './useWsHub'
import type { WsSubscribeResult, WsSubscribeResultReason } from '../ws-types'
import { setTransport } from '../transport'

// ── Fake WebSocket ─────────────────────────────────────────────────
//
// The hub is the only transport for every real-time surface, and all of its
// interesting logic (backoff, the stale-socket close guard, ref-counted
// subscribe) lives in socket event handlers. A controlled
// fake lets us drive those events deterministically and inspect the frames the
// hub sends, without adding a mock-socket dependency.
//
// One fidelity detail matters: browsers deliver `close` ASYNCHRONOUSLY after
// `close()` is called. `connect()` closes the previous socket BEFORE assigning
// `wsRef.current = ws`, so a synchronous close event would fire while the ref
// still points at the old socket — defeating the stale-socket guard and making
// the tests disagree with production. `close()` therefore queues its event.
// `serverDrop()` fires synchronously: it models the event *arriving*, which is
// what the handler under test reacts to.

interface FakeEvent {
  data?: string
  code?: number
  reason?: string
}
type FakeListener = (ev: FakeEvent) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  /** Every socket the hub has constructed, in order. */
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  /** Raw strings passed to send(). */
  sent: string[] = []
  closeCalls: Array<{ code?: number; reason?: string }> = []
  private listeners = new Map<string, Set<FakeListener>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: FakeListener) {
    let set = this.listeners.get(type)
    if (!set) { set = new Set(); this.listeners.set(type, set) }
    set.add(fn)
  }

  removeEventListener(type: string, fn: FakeListener) {
    this.listeners.get(type)?.delete(fn)
  }

  send(data: string) {
    this.sent.push(data)
  }

  /** Called by the hub (replace / unmount). Models the browser: state flips
   *  immediately, the close EVENT is delivered on a later microtask. */
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason })
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.emit('close', { code, reason }))
  }

  // ── test controls ────────────────────────────────────────────────
  /** Connection established. */
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }
  /** A server frame arrives. */
  fireMessage(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) })
  }
  /** A raw (possibly malformed) payload arrives. */
  fireRaw(data: string) {
    this.emit('message', { data })
  }
  /** The connection drops — the close event arrives now. */
  serverDrop() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }
  fireError() {
    this.emit('error', {})
  }

  /** Parsed view of everything sent on this socket. */
  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
  framesOfKind(kind: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.kind === kind)
  }

  private emit(type: string, ev: FakeEvent) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev)
  }
}

const WS_URL = 'ws://test.local/api/ws'

/** Latest constructed socket. */
const sock = (i?: number): FakeWebSocket => {
  const list = FakeWebSocket.instances
  const inst = i == null ? list[list.length - 1] : list[i]
  if (!inst) throw new Error(`No FakeWebSocket at index ${i ?? 'last'} (have ${list.length})`)
  return inst
}

function wrapper({ children }: { children: ReactNode }) {
  return <WsHubProvider url={WS_URL}>{children}</WsHubProvider>
}

/** Mount the hub and expose its api + status. */
function mountHub() {
  return renderHook(() => ({ hub: useWsHub(), status: useWsHubStatus() }), { wrapper })
}

/** Open the current socket inside act() so status/state settle. */
function openSocket() {
  act(() => { sock().fireOpen() })
}

/** Let queued microtasks (async close delivery) run. */
async function flushMicrotasks() {
  await act(async () => { await Promise.resolve() })
}

let realWebSocket: typeof globalThis.WebSocket

beforeEach(() => {
  FakeWebSocket.instances = []
  realWebSocket = globalThis.WebSocket
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  // Deterministic backoff: jitter is Math.random() * 400.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  ;(globalThis as { WebSocket: unknown }).WebSocket = realWebSocket
})

// ── connection lifecycle ───────────────────────────────────────────

describe('useWsHub: connection lifecycle', () => {
  it('connects to the given url on mount and reports online once open', () => {
    const { result } = mountHub()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(sock().url).toBe(WS_URL)
    expect(result.current.status).toBe('connecting')

    openSocket()
    expect(result.current.status).toBe('online')
  })

  it('flips to reconnecting on a drop and reconnects after the backoff delay', () => {
    const { result } = mountHub()
    openSocket()

    act(() => { sock().serverDrop() })
    expect(result.current.status).toBe('reconnecting')
    // No new socket until the timer fires.
    expect(FakeWebSocket.instances).toHaveLength(1)

    // First attempt: 500 * 2^0 + 0 jitter.
    act(() => { vi.advanceTimersByTime(500) })
    expect(FakeWebSocket.instances).toHaveLength(2)

    openSocket()
    expect(result.current.status).toBe('online')
  })

  it('grows the backoff per attempt and resets it after a successful open', () => {
    mountHub()
    openSocket()

    // Drop 1 → 500ms.
    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(499) })
    expect(FakeWebSocket.instances).toHaveLength(1) // not yet
    act(() => { vi.advanceTimersByTime(1) })
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Drop 2 WITHOUT opening → 1000ms (attempt counter advanced).
    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(999) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    act(() => { vi.advanceTimersByTime(1) })
    expect(FakeWebSocket.instances).toHaveLength(3)

    // A successful open resets the counter, so the NEXT drop waits 500ms again.
    openSocket()
    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('caps the backoff delay at 15s', () => {
    mountHub()
    openSocket()
    // Drive enough consecutive failures to exceed the cap (500 * 2^6 = 32s).
    for (let i = 0; i < 7; i++) {
      act(() => { sock().serverDrop() })
      act(() => { vi.advanceTimersByTime(15_000) })
    }
    const countAfterCap = FakeWebSocket.instances.length
    // One more drop must still reconnect within the cap, not 32s later.
    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(FakeWebSocket.instances.length).toBe(countAfterCap + 1)
  })

  it('a stale socket\'s close event does NOT tear down the live connection', async () => {
    // The guard this covers: connect() replaces the socket, and the OLD
    // socket's close event still arrives afterwards. Without the
    // `wsRef.current !== ws` check it would schedule a reconnect that kills
    // the new, working socket.
    mountHub()
    openSocket()
    const stale = sock()

    act(() => { stale.serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    const live = sock()
    openSocket()
    expect(live.readyState).toBe(FakeWebSocket.OPEN)

    // The stale socket emits close again (late delivery).
    act(() => { stale.serverDrop() })
    await flushMicrotasks()
    // No reconnect scheduled, and the live socket is untouched. The 60s
    // window spans live heartbeats, so answer each ping — a healthy server
    // would — or the zombie watchdog would (correctly) replace the socket.
    for (let i = 0; i < 3; i++) {
      act(() => { vi.advanceTimersByTime(25_000) })
      const pings = live.framesOfKind('ping')
      const last = pings[pings.length - 1] as { nonce?: number } | undefined
      act(() => { live.fireMessage({ kind: 'pong', nonce: last?.nonce }) })
    }
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(live.readyState).toBe(FakeWebSocket.OPEN)
    expect(live.closeCalls).toHaveLength(0)
  })

  it("a stale socket's late frames do not reach listeners (onFrame stale guard)", () => {
    // The pong path makes this load-bearing: without the guard, an abandoned
    // socket's late pong would clear the LIVE connection's pendingPingRef and
    // postpone zombie detection by a full interval.
    const { result } = mountHub()
    openSocket()
    const stale = sock()
    act(() => { stale.serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    openSocket()
    const seen = vi.fn()
    act(() => { result.current.hub.addListener(seen) })

    act(() => { stale.fireMessage({ kind: 'sessions-snapshot', sessions: [] }) })
    expect(seen).not.toHaveBeenCalled()

    // The live socket still delivers.
    act(() => { sock().fireMessage({ kind: 'sessions-snapshot', sessions: [] }) })
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('closes the socket and stops reconnecting on unmount', () => {
    const { unmount } = mountHub()
    openSocket()
    const live = sock()

    unmount()
    expect(live.closeCalls[0]).toMatchObject({ code: 1000, reason: 'client unmounting' })

    // A drop after unmount must not resurrect the connection.
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('sends an app-level ping every 25s while open, and stops after a drop', () => {
    mountHub()
    openSocket()
    const live = sock()
    expect(live.framesOfKind('ping')).toHaveLength(0)

    const echoPong = () => {
      const pings = live.framesOfKind('ping')
      const last = pings[pings.length - 1] as { nonce?: number } | undefined
      if (last) act(() => { live.fireMessage({ kind: 'pong', nonce: last.nonce }) })
    }

    // One tick per step: each ping must be answered BEFORE the next tick's
    // zombie check runs (advancing two intervals at once would run both
    // ticks before the echo lands).
    for (let i = 0; i < 3; i++) {
      act(() => { vi.advanceTimersByTime(25_000) })
      echoPong()
    }
    expect(live.framesOfKind('ping')).toHaveLength(3)

    // After a drop the heartbeat interval is cleared — no further pings on the
    // dead socket (its frames stop growing even as time advances).
    act(() => { live.serverDrop() })
    const afterDrop = live.framesOfKind('ping').length
    act(() => { vi.advanceTimersByTime(100_000) })
    expect(live.framesOfKind('ping')).toHaveLength(afterDrop)
  })
})

// ── zombie-connection watchdog ──────────────────────────────────────

describe('useWsHub: zombie-connection watchdog', () => {
  it('keeps the connection alive while every ping is answered in time', () => {
    mountHub()
    openSocket()
    const live = sock()

    // 10 minutes of healthy heartbeats: each tick's ping is answered by the
    // server before the next tick. No reconnect may fire — this is the
    // every-day path and a false zombie here would drop live connections.
    for (let i = 0; i < 24; i++) {
      act(() => { vi.advanceTimersByTime(25_000) })
      const pings = live.framesOfKind('ping')
      const last = pings[pings.length - 1] as { nonce?: number } | undefined
      act(() => { live.fireMessage({ kind: 'pong', nonce: last?.nonce }) })
    }
    expect(live.framesOfKind('ping')).toHaveLength(24)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('detects a dead connection (pong never arrives) and reconnects without a refresh', () => {
    const { result } = mountHub()
    openSocket()
    const zombie = sock()

    // Tick 1: ping goes out. The peer never answers (pipe wedged silently —
    // TCP established, no close event).
    act(() => { vi.advanceTimersByTime(25_000) })
    expect(zombie.framesOfKind('ping')).toHaveLength(1)
    expect(FakeWebSocket.instances).toHaveLength(1) // still hoping

    // Tick 2: the pending ping is now a full interval old (the verdict is
    // whatever is still pending at the next 25s tick — there is no separate
    // deadline constant; pong tolerance IS the ping cadence).
    // The hub must declare the connection dead, drop it, and start the
    // reconnect path (this is what a refresh does, without the refresh).
    act(() => { vi.advanceTimersByTime(25_000) })
    expect(result.current.status).toBe('reconnecting')
    expect(zombie.closeCalls.length).toBeGreaterThan(0)

    // The abandoned socket's events are ignored (stale-sequence guard): a
    // late open must not resurrect the dead connection's state.
    act(() => { zombie.fireOpen() })
    expect(result.current.status).toBe('reconnecting')

    // Backoff (500ms, jitter mocked to 0) → fresh socket → online again.
    act(() => { vi.advanceTimersByTime(500) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    openSocket()
    expect(result.current.status).toBe('online')
    // Heartbeats resume on the new socket.
    act(() => { vi.advanceTimersByTime(25_000) })
    expect(sock().framesOfKind('ping')).toHaveLength(1)
  })

  it('a pong arriving within the deadline cancels the zombie verdict', () => {
    mountHub()
    openSocket()
    const live = sock()

    act(() => { vi.advanceTimersByTime(25_000) })
    const pings = live.framesOfKind('ping') as Array<{ nonce?: number }>
    // Answer the first ping late in the window but before the next tick.
    act(() => { live.fireMessage({ kind: 'pong', nonce: pings[0]?.nonce }) })
    act(() => { vi.advanceTimersByTime(25_000) })

    // Both ticks sent pings, both were answered — still one connection.
    expect(live.framesOfKind('ping')).toHaveLength(2)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

// ── subscribe ref-counting ─────────────────────────────────────────

describe('useWsHub: subscribe ref-counting and channel state', () => {
  /** The server's answer to one subscribe frame (see WsSubscribeResult). */
  const ack = (
    sessionId: string,
    ok: boolean,
    reason: WsSubscribeResultReason,
  ): WsSubscribeResult => ({ kind: 'subscribe-result', sessionId, ok, reason })

  it('sends one subscribe per holder until the server confirms, then one unsubscribe when the last lets go', () => {
    const { result } = mountHub()
    openSocket()
    const live = sock()

    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    let releaseC: () => void = () => {}
    act(() => { releaseA = result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(1)

    // A second holder mounting before the server has answered also sends: the
    // hub deliberately keeps no in-flight flag (its stale direction skips a
    // frame a listener needs), and a duplicate is cheap — the server answers it
    // and re-attaches the listener.
    act(() => { releaseB = result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(2)

    // Once a channel is confirmed, further holders are deduped.
    act(() => { live.fireMessage(ack('s1', true, 'served')) })
    act(() => { releaseC = result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(2)
    expect(live.framesOfKind('subscribe')[0]).toMatchObject({ sessionId: 's1' })

    act(() => { releaseA() })
    expect(live.framesOfKind('unsubscribe')).toHaveLength(0) // still held

    act(() => { releaseB() })
    act(() => { releaseC() })
    expect(live.framesOfKind('unsubscribe')).toHaveLength(1)
    expect(live.framesOfKind('unsubscribe')[0]).toMatchObject({ sessionId: 's1' })
  })

  it('a double release does not tear down a successor holder\'s channel', () => {
    // The release closure captures the entry it was created for: re-reading the
    // map by key would let a second call decrement — and delete — the entry a
    // LATER holder created, killing a live channel it still needs.
    const { result } = mountHub()
    openSocket()
    const live = sock()

    let releaseFirst: () => void = () => {}
    act(() => { releaseFirst = result.current.hub.subscribe('s1') })
    act(() => { live.fireMessage(ack('s1', true, 'served')) })
    act(() => { releaseFirst() })
    expect(live.framesOfKind('unsubscribe')).toHaveLength(1)

    // A new holder takes the channel over, then the stale release fires again.
    act(() => { result.current.hub.subscribe('s1') })
    act(() => { releaseFirst() })
    expect(live.framesOfKind('unsubscribe')).toHaveLength(1) // not 2 — not ours
  })

  it('the subscribe frame carries only the sessionId (no legacy replay cursor)', () => {
    const { result } = mountHub()
    openSocket()
    act(() => { result.current.hub.subscribe('s1') })
    expect(sock().framesOfKind('subscribe')[0]).toEqual({ kind: 'subscribe', sessionId: 's1' })
  })

  it('force sends for a channel the server already confirmed', () => {
    // `force` is how a listener that has not received the server's subscribe
    // answer (the attached handshake + pending-request re-broadcast) says so.
    // The channel is deliberately confirmed live first, so the assertion only
    // holds if the force really bypassed the dedup.
    const { result } = mountHub()
    openSocket()
    const live = sock()

    act(() => { result.current.hub.subscribe('s1') })
    act(() => { live.fireMessage(ack('s1', true, 'served')) })
    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(1) // live ⇒ deduped

    act(() => { result.current.hub.subscribe('s1', { force: true }) })
    expect(live.framesOfKind('subscribe')).toHaveLength(2)
    expect(live.framesOfKind('subscribe')[1]).toMatchObject({ sessionId: 's1' })
  })

  it('a refused subscribe does not poison the session for the next subscriber', () => {
    // Regression guard for "resume 后加载不出任何消息卡片": the panel for a
    // SLEPT session mounts useGitStatus's subscribe FIRST (that hook runs
    // regardless of `running`; startSession refuses to wake a slept session
    // from a subscribe, so the answer is ok:false and nothing is established).
    // <Chat>/useChatStream mounts only once the resume lands, so its subscribe
    // is the one that must actually reach the server. Counting the refusal as
    // a held channel suppressed it and the session was never served.
    const { result } = mountHub()
    openSocket()
    const live = sock()

    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(1)
    act(() => { live.fireMessage(ack('s1', false, 'refused')) })

    // The resume lands (running flips true) and the panel's <Chat> mounts.
    act(() => { result.current.hub.subscribe('s1') })
    const subs = live.framesOfKind('subscribe')
    expect(subs).toHaveLength(2)
    expect(subs[1]).toMatchObject({ sessionId: 's1' })

    // …and the ack that answers it re-arms the dedup for later holders.
    act(() => { live.fireMessage(ack('s1', true, 'served')) })
    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(2)
  })

  it('re-requests a channel the server reports as closed', () => {
    // Sleeping / unloading a session ends its subscriber queues server-side;
    // the per-connection `closed` result is the only signal for it (the global
    // session-update feed is not per-connection, and some teardowns never
    // broadcast one). Without it the recorded channel would suppress the next
    // subscribe on resume, i.e. the blank transcript by another route.
    const { result } = mountHub()
    openSocket()
    const live = sock()

    act(() => { result.current.hub.subscribe('s1') })
    act(() => { live.fireMessage(ack('s1', true, 'served')) })
    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(1)

    act(() => { live.fireMessage(ack('s1', false, 'closed')) })
    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(2)
    expect(live.framesOfKind('subscribe')[1]).toMatchObject({ sessionId: 's1' })
  })

  it('ignores a subscribe-result that names no session', () => {
    // This runs before fan-out, where the handler's only other validation is
    // `typeof frame.kind` — a throw would drop the frame for every listener.
    const { result } = mountHub()
    openSocket()
    const live = sock()
    const global = vi.fn()
    act(() => { result.current.hub.addListener(global) })

    act(() => {
      live.fireMessage({ kind: 'subscribe-result' })
      live.fireMessage({ kind: 'subscribe-result', sessionId: 42, ok: 'yes' })
    })
    expect(global).toHaveBeenCalledTimes(2)

    // A held channel is unaffected by a malformed answer.
    act(() => { result.current.hub.subscribe('s1') })
    act(() => { live.fireMessage(ack('s1', true, 'served')) })
    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(1)
  })

  it('drops channel state when the socket is replaced', () => {
    // Channels are per-connection: a liveness that survived a reconnect would
    // suppress the re-subscribe the reopen handler issues.
    const { result } = mountHub()
    openSocket()
    act(() => { result.current.hub.subscribe('s1') })
    act(() => { sock().fireMessage(ack('s1', true, 'served')) })

    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    openSocket()
    const revived = sock()
    // The open handler re-subscribes the held session even though the previous
    // socket had confirmed it.
    expect(revived.framesOfKind('subscribe')).toHaveLength(1)

    act(() => { revived.fireMessage(ack('s1', true, 'served')) })
    act(() => { result.current.hub.subscribe('s1') })
    expect(revived.framesOfKind('subscribe')).toHaveLength(1)
  })
})

// ── transport seam ─────────────────────────────────────────────────

describe('useWsHub: transport seam', () => {
  afterEach(() => setTransport(null))

  it('handles a transport that opens synchronously during connect()', () => {
    // An IPC-backed transport can deliver `open` while connect() is still on
    // the stack, before the hub assigns connRef. Reads of connRef at that
    // instant are null, so the open must be deferred until the handle exists;
    // otherwise every re-subscribe (and the heartbeat) is silently dropped and
    // a reconnected panel is stranded with no replay.
    const sent: unknown[] = []
    setTransport({
      request: vi.fn(),
      connect(handlers) {
        const conn = { send: (frame: unknown) => { sent.push(frame) }, close: () => {} }
        handlers.onOpen() // synchronous, before connect() returns
        return conn
      },
    })

    const { result } = renderHook(() => useWsHub(), {
      wrapper: ({ children }: { children: ReactNode }) => <WsHubProvider>{children}</WsHubProvider>,
    })

    // The deferred open ran with the real handle: heartbeat armed.
    act(() => { vi.advanceTimersByTime(25_000) })
    expect(sent.some((f) => (f as { kind?: string }).kind === 'ping')).toBe(true)

    // …and normal sends still work afterwards.
    act(() => { result.current.subscribe('s1') })
    expect(sent).toContainEqual({ kind: 'subscribe', sessionId: 's1' })
  })
})

// ── reconnect re-subscribe ─────────────────────────────────────────

describe('useWsHub: reconnect re-subscribe', () => {
  it('re-subscribes every held session on reopen', () => {
    const { result } = mountHub()
    openSocket()

    act(() => {
      result.current.hub.subscribe('s1')
      result.current.hub.subscribe('s2')
    })

    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    const revived = sock()
    expect(revived.framesOfKind('subscribe')).toHaveLength(0) // nothing before open
    openSocket()

    const subs = revived.framesOfKind('subscribe')
    expect(subs).toHaveLength(2)
    expect(subs.find((f) => f.sessionId === 's1')).toMatchObject({ sessionId: 's1' })
    expect(subs.find((f) => f.sessionId === 's2')).toMatchObject({ sessionId: 's2' })
  })

  it('does not re-subscribe a session that was released before the reconnect', () => {
    const { result } = mountHub()
    openSocket()
    let release: () => void = () => {}
    act(() => { release = result.current.hub.subscribe('s1') })
    act(() => { release() })

    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    openSocket()
    expect(sock().framesOfKind('subscribe')).toHaveLength(0)
  })

  it('drops frames sent while the socket is not open, then re-sends them on open', () => {
    // safeSend is a silent no-op unless readyState === OPEN. The subscribe
    // intent is not lost: the reopen handler re-subscribes every held session.
    const { result } = mountHub()
    const connecting = sock() // still CONNECTING
    act(() => { result.current.hub.subscribe('s1') })
    expect(connecting.sent).toHaveLength(0)

    openSocket()
    expect(connecting.framesOfKind('subscribe')).toHaveLength(1)
  })
})

// ── frame fan-out ──────────────────────────────────────────────────

describe('useWsHub: frame fan-out', () => {
  it('delivers frames to global listeners and only matching session listeners', () => {
    const { result } = mountHub()
    openSocket()
    const global = vi.fn()
    const s1 = vi.fn()
    act(() => {
      result.current.hub.addListener(global)
      result.current.hub.addSessionListener('s1', s1)
    })

    act(() => { sock().fireMessage({ kind: 'session-message', sessionId: 's1', message: {} }) })
    expect(global).toHaveBeenCalledTimes(1)
    expect(s1).toHaveBeenCalledTimes(1)

    // Another session's frame reaches the global listener only.
    act(() => { sock().fireMessage({ kind: 'session-message', sessionId: 's2', message: {} }) })
    expect(global).toHaveBeenCalledTimes(2)
    expect(s1).toHaveBeenCalledTimes(1)

    // A frame with no sessionId reaches the global listener only.
    act(() => { sock().fireMessage({ kind: 'sessions-snapshot', sessions: [] }) })
    expect(global).toHaveBeenCalledTimes(3)
    expect(s1).toHaveBeenCalledTimes(1)
  })

  it('stops delivering after a listener unregisters', () => {
    const { result } = mountHub()
    openSocket()
    const global = vi.fn()
    const s1 = vi.fn()
    let offGlobal: () => void = () => {}
    let offSession: () => void = () => {}
    act(() => {
      offGlobal = result.current.hub.addListener(global)
      offSession = result.current.hub.addSessionListener('s1', s1)
    })
    act(() => { offGlobal(); offSession() })

    act(() => { sock().fireMessage({ kind: 'session-message', sessionId: 's1', message: {} }) })
    expect(global).not.toHaveBeenCalled()
    expect(s1).not.toHaveBeenCalled()
  })

  it('a throwing listener does not stop the others', () => {
    const { result } = mountHub()
    openSocket()
    const boom = vi.fn(() => { throw new Error('listener blew up') })
    const ok = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => {
      result.current.hub.addListener(boom)
      result.current.hub.addListener(ok)
    })

    act(() => { sock().fireMessage({ kind: 'sessions-snapshot', sessions: [] }) })
    expect(boom).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed payloads and frames without a string kind', () => {
    const { result } = mountHub()
    openSocket()
    const global = vi.fn()
    act(() => { result.current.hub.addListener(global) })

    act(() => {
      sock().fireRaw('not json at all')
      sock().fireRaw('null')
      sock().fireMessage({ noKind: true })
      sock().fireMessage({ kind: 42 })
    })
    expect(global).not.toHaveBeenCalled()

    // A well-formed frame still gets through afterwards.
    act(() => { sock().fireMessage({ kind: 'pong', nonce: 1 }) })
    expect(global).toHaveBeenCalledTimes(1)
  })

  it('survives a socket error event without tearing down (close drives the retry)', () => {
    const { result } = mountHub()
    openSocket()
    act(() => { sock().fireError() })
    // Error alone is not a disconnect signal — status stays online until close.
    expect(result.current.status).toBe('online')
  })
})

// ── subagent transcript channel ────────────────────────────────────

describe('useWsHub: subagent transcript channel', () => {
  it('sends subscribe on demand, resends on reconnect, unsubscribes on last release', async () => {
    const { result } = mountHub()
    openSocket()
    expect(sock().framesOfKind('subagent-transcript-subscribe')).toHaveLength(0)

    const release = result.current.hub.subscribeSubagentTranscript('s1', 'a1')
    expect(sock().framesOfKind('subagent-transcript-subscribe')).toHaveLength(1)
    expect(sock().framesOfKind('subagent-transcript-subscribe')[0]).toMatchObject({ sessionId: 's1', agentId: 'a1' })

    // ref-count:第二个持有者不重发
    const release2 = result.current.hub.subscribeSubagentTranscript('s1', 'a1')
    expect(sock().framesOfKind('subagent-transcript-subscribe')).toHaveLength(1)

    // 重连:重发所有仍持有的
    act(() => { sock().serverDrop() })
    await flushMicrotasks()
    act(() => { vi.advanceTimersByTime(500) })
    openSocket()
    const subs = sock().framesOfKind('subagent-transcript-subscribe')
    expect(subs).toHaveLength(1) // 本次连接的
    expect(subs[0]).toMatchObject({ sessionId: 's1', agentId: 'a1' })

    release2()
    release()
    expect(sock().framesOfKind('subagent-transcript-unsubscribe')).toHaveLength(1)
  })
})

// ── contract ───────────────────────────────────────────────────────

describe('useWsHub: contract', () => {
  it('keeps the hub api referentially stable across status flips', () => {
    const { result } = mountHub()
    const before = result.current.hub
    openSocket()
    expect(result.current.status).toBe('online')
    act(() => { sock().serverDrop() })
    expect(result.current.status).toBe('reconnecting')
    // Status lives in a separate context precisely so consumers with [hub]
    // dep arrays don't tear down their effects on every flip.
    expect(result.current.hub).toBe(before)
  })

  it('throws when used outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Bare = () => { useWsHub(); return null }
    expect(() => render(<Bare />)).toThrow(/must be used inside/i)
  })

  it('reports connecting status outside a provider default', () => {
    // useWsHubStatus has a context default so a stray consumer renders rather
    // than crashing (unlike useWsHub, which is a programming error).
    const { result } = renderHook(() => useWsHubStatus())
    expect(result.current).toBe('connecting')
  })
})
