// Tests for useImageContent: the render-side ref → blob-URL cache. Unlike
// imageDecodeCache (a pure Blob memo whose URLs are composer-owned), this
// cache OWNS its blob URLs and revokes them on LRU eviction — an entry with
// active subscribers is never evicted, so a mounted <img> (or the Lightbox
// showing its URL) cannot lose its src mid-display.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import {
  useImageContent,
  _setImageContentCapsForTests,
  _clearImageContentCacheForTests,
} from './useImageContent'
import type { ImageAttachmentRef } from '../../shared/image-attachment'

/** Distinct, well-formed refs (sha256:<64 hex>). */
function ref(n: number): ImageAttachmentRef {
  return {
    id: `sha256:${n.toString(16).padStart(64, '0')}`,
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
  }
}

const REF_A = ref(0xaa)
const REF_B = ref(0xbb)
const digestOf = (r: ImageAttachmentRef) => r.id.slice('sha256:'.length)

let urlCounter = 0
const createObjectURL = vi.fn(() => `blob:content-${++urlCounter}`)
const revokeObjectURL = vi.fn()

/** Content-route fetch stub: every digest resolves to the same 4 bytes. */
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('/api/attachments/images/')) throw new Error(`unexpected fetch: ${url}`)
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'Content-Type': 'image/png' },
    }) as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

beforeEach(() => {
  urlCounter = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL, configurable: true, writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL, configurable: true, writable: true,
  })
  _clearImageContentCacheForTests()
  _setImageContentCapsForTests(null)
  stubFetch()
})

afterEach(() => {
  _clearImageContentCacheForTests()
  _setImageContentCapsForTests(null)
  vi.unstubAllGlobals()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).createObjectURL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).revokeObjectURL
})

