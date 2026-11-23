import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockGet = vi.fn()
vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}))

import { useFileSearch } from './useFileSearch'

beforeEach(() => {
  vi.useFakeTimers()
  mockGet.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useFileSearch', () => {
  it('debounces ~150ms before fetching, then returns the results', async () => {
    mockGet.mockResolvedValue({ results: [{ path: 'a.ts', dir: false }] })
    const { result } = renderHook(() => useFileSearch('s1', 'a', true))

    expect(mockGet).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(149) })
    expect(mockGet).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0]![0]).toBe('/sessions/s1/file-search?q=a&limit=20')
    expect(result.current.results).toEqual([{ path: 'a.ts', dir: false }])
    expect(result.current.loading).toBe(false)
  })

  it('encodes the session id and query into the path', async () => {
    mockGet.mockResolvedValue({ results: [] })
    renderHook(() => useFileSearch('s/1', 'my dir/', true))
    await act(async () => { vi.advanceTimersByTime(150) })
    expect(mockGet.mock.calls[0]![0]).toBe('/sessions/s%2F1/file-search?q=my%20dir%2F&limit=20')
  })

  it('aborts the in-flight request when the query changes and ignores its late result', async () => {
    let resolveFirst!: (v: { results: { path: string; dir: boolean }[] }) => void
    let firstSignal!: AbortSignal
    mockGet
      .mockImplementationOnce((_path: string, opts: { signal: AbortSignal }) => {
        firstSignal = opts.signal
        return new Promise((res) => { resolveFirst = res })
      })
      .mockImplementationOnce(() => Promise.resolve({ results: [{ path: 'b.ts', dir: false }] }))

    const { result, rerender } = renderHook(({ q }) => useFileSearch('s1', q, true), {
      initialProps: { q: 'a' },
    })
    act(() => { vi.advanceTimersByTime(150) })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(firstSignal.aborted).toBe(false)

    // Query change aborts the stale request before the new debounce fires.
    rerender({ q: 'ab' })
    expect(firstSignal.aborted).toBe(true)

    // A late resolution of the aborted request must not overwrite state.
    await act(async () => { resolveFirst({ results: [{ path: 'stale.ts', dir: false }] }) })
    expect(result.current.results).not.toContainEqual({ path: 'stale.ts', dir: false })
    // …and an aborted request never settles its query.
    expect(result.current.settledQuery).toBeNull()

    await act(async () => { vi.advanceTimersByTime(150) })
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.results).toEqual([{ path: 'b.ts', dir: false }])
    expect(result.current.settledQuery).toBe('ab')
  })

  it('does not fetch while disabled and returns empty results', () => {
    const { result } = renderHook(() => useFileSearch('s1', 'a', false))
    act(() => { vi.advanceTimersByTime(300) })
    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(result.current.settledQuery).toBeNull()
  })

  it('does not fetch for an empty query', () => {
    const { result } = renderHook(() => useFileSearch('s1', '', true))
    act(() => { vi.advanceTimersByTime(300) })
    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
  })

  it('does not fetch without a session id', () => {
    renderHook(() => useFileSearch(null, 'a', true))
    act(() => { vi.advanceTimersByTime(300) })
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('clears results when a fetch fails (no candidates, not a crash)', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useFileSearch('s1', 'a', true))
    await act(async () => { vi.advanceTimersByTime(150) })
    expect(result.current.results).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  // settledQuery is the "settled for THIS query" signal the composer's Enter
  // fall-through reads: results alone cannot tell a genuinely-empty search
  // from the debounce window / an in-flight request showing stale rows.
  it('echoes the resolved query once settled; null before the first settle', async () => {
    mockGet.mockResolvedValue({ results: [] })
    const { result } = renderHook(() => useFileSearch('s1', 'bob', true))
    expect(result.current.settledQuery).toBeNull()
    act(() => { vi.advanceTimersByTime(149) })
    expect(result.current.settledQuery).toBeNull()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(result.current.settledQuery).toBe('bob')
    expect(result.current.loading).toBe(false)
  })

  it('keeps the PREVIOUS settled query during the next debounce window (stale-visible)', async () => {
    mockGet.mockResolvedValue({ results: [{ path: 'a.ts', dir: false }] })
    const { result, rerender } = renderHook(({ q }) => useFileSearch('s1', q, true), {
      initialProps: { q: 'a' },
    })
    await act(async () => { vi.advanceTimersByTime(150) })
    expect(result.current.settledQuery).toBe('a')

    // Query change: stale results stay visible, but the echo still names the
    // query that produced them — NOT the one being typed.
    rerender({ q: 'ab' })
    expect(result.current.results).toEqual([{ path: 'a.ts', dir: false }])
    expect(result.current.settledQuery).toBe('a')
    act(() => { vi.advanceTimersByTime(149) })
    expect(result.current.settledQuery).toBe('a')

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(result.current.settledQuery).toBe('ab')
  })

  it('a failed search settles its query too (empty candidates, not stuck pending)', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useFileSearch('s1', 'bob', true))
    await act(async () => { vi.advanceTimersByTime(150) })
    expect(result.current.settledQuery).toBe('bob')
    expect(result.current.results).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('an empty query never settles (nothing is searched)', () => {
    const { result } = renderHook(() => useFileSearch('s1', '', true))
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.settledQuery).toBeNull()
  })
})
