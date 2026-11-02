import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { PermissionRequest } from '../types'

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
import { usePermissionChannel } from './usePermissionChannel'

// ── Test data ──────────────────────────────────────────────────────

function makePermissionRequest(id: string, toolName = 'Bash'): PermissionRequest {
  return {
    kind: 'permission',
    id,
    toolName,
    input: { command: 'ls' },
    toolUseID: `tu-${id}`,
    createdAt: Date.now(),
  }
}

// ── Deferred helper for race-condition tests ──────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('usePermissionChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: GET /permissions returns empty list.
    mockGet.mockResolvedValue({ pending: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Initial load ──────────────────────────────────────────────

  it('fetches pending permissions from REST on mount', async () => {
    const existing = makePermissionRequest('p1')
    mockGet.mockResolvedValueOnce({ pending: [existing] })

    const { result } = renderHook(() => usePermissionChannel('s1'))

    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('p1')
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/permissions')
  })

  it('handles REST fetch failure gracefully', async () => {
    mockGet.mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() => usePermissionChannel('s1'))

    // Should not crash; pending stays empty.
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    expect(result.current.pending).toEqual([])
  })

  it('does not fetch when sessionId is empty (e.g. no side chat)', async () => {
    // ChatPanel subscribes the side-chat slot with `sideChatSession?.id ?? ''`
    // when no side chat exists. The snapshot effect must short-circuit so we
    // don't fire `/sessions//permissions` (404) on every panel mount.
    renderHook(() => usePermissionChannel(''))

    // Flush any pending microtasks; the guard means no call should land.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGet).not.toHaveBeenCalled()
  })

  // ── onRequest / onResolved ────────────────────────────────────

  it('adds request via onRequest', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('p1')
  })

  it('ignores onRequest with missing id', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest({ kind: 'permission', id: '', toolName: 'Bash' } as PermissionRequest)
    })
    expect(result.current.pending).toEqual([])
  })

  it('deduplicates requests by id (updates in-place)', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
      result.current.onRequest(makePermissionRequest('p1'))
    })
    expect(result.current.pending).toHaveLength(1)
  })

  it('removes request via onResolved', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
      result.current.onRequest(makePermissionRequest('p2'))
    })
    expect(result.current.pending).toHaveLength(2)

    act(() => {
      result.current.onResolved({ id: 'p1', behavior: 'allow', persisted: false })
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('p2')
  })

  // ── decide ────────────────────────────────────────────────────

  it('optimistically removes request on decide', async () => {
    // POST will succeed after a tick.
    mockPost.mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })
    expect(result.current.pending).toHaveLength(1)

    // Call decide — should remove immediately (optimistic).
    await act(async () => {
      await result.current.decide('p1', { behavior: 'allow', persistForSession: false })
    })

    expect(result.current.pending).toEqual([])
    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/permissions/p1/decide',
      { behavior: 'allow', persistForSession: false },
    )
  })

  it('forwards planTargetMode in the decide body (plan approval)', async () => {
    mockPost.mockResolvedValueOnce({ ok: true })
    const { result } = renderHook(() => usePermissionChannel('s1'))
    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })
    await act(async () => {
      await result.current.decide('p1', { behavior: 'allow', persistForSession: false, planTargetMode: 'acceptEdits' })
    })
    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/permissions/p1/decide',
      { behavior: 'allow', persistForSession: false, planTargetMode: 'acceptEdits' },
    )
  })

  it('shows error and re-fetches pending on decide failure', async () => {
    mockPost.mockRejectedValueOnce(new Error('server down'))
    // Re-fetch after failure returns the original request.
    mockGet.mockResolvedValueOnce({ pending: [makePermissionRequest('p1')] })

    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })

    await act(async () => {
      await result.current.decide('p1', { behavior: 'deny', message: 'blocked' })
    })

    expect(result.current.error).toContain('Permission decision failed')
    expect(result.current.error).toContain('server down')
    // Should have re-fetched (merge).
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/permissions')
    // Pending should be restored from the re-fetch.
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
  })

  it('re-inserts optimistically-removed request when both POST and recovery fetch fail', async () => {
    mockGet
      .mockResolvedValueOnce({ pending: [] })
      .mockRejectedValueOnce(new Error('also down'))
    mockPost.mockRejectedValueOnce(new Error('server down'))

    const { result } = renderHook(() => usePermissionChannel('s1'))

    const req = makePermissionRequest('p1')
    act(() => {
      result.current.onRequest(req)
    })
    expect(result.current.pending).toHaveLength(1)

    await act(async () => {
      await result.current.decide('p1', { behavior: 'allow', persistForSession: false })
    })

    expect(result.current.error).toContain('Permission decision failed')
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('p1')
  })

  // ── answerQuestion ────────────────────────────────────────────

  it('optimistically removes request on answerQuestion', async () => {
    mockPost.mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => usePermissionChannel('s1'))

    const questionReq: PermissionRequest = {
      kind: 'question',
      id: 'q1',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
      toolUseID: 'tu-q1',
      createdAt: Date.now(),
    }
    act(() => {
      result.current.onRequest(questionReq)
    })

    await act(async () => {
      await result.current.answerQuestion('q1', ['A'])
    })

    expect(result.current.pending).toEqual([])
    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/permissions/q1/answer-question',
      { answers: ['A'] },
    )
  })

  it('re-inserts optimistically-removed question when both POST and recovery fetch fail', async () => {
    mockGet
      .mockResolvedValueOnce({ pending: [] })
      .mockRejectedValueOnce(new Error('also down'))
    mockPost.mockRejectedValueOnce(new Error('server down'))

    const { result } = renderHook(() => usePermissionChannel('s1'))

    const questionReq: PermissionRequest = {
      kind: 'question',
      id: 'q1',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
      toolUseID: 'tu-q1',
      createdAt: Date.now(),
    }
    act(() => {
      result.current.onRequest(questionReq)
    })

    await act(async () => {
      await result.current.answerQuestion('q1', ['A'])
    })

    expect(result.current.error).toContain('Answer submission failed')
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('q1')
  })

  it('optimistically removes request on clarifyQuestion', async () => {
    mockPost.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => usePermissionChannel('s1'))
    act(() => {
      result.current.onRequest({
        kind: 'question', id: 'q1', toolName: 'AskUserQuestion',
        questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
        toolUseID: 'tu-q1', createdAt: Date.now(),
      })
    })
    await act(async () => {
      await result.current.clarifyQuestion('q1', 'Explain first')
    })
    expect(result.current.pending).toEqual([])
    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/permissions/q1/clarify-question',
      { feedback: 'Explain first' },
    )
  })

  it('shows error and re-fetches on answerQuestion failure', async () => {
    mockPost.mockRejectedValueOnce(new Error('timeout'))
    mockGet.mockResolvedValueOnce({ pending: [] })

    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('q1'))
    })

    await act(async () => {
      await result.current.answerQuestion('q1', ['answer'])
    })

    expect(result.current.error).toContain('Answer submission failed')
    expect(result.current.error).toContain('timeout')
  })

  // ── reset / clearError ────────────────────────────────────────

  it('clears all state on reset()', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })
    expect(result.current.pending).toHaveLength(1)

    act(() => {
      result.current.reset()
    })
    expect(result.current.pending).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('clears error on clearError()', async () => {
    mockPost.mockRejectedValueOnce(new Error('fail'))
    mockGet.mockResolvedValueOnce({ pending: [] })

    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })

    await act(async () => {
      await result.current.decide('p1', { behavior: 'deny' })
    })
    expect(result.current.error).toBeTruthy()

    act(() => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()
  })

  // ── mergePending behavior ─────────────────────────────────────

  it('preserves order of existing entries when merging new ones', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
      result.current.onRequest(makePermissionRequest('p2'))
      result.current.onRequest(makePermissionRequest('p3'))
    })
    expect(result.current.pending.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])

    // Update p2 in-place and add p4.
    const updatedP2 = makePermissionRequest('p2', 'Write')
    act(() => {
      result.current.onRequest(updatedP2)
      result.current.onRequest(makePermissionRequest('p4'))
    })
    expect(result.current.pending.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(result.current.pending[1].toolName).toBe('Write') // Updated
  })

  // ── Session-switch & recovery race regressions ─────────────────

  it('clears immediately and ignores a late seed after session change', async () => {
    const seedDeferred = deferred<{ pending: PermissionRequest[] }>()
    mockGet.mockReturnValueOnce(seedDeferred.promise)

    const { result, rerender } = renderHook(
      ({ sessionId }) => usePermissionChannel(sessionId),
      { initialProps: { sessionId: 's1' } },
    )

    // While s1's seed is still pending, locally add a request.
    act(() => {
      result.current.onRequest(makePermissionRequest('p-local'))
    })
    expect(result.current.pending).toHaveLength(1)

    // Switch to s2 — visible state must be empty immediately.
    rerender({ sessionId: 's2' })
    expect(result.current.pending).toEqual([])
    expect(result.current.error).toBeNull()

    // s1's late seed resolves with [p-old] — must not write into s2.
    await act(async () => {
      seedDeferred.resolve({ pending: [makePermissionRequest('p-old')] })
      await Promise.resolve()
    })
    expect(result.current.pending).toEqual([])
  })

  it('ignores POST failure and recovery from the previous session', async () => {
    const postDeferred = deferred<void>()
    mockPost.mockReturnValueOnce(postDeferred.promise)
    // Call order: s1 seed, s2 seed (on rerender), s1 recovery (after POST reject).
    mockGet
      .mockResolvedValueOnce({ pending: [] })
      .mockResolvedValueOnce({ pending: [] })
      .mockResolvedValueOnce({ pending: [makePermissionRequest('p1')] })

    const { result, rerender } = renderHook(
      ({ sessionId }) => usePermissionChannel(sessionId),
      { initialProps: { sessionId: 's1' } },
    )

    act(() => {
      result.current.onRequest(makePermissionRequest('p1'))
    })

    let decidePromise!: Promise<void>
    act(() => {
      decidePromise = result.current.decide('p1', { behavior: 'allow', persistForSession: false })
    })
    // Optimistic remove.
    await waitFor(() => expect(result.current.pending).toEqual([]))

    // Switch to s2 before POST settles.
    rerender({ sessionId: 's2' })
    expect(result.current.pending).toEqual([])

    // Reject the POST; recovery fires for s1 and returns [p1].
    // Neither the error nor the recovered pending must touch s2.
    await act(async () => {
      postDeferred.reject(new Error('server down'))
      await decidePromise.catch(() => {})
    })

    expect(result.current.error).toBeNull()
    expect(result.current.pending).toEqual([])
  })

  it('does not overwrite a newer request when stale recovery succeeds', async () => {
    const postDeferred = deferred<void>()
    const recoveryDeferred = deferred<{ pending: PermissionRequest[] }>()
    mockPost.mockReturnValueOnce(postDeferred.promise)
    mockGet
      .mockResolvedValueOnce({ pending: [] }) // seed
      .mockReturnValueOnce(recoveryDeferred.promise) // recovery

    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1', 'Bash'))
    })

    let decidePromise!: Promise<void>
    act(() => {
      decidePromise = result.current.decide('p1', { behavior: 'allow', persistForSession: false })
    })
    // Optimistic remove.
    await waitFor(() => expect(result.current.pending).toEqual([]))

    // Reject POST → recovery GET fires (deferred, still pending).
    await act(async () => {
      postDeferred.reject(new Error('server down'))
      await Promise.resolve() // let the catch block start + fire recovery GET
    })

    // A newer live request arrives for the same id before recovery resolves.
    act(() => {
      result.current.onRequest(makePermissionRequest('p1', 'Write'))
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].toolName).toBe('Write')

    // Stale recovery returns the old version (Bash) — must not overwrite.
    await act(async () => {
      recoveryDeferred.resolve({ pending: [makePermissionRequest('p1', 'Bash')] })
      await decidePromise.catch(() => {})
    })

    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].toolName).toBe('Write')
  })

  it('does not resurrect a resolved request when stale recovery fails', async () => {
    const postDeferred = deferred<void>()
    const recoveryDeferred = deferred<{ pending: PermissionRequest[] }>()
    mockPost.mockReturnValueOnce(postDeferred.promise)
    mockGet
      .mockResolvedValueOnce({ pending: [] }) // seed
      .mockReturnValueOnce(recoveryDeferred.promise) // recovery

    const { result } = renderHook(() => usePermissionChannel('s1'))

    act(() => {
      result.current.onRequest(makePermissionRequest('p1', 'Bash'))
    })

    let decidePromise!: Promise<void>
    act(() => {
      decidePromise = result.current.decide('p1', { behavior: 'allow', persistForSession: false })
    })
    // Optimistic remove.
    await waitFor(() => expect(result.current.pending).toEqual([]))

    // Reject POST → recovery GET fires (deferred, still pending).
    await act(async () => {
      postDeferred.reject(new Error('server down'))
      await Promise.resolve()
    })

    // A newer live request, then a resolution, arrive for the same id.
    act(() => {
      result.current.onRequest(makePermissionRequest('p1', 'Write'))
    })
    act(() => {
      result.current.onResolved({ id: 'p1', behavior: 'allow', persisted: false })
    })
    expect(result.current.pending).toEqual([])

    // Stale recovery fails — must not re-insert the captured old request.
    await act(async () => {
      recoveryDeferred.reject(new Error('also down'))
      await decidePromise.catch(() => {})
    })

    expect(result.current.pending).toEqual([])
  })

  // ── Wrapper does not leak core internals ────────────────────────

  it('does not expose submit or other core internals', () => {
    const { result } = renderHook(() => usePermissionChannel('s1'))
    expect(result.current).not.toHaveProperty('submit')
    expect(result.current).not.toHaveProperty('recoveryTokens')
  })
})
