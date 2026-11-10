import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './useApi'
import { useMessagePreview, type MessagePreviewTarget } from './useMessagePreview'
import type { SessionSearchHit } from '../../shared/session-search'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))

const HIT: SessionSearchHit = {
  seq: 5,
  messageSeq: 5,
  messageUuid: 'm5',
  turnSeq: 1,
  turnNo: 1,
  turnPrompt: 'prompt',
  role: 'assistant',
  snippet: 'snippet',
  matchCount: 1,
}

const HIT_TARGET: MessagePreviewTarget = { kind: 'hit', hit: HIT, query: 'foo' }
const UUID_TARGET: MessagePreviewTarget = { kind: 'uuid', uuid: 'm5', query: 'foo' }

function page(seq: number) {
  return {
    generation: 0,
    headSeq: 20,
    totalCount: 1,
    startIndex: seq,
    hasMore: false,
    messages: [{ seq, uuid: `m${seq}`, msg: { type: 'assistant', uuid: `m${seq}` } }],
    tombstones: [],
  }
}

describe('useMessagePreview', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
  })

  it('fetches a centered page for a search hit', async () => {
    vi.mocked(api.get).mockResolvedValue(page(5))
    const { result } = renderHook(() => useMessagePreview('s1', HIT_TARGET))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(api.get).toHaveBeenCalledWith('/sessions/s1/messages?around=5&limit=41', expect.anything())
    expect(result.current.page?.messages[0].seq).toBe(5)
    expect(result.current.error).toBeNull()
  })

  it('resolves a palette target by uuid', async () => {
    vi.mocked(api.get).mockResolvedValue(page(5))
    renderHook(() => useMessagePreview('s1', UUID_TARGET))

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        '/sessions/s1/messages?aroundUuid=m5&limit=41',
        expect.anything(),
      ),
    )
  })

  it('centers the page on the matched message, not its owner', async () => {
    vi.mocked(api.get).mockResolvedValue(page(9))
    const target: MessagePreviewTarget = {
      kind: 'hit',
      hit: { ...HIT, seq: 5, messageSeq: 9, messageUuid: 'm9' },
      query: 'foo',
    }
    renderHook(() => useMessagePreview('s1', target))

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/sessions/s1/messages?around=9&limit=41', expect.anything()),
    )
  })

  it('maps a 404 to not-found', async () => {
    vi.mocked(api.get).mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    const { result } = renderHook(() => useMessagePreview('s1', HIT_TARGET))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('not-found')
    expect(result.current.page).toBeNull()
  })

  it('retries after a failure', async () => {
    vi.mocked(api.get)
      .mockRejectedValueOnce(Object.assign(new Error('down'), { status: 500 }))
      .mockResolvedValueOnce(page(5))
    const { result } = renderHook(() => useMessagePreview('s1', HIT_TARGET))

    await waitFor(() => expect(result.current.error).toBe('failed'))
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.page?.messages[0].seq).toBe(5))
    expect(result.current.error).toBeNull()
  })

  it('ignores a stale response that lands after the target changed', async () => {
    let resolveFirst!: (value: unknown) => void
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    vi.mocked(api.get).mockReturnValueOnce(first as Promise<never>)
    vi.mocked(api.get).mockResolvedValueOnce(page(9))

    const { result, rerender } = renderHook(
      ({ target }: { target: MessagePreviewTarget }) => useMessagePreview('s1', target),
      { initialProps: { target: HIT_TARGET } },
    )
    rerender({ target: { kind: 'hit', hit: { ...HIT, seq: 9 }, query: 'foo' } })
    await waitFor(() => expect(result.current.page?.messages[0].seq).toBe(9))

    await act(async () => {
      resolveFirst(page(5))
      await first
    })
    expect(result.current.page?.messages[0].seq).toBe(9)
  })
})