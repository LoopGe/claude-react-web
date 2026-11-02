import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mock useApi ─────────────────────────────────────────────────────

const mockGet = vi.fn()
const mockPost = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}))

// Import AFTER mock.
import { usePendingRequestChannel } from './usePendingRequestChannel'

// ── Test types ──────────────────────────────────────────────────────

type TestRequest = { id: string; value: string }
type TestResolution = { id: string }

// ── Deferred helper ─────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('usePendingRequestChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ pending: [] })
    mockPost.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 1. does not fetch for an empty session
  it('does not fetch for an empty session', async () => {
    renderHook(() => usePendingRequestChannel<TestRequest, TestResolution>('', 'permissions'))
    // Flush any pending microtasks; the guard means no call should land.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGet).not.toHaveBeenCalled()
  })

  // 2. ignores empty request and resolution ids
  it('ignores empty request and resolution ids', () => {
    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )

    act(() => {
      result.current.onRequest({ id: '', value: 'x' })
      result.current.onResolved({ id: '' })
    })
    expect(result.current.pending).toEqual([])
  })

  // 3. seeds and merges in stable order
  it('seeds and merges in stable order', async () => {
    mockGet.mockResolvedValueOnce({
      pending: [
        { id: 'p1', value: 'v1' },
        { id: 'p2', value: 'v2' },
      ],
    })

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(2))

    // Update p1 in-place and add p3.
    act(() => {
      result.current.onRequest({ id: 'p1', value: 'v1-updated' })
      result.current.onRequest({ id: 'p3', value: 'v3' })
    })

    expect(result.current.pending.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(result.current.pending[0].value).toBe('v1-updated')
  })

  // 4. resets visible state immediately and ignores late seed/events from old session
  it('resets visible state immediately and ignores late seed/events from the old session', async () => {
    const seedDeferred = deferred<{ pending: TestRequest[] }>()
    mockGet.mockReturnValueOnce(seedDeferred.promise)

    const { result, rerender } = renderHook(
      ({ sessionId }) => usePendingRequestChannel<TestRequest, TestResolution>(sessionId, 'permissions'),
      { initialProps: { sessionId: 's1' } },
    )

    // Add a local request while s1's seed is still pending.
    act(() => {
      result.current.onRequest({ id: 'p1', value: 'v1' })
    })
    expect(result.current.pending).toHaveLength(1)

    // Capture old-session handlers before rerender.
    const oldOnRequest = result.current.onRequest
    const oldOnResolved = result.current.onResolved

    // Switch to s2 — empty immediately.
    rerender({ sessionId: 's2' })
    expect(result.current.pending).toEqual([])
    expect(result.current.error).toBeNull()

    // Late seed from s1 resolves — must not write into s2.
    await act(async () => {
      seedDeferred.resolve({ pending: [{ id: 'p-old', value: 'old' }] })
      await Promise.resolve()
    })
    expect(result.current.pending).toEqual([])

    // Late events from old-session handlers — must not write into s2.
    act(() => {
      oldOnRequest({ id: 'p-late', value: 'late' })
      oldOnResolved({ id: 'whatever' })
    })
    expect(result.current.pending).toEqual([])
  })

  // 5. ignores previous-session POST failure and both recovery outcomes
  it('ignores previous-session POST failure and both recovery outcomes', async () => {
    async function runCase(recoverySucceeds: boolean) {
      mockGet.mockReset()
      mockPost.mockReset()
      mockGet.mockResolvedValue({ pending: [] })
      mockPost.mockResolvedValue(undefined)

      const postDeferred = deferred<void>()
      mockPost.mockReturnValueOnce(postDeferred.promise)
      // Call order: s1 seed, s2 seed (rerender), s1 recovery (after POST reject).
      mockGet.mockResolvedValueOnce({ pending: [] }) // s1 seed
      mockGet.mockResolvedValueOnce({ pending: [] }) // s2 seed
      if (recoverySucceeds) {
        mockGet.mockResolvedValueOnce({ pending: [{ id: 'p1', value: 's1-v1' }] }) // recovery
      } else {
        mockGet.mockRejectedValueOnce(new Error('recovery-fail')) // recovery
      }

      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          usePendingRequestChannel<TestRequest, TestResolution>(sessionId, 'permissions'),
        { initialProps: { sessionId: 's1' } },
      )

      act(() => {
        result.current.onRequest({ id: 'p1', value: 'v1' })
      })

      let submitPromise!: Promise<void>
      act(() => {
        submitPromise = result.current.submit('p1', 'decide', { behavior: 'allow' }, 'Decide failed')
      })
      // Optimistic remove.
      await waitFor(() => expect(result.current.pending).toEqual([]))

      // Switch to s2 before POST settles.
      rerender({ sessionId: 's2' })
      expect(result.current.pending).toEqual([])

      // Reject POST; recovery fires for s1 — neither error nor pending must touch s2.
      await act(async () => {
        postDeferred.reject(new Error('post-fail'))
        await submitPromise.catch(() => {})
      })

      expect(result.current.error).toBeNull()
      expect(result.current.pending).toEqual([])
    }

    await runCase(true) // recovery resolves
    await runCase(false) // recovery rejects
  })

  // 6. restores only the target id from a successful recovery
  it('restores only the target id from a successful recovery', async () => {
    mockGet.mockResolvedValueOnce({
      pending: [
        { id: 'p1', value: 'v1' },
        { id: 'p2', value: 'seed-v2' },
      ],
    }) // seed
    mockPost.mockRejectedValueOnce(new Error('post-fail'))
    // Recovery returns both p1 and p2, but p2 has a different value.
    mockGet.mockResolvedValueOnce({
      pending: [
        { id: 'p1', value: 'v1' },
        { id: 'p2', value: 'recovery-v2' },
      ],
    }) // recovery

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(2))

    await act(async () => {
      await result.current.submit('p1', 'decide', { behavior: 'allow' }, 'Decide failed')
    })

    // p1 restored (from recovery response); p2 unchanged (seed value, NOT recovery value).
    const ids = result.current.pending.map((p) => p.id)
    expect(ids).toContain('p1')
    expect(ids).toContain('p2')
    const p2 = result.current.pending.find((p) => p.id === 'p2')!
    expect(p2.value).toBe('seed-v2')
  })

  // 7. re-inserts the removed target when current recovery fails
  it('re-inserts the removed target when current recovery fails', async () => {
    mockGet.mockResolvedValueOnce({ pending: [{ id: 'p1', value: 'v1' }] }) // seed
    mockPost.mockRejectedValueOnce(new Error('post-fail'))
    mockGet.mockRejectedValueOnce(new Error('recovery-fail')) // recovery

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    await act(async () => {
      await result.current.submit('p1', 'decide', { behavior: 'allow' }, 'Decide failed')
    })

    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('p1')
    expect(result.current.error).toBe('Decide failed: post-fail')
  })

  // 8. ignores recovery success after a newer request for the same id
  it('ignores recovery success after a newer request for the same id', async () => {
    const postDeferred = deferred<void>()
    const recoveryDeferred = deferred<{ pending: TestRequest[] }>()
    mockPost.mockReturnValueOnce(postDeferred.promise)
    mockGet
      .mockResolvedValueOnce({ pending: [{ id: 'p1', value: 'old' }] }) // seed
      .mockReturnValueOnce(recoveryDeferred.promise) // recovery

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    let submitPromise!: Promise<void>
    act(() => {
      submitPromise = result.current.submit('p1', 'decide', {}, 'Decide failed')
    })
    await waitFor(() => expect(result.current.pending).toEqual([]))

    // Reject POST → recovery fires (deferred).
    await act(async () => {
      postDeferred.reject(new Error('post-fail'))
      await Promise.resolve()
    })

    // A newer live request arrives for the same id.
    act(() => {
      result.current.onRequest({ id: 'p1', value: 'new' })
    })
    expect(result.current.pending[0].value).toBe('new')

    // Stale recovery returns the old value — must not overwrite.
    await act(async () => {
      recoveryDeferred.resolve({ pending: [{ id: 'p1', value: 'old' }] })
      await submitPromise.catch(() => {})
    })

    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].value).toBe('new')
  })

  // 9. ignores recovery failure after a resolution for the same id
  it('ignores recovery failure after a resolution for the same id', async () => {
    const postDeferred = deferred<void>()
    const recoveryDeferred = deferred<{ pending: TestRequest[] }>()
    mockPost.mockReturnValueOnce(postDeferred.promise)
    mockGet
      .mockResolvedValueOnce({ pending: [{ id: 'p1', value: 'old' }] }) // seed
      .mockReturnValueOnce(recoveryDeferred.promise) // recovery

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    let submitPromise!: Promise<void>
    act(() => {
      submitPromise = result.current.submit('p1', 'decide', {}, 'Decide failed')
    })
    await waitFor(() => expect(result.current.pending).toEqual([]))

    // Reject POST → recovery fires (deferred).
    await act(async () => {
      postDeferred.reject(new Error('post-fail'))
      await Promise.resolve()
    })

    // A newer request, then a resolution, arrive for the same id.
    act(() => {
      result.current.onRequest({ id: 'p1', value: 'new' })
    })
    act(() => {
      result.current.onResolved({ id: 'p1' })
    })
    expect(result.current.pending).toEqual([])

    // Stale recovery fails — must not re-insert the captured old request.
    await act(async () => {
      recoveryDeferred.reject(new Error('recovery-fail'))
      await submitPromise.catch(() => {})
    })

    expect(result.current.pending).toEqual([])
  })

  // 10. ignores the first recovery after a second submit for the same id
  it('ignores the first recovery after a second submit for the same id', async () => {
    const post1Deferred = deferred<void>()
    const recovery1Deferred = deferred<{ pending: TestRequest[] }>()
    mockPost.mockReturnValueOnce(post1Deferred.promise) // POST #1 (deferred)
    mockPost.mockResolvedValueOnce(undefined) // POST #2 (succeeds)
    mockGet
      .mockResolvedValueOnce({ pending: [{ id: 'p1', value: 'v1' }] }) // seed
      .mockReturnValueOnce(recovery1Deferred.promise) // recovery #1

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    // First submit — POST will reject, recovery is deferred.
    let submit1Promise!: Promise<void>
    act(() => {
      submit1Promise = result.current.submit('p1', 'decide', {}, 'Decide failed')
    })
    await waitFor(() => expect(result.current.pending).toEqual([]))

    // Reject POST #1 → recovery #1 fires (deferred).
    await act(async () => {
      post1Deferred.reject(new Error('post1-fail'))
      await Promise.resolve()
    })

    // Second submit for the same id — POST succeeds, replacing the token.
    await act(async () => {
      await result.current.submit('p1', 'decide', {}, 'Decide failed')
    })

    // Resolve the stale recovery #1 — must not restore anything.
    await act(async () => {
      recovery1Deferred.resolve({ pending: [{ id: 'p1', value: 'stale' }] })
      await submit1Promise.catch(() => {})
    })

    expect(result.current.pending).toEqual([])
  })

  // 11. allows target recovery after activity for an unrelated id
  it('allows target recovery after activity for an unrelated id', async () => {
    const postDeferred = deferred<void>()
    const recoveryDeferred = deferred<{ pending: TestRequest[] }>()
    mockPost.mockReturnValueOnce(postDeferred.promise)
    mockGet
      .mockResolvedValueOnce({
        pending: [
          { id: 'p1', value: 'v1' },
          { id: 'p2', value: 'v2' },
        ],
      }) // seed
      .mockReturnValueOnce(recoveryDeferred.promise) // recovery

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(2))

    let submitPromise!: Promise<void>
    act(() => {
      submitPromise = result.current.submit('p1', 'decide', {}, 'Decide failed')
    })
    // p1 optimistically removed; p2 remains.
    await waitFor(() => expect(result.current.pending.map((p) => p.id)).toEqual(['p2']))

    // Reject POST → recovery fires (deferred).
    await act(async () => {
      postDeferred.reject(new Error('post-fail'))
      await Promise.resolve()
    })

    // Activity for an unrelated id (p2) — must not invalidate p1's token.
    act(() => {
      result.current.onRequest({ id: 'p2', value: 'v2-updated' })
    })
    act(() => {
      result.current.onResolved({ id: 'p2' })
    })
    expect(result.current.pending).toEqual([])

    // Resolve recovery with [p1] — should restore p1 (token still valid).
    await act(async () => {
      recoveryDeferred.resolve({ pending: [{ id: 'p1', value: 'v1' }] })
      await submitPromise.catch(() => {})
    })

    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('p1')
  })

  // 12. reset invalidates outstanding recovery
  it('reset invalidates outstanding recovery', async () => {
    async function runCase(recoverySucceeds: boolean) {
      mockGet.mockReset()
      mockPost.mockReset()
      mockGet.mockResolvedValue({ pending: [] })
      mockPost.mockResolvedValue(undefined)

      const postDeferred = deferred<void>()
      const recoveryDeferred = deferred<{ pending: TestRequest[] }>()
      mockPost.mockReturnValueOnce(postDeferred.promise)
      mockGet
        .mockResolvedValueOnce({ pending: [{ id: 'p1', value: 'v1' }] }) // seed
        .mockReturnValueOnce(recoveryDeferred.promise) // recovery

      const { result } = renderHook(() =>
        usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
      )
      await waitFor(() => expect(result.current.pending).toHaveLength(1))

      let submitPromise!: Promise<void>
      act(() => {
        submitPromise = result.current.submit('p1', 'decide', {}, 'Decide failed')
      })
      await waitFor(() => expect(result.current.pending).toEqual([]))

      // Reject POST → recovery fires (deferred).
      await act(async () => {
        postDeferred.reject(new Error('post-fail'))
        await Promise.resolve()
      })

      // Reset — must invalidate the recovery token.
      act(() => {
        result.current.reset()
      })
      expect(result.current.pending).toEqual([])
      expect(result.current.error).toBeNull()

      // Stale recovery resolves/rejects — must not restore.
      await act(async () => {
        if (recoverySucceeds) {
          recoveryDeferred.resolve({ pending: [{ id: 'p1', value: 'stale' }] })
        } else {
          recoveryDeferred.reject(new Error('recovery-fail'))
        }
        await submitPromise.catch(() => {})
      })
      expect(result.current.pending).toEqual([])
    }

    await runCase(true) // recovery resolves
    await runCase(false) // recovery rejects
  })

  // 13. cleans up its token after success and after each recovery outcome
  it('cleans up its token after success and after each recovery outcome', async () => {
    // After POST success: subsequent request + submit behave as on a fresh hook.
    mockGet.mockResolvedValueOnce({ pending: [{ id: 'p1', value: 'v1' }] }) // seed
    mockPost.mockResolvedValueOnce(undefined) // POST succeeds

    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    await act(async () => {
      await result.current.submit('p1', 'decide', {}, 'Decide failed')
    })
    expect(result.current.pending).toEqual([])

    // Subsequent request adds the item (no stale token blocks it).
    act(() => {
      result.current.onRequest({ id: 'p1', value: 'v1-new' })
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].value).toBe('v1-new')

    // Subsequent submit with POST failure + recovery failure re-inserts the
    // captured item — the old token does not interfere.
    mockPost.mockRejectedValueOnce(new Error('post2-fail'))
    mockGet.mockRejectedValueOnce(new Error('recovery2-fail'))
    await act(async () => {
      await result.current.submit('p1', 'decide', {}, 'Decide failed')
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('p1')
    expect(result.current.pending[0].value).toBe('v1-new')
  })

  // 14. does not expose implementation fields
  it('does not expose implementation fields', () => {
    const { result } = renderHook(() =>
      usePendingRequestChannel<TestRequest, TestResolution>('s1', 'permissions'),
    )
    const keys = Object.keys(result.current).sort()
    expect(keys).toEqual(
      ['clearError', 'error', 'onRequest', 'onResolved', 'pending', 'reset', 'submit'].sort(),
    )
    expect(result.current).not.toHaveProperty('recoveryTokens')
    expect(result.current).not.toHaveProperty('sessionId')
    expect(result.current).not.toHaveProperty('state')
  })
})
