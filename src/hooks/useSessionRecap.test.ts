// Tests for the phase-driven recap hook.
//
// The hook is a pure timer + POST trigger, fed by `session.phase`,
// `session.lastTurnAt`, and `session.recap` (all server-pushed). It
// fires POST /sessions/:id/recap exactly when:
//   - phase === 'idle'
//   - lastTurnAt is set
//   - session.recap is undefined (no fresh one already covers it)
//   - and the 5-minute idle window has elapsed (or fires immediately
//     when already past it)
//
// Anything that breaks one of those is a no-op. Manual refresh()
// bypasses the timer but still requires lastTurnAt.
//
// We do NOT test the server's phase gate here (covered by recap.test.ts);
// the hook trusts what's on session.phase.

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
import type { SessionInfo } from '../types'

// ── Helpers ────────────────────────────────────────────────────────

/** Build a minimal SessionInfo for the hook. Only the fields the hook
 *  reads (id, phase, lastTurnAt, messageCount, recap) actually matter —
 *  the rest satisfy the type. Defaults messageCount to 5 so a "real"
 *  session with history is modelled; tests that need an empty history
 *  pass messageCount: 0 explicitly. */
function buildSession(partial: Partial<SessionInfo> & Pick<SessionInfo, 'phase'>): SessionInfo {
  return {
    id: 's1',
    createdAt: 0,
    lastActivityAt: 0,
    subscribers: 1,
    messageCount: 5,
    running: true,
    terminated: false,
    working: false,
    ...partial,
  }
}

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

  // ── Phase gate ────────────────────────────────────────────────

  it('does NOT fetch when phase is not idle, even past the threshold', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'working', lastTurnAt: now - 10 * 60_000 }),
      ),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('does NOT fetch when the session has no completed turn yet', () => {
    renderHook(() => useSessionRecap(buildSession({ phase: 'idle' })))
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('does NOT fetch when phase is dormant', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'dormant', lastTurnAt: now - 10 * 60_000 }),
      ),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  // ── Empty-history gate (regression: "No messages yet." after /clear) ──

  it('does NOT fetch when the history ring is empty even if lastTurnAt is set', async () => {
    // lastTurnAt is a fallible proxy: spawn() carries it forward on resume
    // even when the transcript seed is empty (and the old in-place /clear
    // wiped history without resetting it). Gating on lastTurnAt alone would
    // fire requestGenerate on an empty history and synthesize the misleading
    // "No messages yet." ready recap. messageCount is the ground truth.
    const now = Date.now()
    vi.setSystemTime(now)

    renderHook(() =>
      useSessionRecap(
        buildSession({
          phase: 'idle',
          lastTurnAt: now - 10 * 60_000,
          messageCount: 0,
        }),
      ),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('does NOT fetch when phase is terminated', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'terminated', lastTurnAt: now - 10 * 60_000 }),
      ),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  // ── Idle-trigger threshold ────────────────────────────────────

  it('does NOT fetch when the session is still under 5 minutes idle', () => {
    const now = Date.now()
    vi.setSystemTime(now)

    renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'idle', lastTurnAt: now - 60_000 }),
      ),
    )

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('fetches immediately when already idle ≥ 5 minutes', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'idle', lastTurnAt: now - 10 * 60_000 }),
      ),
    )

    // Timer fires synchronously at remaining=0; flush microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/recap',
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('schedules a timer and fires once the 5-minute idle threshold is reached', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    // 2 minutes since the last turn — 3 more minutes to wait.
    const lastTurn = now - 2 * 60_000
    renderHook(() =>
      useSessionRecap(buildSession({ phase: 'idle', lastTurnAt: lastTurn })),
    )

    expect(mockPost).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000 - 1)
    })
    expect(mockPost).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  // ── Re-render reactions ──────────────────────────────────────

  it('cancels the timer when phase flips away from idle (user starts a turn)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const lastTurn = now - 4 * 60_000
    const { rerender } = renderHook(
      ({ phase }: { phase: SessionInfo['phase'] }) =>
        useSessionRecap(buildSession({ phase, lastTurnAt: lastTurn })),
      { initialProps: { phase: 'idle' as SessionInfo['phase'] } },
    )

    // 30 s in — about to fire in another minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // User starts typing → server flips phase to 'working'.
    rerender({ phase: 'working' })

    // Past where the original timer would have fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000)
    })
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('reschedules from the new lastTurnAt when the user sends a message', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const { rerender } = renderHook(
      ({ ts }: { ts: number }) =>
        useSessionRecap(buildSession({ phase: 'idle', lastTurnAt: ts })),
      { initialProps: { ts: now - 4 * 60_000 } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // New turn lands; lastTurnAt jumps forward.
    vi.setSystemTime(now + 30_000)
    rerender({ ts: now + 30_000 })

    // Old timer would have fired by now — it shouldn't have.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // Wait the full 5 minutes from the new turn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  // ── recap-already-covers-it gate ─────────────────────────────

  it('does NOT auto-fetch when session.recap is already set (any status)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    for (const status of ['pending', 'ready', 'error'] as const) {
      mockPost.mockClear()
      renderHook(() =>
        useSessionRecap(
          buildSession({
            phase: 'idle',
            lastTurnAt: now - 10 * 60_000,
            recap: { status, generatedAt: now },
          }),
        ),
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(mockPost).not.toHaveBeenCalled()
    }
  })

  it('auto-fetches when recap is cleared (server invalidated it)', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const { rerender } = renderHook(
      ({ recap }: { recap: SessionInfo['recap'] }) =>
        useSessionRecap(
          buildSession({
            phase: 'idle',
            lastTurnAt: now - 10 * 60_000,
            recap,
          }),
        ),
      { initialProps: { recap: { status: 'ready' as const, generatedAt: now } as SessionInfo['recap'] } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).not.toHaveBeenCalled()

    // Server invalidated (e.g. user sent a new message that mutated history).
    rerender({ recap: undefined })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  // ── refresh() ────────────────────────────────────────────────

  it('refresh fetches on demand even before the 5-minute window', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const { result } = renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'idle', lastTurnAt: now - 60_000 }),
      ),
    )

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
    const { result } = renderHook(() =>
      useSessionRecap(buildSession({ phase: 'idle' })),
    )

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('refresh fires even when phase is not idle (server returns 409, we tolerate that)', async () => {
    // The hook does NOT gate refresh() on phase — defence-in-depth lives
    // server-side. The user pressing Alt+R during a turn is unusual but
    // shouldn't be silently swallowed.
    const now = Date.now()
    vi.setSystemTime(now)

    mockPost.mockRejectedValueOnce(new Error('409 Conflict'))

    const { result } = renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'working', lastTurnAt: now - 60_000 }),
      ),
    )

    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('refresh aborts a previous in-flight request', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const { result } = renderHook(() =>
      useSessionRecap(
        buildSession({ phase: 'idle', lastTurnAt: now - 60_000 }),
      ),
    )

    let firstAbortSignal: AbortSignal | undefined
    mockPost.mockImplementationOnce((_url: string, _body: unknown, opts: { signal?: AbortSignal }) => {
      firstAbortSignal = opts?.signal
      return new Promise(() => {})
    })

    await act(async () => {
      result.current.refresh()
    })

    expect(firstAbortSignal?.aborted).toBe(false)

    mockPost.mockResolvedValueOnce({})
    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(firstAbortSignal?.aborted).toBe(true)
  })
})
