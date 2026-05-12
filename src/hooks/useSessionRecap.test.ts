import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RecapResponse } from '../types'

// ── Mock useApi ─────────────────────────────────────────────────────

const mockPost = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}))

// Import AFTER mock.
import { useSessionRecap } from './useSessionRecap'

// ── Constants ──────────────────────────────────────────────────────

const LAST_VIEWED_KEY = 'claude-react-web:last-viewed'

// ── Helpers ────────────────────────────────────────────────────────

function setLastViewed(id: string, ts: number) {
  const raw = localStorage.getItem(LAST_VIEWED_KEY)
  const map = raw ? JSON.parse(raw) : {}
  map[id] = ts
  localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map))
}

function makeRecapResponse(summary = 'Test recap'): RecapResponse {
  return {
    summary,
    stats: {
      messageCount: 10,
      userTurns: 5,
      assistantTurns: 5,
      totalCostUsd: 0.05,
      durationMs: 12000,
      toolsUsed: ['Read', 'Write'],
    },
    cached: false,
    generatedAt: Date.now(),
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('useSessionRecap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.useFakeTimers()
    mockPost.mockResolvedValue(makeRecapResponse())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── Staleness gate ────────────────────────────────────────────

  it('does NOT fetch when session was viewed recently (< 5 min ago)', () => {
    const now = Date.now()
    vi.setSystemTime(now)
    setLastViewed('s1', now - 60_000) // 1 minute ago

    const { result } = renderHook(() => useSessionRecap('s1', true))

    // Should not have called the API.
    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.visible).toBe(false)
    expect(result.current.recap).toBeNull()
  })

  it('does NOT fetch on first-ever view (never viewed)', () => {
    const { result } = renderHook(() => useSessionRecap('s1', true))

    // First visit — just records the timestamp, no fetch.
    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.visible).toBe(false)
  })

  it('fetches recap when session is stale (> 5 min since last view)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    setLastViewed('s1', now - 10 * 60_000) // 10 minutes ago

    const { result } = renderHook(() => useSessionRecap('s1', true))

    expect(result.current.visible).toBe(true)
    expect(result.current.loading).toBe(true)

    await act(async () => {
      // Flush the promise.
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/recap',
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result.current.recap).not.toBeNull()
    expect(result.current.recap!.summary).toBe('Test recap')
    expect(result.current.loading).toBe(false)
  })

  // ── Error handling ────────────────────────────────────────────

  it('shows error when recap fetch fails', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    setLastViewed('s1', now - 10 * 60_000)

    mockPost.mockRejectedValueOnce(new Error('network error'))

    const { result } = renderHook(() => useSessionRecap('s1', true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.error).toBe('network error')
    expect(result.current.loading).toBe(false)
    expect(result.current.visible).toBe(true) // Banner stays visible with error
    expect(result.current.recap).toBeNull()
  })

  // ── Timestamp update behavior ─────────────────────────────────

  it('updates last-viewed timestamp on successful fetch', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    setLastViewed('s1', now - 10 * 60_000)

    mockPost.mockResolvedValueOnce(makeRecapResponse())

    renderHook(() => useSessionRecap('s1', true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // After successful fetch, timestamp should be updated to `now`.
    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = JSON.parse(raw!)
    expect(map.s1).toBe(now)
  })

  it('does NOT update timestamp on failed fetch (enables retry)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const staleTs = now - 10 * 60_000
    setLastViewed('s1', staleTs)

    // Make the fetch hang so we can control the abort timing.
    let rejectFetch!: (err: Error) => void
    mockPost.mockReturnValueOnce(new Promise((_r, rej) => { rejectFetch = rej }))

    // Use focused: false so the focus effect does NOT call writeLastViewed.
    // With focused: true, the focus effect would overwrite the timestamp
    // regardless of fetch outcome.
    const { unmount } = renderHook(() => useSessionRecap('s1', false))

    // Let the effect run and start the fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Unmount triggers the cleanup which aborts the controller.
    unmount()

    // Now reject — the catch block will see signal.aborted === true
    // and skip the writeLastViewed call.
    rejectFetch(new DOMException('aborted', 'AbortError'))

    // Let the rejection propagate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Timestamp should still be the old value, not `now`.
    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = JSON.parse(raw!)
    expect(map.s1).toBe(staleTs)
  })

  // ── dismiss ──────────────────────────────────────────────────

  it('dismiss hides the banner', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    setLastViewed('s1', now - 10 * 60_000)

    const { result } = renderHook(() => useSessionRecap('s1', true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.visible).toBe(true)

    act(() => {
      result.current.dismiss()
    })
    expect(result.current.visible).toBe(false)
  })

  // ── refresh ──────────────────────────────────────────────────

  it('refresh fetches a new recap regardless of staleness', async () => {
    // First visit — no fetch.
    const { result } = renderHook(() => useSessionRecap('s1', true))
    expect(mockPost).not.toHaveBeenCalled()

    // Manual refresh should fetch.
    mockPost.mockResolvedValueOnce(makeRecapResponse('Refreshed recap'))

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/recap',
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result.current.recap!.summary).toBe('Refreshed recap')
    expect(result.current.visible).toBe(true)
  })

  it('refresh aborts previous in-flight request', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    setLastViewed('s1', now - 10 * 60_000)

    // Make the first request hang.
    mockPost.mockReturnValueOnce(new Promise(() => {}))

    const { result } = renderHook(() => useSessionRecap('s1', true))

    // Trigger the stale fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.loading).toBe(true)

    // Now trigger a refresh — should abort the first.
    mockPost.mockResolvedValueOnce(makeRecapResponse('Second'))

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.recap!.summary).toBe('Second')
    expect(result.current.loading).toBe(false)
  })

  // ── 7-day prune ──────────────────────────────────────────────

  it('prunes entries older than 7 days when writing', () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Seed localStorage with old and recent entries.
    const old = now - 8 * 24 * 60 * 60 * 1000 // 8 days ago
    const recent = now - 1 * 24 * 60 * 60 * 1000 // 1 day ago
    localStorage.setItem(
      LAST_VIEWED_KEY,
      JSON.stringify({ old_session: old, recent_session: recent }),
    )

    // Trigger a write by focusing a session.
    renderHook(() => useSessionRecap('s1', true))

    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = JSON.parse(raw!)

    // old_session should be pruned (8 days > 7 day cutoff).
    expect(map.old_session).toBeUndefined()
    // recent_session should survive.
    expect(map.recent_session).toBe(recent)
    // s1 should be recorded.
    expect(map.s1).toBe(now)
  })

  // ── Focus updates timestamp ──────────────────────────────────

  it('updates last-viewed when focus changes to true', () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const { rerender } = renderHook(
      ({ focused }) => useSessionRecap('s1', focused),
      { initialProps: { focused: false } },
    )

    // Switch to focused.
    vi.setSystemTime(now + 1000)
    rerender({ focused: true })

    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = JSON.parse(raw!)
    expect(map.s1).toBe(now + 1000)
  })
})
