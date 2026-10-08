import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockPost = vi.fn()
vi.mock('./useApi', () => ({
  api: { get: vi.fn(), post: (...args: unknown[]) => mockPost(...args) },
}))

// WS hub mock: capture the global listener so tests can emit frames.
let listener: ((frame: unknown) => void) | null = null
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    addListener: (fn: (frame: unknown) => void) => {
      listener = fn
      return () => { listener = null }
    },
  }),
}))

import { useClientDebug } from './useClientDebug'

function emit(frame: unknown) {
  listener?.(frame)
}

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ ok: true })
  listener = null
})

afterEach(() => {
  // Nothing renders, but keep symmetric with other hook tests.
  document.body.innerHTML = ''
})

describe('useClientDebug', () => {
  it('answers a client-debug-request with the executor result', async () => {
    renderHook(() => useClientDebug())
    document.body.innerHTML = '<h1 class="t">Title</h1>'

    emit({ kind: 'client-debug-request', id: 'req-1', op: 'dom_query', params: { selector: 'h1' } })
    await vi.waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost).toHaveBeenCalledWith('/client-debug/req-1/answer', {
      ok: true,
      result: { total: 1, nodes: [expect.objectContaining({ tag: 'H1', text: 'Title' })] },
    })
  })

  it('answers with ok:false when the executor fails', async () => {
    renderHook(() => useClientDebug())

    emit({ kind: 'client-debug-request', id: 'req-2', op: 'dom_query', params: { selector: '<<<' } })
    await vi.waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost).toHaveBeenCalledWith('/client-debug/req-2/answer', {
      ok: false,
      error: expect.stringMatching(/selector/i),
    })
  })

  it('ignores other frame kinds', () => {
    renderHook(() => useClientDebug())
    emit({ kind: 'message', sessionId: 's1' })
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('does not send a second failure answer when the success POST itself fails (lost first-answer race)', async () => {
    renderHook(() => useClientDebug())
    document.body.innerHTML = '<h1>Title</h1>'
    mockPost.mockRejectedValueOnce(new Error('404 already answered'))

    emit({ kind: 'client-debug-request', id: 'req-3', op: 'dom_query', params: { selector: 'h1' } })
    await vi.waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    // Give the catch path a chance to fire a spurious second POST.
    await new Promise((r) => setTimeout(r, 20))
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('unregisters its listener on unmount', () => {
    const { unmount } = renderHook(() => useClientDebug())
    unmount()
    expect(listener).toBeNull()
  })
})
