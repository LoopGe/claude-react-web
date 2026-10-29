// Environment: happy-dom (repo default for src/** — uses renderHook, which
// needs a DOM for the React reconciler; the real SessionStore also uses
// window.clearTimeout in destroy()/purge()).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mocks ──────────────────────────────────────────────────────────

type WsHubListener = (frame: Record<string, unknown>) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>
let mockSubscribe: ReturnType<typeof vi.fn>
let mockApiGet: ReturnType<typeof vi.fn>

const mockHub = {
  addSessionListener: (sessionId: string, fn: WsHubListener) => {
    let set = currentSessionListeners.get(sessionId)
    if (!set) {
      set = new Set()
      currentSessionListeners.set(sessionId, set)
    }
    set.add(fn)
    return () => {
      const s = currentSessionListeners.get(sessionId)
      if (!s) return
      s.delete(fn)
      if (s.size === 0) currentSessionListeners.delete(sessionId)
    }
  },
  subscribe: (...args: unknown[]) => mockSubscribe(...(args as [])),
}

vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => mockHub,
  useWsHubStatus: () => 'online' as const,
}))

vi.mock('../hooks/useApi', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...(args as [])),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

// Import AFTER mock so the adapter picks up our stubs. The registry is real —
// we want the real SessionStore so the synchronizer's dispatches land in a
// store whose snapshot we can read.
import { useSessionSynchronizer } from './useSessionSynchronizer'
import { sessionStoreRegistry } from '../session-store/registry'
import { getSessionStore } from '../session-store/selectors'
import type { SessionSyncHandlers } from './session-synchronizer'

// ── Helpers ────────────────────────────────────────────────────────

function dispatchToSession(sessionId: string, frame: Record<string, unknown>) {
  const set = currentSessionListeners.get(sessionId)
  if (!set) throw new Error(`No listeners for session ${sessionId}`)
  for (const fn of set) fn(frame)
}

const noopHandlers: SessionSyncHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

/** Default open-path answer: an empty transcript page at generation 0. */
const emptyPage = {
  generation: 0,
  headSeq: 0,
  totalCount: 0,
  startIndex: 0,
  hasMore: false,
  messages: [],
}

/** Seed the store's seq window directly (same shape as the synchronizer's
 *  tail-page dispatch), so replayReady flips and the windowed messages run
 *  the full applyMessage pipeline. */
function seedPage(
  sid: string,
  messages: Array<{ seq: number; msg: unknown }>,
  opts?: { hasMore?: boolean; generation?: number; headSeq?: number },
) {
  const headSeq = opts?.headSeq ?? (messages.length > 0 ? messages[messages.length - 1].seq + 1 : 0)
  getSessionStore(sid).dispatch({
    type: 'WINDOW_PAGE',
    at: 'tail',
    generation: opts?.generation ?? 0,
    headSeq,
    messages,
    hasMore: opts?.hasMore ?? false,
    tombstones: [],
  })
}

const syncAgentFrame = {
  type: 'assistant',
  uuid: 'a-sync',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_term', name: 'Agent', input: { description: 'sync work' } }],
  },
}
const seedSyncAgent = (sid: string) => seedPage(sid, [{ seq: 0, msg: syncAgentFrame }])
const subagentStatus = (sid: string) =>
  getSessionStore(sid).getState().mirror.activeSubagents.get('tu_term')?.status

// ── Tests ──────────────────────────────────────────────────────────

// Helpers that return the exact spy type `vi.spyOn` produces for each
// registry method. Pre-declaring with `ReturnType<typeof vi.spyOn>` (the
// broad overload) fails for methods with typed parameters because of
// parameter contravariance — the specific MockInstance for
// `(sessionId: string) => SessionStore` is not assignable to the broad
// `(...args: unknown[]) => unknown`. Routing through a per-method helper
// captures the exact return type at the call site.
const spyRetain = () => vi.spyOn(sessionStoreRegistry, 'retain')
const spyRelease = () => vi.spyOn(sessionStoreRegistry, 'release')

