import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('./useApi', () => ({
  api: { post: vi.fn() },
}))

import { useStructuredRun } from './useStructuredRun'
import { api } from './useApi'

const mockPost = api.post as unknown as ReturnType<typeof vi.fn>

const REQ = { prompt: 'p', schema: { type: 'object' } }

describe('useStructuredRun', () => {
  beforeEach(() => vi.clearAllMocks())

  it('posts with the server-owned timeout and surfaces the result', async () => {
    mockPost.mockResolvedValue({ ok: true, structuredOutput: { n: 1 } })
    const { result } = renderHook(() => useStructuredRun())

    await act(async () => {
      await result.current.run(REQ)
    })

    expect(mockPost).toHaveBeenCalledWith(
      '/structured',
      REQ,
      expect.objectContaining({ timeoutMs: 0 }),
    )
    expect(result.current.result).toEqual({ ok: true, structuredOutput: { n: 1 } })
    expect(result.current.running).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('raises running while the request is in flight', async () => {
    let resolveRun: ((v: unknown) => void) | null = null
    mockPost.mockImplementation(() => new Promise((res) => { resolveRun = res }))
    const { result } = renderHook(() => useStructuredRun())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run(REQ)
    })
    expect(result.current.running).toBe(true)

    await act(async () => {
      resolveRun?.({ ok: true })
      await runPromise
    })
    expect(result.current.running).toBe(false)
  })

  it('exposes a non-abort error and clears the running flag', async () => {
    mockPost.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useStructuredRun())
    await act(async () => {
      await result.current.run(REQ)
    })
    expect(result.current.error).toBe('boom')
    expect(result.current.result).toBeNull()
    expect(result.current.running).toBe(false)
  })

  it('swallows the error when the run was cancelled', async () => {
    mockPost.mockImplementation(async (_path: string, _req: unknown, o?: { signal?: AbortSignal }) => {
      // Yield one tick so cancel() can fire before we re-check the signal.
      await new Promise((r) => setTimeout(r, 0))
      if (o?.signal?.aborted) {
        const e = new Error('aborted') as Error & { name: string }
        e.name = 'AbortError'
        throw e
      }
      return { ok: true }
    })
    const { result } = renderHook(() => useStructuredRun())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run(REQ)
    })
    act(() => result.current.cancel())

    await act(async () => {
      await runPromise
    })
    expect(result.current.error).toBeNull()
    expect(result.current.result).toBeNull()
    expect(result.current.running).toBe(false)
  })

  it('reset clears result and error', async () => {
    mockPost.mockResolvedValue({ ok: true, structuredOutput: {} })
    const { result } = renderHook(() => useStructuredRun())
    await act(async () => {
      await result.current.run(REQ)
    })
    expect(result.current.result?.ok).toBe(true)
    act(() => result.current.reset())
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.running).toBe(false)
  })
})