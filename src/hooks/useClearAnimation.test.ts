import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useClearAnimation } from './useClearAnimation'

describe('useClearAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets fading-in when beginClear is called', () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    expect(result.current.clearingByPanel.size).toBe(0)
    act(() => {
      void result.current.beginClear('X')
    })
    expect(result.current.clearingByPanel.get('X')).toBe('fading-in')
  })

  it('beginClear resolves after fadeInMs', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    let resolved = false
    act(() => {
      void result.current.beginClear('X').then(() => {
        resolved = true
      })
    })
    expect(resolved).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(179)
    })
    expect(resolved).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(resolved).toBe(true)
  })

  it('swapAndEnd moves state from oldId to newId as fading-out, then clears after fadeOutMs', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    expect(result.current.clearingByPanel.get('X')).toBe('fading-in')
    act(() => {
      result.current.swapAndEnd('X', 'Y')
    })
    expect(result.current.clearingByPanel.has('X')).toBe(false)
    expect(result.current.clearingByPanel.get('Y')).toBe('fading-out')
    await act(async () => {
      vi.advanceTimersByTime(180)
    })
    expect(result.current.clearingByPanel.has('Y')).toBe(false)
  })

  it('cancelClear removes state immediately and cancels pending cleanup', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    act(() => {
      result.current.cancelClear('X')
    })
    expect(result.current.clearingByPanel.has('X')).toBe(false)
    // No timer should fire and re-add 'X'.
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.clearingByPanel.has('X')).toBe(false)
  })

  it('a second beginClear on the same panel cancels the prior cleanup timer', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    act(() => {
      result.current.swapAndEnd('X', 'Y')
    })
    // Y is fading-out; before cleanup fires, a fresh clear on Y should restart in.
    act(() => {
      void result.current.beginClear('Y')
    })
    expect(result.current.clearingByPanel.get('Y')).toBe('fading-in')
    // Original cleanup timer would have fired at t=180; advance past it and
    // confirm 'Y' still reads 'fading-in' (not deleted).
    await act(async () => {
      vi.advanceTimersByTime(180)
    })
    expect(result.current.clearingByPanel.get('Y')).toBe('fading-in')
  })

  it('cleans up pending timers on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    act(() => {
      result.current.swapAndEnd('X', 'Y')
    })
    // Unmount before fade-out cleanup fires; advancing timers must not throw
    // (no setState after unmount).
    unmount()
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
  })
})
