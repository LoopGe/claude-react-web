import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { UserDialogRequestUi } from '../types'

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
import { useUserDialogChannel } from './useUserDialogChannel'

// ── Test data ──────────────────────────────────────────────────────

function makeDialog(id: string, fallbackModel = 'model-b'): UserDialogRequestUi {
  return {
    id,
    dialogKind: 'refusal_fallback_prompt',
    payload: {
      originalModel: 'model-a',
      fallbackModel,
      guidanceText: 'The model refused to continue.',
      retractedMessageUuids: ['u1'],
    },
    createdAt: Date.now(),
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('useUserDialogChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: GET /dialogs returns empty list.
    mockGet.mockResolvedValue({ pending: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Initial load ──────────────────────────────────────────────

  it('fetches pending dialogs from REST on mount', async () => {
    const existing = makeDialog('d1')
    mockGet.mockResolvedValueOnce({ pending: [existing] })

    const { result } = renderHook(() => useUserDialogChannel('s1'))

    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('d1')
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/dialogs')
  })

  it('handles REST fetch failure gracefully', async () => {
    mockGet.mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() => useUserDialogChannel('s1'))

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    expect(result.current.pending).toEqual([])
  })

  it('does not fetch when sessionId is empty', async () => {
    renderHook(() => useUserDialogChannel(''))

    await Promise.resolve()
    await Promise.resolve()
    expect(mockGet).not.toHaveBeenCalled()
  })

  // ── onRequest / onResolved ────────────────────────────────────

  it('adds request via onRequest', () => {
    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('d1')
  })

  it('ignores onRequest with missing id', () => {
    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest({ ...makeDialog(''), id: '' })
    })
    expect(result.current.pending).toEqual([])
  })

  it('deduplicates requests by id (updates in-place)', () => {
    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
      result.current.onRequest(makeDialog('d1'))
    })
    expect(result.current.pending).toHaveLength(1)
  })

  it('removes request via onResolved', () => {
    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
      result.current.onRequest(makeDialog('d2'))
    })
    expect(result.current.pending).toHaveLength(2)

    act(() => {
      result.current.onResolved({
        id: 'd1',
        decision: { behavior: 'completed', result: 'retry_fallback' },
        retractedMessageUuids: ['u1'],
      })
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('d2')
  })

  // ── decide ────────────────────────────────────────────────────

  it('optimistically removes request on decide', async () => {
    mockPost.mockResolvedValueOnce({ ok: true })

    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
    })
    expect(result.current.pending).toHaveLength(1)

    await act(async () => {
      await result.current.decide('d1', { behavior: 'completed', result: 'retry_fallback' })
    })

    expect(result.current.pending).toEqual([])
    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/dialogs/d1/decide',
      { behavior: 'completed', result: 'retry_fallback' },
    )
  })

  it('shows error and re-fetches pending on decide failure', async () => {
    mockPost.mockRejectedValueOnce(new Error('server down'))
    // Re-fetch after failure returns the original request.
    mockGet.mockResolvedValueOnce({ pending: [makeDialog('d1')] })

    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
    })

    await act(async () => {
      await result.current.decide('d1', { behavior: 'cancelled' })
    })

    expect(result.current.error).toContain('Dialog decision failed')
    expect(result.current.error).toContain('server down')
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/dialogs')
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
  })

  it('re-inserts optimistically-removed request when both POST and recovery fetch fail', async () => {
    mockGet
      .mockResolvedValueOnce({ pending: [] })
      .mockRejectedValueOnce(new Error('also down'))
    mockPost.mockRejectedValueOnce(new Error('server down'))

    const { result } = renderHook(() => useUserDialogChannel('s1'))

    const req = makeDialog('d1')
    act(() => {
      result.current.onRequest(req)
    })
    expect(result.current.pending).toHaveLength(1)

    await act(async () => {
      await result.current.decide('d1', { behavior: 'cancelled' })
    })

    expect(result.current.error).toContain('Dialog decision failed')
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('d1')
  })

  // ── reset / clearError ────────────────────────────────────────

  it('clears all state on reset()', () => {
    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
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

    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
    })

    await act(async () => {
      await result.current.decide('d1', { behavior: 'cancelled' })
    })
    expect(result.current.error).toBeTruthy()

    act(() => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()
  })

  // ── mergePending behavior ─────────────────────────────────────

  it('preserves order of existing entries when merging new ones', () => {
    const { result } = renderHook(() => useUserDialogChannel('s1'))

    act(() => {
      result.current.onRequest(makeDialog('d1'))
      result.current.onRequest(makeDialog('d2'))
      result.current.onRequest(makeDialog('d3'))
    })
    expect(result.current.pending.map((p) => p.id)).toEqual(['d1', 'd2', 'd3'])

    // Update d2 in-place and add d4.
    const updatedD2 = makeDialog('d2', 'model-c')
    act(() => {
      result.current.onRequest(updatedD2)
      result.current.onRequest(makeDialog('d4'))
    })
    expect(result.current.pending.map((p) => p.id)).toEqual(['d1', 'd2', 'd3', 'd4'])
    expect(result.current.pending[1].payload.fallbackModel).toBe('model-c') // Updated
  })
})
