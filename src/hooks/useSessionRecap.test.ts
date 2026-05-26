import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ── Mock useApi ─────────────────────────────────────────────────────

const mockPost = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}))

// Import AFTER mock.
import { useSessionRecap } from './useSessionRecap'

// ── Helpers ────────────────────────────────────────────────────────

// ── Tests ──────────────────────────────────────────────────────────

describe('useSessionRecap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockPost.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── Idle-trigger gate ─────────────────────────────────────────

  it('does NOT fetch when the session has no completed turn yet', () => {
    const { result } = renderHook(() => useSessionRecap('s1', undefined))
    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.loadingMessage).toBeNull()
  })

  it('does NOT fetch when the session is still under 5 minutes idle', () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Last turn 1 minute ago — far from idle.
    const { result } = renderHook(() => useSessionRecap('s1', now - 60_000))

    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.loadingMessage).toBeNull()
  })

  it('fetches immediately on mount when already idle ≥ 5 minutes', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 10 * 60_000 // 10 minutes ago
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    // doFetch is deferred via setTimeout(fn, 0) — advance to trigger it
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/recap',
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    // After fetch completes, loading message clears.
    expect(result.current.loadingMessage).toBeNull()
  })

  it('schedules a timer and fires once the 5-minute idle threshold is reached', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // Last turn 2 minutes ago — 3 more minutes to wait.
    const lastTurn = now - 2 * 60_000
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    expect(mockPost).not.toHaveBeenCalled()
    expect(result.current.loadingMessage).toBeNull()

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

  // ── Error handling ────────────────────────────────────────────

  it('clears loading state when the fetch fails', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    mockPost.mockRejectedValueOnce(new Error('network error'))

    const { result } = renderHook(() => useSessionRecap('s1', now - 10 * 60_000))

    // doFetch is deferred via setTimeout — advance to trigger it.
    // Loading state and fetch settlement happen in the same act() batch,
    // so we verify the fetch was initiated and loading clears after error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith('/sessions/s1/recap', undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    // Loading message should clear after error.
    expect(result.current.loadingMessage).toBeNull()
  })

  // ── refresh ──────────────────────────────────────────────────

  it('refresh fetches a new recap on demand', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 60_000 // 1 min idle — would not auto-fire
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn))

    expect(mockPost).not.toHaveBeenCalled()

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/recap',
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('refresh is a no-op when the session has no completed turn', async () => {
    const { result } = renderHook(() => useSessionRecap('s1', undefined))

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  // ── hasFreshRecap gate ───────────────────────────────────────
  //
  // Regression: switching back to an idle session re-fired the recap
  // fetch on every mount. Server cache returned the same uuid, the
  // broadcast was applied without dedup, and the transcript stacked
  // identical recap cards on every switch. The gate stops the auto-fire
  // when the transcript already covers the current lastTurnAt.

  it('does NOT auto-fetch when hasFreshRecap is true', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 10 * 60_000 // 10 min idle — would normally fire
    renderHook(() => useSessionRecap('s1', lastTurn, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('auto-fetches once hasFreshRecap flips back to false (recap evicted / staled)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 10 * 60_000
    const { rerender } = renderHook(
      ({ fresh }: { fresh: boolean }) =>
        useSessionRecap('s1', lastTurn, fresh),
      { initialProps: { fresh: true } },
    )

    // Initially gated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // The cached recap got pruned (e.g. items rebuilt without it) — gate flips.
    rerender({ fresh: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('manual refresh fires even when hasFreshRecap is true', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 10 * 60_000
    const { result } = renderHook(() => useSessionRecap('s1', lastTurn, true))

    // Auto-path is gated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // Explicit user refresh ignores the gate.
    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
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
    expect(result.current.loadingMessage?.state).toBe('loading')

    // Trigger another refresh — should abort the first.
    mockPost.mockResolvedValueOnce({})
    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    // Loading message clears after second fetch completes.
    expect(result.current.loadingMessage).toBeNull()
  })
})
