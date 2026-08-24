import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { AccountInfoData, SessionUsageData } from '../types'

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

// refresh() fires TWO GETs (usage + account). Route the shared mock by URL
// so queued mockResolvedValueOnce ordering never leaks across endpoints.
function routeMock(handlers: {
  usage?: SessionUsageData | Promise<never>
  account?: AccountInfoData | null | Promise<never>
}) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/account')) {
      if (handlers.account instanceof Promise) return handlers.account
      return Promise.resolve({ account: handlers.account ?? null })
    }
    if (handlers.usage instanceof Promise) return handlers.usage
    return Promise.resolve({ usage: handlers.usage ?? null })
  })
}

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
    expect(result.current.account).toBeNull()
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
    routeMock({ usage })

    const { result } = renderHook(() => useSessionUsage('s1'))
    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.data).toEqual(usage)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/usage', expect.anything())
  })

  it('refresh() also exposes account info from the same refresh', async () => {
    const account: AccountInfoData = {
      email: 'user@example.com',
      subscriptionType: 'pro',
      apiProvider: 'firstParty',
    }
    routeMock({ usage: { session: { total_cost_usd: 0 } }, account })

    const { result } = renderHook(() => useSessionUsage('s1'))
    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.account).toEqual(account)
    })
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/account', expect.anything())
  })

  it('an account fetch failure never fails the usage display', async () => {
    routeMock({ usage: { session: { total_cost_usd: 1 } }, account: Promise.reject(new Error('acct down')) })

    const { result } = renderHook(() => useSessionUsage('s1'))
    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.data).toEqual({ session: { total_cost_usd: 1 } })
    })
    expect(result.current.error).toBeNull()
    expect(result.current.account).toBeNull()
  })

  it('records the error message when the usage fetch fails', async () => {
    routeMock({ usage: Promise.reject(new Error('boom')) })

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
    routeMock({ usage: { session: { total_cost_usd: 1 } } })

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useSessionUsage(id),
      { initialProps: { id: 's1' } },
    )
    act(() => result.current.refresh())
    await waitFor(() => {
      expect(result.current.data).toEqual({ session: { total_cost_usd: 1 } })
    })

    rerender({ id: 's2' })
    expect(result.current.data).toBeNull()
    expect(result.current.account).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
