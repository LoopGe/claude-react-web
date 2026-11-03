// Tests for the guarded useGitQuery core — the shared HTTP lifecycle + external
// snapshot state machine that the nine git read-only adapters will migrate to.
//
// Runs in happy-dom (per `environmentMatchGlobs`: `src/**` → happy-dom after
// the node overrides) so `renderHook` / `act` are available.
//
// Focus areas (per the task brief):
//   - accepted/rejected external updates
//   - token invalidation before abort (stale HTTP can't overwrite a snapshot)
//   - no abort inside setState updaters (abort is in a dedicated effect)
//   - disabled loading reset (loading must not linger when disabled mid-flight)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState, useEffect, createElement } from 'react'
import { render, renderHook, act, waitFor } from '@testing-library/react'
import { useGitQuery } from './useGitQuery'

// ── Controllable load function ──────────────────────────────────────
// Each call captures its AbortSignal and gives the test a resolve/reject
// handle, so we can simulate ordered, out-of-order, and aborted responses
// without reaching into the implementation. The `fn` identity is stable
// across renders (it's the same vi.fn), matching the adapter contract that
// `load` is wrapped in `useCallback` keyed on the same scalars as queryKey.

type LoadCall<T> = {
  signal: AbortSignal
  resolve: (v: T) => void
  reject: (e: Error) => void
}

function trackLoad<T>() {
  const calls: LoadCall<T>[] = []
  const fn = vi.fn((signal: AbortSignal): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      calls.push({ signal, resolve, reject })
    })
  })
  return {
    fn,
    calls,
    count: () => fn.mock.calls.length,
    resolveLast: (v: T) => calls[calls.length - 1]?.resolve(v),
    resolveAt: (idx: number, v: T) => calls[idx]?.resolve(v),
    rejectLast: (e: Error) => calls[calls.length - 1]?.reject(e),
    rejectAt: (idx: number, e: Error) => calls[idx]?.reject(e),
    lastSignal: () => calls[calls.length - 1]?.signal,
    signalAt: (idx: number) => calls[idx]?.signal,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

// ── 1. disabled / missing input ─────────────────────────────────────

describe('useGitQuery — disabled', () => {
  it('returns {data:null,error:null,loading:false} and does not fetch', () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: false, queryKey: 'k', load: load.fn }),
    )
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(load.count()).toBe(0)
  })

  it('switching to disabled mid-flight aborts the request, clears loading, and ignores the late response', async () => {
    const load = trackLoad<string>()
    const { result, rerender } = renderHook(
      ({ e }) => useGitQuery({ enabled: e, queryKey: 'k', load: load.fn }),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(load.count()).toBe(1)
    const signal = load.lastSignal()!

    rerender({ e: false })
    // The disabled reset: data null, loading false, error null.
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    // The in-flight HTTP was aborted.
    expect(signal.aborted).toBe(true)

    // Late response is a no-op.
    await act(async () => {
      load.resolveLast('late')
      await Promise.resolve()
    })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })
})

// ── 2. first success / failure ──────────────────────────────────────

