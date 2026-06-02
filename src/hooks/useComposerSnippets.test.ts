import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mock useApi ─────────────────────────────────────────────────────
const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPut = vi.fn()
const mockDelete = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    put: (...a: unknown[]) => mockPut(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))

// Import AFTER the mock.
import { useComposerSnippets } from './useComposerSnippets'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockGet.mockResolvedValue({ snippets: [] })
  mockPost.mockResolvedValue({})
  mockPut.mockResolvedValue({})
  mockDelete.mockResolvedValue({})
})

/** Render the hook and wait for the initial load to settle. */
async function mountSettled() {
  const h = renderHook(() => useComposerSnippets())
  await waitFor(() => expect(h.result.current.loading).toBe(false))
  return h
}

describe('useComposerSnippets', () => {
  it('loads the list from the server on mount', async () => {
    mockGet.mockResolvedValue({ snippets: [{ id: 'a', label: 'A', content: 'x' }] })
    const { result } = await mountSettled()
    expect(mockGet).toHaveBeenCalledWith('/snippets')
    expect(result.current.snippets).toEqual([{ id: 'a', label: 'A', content: 'x' }])
  })

  it('add is optimistic and POSTs to the server', async () => {
    const { result } = await mountSettled()
    let returned: { id: string } | undefined
    act(() => { returned = result.current.add('L', 'C') })
    // Optimistic: appears immediately, synchronously returns a snippet.
    expect(result.current.snippets).toHaveLength(1)
    expect(result.current.snippets[0]).toMatchObject({ label: 'L', content: 'C' })
    expect(returned!.id).toBe(result.current.snippets[0].id)
    expect(mockPost).toHaveBeenCalledWith('/snippets', { id: returned!.id, label: 'L', content: 'C' })
  })

  it('reverts add when the POST fails', async () => {
    mockPost.mockRejectedValue(new Error('boom'))
    const { result } = await mountSettled()
    act(() => { result.current.add('L', 'C') })
    expect(result.current.snippets).toHaveLength(1) // optimistic
    await waitFor(() => expect(result.current.snippets).toHaveLength(0)) // reverted
    expect(result.current.error).toBeTruthy()
  })

  it('move sends the full ordered id list to /reorder', async () => {
    mockGet.mockResolvedValue({ snippets: [
      { id: 'a', label: 'A', content: '1' },
      { id: 'b', label: 'B', content: '2' },
      { id: 'c', label: 'C', content: '3' },
    ] })
    const { result } = await mountSettled()
    act(() => { result.current.move(0, 1) }) // a down → b,a,c
    expect(result.current.snippets.map((s) => s.id)).toEqual(['b', 'a', 'c'])
    expect(mockPut).toHaveBeenCalledWith('/snippets/reorder', { ids: ['b', 'a', 'c'] })
  })

  it('remove is optimistic and reverts on failure', async () => {
    mockGet.mockResolvedValue({ snippets: [{ id: 'a', label: 'A', content: 'x' }] })
    mockDelete.mockRejectedValue(new Error('nope'))
    const { result } = await mountSettled()
    act(() => { result.current.remove('a') })
    expect(result.current.snippets).toHaveLength(0)
    await waitFor(() => expect(result.current.snippets).toHaveLength(1))
  })

  describe('migration', () => {
    it('imports localStorage snippets then clears the local copy', async () => {
      localStorage.setItem('composer-snippets', JSON.stringify([
        { id: 'old', label: 'Old', content: 'data' },
      ]))
      await mountSettled()
      expect(mockPost).toHaveBeenCalledWith('/snippets/import', {
        snippets: [{ id: 'old', label: 'Old', content: 'data' }],
      })
      expect(localStorage.getItem('composer-snippets')).toBeNull()
    })

    it('does NOT clear localStorage when import fails', async () => {
      localStorage.setItem('composer-snippets', JSON.stringify([
        { id: 'old', label: 'Old', content: 'data' },
      ]))
      mockPost.mockRejectedValue(new Error('server down'))
      await mountSettled()
      expect(localStorage.getItem('composer-snippets')).not.toBeNull()
    })

    it('does not import when there is no local data', async () => {
      await mountSettled()
      expect(mockPost).not.toHaveBeenCalledWith('/snippets/import', expect.anything())
    })
  })
})
