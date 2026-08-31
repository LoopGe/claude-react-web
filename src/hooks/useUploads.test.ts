import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mock useApi ─────────────────────────────────────────────────────
const mockGet = vi.fn()
const mockDelete = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))

// Import AFTER the mock.
import { useUploads } from './useUploads'

const ENTRIES = [
  { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 10, uploadedAt: 1, sessionTitle: 'S', exists: true },
  { id: 'b', path: '/p/claude-web-uploads/2-b.txt', cwd: '/p', name: 'b.txt', size: 20, uploadedAt: 2, sessionTitle: 'S', exists: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ uploads: ENTRIES })
  mockDelete.mockResolvedValue({ ok: true })
})

describe('useUploads', () => {
  it('does not fetch while closed', () => {
    renderHook(() => useUploads(false))
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('fetches on open and exposes the list', async () => {
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.uploads).toEqual(ENTRIES))
    expect(mockGet).toHaveBeenCalledWith('/uploads')
    expect(result.current.error).toBeNull()
  })

  it('exposes fetch errors and keeps uploads null', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.uploads).toBeNull()
  })

  it('remove() deletes then refreshes', async () => {
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.uploads).not.toBeNull())

    await act(() => result.current.remove('a'))
    expect(mockDelete).toHaveBeenCalledWith('/uploads/a')
    expect(mockGet).toHaveBeenCalledTimes(2) // initial + refresh
  })

  it('removeMany() deletes sequentially then refreshes once', async () => {
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.uploads).not.toBeNull())

    mockGet.mockClear()
    await act(() => result.current.removeMany(['a', 'b']))
    expect(mockDelete).toHaveBeenCalledTimes(2)
    expect(mockGet).toHaveBeenCalledTimes(1) // single refresh after the batch
  })
})