describe('useSessionSynchronizer', () => {
  let retainSpy: ReturnType<typeof spyRetain>
  let releaseSpy: ReturnType<typeof spyRelease>

  beforeEach(() => {
    currentSessionListeners = new Map()
    mockSubscribe = vi.fn((_sessionId: string, _opts?: { force?: boolean }) => vi.fn())
    mockApiGet = vi.fn(async () => ({ ...emptyPage }))
    retainSpy = spyRetain()
    releaseSpy = spyRelease()
    void sessionStoreRegistry.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Empty sessionId is fully inert ──────────────────────────────

  it('does not subscribe, fetch, or retain when sessionId is empty', () => {
    renderHook(() => useSessionSynchronizer('', noopHandlers, false, false))

    expect(mockSubscribe).not.toHaveBeenCalled()
    expect(mockApiGet).not.toHaveBeenCalled()
    expect(retainSpy).not.toHaveBeenCalled()
  })

  it('does not call release on unmount when sessionId is empty', () => {
    const { unmount } = renderHook(() =>
      useSessionSynchronizer('', noopHandlers, false, false),
    )
    unmount()

    // retain was never called, so release must not be called either.
    expect(releaseSpy).not.toHaveBeenCalled()
  })

  // ── Mount retains and starts once ──────────────────────────────

  it('retains the store once on mount', () => {
    renderHook(() => useSessionSynchronizer('s1', noopHandlers, false, false))

    expect(retainSpy).toHaveBeenCalledTimes(1)
    expect(retainSpy).toHaveBeenCalledWith('s1')
  })

  it('subscribes with force on mount', () => {
    renderHook(() => useSessionSynchronizer('s1', noopHandlers, false, false))

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenCalledWith('s1', { force: true })
  })

  it('fetches the tail page on mount', async () => {
    renderHook(() => useSessionSynchronizer('s1', noopHandlers, false, false))

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/sessions/s1/messages?limit=200')
    })
  })

  // ── Unmount releases and stops ─────────────────────────────────

  it('releases the store and the subscribe channel on unmount', () => {
    const { unmount } = renderHook(() =>
      useSessionSynchronizer('s1', noopHandlers, false, false),
    )
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    const releaseChannel = mockSubscribe.mock.results[0].value as ReturnType<typeof vi.fn>

    unmount()

    expect(releaseChannel).toHaveBeenCalledTimes(1)
    expect(releaseSpy).toHaveBeenCalledTimes(1)
    expect(releaseSpy).toHaveBeenCalledWith('s1')
  })

  // ── Rerender with new handlers does not resubscribe ────────────

  it('does not resubscribe when handlers change, but the new callbacks take effect', () => {
    const handlersA: SessionSyncHandlers = { onRequest: vi.fn(), onResolved: vi.fn() }
    const handlersB: SessionSyncHandlers = { onRequest: vi.fn(), onResolved: vi.fn() }
    const { rerender } = renderHook(
      ({ h }: { h: SessionSyncHandlers }) => useSessionSynchronizer('s1', h, false, false),
      { initialProps: { h: handlersA } },
    )

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    const subscribeCallsAfterMount = mockSubscribe.mock.calls.length

    // Swap handlers without changing running/sessionId — no re-subscribe.
    rerender({ h: handlersB })
    expect(mockSubscribe.mock.calls.length).toBe(subscribeCallsAfterMount)

    // The new onRequest takes effect on the next frame.
    act(() => {
      dispatchToSession('s1', {
        kind: 'permission-request',
        sessionId: 's1',
        payload: { id: 'p1', kind: 'permission', toolName: 'Bash' },
      })
    })

    expect(handlersB.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
    )
    expect(handlersA.onRequest).not.toHaveBeenCalled()
  })

  // ── Changing running stops/starts and preserves force subscription ─

  it('re-subscribes with force when running changes', () => {
    const { rerender } = renderHook(
      ({ running }: { running: boolean }) =>
        useSessionSynchronizer('s1', noopHandlers, running, false),
      { initialProps: { running: false } },
    )
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', { force: true })

    // false → true: the effect re-runs, tearing down the old run and
    // starting a fresh one — a fresh subscribe with force.
    rerender({ running: true })
    expect(mockSubscribe).toHaveBeenCalledTimes(2)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', { force: true })

    // true → false: same — every running flip re-establishes the channel.
    rerender({ running: false })
    expect(mockSubscribe).toHaveBeenCalledTimes(3)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', { force: true })
  })

  // ── Terminated is forwarded ────────────────────────────────────

  it('forwards terminated=true to the synchronizer (sweeps a live sync subagent)', async () => {
    const { rerender } = renderHook(
      ({ terminated }: { terminated: boolean }) =>
        useSessionSynchronizer('term-live', noopHandlers, false, terminated),
      { initialProps: { terminated: false } },
    )
    act(() => {
      seedSyncAgent('term-live')
    })
    await waitFor(() => expect(subagentStatus('term-live')).toBe('running'))

    // The terminated effect forwards the flip to the synchronizer, which
    // dispatches SESSION_TERMINATED immediately (replayReady is true).
    rerender({ terminated: true })
    await waitFor(() => expect(subagentStatus('term-live')).toBe('interrupted'))
  })

  it('forwards terminated=true on mount for a reloaded terminated session', async () => {
    renderHook(() => useSessionSynchronizer('term-reload', noopHandlers, false, true))

    // The seed arrives AFTER the mount (the tail page lands), so the sweep
    // must be gated on replayReady — which the synchronizer does internally.
    act(() => {
      seedSyncAgent('term-reload')
    })
    await waitFor(() => expect(subagentStatus('term-reload')).toBe('interrupted'))
  })

  it('re-arms the terminated sweep after a running flip on a terminated session', async () => {
    // Regression (code-review finding #1): a running flip tears the
    // synchronizer down and rebuilds it. stopInternal() resets
    // this.terminated = false, so the terminated effect MUST re-forward
    // terminated=true (its deps include `running`) or the replayReady-gated
    // SESSION_TERMINATED sweep is lost on a reloaded terminated session
    // whose panel re-subscribes before the tail page lands.
    const { rerender } = renderHook(
      ({ running }: { running: boolean }) =>
        useSessionSynchronizer('term-rerun', noopHandlers, running, true),
      { initialProps: { running: false } },
    )
    // running flip before the tail page lands: stop+start, then the
    // terminated effect re-forwards terminated=true (re-arming the gate).
    rerender({ running: true })
    rerender({ running: false })

    // Now the tail page lands (replayReady flips) and seeds a sync agent —
    // the re-armed gate must fire SESSION_TERMINATED and sweep it.
    act(() => {
      seedSyncAgent('term-rerun')
    })
    await waitFor(() => expect(subagentStatus('term-rerun')).toBe('interrupted'))
  })

  // ── Returned paging follows the synchronizer snapshot ──────────

  it('exposes the initial paging snapshot { loadingOlder: false, olderError: null }', () => {
    const { result } = renderHook(() =>
      useSessionSynchronizer('s1', noopHandlers, false, false),
    )
    expect(result.current.loadingOlder).toBe(false)
    expect(result.current.olderError).toBeNull()
  })

  it('loadOlder is a stable function identity per synchronizer across rerenders and paging flips', async () => {
    // The brief requires loadOlder identity to be stable per synchronizer.
    // A paging-snapshot change (loadingOlder/olderError toggling during a
    // loadOlder cycle) must NOT re-bind loadOlder — consumers that put it in
    // a dep array would otherwise churn on every flip.
    const { result } = renderHook(() =>
      useSessionSynchronizer('s1', noopHandlers, false, false),
    )
    await waitFor(() =>
      expect(getSessionStore('s1').getSnapshot().replayReady).toBe(true),
    )
    const initial = result.current.loadOlder

    // Seed a window with hasOlder=true so a real loadOlder cycle flips the
    // paging snapshot (loadingOlder true → false).
    act(() => {
      seedPage('s1', [{ seq: 0, msg: { type: 'user', uuid: 'u0' } }], { hasMore: true })
    })
    expect(getSessionStore('s1').getSnapshot().hasOlder).toBe(true)

    // A failing head-page fetch flips olderError — the paging snapshot
    // reference changes, the returned TranscriptPaging object identity
    // changes, but loadOlder stays the SAME function reference.
    mockApiGet.mockImplementationOnce(async () => {
      throw new Error('network down')
    })
    await act(async () => {
      await result.current.loadOlder()
    })
    await waitFor(() =>
      expect(result.current.olderError).toBe("Couldn't load earlier messages"),
    )
    // The object identity changed (olderError flipped), but loadOlder did not.
    expect(result.current.loadOlder).toBe(initial)
  })

  it('loadOlder returns 0 and flips loadingOlder true then false on an empty window', async () => {
    // No messages in the window → loadOlder no-ops (oldestSeq is null).
    const { result } = renderHook(() =>
      useSessionSynchronizer('s1', noopHandlers, false, false),
    )
    let count = -1
    await act(async () => {
      count = await result.current.loadOlder()
    })
    expect(count).toBe(0)
    // The latch was never set (the guards returned before olderInFlight),
    // so loadingOlder stayed false throughout — no spurious UI flip.
    expect(result.current.loadingOlder).toBe(false)
    expect(result.current.olderError).toBeNull()
  })

  it('loadOlder surfaces olderError when the fetch fails and clears it on session-cleared', async () => {
    const { result } = renderHook(() =>
      useSessionSynchronizer('s1', noopHandlers, false, false),
    )
    // Wait for the open-path tail fetch to land BEFORE seeding — otherwise
    // the tail page (empty) resolves mid-test and overwrites the seed.
    await waitFor(() =>
      expect(getSessionStore('s1').getSnapshot().replayReady).toBe(true),
    )

    // Seed a window with hasOlder=true so loadOlder actually attempts a fetch.
    act(() => {
      seedPage('s1', [{ seq: 0, msg: { type: 'user', uuid: 'u0' } }], { hasMore: true })
    })
    expect(getSessionStore('s1').getSnapshot().hasOlder).toBe(true)

    // Make the next head-page fetch reject (use mockImplementationOnce for an
    // explicit, ordered rejection that survives across the await boundary).
    mockApiGet.mockImplementationOnce(async () => {
      throw new Error('network down')
    })
    await act(async () => {
      const n = await result.current.loadOlder()
      expect(n).toBe(0)
    })
    await waitFor(() =>
      expect(result.current.olderError).toBe("Couldn't load earlier messages"),
    )
    expect(result.current.loadingOlder).toBe(false)

    // A session-cleared frame resets the paging pill (olderError → null).
    act(() => {
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
    })
    await waitFor(() => expect(result.current.olderError).toBeNull())
  })
})
