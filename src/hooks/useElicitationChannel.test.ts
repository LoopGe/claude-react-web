import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ElicitationRequestUi } from '../types'

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
import { useElicitationChannel } from './useElicitationChannel'

// ── Test data ──────────────────────────────────────────────────────

function makeElicitation(id: string, serverName = 'github'): ElicitationRequestUi {
  return {
    id,
    serverName,
    message: 'Sign in to continue',
    mode: 'url',
    url: 'https://example.com/auth',
    createdAt: Date.now(),
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('useElicitationChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: GET /elicitations returns empty list.
    mockGet.mockResolvedValue({ pending: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Initial load ──────────────────────────────────────────────

  it('fetches pending elicitations from REST on mount', async () => {
    const existing = makeElicitation('e1')
    mockGet.mockResolvedValueOnce({ pending: [existing] })

    const { result } = renderHook(() => useElicitationChannel('s1'))

    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('e1')
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/elicitations')
  })

  it('handles REST fetch failure gracefully', async () => {
    mockGet.mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() => useElicitationChannel('s1'))

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    expect(result.current.pending).toEqual([])
  })

  it('does not fetch when sessionId is empty (e.g. no side chat)', async () => {
    // Mirrors usePermissionChannel: the side-chat slot subscribes with ''
    // when no session exists; the snapshot effect must short-circuit so we
    // don't fire `/sessions//elicitations` (404) on every panel mount.
    renderHook(() => useElicitationChannel(''))

    await Promise.resolve()
    await Promise.resolve()
    expect(mockGet).not.toHaveBeenCalled()
  })

  // ── onRequest / onResolved ────────────────────────────────────

  it('adds request via onRequest', () => {
    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('e1')
  })

  it('ignores onRequest with missing id', () => {
    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest({ ...makeElicitation(''), id: '' })
    })
    expect(result.current.pending).toEqual([])
  })

  it('deduplicates requests by id (updates in-place)', () => {
    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
      result.current.onRequest(makeElicitation('e1'))
    })
    expect(result.current.pending).toHaveLength(1)
  })

  it('removes request via onResolved', () => {
    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
      result.current.onRequest(makeElicitation('e2'))
    })
    expect(result.current.pending).toHaveLength(2)

    act(() => {
      result.current.onResolved({ id: 'e1', decision: { action: 'accept' } })
    })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0].id).toBe('e2')
  })

  // ── decide ────────────────────────────────────────────────────

  it('optimistically removes request on decide', async () => {
    mockPost.mockResolvedValueOnce({ ok: true })

    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
    })
    expect(result.current.pending).toHaveLength(1)

    await act(async () => {
      await result.current.decide('e1', { action: 'accept', content: { token: 't' } })
    })

    expect(result.current.pending).toEqual([])
    expect(mockPost).toHaveBeenCalledWith(
      '/sessions/s1/elicitations/e1/decide',
      { action: 'accept', content: { token: 't' } },
    )
  })

  it('shows error and re-fetches pending on decide failure', async () => {
    mockPost.mockRejectedValueOnce(new Error('server down'))
    // Re-fetch after failure returns the original request.
    mockGet.mockResolvedValueOnce({ pending: [makeElicitation('e1')] })

    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
    })

    await act(async () => {
      await result.current.decide('e1', { action: 'cancel' })
    })

    expect(result.current.error).toContain('Elicitation decision failed')
    expect(result.current.error).toContain('server down')
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/elicitations')
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
  })

  it('re-inserts optimistically-removed request when both POST and recovery fetch fail', async () => {
    mockGet
      .mockResolvedValueOnce({ pending: [] })
      .mockRejectedValueOnce(new Error('also down'))
    mockPost.mockRejectedValueOnce(new Error('server down'))

    const { result } = renderHook(() => useElicitationChannel('s1'))

    const req = makeElicitation('e1')
    act(() => {
      result.current.onRequest(req)
    })
    expect(result.current.pending).toHaveLength(1)

    await act(async () => {
      await result.current.decide('e1', { action: 'accept' })
    })

    expect(result.current.error).toContain('Elicitation decision failed')
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1)
    })
    expect(result.current.pending[0].id).toBe('e1')
  })

  // ── reset / clearError ────────────────────────────────────────

  it('clears all state on reset()', () => {
    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
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

    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
    })

    await act(async () => {
      await result.current.decide('e1', { action: 'cancel' })
    })
    expect(result.current.error).toBeTruthy()

    act(() => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()
  })

  // ── mergePending behavior ─────────────────────────────────────

  it('preserves order of existing entries when merging new ones', () => {
    const { result } = renderHook(() => useElicitationChannel('s1'))

    act(() => {
      result.current.onRequest(makeElicitation('e1'))
      result.current.onRequest(makeElicitation('e2'))
      result.current.onRequest(makeElicitation('e3'))
    })
    expect(result.current.pending.map((p) => p.id)).toEqual(['e1', 'e2', 'e3'])

    // Update e2 in-place and add e4.
    const updatedE2 = makeElicitation('e2', 'linear')
    act(() => {
      result.current.onRequest(updatedE2)
      result.current.onRequest(makeElicitation('e4'))
    })
    expect(result.current.pending.map((p) => p.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(result.current.pending[1].serverName).toBe('linear') // Updated
  })
})
