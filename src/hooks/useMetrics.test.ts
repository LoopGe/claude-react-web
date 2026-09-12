import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMetrics } from './useMetrics'
import type { MetricsSnapshot } from '../../shared/metrics.js'

vi.mock('./useApi', () => ({
  api: { get: vi.fn() },
}))

import { api } from './useApi'
const getMock = api.get as ReturnType<typeof vi.fn>

const snap: MetricsSnapshot = { uptimeSec: 1, gauges: {}, counters: {}, histograms: {} }

describe('useMetrics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getMock.mockResolvedValue(snap)
  })
  afterEach(() => vi.useRealTimers())

  it('fetches on mount', async () => {
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    expect(getMock).toHaveBeenCalledWith('/metrics', expect.anything())
    expect(result.current.data).toEqual(snap)
    expect(result.current.error).toBeNull()
  })

  it('does not poll until auto is enabled', async () => {
    renderHook(() => useMetrics())
    await act(async () => {})
    const calls = getMock.mock.calls.length
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(getMock.mock.calls.length).toBe(calls)
  })

  it('polls every 5s while auto is on, stops when off', async () => {
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    act(() => { result.current.setAuto(true) })
    const calls = getMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(getMock.mock.calls.length).toBe(calls + 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(getMock.mock.calls.length).toBe(calls + 2)
    act(() => { result.current.setAuto(false) })
    const paused = getMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getMock.mock.calls.length).toBe(paused)
  })

  it('surfaces fetch errors', async () => {
    getMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    expect(result.current.error).toBe('boom')
  })

  it('accumulates a snapshot history ring, capped at 60', async () => {
    getMock.mockResolvedValue(snap)
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    expect(result.current.history).toHaveLength(1)
    await act(async () => { await result.current.refresh() })
    await act(async () => { await result.current.refresh() })
    expect(result.current.history).toHaveLength(3)
    // Cap: fire 70 more refreshes.
    for (let i = 0; i < 70; i++) {
      await act(async () => { await result.current.refresh() })
    }
    expect(result.current.history).toHaveLength(60)
    // The oldest sample is evicted — history[-1] is always the newest.
    expect(result.current.history[result.current.history.length - 1]).toEqual(snap)
  })

  it('failed fetches do not append to history', async () => {
    getMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    expect(result.current.history).toHaveLength(0)
  })

  it('a superseded (aborted) refresh does not clobber the newer call', async () => {
    // Deferred promises so we control resolution order.
    const stale = { reject: (undefined as unknown as (e: Error) => void) }
    const stalePromise = new Promise<never>((_, rej) => { stale.reject = rej })
    getMock.mockImplementationOnce(() => stalePromise) // mount fetch — will be aborted
    const { result } = renderHook(() => useMetrics())
    await act(async () => {}) // let mount effect run
    // Manual refresh #2: aborts the mount fetch, issues its own (resolving) call.
    getMock.mockResolvedValueOnce(snap)
    await act(async () => { await result.current.refresh() })
    // Now the aborted stale fetch rejects with an AbortError — its catch/finally
    // must be skipped so the panel keeps the fresh data and no bogus error.
    const abortErr = new Error('Request cancelled')
    abortErr.name = 'AbortError'
    await act(async () => { stale.reject(abortErr) })
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual(snap)
  })
})
