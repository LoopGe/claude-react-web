// @vitest-environment node
// Upload resource provider: fetch-once immutability, the lazy byte posture
// (only text reads bytes here), and the capped stream's exact-cap semantics.

import { describe, it, expect, vi } from 'vitest'
import { createUploadProvider, TEXT_PREVIEW_LIMIT } from './upload'
import { uploadResource } from '../../../shared/resource-address'
import type { ResourceFrame } from '../registry'
import type { UploadResourceValue } from './upload'

const UP = uploadResource({ id: 'u-1', name: 'notes.md', size: 7 })

async function collect(
  iterable: AsyncIterable<ResourceFrame<UploadResourceValue>>,
): Promise<ResourceFrame<UploadResourceValue>[]> {
  const frames: ResourceFrame<UploadResourceValue>[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

function ctx() {
  return {
    signal: new AbortController().signal,
    invalidations: () => (async function* () {})(),
  }
}

function responseFromChunks(chunks: Uint8Array[], { status = 200, close = true } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    },
  })
  return new Response(stream, { status })
}

const enc = new TextEncoder()

describe('upload resource provider', () => {
  it('yields metadata without fetching for image / pdf / other kinds', async () => {
    let fetched = 0
    const provider = createUploadProvider(async () => {
      fetched += 1
      return responseFromChunks([])
    })
    for (const [name, kind] of [
      ['pic.png', 'image'],
      ['doc.pdf', 'pdf'],
      ['archive.zip', 'other'],
    ] as const) {
      const address = uploadResource({ id: 'u-1', name, size: 100 })
      const frames = await collect(provider.open(address, ctx()))
      expect(frames).toEqual([{ ok: true, value: { kind, name, size: 100 } }])
    }
    expect(fetched).toBe(0)
  })

  it('fetches the content URL for a text kind and yields the decoded body', async () => {
    const urls: string[] = []
    const provider = createUploadProvider(async (url) => {
      urls.push(url)
      return responseFromChunks([enc.encode('hello '), enc.encode('world')])
    })
    const frames = await collect(provider.open(UP, ctx()))
    expect(urls).toEqual(['/api/uploads/u-1/content'])
    expect(frames).toEqual([
      {
        ok: true,
        value: {
          kind: 'text',
          name: 'notes.md',
          size: 7,
          text: { available: true, encoding: 'utf-8', contents: 'hello world' },
        },
      },
    ])
  })

  it('encodes the upload id in the content URL', async () => {
    const urls: string[] = []
    const provider = createUploadProvider(async (url) => {
      urls.push(url)
      return responseFromChunks([])
    })
    await collect(provider.open(uploadResource({ id: 'a/b c', name: 't.txt', size: 0 }), ctx()))
    expect(urls).toEqual(['/api/uploads/a%2Fb%20c/content'])
  })

  it('does not flag truncation when the stream ends exactly at the cap', async () => {
    const provider = createUploadProvider(async () =>
      responseFromChunks([enc.encode('x'.repeat(TEXT_PREVIEW_LIMIT))]),
    )
    const [frame] = await collect(provider.open(UP, ctx()))
    expect(frame.ok && frame.value.text?.truncated).toBeUndefined()
    expect(frame.ok && frame.value.text?.contents?.length).toBe(TEXT_PREVIEW_LIMIT)
  })

  it('flags truncation past the cap and cancels the reader', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('a'.repeat(TEXT_PREVIEW_LIMIT)))
        controller.enqueue(enc.encode('b'))
      },
      cancel() {
        cancelled = true
      },
    })
    const provider = createUploadProvider(async () => new Response(stream))
    const [frame] = await collect(provider.open(UP, ctx()))
    expect(frame.ok && frame.value.text?.truncated).toBe(true)
    expect(frame.ok && frame.value.text?.contents).toBe('a'.repeat(TEXT_PREVIEW_LIMIT))
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it('yields a failure frame on a non-ok response', async () => {
    const provider = createUploadProvider(async () => responseFromChunks([], { status: 404 }))
    const frames = await collect(provider.open(UP, ctx()))
    expect(frames).toEqual([
      { ok: false, failure: { code: 'upload/read-failed', message: 'HTTP 404' } },
    ])
  })

  it('yields a failure frame when the fetch rejects', async () => {
    const provider = createUploadProvider(async () => {
      throw new Error('network down')
    })
    const frames = await collect(provider.open(UP, ctx()))
    expect(frames).toEqual([
      { ok: false, failure: { code: 'upload/read-failed', message: 'network down' } },
    ])
  })

  it('yields a failure for a non-upload address', async () => {
    const provider = createUploadProvider(async () => responseFromChunks([]))
    const frames = await collect(provider.open('crw-resource://file/s1//a.ts', ctx()))
    expect(frames[0]).toMatchObject({ ok: false, failure: { code: 'upload/invalid-address' } })
  })
})