describe('useGitQuery — success and failure', () => {
  it('resolves to data and clears loading; error stays null', async () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    expect(result.current.loading).toBe(true)
    await act(async () => {
      load.resolveLast('hello')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('hello')
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('reject sets error message, clears data and loading', async () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    await act(async () => {
      load.rejectLast(new Error('boom'))
      await Promise.resolve()
    })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe('boom')
  })
})

// ── 3. key A→B retains old data; late A must not overwrite B ─────────

describe('useGitQuery — key switch', () => {
  it('A→B retains A data while B loads, then B commits', async () => {
    const load = trackLoad<string>()
    const { result, rerender } = renderHook(
      ({ k }) => useGitQuery({ enabled: true, queryKey: k, load: load.fn }),
      { initialProps: { k: 'A' } },
    )
    await act(async () => {
      load.resolveLast('A-data')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('A-data')

    rerender({ k: 'B' })
    expect(result.current.data).toBe('A-data') // retained
    expect(result.current.loading).toBe(true)
    expect(load.count()).toBe(2)

    await act(async () => {
      load.resolveLast('B-data')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('B-data')
  })

  it('A still pending when B starts: A resolves late and is discarded', async () => {
    const load = trackLoad<string>()
    const { result, rerender } = renderHook(
      ({ k }) => useGitQuery({ enabled: true, queryKey: k, load: load.fn }),
      { initialProps: { k: 'A' } },
    )
    // Don't resolve A; switch to B immediately.
    rerender({ k: 'B' })
    expect(result.current.data).toBeNull() // never had data
    expect(result.current.loading).toBe(true)
    expect(load.count()).toBe(2)

    // A resolves late → no-op.
    await act(async () => {
      load.resolveAt(0, 'A-late')
      await Promise.resolve()
    })
    expect(result.current.data).toBeNull()

    // B resolves → commits.
    await act(async () => {
      load.resolveLast('B-data')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('B-data')
  })
})

// ── 4. refresh: only current token commits; old data retained ───────

describe('useGitQuery — refresh', () => {
  it('retains old data while the new request loads; new commits', async () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    await act(async () => {
      load.resolveLast('first')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('first')

    act(() => result.current.refresh())
    expect(result.current.data).toBe('first') // retained
    expect(result.current.loading).toBe(true)
    expect(load.count()).toBe(2)

    await act(async () => {
      load.resolveLast('second')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('second')
  })

  it('two pending requests: only the current token commits', async () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    // First request pending; refresh before it resolves.
    act(() => result.current.refresh())
    expect(load.count()).toBe(2)

    // Old (first) resolves → no-op.
    await act(async () => {
      load.resolveAt(0, 'old')
      await Promise.resolve()
    })
    expect(result.current.data).toBeNull()

    // Current (second) resolves → commits.
    await act(async () => {
      load.resolveLast('new')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('new')
  })
})

// ── 5. applyExternal accept: adopts snapshot, clears state, aborts HTTP ─

describe('useGitQuery — applyExternal accept', () => {
  it('adopts snapshot, clears loading/error, aborts in-flight HTTP, ignores late response', async () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    await waitFor(() => expect(load.count()).toBe(1))
    expect(result.current.loading).toBe(true)
    const signal = load.lastSignal()!

    act(() => result.current.applyExternal('snap'))
    expect(result.current.data).toBe('snap')
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(signal.aborted).toBe(true)

    // Late HTTP response is a no-op.
    await act(async () => {
      load.resolveLast('http-late')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('snap')
  })
})

// ── 6. applyExternal equal=true: retain reference but invalidate HTTP ─

describe('useGitQuery — applyExternal equal', () => {
  it('equal=true retains old data reference, gains new token, aborts old HTTP', async () => {
    const load = trackLoad<{ v: string }>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    // Resolve first HTTP so we have a data reference to retain.
    await act(async () => {
      load.resolveLast({ v: 'R1' })
      await Promise.resolve()
    })
    const r1 = result.current.data
    expect(r1).toEqual({ v: 'R1' })

    // Start a new HTTP (refresh) so there's an in-flight request to abort.
    act(() => result.current.refresh())
    expect(load.count()).toBe(2)
    const refreshSignal = load.lastSignal()!

    // applyExternal with equal=true → keep r1 reference, but new external token.
    act(() => result.current.applyExternal({ v: 'R2' }, { equal: () => true }))
    expect(result.current.data).toBe(r1) // same reference
    expect(result.current.loading).toBe(false)
    expect(refreshSignal.aborted).toBe(true)

    // The aborted refresh HTTP resolves → no-op; r1 reference survives.
    await act(async () => {
      load.resolveLast({ v: 'http' })
      await Promise.resolve()
    })
    expect(result.current.data).toBe(r1)
  })
})

// ── 7. applyExternal reject: everything unchanged, HTTP continues ────

describe('useGitQuery — applyExternal reject', () => {
  it('accept=false leaves data/loading/error/token unchanged; HTTP not aborted and completes', async () => {
    const load = trackLoad<string>()
    const { result } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    await waitFor(() => expect(load.count()).toBe(1))
    expect(result.current.loading).toBe(true)
    const signal = load.lastSignal()!

    act(() => result.current.applyExternal('snap', { accept: () => false }))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()
    expect(signal.aborted).toBe(false)

    // HTTP completes normally after a rejected external update.
    await act(async () => {
      load.resolveLast('http-data')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('http-data')
    expect(result.current.loading).toBe(false)
  })
})

// ── 8. external / HTTP interleaving: stale response can't overwrite ──

describe('useGitQuery — external and HTTP interleaving', () => {
  it('old HTTP resolving after applyExternal cannot overwrite the snapshot', async () => {
    const load = trackLoad<string>()
    const { result, rerender } = renderHook(
      ({ k }) => useGitQuery({ enabled: true, queryKey: k, load: load.fn }),
      { initialProps: { k: 'A' } },
    )
    // A's HTTP is in flight (not resolved).
    await waitFor(() => expect(load.count()).toBe(1))

    // An external snapshot arrives and is accepted → token becomes external.
    act(() => result.current.applyExternal('snap'))
    expect(result.current.data).toBe('snap')

    // A's HTTP resolves AFTER the external token was set → must be a no-op.
    // The token check (prev.token !== http-token) prevents commit even if the
    // abort effect hasn't flushed yet.
    await act(async () => {
      load.resolveAt(0, 'A-http')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('snap')

    // A subsequent key change starts a new HTTP that resolves normally.
    rerender({ k: 'B' })
    await act(async () => {
      load.resolveLast('B-data')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('B-data')
  })
})

// ── 9. equalOnLoad only affects HTTP success path ────────────────────

describe('useGitQuery — equalOnLoad', () => {
  it('equal=true retains old reference; equal=false adopts new', async () => {
    const load = trackLoad<{ v: string }>()
    let equalCalled = false
    const { result } = renderHook(() =>
      useGitQuery({
        enabled: true,
        queryKey: 'k',
        load: load.fn,
        equalOnLoad: (prev, next) => {
          equalCalled = true
          return JSON.stringify(prev) === JSON.stringify(next)
        },
      }),
    )
    // First load: prev is null → equal returns false → adopt.
    await act(async () => {
      load.resolveLast({ v: 'X' })
      await Promise.resolve()
    })
    expect(equalCalled).toBe(true)
    const x = result.current.data
    expect(x).toEqual({ v: 'X' })

    // Refresh with equal data → retain reference.
    act(() => result.current.refresh())
    await act(async () => {
      load.resolveLast({ v: 'X' })
      await Promise.resolve()
    })
    expect(result.current.data).toBe(x) // same reference

    // Refresh with different data → adopt new.
    act(() => result.current.refresh())
    await act(async () => {
      load.resolveLast({ v: 'Y' })
      await Promise.resolve()
    })
    expect(result.current.data).toEqual({ v: 'Y' })
    expect(result.current.data).not.toBe(x)
  })
})

// ── 10. request dedup: same key+load no repeat; key/refresh do ───────

describe('useGitQuery — request dedup', () => {
  it('same queryKey/load does not re-request; key change or refresh does', async () => {
    const load = trackLoad<string>()
    const stableLoad = load.fn
    const { result, rerender } = renderHook(
      ({ k }) => useGitQuery({ enabled: true, queryKey: k, load: stableLoad }),
      { initialProps: { k: 'A' } },
    )
    await waitFor(() => expect(load.count()).toBe(1))

    // Re-render with the same key → no new request.
    rerender({ k: 'A' })
    expect(load.count()).toBe(1)

    // New key → new request.
    rerender({ k: 'B' })
    expect(load.count()).toBe(2)

    // Resolve B so we can refresh.
    await act(async () => {
      load.resolveLast('B')
      await Promise.resolve()
    })

    // Refresh → new request.
    act(() => result.current.refresh())
    expect(load.count()).toBe(3)
  })
})

// ── 11. unmount aborts; late response is silent ─────────────────────

describe('useGitQuery — unmount', () => {
  it('aborts in-flight request on unmount; late response produces no warning', async () => {
    const load = trackLoad<string>()
    const { result, unmount } = renderHook(() =>
      useGitQuery({ enabled: true, queryKey: 'k', load: load.fn }),
    )
    await waitFor(() => expect(load.count()).toBe(1))
    const signal = load.lastSignal()!
    expect(result.current.loading).toBe(true)

    unmount()
    expect(signal.aborted).toBe(true)

    // Resolving after unmount must not throw or produce an act warning.
    await act(async () => {
      load.resolveLast('late')
      await Promise.resolve()
    })
  })
})

// ── 12. disabled → enabled transition (regression) ───────────────────
//
// The external-token abort effect must NOT fire when transitioning from
// disabled (tokenKind='external') to enabled. On the pre-fix core, the
// abort effect saw the stale 'external' tokenKind in the same batched
// render as the HTTP effect's enabled path and aborted the freshly
// created controller. The fix (needsAbortRef) ensures the abort effect
// only fires for applyExternal, not for the disabled path.

describe('useGitQuery — disabled→enabled transition (regression)', () => {
  // Captures the latest hook state from the Harness component. Updated on
  // every render so the test can assert after async resolution.
  let harnessState: { data: string | null; loading: boolean; error: string | null } = {
    data: null, loading: false, error: null,
  }

  /** Renders useGitQuery starting disabled, then flips enabled=true in a
   *  mount effect. This batches the disabled path's setState({tokenKind:
   *  'external'}) with the enabled prop change in the same React update
   *  cycle — reproducing the CommitFileRow scenario where fetchStarted
   *  flips before the disabled path's state is fully processed. */
  function Harness({ load }: { load: (signal: AbortSignal) => Promise<string> }) {
    const [enabled, setEnabled] = useState(false)
    const q = useGitQuery<string>({ enabled, queryKey: 'k', load })
    harnessState = { data: q.data, loading: q.loading, error: q.error }
    useEffect(() => {
      setEnabled(true)
    }, [])
    return null
  }

  beforeEach(() => {
    harnessState = { data: null, loading: false, error: null }
  })

  it('batched disabled→enabled: new controller is not aborted and fetch resolves', async () => {
    const load = trackLoad<string>()
    render(createElement(Harness, { load: load.fn }))

    // The Harness's mount effect flips enabled to true, batching with the
    // disabled path's setState in the same React update. On the pre-fix
    // core, the abort effect saw the stale 'external' tokenKind and
    // aborted the new controller — the fetch response was then discarded.
    await waitFor(() => expect(load.count()).toBe(1))

    // The new controller must NOT be aborted.
    expect(load.lastSignal()!.aborted).toBe(false)

    // The fetch resolves and commits.
    await act(async () => {
      load.resolveLast('data')
      await Promise.resolve()
    })
    expect(harnessState.data).toBe('data')
    expect(harnessState.loading).toBe(false)
  })

  it('rerender-based disabled→enabled→disabled→enabled: each enable starts a fresh, unaborted request', async () => {
    // Uses rerender (act flushes between calls, so no batching). Still
    // guards against regressions where the abort effect might fire for
    // the disabled path's external token on any enable transition.
    const load = trackLoad<string>()
    const { result, rerender } = renderHook(
      ({ e }) => useGitQuery<string>({ enabled: e, queryKey: 'k', load: load.fn }),
      { initialProps: { e: false } },
    )
    expect(result.current.data).toBeNull()
    expect(load.count()).toBe(0)

    // First enable.
    rerender({ e: true })
    await waitFor(() => expect(load.count()).toBe(1))
    expect(load.lastSignal()!.aborted).toBe(false)
    await act(async () => {
      load.resolveLast('first')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('first')

    // Disable — data cleared, loading false.
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)

    // Re-enable — fresh request, NOT aborted.
    rerender({ e: true })
    await waitFor(() => expect(load.count()).toBe(2))
    expect(load.lastSignal()!.aborted).toBe(false)
    await act(async () => {
      load.resolveLast('second')
      await Promise.resolve()
    })
    expect(result.current.data).toBe('second')
  })
})
