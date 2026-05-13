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

  // ── Idle-trigger gate ─────────────────────────────────────────

  it('does NOT fetch when the session has no completed turn yet', () => {
    const { result } = renderHook(() => useSessionRecap('s1', undefined))
    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.message).toBeNull()
  })

  it('does NOT fetch when the session is still under 5 minutes idle', () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Last turn 1 minute ago — far from idle.
    const { result } = renderHook(() => useSessionRecap('s1', now - 60_000))

    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.message).toBeNull()
  })

  it('fetches immediately on mount when already idle ≥ 5 minutes', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 10 * 60_000 // 10 minutes ago
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    // Loading state appears synchronously.
    expect(result.current.message?.state).toBe('loading')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/recap',
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result.current.message?.state).toBe('ready')
    expect(result.current.message?.recap?.summary).toBe('Test recap')
  })

  it('schedules a timer and fires once the 5-minute idle threshold is reached', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Last turn 2 minutes ago — 3 more minutes to wait.
    const lastTurn = now - 2 * 60_000
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.message).toBeNull()

    // Advance to just before the threshold — still nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000 - 1)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // Cross the threshold.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(result.current.message?.state).toBe('ready')
  })

  it('resets the timer when a newer lastTurnAt arrives (e.g. user sent a message)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Initial mount: 4 min idle, would fire in 1 min.
    const lastTurn1 = now - 4 * 60_000
    const { rerender } = renderHook(
      ({ ts }: { ts: number }) => useSessionRecap('s1', ts),
      { initialProps: { ts: lastTurn1 } },
    )

    // Advance 30 seconds — about to fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // User sends a new message → lastTurnAt jumps to now.
    vi.setSystemTime(now + 30_000)
    rerender({ ts: now + 30_000 })

    // Advance another minute. The OLD timer would have fired by now,
    // but it should have been cancelled by the rerender.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // Now wait the full 5 minutes from the new turn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-fire for a turn already viewed in localStorage', () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 10 * 60_000
    setLastViewed('s1', lastTurn)

    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))
    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.message).toBeNull()
  })

  it('does fire for a newer turn even if an older turn was already viewed', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Old turn was viewed.
    setLastViewed('s1', now - 30 * 60_000)

    // But there's a more recent turn that's also past the idle threshold.
    const lastTurn = now - 10 * 60_000
    renderHook(() => useSessionRecap('s1', lastTurn))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  // ── Error handling ────────────────────────────────────────────

  it('exposes an error message when the recap fetch fails', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    mockPost.mockRejectedValueOnce(new Error('network error'))

    const { result } = renderHook(() => useSessionRecap('s1', now - 10 * 60_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.message?.state).toBe('error')
    expect(result.current.message?.error).toBe('network error')
  })

  // ── localStorage bookkeeping ──────────────────────────────────

  it('records the lastTurnAt as viewed after a successful fetch', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const lastTurn = now - 10 * 60_000

    renderHook(() => useSessionRecap('s1', lastTurn))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = JSON.parse(raw!)
    // We persist the *turn* timestamp, not the wall-clock time of the fetch.
    // That way, a fresh turn that arrives at exactly the same wall-clock
    // moment still counts as a different "view" target.
    expect(map.s1).toBe(lastTurn)
  })

  it('does NOT record the turn as viewed when the fetch fails', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    mockPost.mockRejectedValueOnce(new Error('network error'))

    const lastTurn = now - 10 * 60_000
    renderHook(() => useSessionRecap('s1', lastTurn))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = raw ? JSON.parse(raw) : {}
    expect(map.s1).toBeUndefined()
  })

  // ── refresh ──────────────────────────────────────────────────

  it('refresh fetches a new recap on demand', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 60_000 // 1 min idle — would not auto-fire
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    expect(mockPost).not.toHaveBeenCalled()

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
    expect(result.current.message?.recap?.summary).toBe('Refreshed recap')
  })

  it('refresh is a no-op when the session has no completed turn', async () => {
    const { result } = renderHook(() => useSessionRecap('s1', undefined))

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('refresh aborts a previous in-flight request', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Use a not-yet-idle session so no auto-fetch fires.
    const lastTurn = now - 60_000 // 1 min idle
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    // First refresh: hangs forever.
    mockPost.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      result.current.refresh()
    })
    expect(result.current.message?.state).toBe('loading')

    // Trigger another refresh — should abort the first.
    mockPost.mockResolvedValueOnce(makeRecapResponse('Second refresh'))
    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.message?.recap?.summary).toBe('Second refresh')
    expect(result.current.message?.state).toBe('ready')
  })

  // ── 7-day prune ──────────────────────────────────────────────

  it('prunes entries older than 7 days when writing', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const old = now - 8 * 24 * 60 * 60 * 1000 // 8 days ago
    const recent = now - 1 * 24 * 60 * 60 * 1000 // 1 day ago
    localStorage.setItem(
      LAST_VIEWED_KEY,
      JSON.stringify({ old_session: old, recent_session: recent }),
    )

    const lastTurn = now - 10 * 60_000
    renderHook(() => useSessionRecap('s1', lastTurn))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const raw = localStorage.getItem(LAST_VIEWED_KEY)
    const map = JSON.parse(raw!)

    expect(map.old_session).toBeUndefined()
    expect(map.recent_session).toBe(recent)
    expect(map.s1).toBe(lastTurn)
  })
})
