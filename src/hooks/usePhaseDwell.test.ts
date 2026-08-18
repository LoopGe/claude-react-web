import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePhaseDwell } from './usePhaseDwell'
import type { ActivePhase } from '../session-store/types'

describe('usePhaseDwell', () => {
  it('commits the first phase immediately', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
      { initialProps: { p: null as ActivePhase } },
    )
    expect(result.current).toBeNull()
    rerender({ p: 'thinking' })
    expect(result.current).toBe('thinking')
  })

  it('clears immediately when the turn ends', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
      { initialProps: { p: 'thinking' as ActivePhase } },
    )
    rerender({ p: null })
    expect(result.current).toBeNull()
  })

  it('holds the previous phase until the new one is stable for 300ms', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
        { initialProps: { p: null as ActivePhase } },
      )
      rerender({ p: 'thinking' })
      expect(result.current).toBe('thinking')
      rerender({ p: 'writing' })
      expect(result.current).toBe('thinking')
      act(() => { vi.advanceTimersByTime(299) })
      expect(result.current).toBe('thinking')
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current).toBe('writing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays on A when a transient B is reverted to A inside the dwell window', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
        { initialProps: { p: null as ActivePhase } },
      )
      rerender({ p: 'thinking' })
      rerender({ p: 'writing' })
      rerender({ p: 'thinking' })
      act(() => { vi.advanceTimersByTime(500) })
      expect(result.current).toBe('thinking')
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits C after its own dwell when B and C arrive inside the same window', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
        { initialProps: { p: null as ActivePhase } },
      )
      rerender({ p: 'thinking' })
      rerender({ p: 'writing' })
      rerender({ p: { type: 'tool_use', name: 'Bash' } })
      act(() => { vi.advanceTimersByTime(300) })
      expect(result.current).toEqual({ type: 'tool_use', name: 'Bash' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-commit when the same phase re-arrives as a new object (tool_use identity churn)', () => {
    const first = { type: 'tool_use' as const, name: 'Bash' }
    const { result, rerender } = renderHook(
      ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
      { initialProps: { p: first } },
    )
    expect(result.current).toBe(first)
    rerender({ p: { type: 'tool_use', name: 'Bash' } })
    // Same key -> no re-commit -> the display keeps the original stable ref so
    // a memoized WorkingBubble doesn't re-render on per-block churn.
    expect(result.current).toBe(first)
  })
})
