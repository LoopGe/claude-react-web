import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDelayedFlag } from './useDelayedFlag'

afterEach(() => {
  vi.useRealTimers()
})

describe('useDelayedFlag', () => {
  it('stays false through the delay and goes true once it elapses', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 500), {
      initialProps: { active: false },
    })
    expect(result.current).toBe(false)

    rerender({ active: true })
    // This is the whole point of the delay: an in-flight op that resolves
    // quickly (the common case) must never render the indicator at all.
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(499))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })

  it('clears immediately when the flag drops, without waiting out the delay', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 500), {
      initialProps: { active: false },
    })
    rerender({ active: true })
    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBe(true)

    rerender({ active: false })
    expect(result.current).toBe(false)
  })

  it('cancels the pending delay when the flag clears before it elapses', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 500), {
      initialProps: { active: false },
    })
    rerender({ active: true })
    act(() => vi.advanceTimersByTime(200))
    rerender({ active: false })

    // Long past the original deadline the stale timer must not flip it true.
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(false)
  })

  it('waits out the delay again on a SECOND activation', () => {
    // The reason this hook is not `active && useDebouncedValue(active, …)`:
    // a debounce's stored value lags the falling edge by the delay, so on a
    // re-activation inside that window it is still true and the indicator
    // shows instantly — every switch after the first would flash, which is
    // exactly what the delay exists to prevent.
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 500), {
      initialProps: { active: false },
    })
    rerender({ active: true })
    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBe(true)
    rerender({ active: false })
    expect(result.current).toBe(false)

    // Re-activate immediately (well inside the previous delay window).
    rerender({ active: true })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(499))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })
})