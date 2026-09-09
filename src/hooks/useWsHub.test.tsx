import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WsHubProvider, useWsHub, useWsHubStatus } from './useWsHub'

// ── Fake WebSocket ─────────────────────────────────────────────────
//
// The hub is the only transport for every real-time surface, and all of its
// interesting logic (backoff, the stale-socket close guard, ref-counted
// subscribe, sinceUuid resume) lives in socket event handlers. A controlled
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
    // No reconnect scheduled, and the live socket is untouched.
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(live.readyState).toBe(FakeWebSocket.OPEN)
    expect(live.closeCalls).toHaveLength(0)
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

    act(() => { vi.advanceTimersByTime(25_000) })
    expect(live.framesOfKind('ping')).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(50_000) })
    expect(live.framesOfKind('ping')).toHaveLength(3)

    // After a drop the heartbeat interval is cleared — no further pings on the
    // dead socket (its frames stop growing even as time advances).
    act(() => { live.serverDrop() })
    const afterDrop = live.framesOfKind('ping').length
    act(() => { vi.advanceTimersByTime(100_000) })
    expect(live.framesOfKind('ping')).toHaveLength(afterDrop)
  })
})

// ── subscribe ref-counting ─────────────────────────────────────────

describe('useWsHub: subscribe ref-counting', () => {
  it('sends one subscribe on 0→1 and one unsubscribe only when the last holder releases', () => {
    const { result } = mountHub()
    openSocket()
    const live = sock()

    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    act(() => { releaseA = result.current.hub.subscribe('s1') })
    act(() => { releaseB = result.current.hub.subscribe('s1') })
    // Second subscriber must not re-send.
    expect(live.framesOfKind('subscribe')).toHaveLength(1)
    expect(live.framesOfKind('subscribe')[0]).toMatchObject({ sessionId: 's1' })

    act(() => { releaseA() })
    expect(live.framesOfKind('unsubscribe')).toHaveLength(0) // still held

    act(() => { releaseB() })
    expect(live.framesOfKind('unsubscribe')).toHaveLength(1)
    expect(live.framesOfKind('unsubscribe')[0]).toMatchObject({ sessionId: 's1' })
  })

  it('passes sinceUuid on the subscribe frame when given', () => {
    const { result } = mountHub()
    openSocket()
    act(() => { result.current.hub.subscribe('s1', 'uuid-42') })
    expect(sock().framesOfKind('subscribe')[0]).toMatchObject({ sessionId: 's1', sinceUuid: 'uuid-42' })
  })

  it('omits sinceUuid entirely when not given (no undefined key on the wire)', () => {
    const { result } = mountHub()
    openSocket()
    act(() => { result.current.hub.subscribe('s1') })
    expect('sinceUuid' in sock().framesOfKind('subscribe')[0]).toBe(false)
  })

  it('resubscribe bypasses the ref-count guard and forces a fresh frame', () => {
    // subscribe() only emits on 0→1, so a session already held by another
    // consumer could never re-request a replay after being resumed from
    // dormant. resubscribe is that escape hatch.
    const { result } = mountHub()
    openSocket()
    const live = sock()

    act(() => { result.current.hub.subscribe('s1') })
    expect(live.framesOfKind('subscribe')).toHaveLength(1)

    act(() => { result.current.hub.resubscribe('s1', 'uuid-9') })
    expect(live.framesOfKind('subscribe')).toHaveLength(2)
    expect(live.framesOfKind('subscribe')[1]).toMatchObject({ sessionId: 's1', sinceUuid: 'uuid-9' })
  })
})

// ── reconnect replay ───────────────────────────────────────────────

describe('useWsHub: reconnect replay', () => {
  it('re-subscribes every held session on reopen, carrying the latest uuid', () => {
    const { result } = mountHub()
    openSocket()

    act(() => {
      result.current.hub.subscribe('s1', 'u1')
      result.current.hub.subscribe('s2')
      // A later message advances s1's cursor; the resume must use THIS, not u1.
      result.current.hub.setLastMessageUuid('s1', 'u9')
    })

    act(() => { sock().serverDrop() })
    act(() => { vi.advanceTimersByTime(500) })
    const revived = sock()
    expect(revived.framesOfKind('subscribe')).toHaveLength(0) // nothing before open
    openSocket()

    const subs = revived.framesOfKind('subscribe')
    expect(subs).toHaveLength(2)
    expect(subs.find((f) => f.sessionId === 's1')).toMatchObject({ sinceUuid: 'u9' })
    // s2 never got a cursor, so it resumes without one (full replay).
    expect('sinceUuid' in subs.find((f) => f.sessionId === 's2')!).toBe(false)
  })

  it('does not replay a session that was released before the reconnect', () => {
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

  it('drops frames sent while the socket is not open, then replays them on open', () => {
    // safeSend is a silent no-op unless readyState === OPEN. The subscribe
    // intent is not lost: the reopen handler replays every held session.
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
