import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockDelete = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))

import { useScheduledSends } from './useScheduledSends'

const pending = (id: string, fireAt: number) => ({
  id, sessionId: 's1', fireAt,
  body: { text: 'hi' } as const,
  status: 'pending' as const,
  createdAt: 1,
})

beforeEach(() => {
  vi.useFakeTimers()
  // Anchor "now" at a small known epoch so fireAt values below are genuinely
  // in the FUTURE (fake timers default to the real 2026 clock, which would
  // make 2_000_000 a past instant and trip the reconcile-on-mount path).
  vi.setSystemTime(1_000_000)
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ schedules: [] })
  mockPost.mockResolvedValue({ schedule: {} })
  mockDelete.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flush the microtask queue so pending resolved promises settle inside act. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('useScheduledSends', () => {
  it('loads schedules on mount', async () => {
    mockGet.mockResolvedValue({ schedules: [pending('a', 1_060_000)] })
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/schedules')
    expect(result.current.schedules).toHaveLength(1)
    expect(result.current.hasPending).toBe(true)
  })

  it('schedule POSTs then refetches', async () => {
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    await act(async () => {
      await result.current.schedule(1_060_000, { text: 'later' })
    })
    expect(mockPost).toHaveBeenCalledWith('/sessions/s1/schedules', { fireAt: 1_060_000, text: 'later' })
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('cancel optimistically removes and DELETEs', async () => {
    mockGet.mockResolvedValue({ schedules: [pending('a', 1_060_000)] })
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    act(() => { void result.current.cancel('a') })
    expect(result.current.schedules).toHaveLength(0)
    await settle()
    expect(mockDelete).toHaveBeenCalledWith('/sessions/s1/schedules/a')
  })

  it('session switch: new session fetches its own data, old session late response does not clobber', async () => {
    // Return manually-resolvable promises so we control resolution order.
    let resolveOld: (v: unknown) => void
    let resolveNew: (v: unknown) => void
    mockGet
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
      .mockImplementationOnce(() => new Promise((r) => { resolveNew = r }))

    const { result, rerender } = renderHook(
      ({ sid }) => useScheduledSends(sid),
      { initialProps: { sid: 's1' } },
    )
    // s1 GET is in flight (refreshingRef.current === 's1').

    // Switch to s2 while s1's GET is still pending.
    rerender({ sid: 's2' })
    // s2's refresh sees refreshingRef.current === 's1' !== 's2', so it
    // proceeds — the string-keyed guard only blocks same-session overlap.

    // Now resolve s1's response (late) — should NOT clobber s2's state.
    await act(async () => {
      resolveOld!({ schedules: [pending('old', 1_060_000)] })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.schedules).toHaveLength(0) // s1 data rejected

    // Resolve s2's response.
    await act(async () => {
      resolveNew!({ schedules: [pending('new', 1_060_000)] })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.schedules).toHaveLength(1)
    expect(result.current.schedules[0].id).toBe('new')
  })

  it('refetches when a pending fireAt passes (authoritative sent/failed flip)', async () => {
    // Fire time 2s in the future (1_002_000): the crossing effect must
    // reconcile BEFORE the 3s poll, so the second GET is the reconcile.
    mockGet
      .mockResolvedValueOnce({ schedules: [pending('a', 1_002_000)] }) // mount
      .mockResolvedValueOnce({ schedules: [] })                        // reconcile
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    expect(result.current.schedules).toHaveLength(1)
    await act(async () => {
      // t=1s: now=1_001_000 (< fireAt). t=2s: now=1_002_000 → reconcile.
      for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.schedules).toHaveLength(0)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
