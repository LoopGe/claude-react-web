// Tests for uploadImage: the composer's normalized-blob → durable-ref
// transfer (POST /api/uploads/images, raw body). Mirrors upload-file's
// per-item contract: the server's error text surfaces on refusal, and an
// abort propagates as AbortError so the queue can drop it silently.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { uploadImage } from './upload-image'
import type { ImageAttachmentRef } from '../../shared/image-attachment'

const REF: ImageAttachmentRef = {
  id: `sha256:${'ab'.repeat(32)}`,
  mediaType: 'image/webp',
  bytes: 4,
  width: 10,
  height: 20,
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadImage', () => {
  it('POSTs the raw blob to the image upload route with the session query', async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ attachment: REF })))
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' })
    const out = await uploadImage(blob, { sessionId: 's1' })
    expect(out).toEqual(REF)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/uploads/images?sessionId=s1')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(blob)
  })

  it('omits the query when no session is given', async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ attachment: REF })))
    await uploadImage(new Blob(['x']))
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/uploads/images')
  })

  it('rejects with the server error text on a non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'not a valid image' }), { status: 400 }))
    await expect(uploadImage(new Blob(['x']))).rejects.toThrow('not a valid image')
  })

  it('falls back to the status when the error body is not JSON', async () => {
    stubFetch(() => new Response('oops', { status: 500 }))
    await expect(uploadImage(new Blob(['x']))).rejects.toThrow('HTTP 500')
  })

  it('rejects when the response carries no valid image ref', async () => {
    stubFetch(() => new Response(JSON.stringify({ attachment: { id: 'nope' } })))
    await expect(uploadImage(new Blob(['x']))).rejects.toThrow(/image reference/)
  })

  it('propagates an abort as AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }))
    await expect(uploadImage(new Blob(['x']))).rejects.toMatchObject({ name: 'AbortError' })
  })
})
