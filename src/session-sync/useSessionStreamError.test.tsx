// Environment: happy-dom (repo default for src/** — renderHook needs a DOM
// for the React reconciler).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { WsHubStatus } from '../hooks/useWsHub'

// ── Mocks ──────────────────────────────────────────────────────────

// Controllable hub status so each test (and each transition) can pin the
// projection without re-mocking per case.
let currentHubStatus: WsHubStatus

vi.mock('../hooks/useWsHub', () => ({
  useWsHubStatus: () => currentHubStatus,
}))

// Import AFTER mock so the adapter picks up the stub.
import { useSessionStreamError } from './useSessionStreamError'
import { sessionStoreRegistry } from '../session-store/registry'
import { getSessionStore } from '../session-store/selectors'

// ── Helpers ────────────────────────────────────────────────────────

const RECONNECTING = 'Stream reconnecting…'

/** Write `intent.error` through the real reducer (the path the WS error
 *  frame takes). ERROR with `null` clears it. */
function setStoreError(sid: string, message: string | null) {
  getSessionStore(sid).dispatch({ type: 'ERROR', message })
}

// ── Tests ──────────────────────────────────────────────────────────

describe('useSessionStreamError', () => {
  beforeEach(() => {
    currentHubStatus = 'online'
    void sessionStoreRegistry.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── connecting ─────────────────────────────────────────────────

  it('connecting passes the store error through unchanged', () => {
    currentHubStatus = 'connecting'
    setStoreError('s1', 'boom')
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe('boom')
  })

  it('connecting passes null through unchanged', () => {
    currentHubStatus = 'connecting'
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBeNull()
  })

  it('connecting surfaces the reconnecting placeholder as-is (no suppression)', () => {
    currentHubStatus = 'connecting'
    setStoreError('s1', RECONNECTING)
    const { result } = renderHook(() => useSessionStreamError('s1'))
    // The placeholder is a real error string in the store; connecting does
    // not reinterpret it.
    expect(result.current).toBe(RECONNECTING)
  })

  // ── online ─────────────────────────────────────────────────────

  it('online clears the reconnecting placeholder', () => {
    currentHubStatus = 'online'
    setStoreError('s1', RECONNECTING)
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBeNull()
  })

  it('online preserves a non-reconnect error', () => {
    currentHubStatus = 'online'
    setStoreError('s1', 'boom')
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe('boom')
  })

  it('online returns null when the store has no error', () => {
    currentHubStatus = 'online'
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBeNull()
  })

  // ── reconnecting ───────────────────────────────────────────────

  it('reconnecting surfaces the placeholder when the store has no error', () => {
    currentHubStatus = 'reconnecting'
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe(RECONNECTING)
  })

  it('reconnecting promotes the placeholder to the reconnecting message', () => {
    currentHubStatus = 'reconnecting'
    setStoreError('s1', RECONNECTING)
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe(RECONNECTING)
  })

  it('reconnecting preserves a non-reconnect error over the reconnecting message', () => {
    currentHubStatus = 'reconnecting'
    setStoreError('s1', 'boom')
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe('boom')
  })

  // ── transitions ────────────────────────────────────────────────

  it('connecting → online clears the reconnecting placeholder', () => {
    setStoreError('s1', RECONNECTING)
    currentHubStatus = 'connecting'
    const { result, rerender } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe(RECONNECTING)

    currentHubStatus = 'online'
    rerender()
    expect(result.current).toBeNull()
  })

  it('online → reconnecting re-arms the reconnecting message when no real error', () => {
    currentHubStatus = 'online'
    const { result, rerender } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBeNull()

    currentHubStatus = 'reconnecting'
    rerender()
    expect(result.current).toBe(RECONNECTING)
  })

  it('a non-reconnect error survives a connecting → reconnecting → online cycle', () => {
    // The error banner must not flicker or get swallowed by the WS status
    // transitions — a real error stays visible until it is explicitly cleared.
    setStoreError('s1', 'boom')
    currentHubStatus = 'connecting'
    const { result, rerender } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBe('boom')

    currentHubStatus = 'reconnecting'
    rerender()
    expect(result.current).toBe('boom')

    currentHubStatus = 'online'
    rerender()
    expect(result.current).toBe('boom')
  })

  it('reacts to a store error change while the hub status is steady', () => {
    currentHubStatus = 'online'
    const { result } = renderHook(() => useSessionStreamError('s1'))
    expect(result.current).toBeNull()

    act(() => setStoreError('s1', 'boom'))
    expect(result.current).toBe('boom')

    act(() => setStoreError('s1', null))
    expect(result.current).toBeNull()
  })
})
