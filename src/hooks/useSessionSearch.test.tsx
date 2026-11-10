import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './useApi'
import { useSessionSearch } from './useSessionSearch'
import type { SessionSearchHit, SessionSearchResponse } from '../../shared/session-search'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))
const get = vi.mocked(api.get)

function hit(messageSeq: number, overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    seq: messageSeq,
    messageSeq,
    messageUuid: `u${messageSeq}`,
    turnSeq: 0,
    turnNo: 1,
    turnPrompt: 'prompt',
    role: 'assistant',
    snippet: 'snippet',
    matchCount: 1,
    ...overrides,
  }
}

function response(overrides: Partial<SessionSearchResponse> = {}): SessionSearchResponse {
  return { query: 'q', hits: [], totalHits: 0, truncated: false, indexStatus: 'ok', ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  get.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSessionSearch', () => {
  it('does not request for an empty query', () => {
    const { result } = renderHook(() => useSessionSearch('s1', '   '))
    act(() => vi.advanceTimersByTime(300))
    expect(get).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    expect(result.current.hits).toEqual([])
  })

  it('debounces and aborts the previous request', () => {
    get.mockResolvedValueOnce(response())
    const { rerender } = renderHook(({ q }: { q: string }) => useSessionSearch('s1', q), {
      initialProps: { q: '' },
    })
    rerender({ q: 'a' })
    act(() => vi.advanceTimersByTime(179))
    expect(get).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(get).toHaveBeenCalledTimes(1)
    const firstSignal = get.mock.calls[0]![1]?.signal

    get.mockReturnValueOnce(new Promise(() => {}))
    rerender({ q: 'ab' })
    act(() => vi.advanceTimersByTime(180))
    expect(get).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)
  })

  it('ignores an out-of-order response', async () => {
    const first = deferred<SessionSearchResponse>()
    const second = deferred<SessionSearchResponse>()
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const { result, rerender } = renderHook(({ q }: { q: string }) => useSessionSearch('s1', q), {
      initialProps: { q: 'first' },
    })
    act(() => vi.advanceTimersByTime(180))
    rerender({ q: 'second' })
    act(() => vi.advanceTimersByTime(180))

    await act(async () => {
      second.resolve(response({ hits: [hit(5)], totalHits: 1 }))
      await Promise.resolve()
    })
    expect(result.current.hits[0]?.messageSeq).toBe(5)

    await act(async () => {
      first.resolve(response({ hits: [hit(1)], totalHits: 1 }))
      await Promise.resolve()
    })
    expect(result.current.hits[0]?.messageSeq).toBe(5)
  })

  it('surfaces degraded and error states, and retries', async () => {
    get.mockResolvedValueOnce(response({ indexStatus: 'degraded' }))
    const { result } = renderHook(() => useSessionSearch('s1', 'q'))
    act(() => vi.advanceTimersByTime(180))
    await act(async () => { await Promise.resolve() })
    expect(result.current.indexStatus).toBe('degraded')

    get.mockRejectedValueOnce(new Error('boom'))
    act(() => result.current.retry())
    act(() => vi.advanceTimersByTime(180))
    await act(async () => { await Promise.resolve() })
    expect(result.current.error).toBe(true)
    expect(result.current.hits).toEqual([])
    expect(get).toHaveBeenCalledTimes(2)
  })
})