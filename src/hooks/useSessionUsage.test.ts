import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionUsageData } from '../types'

// ── Mock useApi ─────────────────────────────────────────────────────

const mockGet = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
  },
}))

// Import AFTER mock.
import { useSessionUsage } from './useSessionUsage'

// ── Tests ──────────────────────────────────────────────────────────

describe('useSessionUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts idle with no data and does not fetch until refresh()', () => {
    const { result } = renderHook(() => useSessionUsage('s1'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('refresh() fetches and exposes the wrapped usage payload', async () => {
    const usage: SessionUsageData = {
      session: { total_cost_usd: 0.0123 },
      subscription_type: 'pro',
      rate_limits_available: true,
    }
    mockGet.mockResolvedValueOnce({ usage })

    const { result } = renderHook(() => useSessionUsage('s1'))
    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.data).toEqual(usage)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/usage', expect.anything())
  })

  it('records the error message when the fetch fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useSessionUsage('s1'))
    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.error).toBe('boom')
    })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('is a no-op without a session id', () => {
    const { result } = renderHook(() => useSessionUsage(undefined))
    act(() => result.current.refresh())
    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it('clears data when the session id changes', async () => {
    const usage: SessionUsageData = { session: { total_cost_usd: 1 } }
    mockGet.mockResolvedValueOnce({ usage })

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useSessionUsage(id),
      { initialProps: { id: 's1' } },
    )
    act(() => result.current.refresh())
    await waitFor(() => {
      expect(result.current.data).toEqual(usage)
    })

    rerender({ id: 's2' })
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
