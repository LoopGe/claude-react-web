// @vitest-environment jsdom
// jsdom does not implement window.matchMedia, so each test that branches on
// it installs a spy (same pattern as utils/theme.test.ts).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCountUp } from './useCountUp'

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

/** Install a matchMedia mock reporting the given reduced-motion preference. */
function mockReduceMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query === REDUCE_QUERY && reduce,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList)
}

/** Mutable matchMedia mock: returns a function that flips the reported
 *  reduced-motion state AND fires the hook's 'change' listener, simulating a
 *  live OS-preference toggle mid-flight. */
function installMutableMatchMedia(initial: boolean): (next: boolean) => void {
  let matches = initial
  const handlers = new Set<(e: { matches: boolean }) => void>()
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    return {
      matches: query === REDUCE_QUERY && matches,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        h: (e: { matches: boolean }) => void,
      ) => handlers.add(h),
      removeEventListener: (
        _type: string,
        h: (e: { matches: boolean }) => void,
      ) => handlers.delete(h),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList
  })
  return (next: boolean) => {
    matches = next
    handlers.forEach((h) => h({ matches: next }))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useCountUp', () => {
  it('renders the target immediately on first mount (no entrance animation)', () => {
    mockReduceMotion(false)
    const { result } = renderHook(() => useCountUp(42, 300))
    expect(result.current).toBe(42)
  })

  it('snaps straight to a new target under prefers-reduced-motion', () => {
    mockReduceMotion(true)
    const { result, rerender } = renderHook(({ t }) => useCountUp(t, 300), {
      initialProps: { t: 0 },
    })
    expect(result.current).toBe(0)
    rerender({ t: 100 })
    // No frames to run — the new value is the displayed value immediately.
    expect(result.current).toBe(100)
  })

  it('eases toward the target over the duration (arrives at the destination)', () => {
    mockReduceMotion(false)
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ t }) => useCountUp(t, 300), {
      initialProps: { t: 0 },
    })
    expect(result.current).toBe(0)

    rerender({ t: 100 })
    // Immediately after retarget, still at the old value.
    expect(result.current).toBe(0)

    // Partway through the tween it has moved but not arrived.
    act(() => vi.advanceTimersByTime(150))
    expect(result.current).toBeGreaterThan(0)
    expect(result.current).toBeLessThan(100)

    // Long past the duration, it has converged to the (rounded-up) target.
    act(() => vi.advanceTimersByTime(400))
    expect(result.current).toBe(100)
  })

  it('resumes and converges on the target after a reduced→normal swing', () => {
    const setReduced = installMutableMatchMedia(false)
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ t }) => useCountUp(t, 300), {
      initialProps: { t: 0 },
    })

    rerender({ t: 100 })
    act(() => vi.advanceTimersByTime(150))
    const mid = result.current
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(100)

    // Toggle reduced-motion ON: display snaps to the destination.
    act(() => setReduced(true))
    expect(result.current).toBe(100)

    // Toggle it back OFF: the value must not stay stuck at the stale `mid`
    // (regression guard) — it re-arms the tween and converges to 100.
    act(() => setReduced(false))
    act(() => vi.advanceTimersByTime(600))
    expect(result.current).toBe(100)
  })
})