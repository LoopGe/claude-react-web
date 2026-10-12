// Tests for the image decode cache: async (fetch data:-URL) decoding of
// persisted history images with an LRU keyed by the base64 payload. The
// cache is a pure decode MEMO — it stores Blobs; every buildPastedImages
// call mints a FRESH blob URL (composer-owned) from the cached Blob, so
// cache eviction never revokes a URL the composer is displaying.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPastedImages, clearImageDecodeCache } from './imageDecodeCache'
import type { PersistedImage } from '../state/inputHistoryImages'
import type { PastedImage } from '../types'

function persisted(data = 'AAAA', mediaType: PersistedImage['mediaType'] = 'image/png'): PersistedImage {
  return { data, mediaType, width: 10, height: 20, size: 3 }
}

let urlCounter = 0
const createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
const revokeObjectURL = vi.fn()

/** Install a fetch stub that resolves data: URLs to a Blob of the decoded
 *  bytes (mirrors the browser's native data:-URL handling the module relies
 *  on; jsdom's fetch cannot do this). */
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('data:')) throw new Error(`unexpected fetch: ${url}`)
    const comma = url.indexOf(',')
    const b64 = url.slice(comma + 1)
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Response(bytes) as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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
  stubFetch()
  clearImageDecodeCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).createObjectURL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).revokeObjectURL
})

describe('imageDecodeCache', () => {
  it('decodes via fetch(data:) into composer-owned PastedImages', async () => {
    const fetchMock = stubFetch()
    const out = await buildPastedImages([persisted()])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      data: 'AAAA', mediaType: 'image/png', width: 10, height: 20, size: 3,
    })
    expect(out[0].id).toBeTruthy()
    expect(out[0].previewUrl).toBe('blob:mock-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The fetch URL is a data: URL carrying the base64 payload.
    expect(String(fetchMock.mock.calls[0][0])).toContain('data:image/png;base64,AAAA')
  })

  it('a cache hit reuses the decoded Blob without re-fetching (fresh URL)', async () => {
    const fetchMock = stubFetch()
    const first = await buildPastedImages([persisted()])
    const second = await buildPastedImages([persisted()])
    expect(fetchMock).toHaveBeenCalledTimes(1) // no re-decode
    // A FRESH URL is minted from the cached Blob — composer-owned, so cache
    // eviction can never revoke a URL the composer is displaying.
    expect(second[0].previewUrl).toBe('blob:mock-2')
    expect(second[0].previewUrl).not.toBe(first[0].previewUrl)
  })

  it('builds many images in one call', async () => {
    const out = await buildPastedImages([persisted('A1'), persisted('A2', 'image/jpeg')])
    expect(out.map((i) => i.data)).toEqual(['A1', 'A2'])
  })

  it('an image whose decode fails is skipped, not fatal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('BBBB')) throw new Error('decode boom')
      const binary = atob('AAAA')
      return new Response(Uint8Array.from(binary, (c) => c.charCodeAt(0))) as Response
    }))
    const out = await buildPastedImages([persisted('BBBB'), persisted('AAAA')])
    expect(out.map((i) => i.data)).toEqual(['AAAA'])
  })

  it('concurrent builds of the same payload share one decode', async () => {
    const fetchMock = stubFetch()
    const [x, y] = await Promise.all([
      buildPastedImages([persisted('SHAR')]),
      buildPastedImages([persisted('SHAR')]),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(x[0].data).toBe('SHAR')
    expect(y[0].data).toBe('SHAR')
  })

  it('evicts the least-recently-used Blob past the count cap (re-decode on next use)', async () => {
    const { _setCapsForTests } = await import('./imageDecodeCache')
    _setCapsForTests({ maxEntries: 1, maxTotalBytes: 1 << 30 })
    try {
      const fetchMock = stubFetch()
      await buildPastedImages([persisted('A1')])
      await buildPastedImages([persisted('B1')]) // evicts A1's Blob
      await buildPastedImages([persisted('A1')]) // re-decode (evicted)
      // Three decodes total: A1, B1, A1-again.
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      _setCapsForTests(null)
      clearImageDecodeCache()
    }
  })

  it('LRU touch keeps a recently used entry alive past the cap', async () => {
    const { _setCapsForTests } = await import('./imageDecodeCache')
    _setCapsForTests({ maxEntries: 2, maxTotalBytes: 1 << 30 })
    try {
      const fetchMock = stubFetch()
      await buildPastedImages([persisted('A1')])
      await buildPastedImages([persisted('B1')])
      await buildPastedImages([persisted('A1')]) // touch A1 (cache hit)
      await buildPastedImages([persisted('C1')]) // evicts B1 (LRU), keeps A1
      await buildPastedImages([persisted('A1')]) // still cached — no re-decode
      // A1: initial + touch = 1 decode (second call hit, third call hit);
      // B1: 1; C1: 1 → 3 total, A1 never re-decoded.
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      _setCapsForTests(null)
      clearImageDecodeCache()
    }
  })

  it('clearImageDecodeCache drops the decoded Blobs (nothing to revoke)', async () => {
    const fetchMock = stubFetch()
    await buildPastedImages([persisted('A1'), persisted('A2', 'image/jpeg')])
    clearImageDecodeCache()
    // No URL ever belongs to the cache — nothing is revoked on clear.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    // A subsequent build re-decodes (memo was dropped): A1 + A2 then A1 = 3.
    await buildPastedImages([persisted('A1')])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a decode landing after clear() does not resurrect the memo', async () => {
    stubFetch()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      const binary = atob('AAAA')
      return new Response(Uint8Array.from(binary, (c) => c.charCodeAt(0))) as Response
    }))
    const pending = buildPastedImages([persisted('A1')])
    clearImageDecodeCache() // reset-config wipes WHILE the decode is in flight
    release()
    await pending
    // The cleared generation must not re-insert the memo: the next build
    // re-decodes.
    const fetch2 = stubFetch()
    await buildPastedImages([persisted('A1')])
    expect(fetch2).toHaveBeenCalledTimes(1)
  })

  it('PastedImage shape matches the composer contract', async () => {
    const out = await buildPastedImages([persisted()])
    const keys = Object.keys(out[0]).sort()
    expect(keys).toEqual(['data', 'height', 'id', 'mediaType', 'previewUrl', 'size', 'width'])
    // Type-level contract check (compiled, not runtime).
    const asPasted: PastedImage = out[0]
    expect(asPasted.mediaType).toBe('image/png')
  })
})
