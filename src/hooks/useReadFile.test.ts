import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('./useApi', () => ({
  api: { get: vi.fn() },
}))

import { useReadFile } from './useReadFile'
import { api } from './useApi'

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>

describe('useReadFile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not fetch when path is null', () => {
    renderHook(() => useReadFile('s1', null))
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('fetches the encoded path on mount and surfaces the contents', async () => {
    mockGet.mockResolvedValue({ available: true, contents: 'hello' })
    const { result } = renderHook(() => useReadFile('s1', '/repo/a.txt'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/read-file?path=%2Frepo%2Fa.txt')
    expect(result.current.contents).toBe('hello')
    expect(result.current.available).toBe(true)
    expect(result.current.data).toEqual({ available: true, contents: 'hello' })
    expect(result.current.error).toBeNull()
  })

  it('refetches when the path changes', async () => {
    mockGet.mockResolvedValue({ available: true, contents: 'one' })
    const { result, rerender } = renderHook(({ p }) => useReadFile('s1', p), { initialProps: { p: '/a.txt' } })
    await waitFor(() => expect(result.current.contents).toBe('one'))

    mockGet.mockResolvedValue({ available: true, contents: 'two' })
    rerender({ p: '/b.txt' })
    await waitFor(() => expect(result.current.contents).toBe('two'))
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(mockGet.mock.calls[1][0]).toBe('/sessions/s1/read-file?path=%2Fb.txt')
  })

  it('surfaces available:false when the read was denied/missing', async () => {
    mockGet.mockResolvedValue({ available: false })
    const { result } = renderHook(() => useReadFile('s1', '/secret.txt'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.available).toBe(false)
    expect(result.current.contents).toBeUndefined()
    expect(result.current.error).toBeNull()
    // data is non-null once settled, so the viewer can distinguish a real
    // denial from a still-pending read.
    expect(result.current.data).toEqual({ available: false })
  })

  it('surfaces a fetch error', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useReadFile('s1', '/a.txt'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('boom')
    expect(result.current.contents).toBeUndefined()
    expect(result.current.available).toBe(false)
  })

  it('refetch() re-runs the request', async () => {
    mockGet.mockResolvedValue({ available: true, contents: 'v1' })
    const { result } = renderHook(() => useReadFile('s1', '/a.txt'))
    await waitFor(() => expect(result.current.contents).toBe('v1'))

    mockGet.mockResolvedValue({ available: true, contents: 'v2' })
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.contents).toBe('v2'))
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})