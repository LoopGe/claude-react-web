/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { TASK_RESULT_PAGE_MAX_CHARS } from '../../shared/tasks'
import { useTaskResult } from './useTaskResult'
import { api } from './useApi'

vi.mock('./useApi', () => ({
  api: { get: vi.fn() },
}))

const get = vi.mocked(api.get)

describe('useTaskResult', () => {
  beforeEach(() => get.mockReset())

  it('does not fetch while hidden and loads only the bounded tail when enabled', async () => {
    get.mockResolvedValue({
      available: true, taskId: 't1', runId: 'run-a', updatedAt: 7,
      offset: 90, totalChars: 100, result: 'tail', nextOffset: 100, hasMore: false,
    })
    const props = {
      sessionId: 's1', taskId: 't1', runId: 'run-a', updatedAt: 7,
      totalChars: 200_000, enabled: false,
    }
    const { rerender } = renderHook((p) => useTaskResult(p), { initialProps: props })
    expect(get).not.toHaveBeenCalled()
    rerender({ ...props, enabled: true })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    expect(get.mock.calls[0][0]).toContain(`offset=${200_000 - TASK_RESULT_PAGE_MAX_CHARS}`)
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  })

  it('replaces the current page on navigation without accumulating bodies', async () => {
    get
      .mockResolvedValueOnce({
        available: true, taskId: 't1', runId: 'run-a', updatedAt: 7,
        offset: 50, totalChars: 100, result: 'second', nextOffset: 100, hasMore: false,
      })
      .mockResolvedValueOnce({
        available: true, taskId: 't1', runId: 'run-a', updatedAt: 7,
        offset: 0, totalChars: 100, result: 'first', nextOffset: 50, hasMore: true,
      })
    const { result } = renderHook(() => useTaskResult({
      sessionId: 's1', taskId: 't1', runId: 'run-a', updatedAt: 7,
      totalChars: 100, enabled: true,
    }))
    await waitFor(() => expect(result.current.page?.result).toBe('second'))
    act(() => result.current.loadPrevious())
    await waitFor(() => expect(result.current.page?.result).toBe('first'))
    expect(result.current.page?.result).not.toContain('second')
  })

  it('hides the previous run page immediately when task identity changes', async () => {
    get.mockResolvedValueOnce({
      available: true, taskId: 't1', runId: 'run-a', updatedAt: 7,
      offset: 0, totalChars: 4, result: 'old!', nextOffset: 4, hasMore: false,
    })
    const props = {
      sessionId: 's1', taskId: 't1', runId: 'run-a', updatedAt: 7,
      totalChars: 4, enabled: true,
    }
    const { result, rerender } = renderHook((p) => useTaskResult(p), { initialProps: props })
    await waitFor(() => expect(result.current.page?.result).toBe('old!'))
    get.mockReturnValueOnce(new Promise(() => {}))
    rerender({ ...props, runId: 'run-b', updatedAt: 8 })
    expect(result.current.page).toBeUndefined()
  })

  it('uses non-overlapping previous windows and retries the failed target offset', async () => {
    get
      .mockResolvedValueOnce({
        available: true, taskId: 't1', runId: 'run-a', updatedAt: 7,
        offset: 68_928, totalChars: 200_000, result: 'tail', nextOffset: 200_000, hasMore: false,
      })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        available: true, taskId: 't1', runId: 'run-a', updatedAt: 7,
        offset: 0, totalChars: 200_000, result: 'first', nextOffset: 68_928, hasMore: true,
      })
    const { result } = renderHook(() => useTaskResult({
      sessionId: 's1', taskId: 't1', runId: 'run-a', updatedAt: 7,
      totalChars: 200_000, enabled: true,
    }))
    await waitFor(() => expect(result.current.page?.result).toBe('tail'))
    act(() => result.current.loadPrevious())
    await waitFor(() => expect(result.current.error).toBe('temporary'))
    expect(get.mock.calls[1][0]).toContain('offset=0&limit=68928')
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.page?.result).toBe('first'))
    expect(get.mock.calls[2][0]).toContain('offset=0&limit=68928')
    act(() => result.current.loadNext())
    expect(get.mock.calls[3][0]).toContain('offset=68928&limit=131072')
  })

  it('reloads a same-looking task identity when the session changes', async () => {
    get
      .mockResolvedValueOnce({
        available: true, taskId: 'shared-task', runId: 'run-a', updatedAt: 7,
        offset: 0, totalChars: 1, result: 'A', nextOffset: 1, hasMore: false,
      })
      .mockResolvedValueOnce({
        available: true, taskId: 'shared-task', runId: 'run-a', updatedAt: 7,
        offset: 0, totalChars: 1, result: 'B', nextOffset: 1, hasMore: false,
      })
    const props = {
      sessionId: 'session-a', taskId: 'shared-task', runId: 'run-a', updatedAt: 7,
      totalChars: 1, enabled: true,
    }
    const { result, rerender } = renderHook((p) => useTaskResult(p), { initialProps: props })
    await waitFor(() => expect(result.current.page?.result).toBe('A'))
    rerender({ ...props, sessionId: 'session-b' })
    await waitFor(() => expect(result.current.page?.result).toBe('B'))
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('includes the result generation in each request identity', async () => {
    let request = 0
    get.mockImplementation(() => {
      request += 1
      return Promise.resolve({
        available: true, taskId: 'generation-dedup', runId: 'run-a', updatedAt: 7,
        resultVersion: request === 1 ? 101 : 202,
        offset: 68_928, totalChars: 200_000, result: 'tail', nextOffset: 200_000, hasMore: false,
      })
    })
    const props = {
      sessionId: 's1', taskId: 'generation-dedup', runId: 'run-a', updatedAt: 7, resultVersion: 101,
      totalChars: 200_000, enabled: true,
    }
    const { rerender } = renderHook((p) => useTaskResult(p), { initialProps: props })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    rerender({ ...props, updatedAt: 8, resultVersion: 202 })
    await waitFor(() => expect(get.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('resultVersion=101'),
      expect.stringContaining('resultVersion=202'),
    ]))
    expect(get.mock.calls[0][0]).toContain('resultVersion=101')
    expect(get.mock.calls[1][0]).toContain('resultVersion=202')
  })

  it('rejects a response from a different result generation', async () => {
    get.mockResolvedValue({
      available: true, taskId: 't1', runId: 'run-b', updatedAt: 8,
      offset: 0, totalChars: 4, result: 'new!', nextOffset: 4, hasMore: false,
    })
    const { result } = renderHook(() => useTaskResult({
      sessionId: 's1', taskId: 't1', runId: 'run-a', updatedAt: 7,
      totalChars: 4, enabled: true,
    }))
    await waitFor(() => expect(result.current.error).toContain('changed'))
    expect(result.current.page).toBeUndefined()
  })
})