describe('useImageContent', () => {
  it('fetches the content route by bare digest and returns a blob URL', async () => {
    const fetchMock = stubFetch()
    const { result } = renderHook(() => useImageContent(REF_A))
    // Loading: no URL yet.
    expect(result.current).toEqual({ url: null, failed: false })
    await waitFor(() => expect(result.current.url).toBe('blob:content-1'))
    expect(result.current.failed).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/attachments/images/${digestOf(REF_A)}`)
  })

  it('a cache hit serves the same URL without refetching', async () => {
    const fetchMock = stubFetch()
    const first = renderHook(() => useImageContent(REF_A))
    await waitFor(() => expect(first.result.current.url).toBe('blob:content-1'))
    const second = renderHook(() => useImageContent(REF_A))
    // The hit is synchronous — no loading frame for an already-cached ref.
    expect(second.result.current.url).toBe('blob:content-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('concurrent subscribers share one fetch', async () => {
    const gate = deferred<Response>()
    const fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const a = renderHook(() => useImageContent(REF_A))
    const b = renderHook(() => useImageContent(REF_A))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      gate.resolve(new Response(new Uint8Array([1, 2, 3, 4])) as Response)
    })
    await waitFor(() => expect(a.result.current.url).toBe('blob:content-1'))
    expect(b.result.current.url).toBe('blob:content-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('eviction revokes the URL once no subscriber holds it', async () => {
    _setImageContentCapsForTests({ maxEntries: 1, maxTotalBytes: 1 << 30 })
    const fetchMock = stubFetch()
    const a = renderHook(() => useImageContent(REF_A))
    await waitFor(() => expect(a.result.current.url).toBe('blob:content-1'))
    a.unmount()
    const b = renderHook(() => useImageContent(REF_B))
    await waitFor(() => expect(b.result.current.url).toBe('blob:content-2'))
    // A's entry was evicted when B landed over the count cap — URL revoked.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-1')
    // A re-fetched after eviction (its Blob is gone).
    const again = renderHook(() => useImageContent(REF_A))
    await waitFor(() => expect(again.result.current.url).toBe('blob:content-3'))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a subscribed entry survives eviction pressure (no revoke under a live <img>)', async () => {
    _setImageContentCapsForTests({ maxEntries: 1, maxTotalBytes: 1 << 30 })
    const a = renderHook(() => useImageContent(REF_A))
    await waitFor(() => expect(a.result.current.url).toBe('blob:content-1'))
    const b = renderHook(() => useImageContent(REF_B))
    await waitFor(() => expect(b.result.current.url).toBe('blob:content-2'))
    // Over cap, but BOTH entries are subscribed — nothing is evictable.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    b.unmount()
    // B is now evictable; A (still subscribed) must keep its URL.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-2')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:content-1')
    expect(a.result.current.url).toBe('blob:content-1')
  })

  it('the byte cap evicts by stored blob size', async () => {
    // Each blob is 4 bytes; a 5-byte budget holds exactly one entry.
    _setImageContentCapsForTests({ maxEntries: 100, maxTotalBytes: 5 })
    const a = renderHook(() => useImageContent(REF_A))
    await waitFor(() => expect(a.result.current.url).toBe('blob:content-1'))
    a.unmount()
    const b = renderHook(() => useImageContent(REF_B))
    await waitFor(() => expect(b.result.current.url).toBe('blob:content-2'))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-1')
  })

  it('a failed content fetch surfaces failed without a URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 }) as Response))
    const { result } = renderHook(() => useImageContent(REF_A))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.url).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('a null ref never fetches', async () => {
    const fetchMock = stubFetch()
    const { result } = renderHook(() => useImageContent(null))
    expect(result.current).toEqual({ url: null, failed: false })
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('switching to a different ref resolves the new content', async () => {
    const fetchMock = stubFetch()
    const { result, rerender } = renderHook(({ r }: { r: ImageAttachmentRef }) => useImageContent(r), {
      initialProps: { r: REF_A },
    })
    await waitFor(() => expect(result.current.url).toBe('blob:content-1'))
    rerender({ r: REF_B })
    await waitFor(() => expect(result.current.url).toBe('blob:content-2'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe(`/api/attachments/images/${digestOf(REF_B)}`)
  })

  // Row-reuse race (Virtuoso hands a mounted row a new block): the previous
  // ref's load is still in flight when the ref switches. Its late settlement
  // must not paint over the current ref's state — the render-phase guard
  // never re-corrects (trackedId already equals the new id).
  it('a slow load for a previous ref cannot overwrite the current ref on row reuse', async () => {
    const gateA = deferred<Response>()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith(digestOf(REF_A))) return gateA.promise
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])) as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender } = renderHook(({ r }: { r: ImageAttachmentRef }) => useImageContent(r), {
      initialProps: { r: REF_A },
    })
    // A's fetch is gated; switch the row to B, whose content lands immediately.
    rerender({ r: REF_B })
    await waitFor(() => expect(result.current.url).toBe('blob:content-1'))
    // Release A's slow fetch LAST. Its load completes (a URL is minted and
    // cached for future use) but the stale callback must not set state.
    await act(async () => {
      gateA.resolve(new Response(new Uint8Array([9, 9, 9, 9])) as Response)
      await flushMicrotasks()
    })
    expect(createObjectURL).toHaveBeenCalledTimes(2) // A's load DID complete
    expect(result.current.url).toBe('blob:content-1') // still B, not A
    expect(result.current.failed).toBe(false)
  })

  it('a slow refusal for a previous ref cannot mark the current ref failed', async () => {
    const gateA = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith(digestOf(REF_A))) return gateA.promise
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])) as Response)
    }))
    const { result, rerender } = renderHook(({ r }: { r: ImageAttachmentRef }) => useImageContent(r), {
      initialProps: { r: REF_A },
    })
    rerender({ r: REF_B })
    await waitFor(() => expect(result.current.url).toBe('blob:content-1'))
    // A's 404 lands after the switch — it must not flip B to failed.
    await act(async () => {
      gateA.resolve(new Response('gone', { status: 404 }) as Response)
      await flushMicrotasks()
    })
    expect(result.current).toEqual({ url: 'blob:content-1', failed: false })
  })
})
