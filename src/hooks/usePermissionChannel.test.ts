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
})
