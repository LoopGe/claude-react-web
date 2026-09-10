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
})
