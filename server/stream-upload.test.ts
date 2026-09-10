import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { streamUploads, UploadError, isStreamingUploadPath } from './stream-upload.js'
import { tempDir } from './__test-utils__/index.js'

/** Build a real multipart body + its content-type header from a FormData. */
function form(files: Array<{ body: string | Uint8Array; filename?: string; type?: string }>) {
  const fd = new FormData()
  for (const f of files) {
    if (f.filename === undefined) fd.append('file', f.body as string)
    else fd.append('file', new File([f.body], f.filename, { type: f.type }))
  }
  const req = new Request('http://localhost/upload', { method: 'POST', body: fd })
  return { body: req.body!, contentType: req.headers.get('content-type')! }
}

describe('streamUploads', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('su') })
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

  const place = ({ filename, index }: { filename: string; index: number }) => ({
    tmp: join(dir, `${index}.part`),
    final: join(dir, `${index}-${filename}`),
    name: filename,
  })

  const noParts = () => readdirSync(dir).filter((f) => f.endsWith('.part'))

  it('writes one file and reports its size', async () => {
    const { body, contentType } = form([{ body: 'hello', filename: 'a.txt', type: 'text/plain' }])
    const saved = await streamUploads({ body, contentType, maxFileBytes: 1024, place })
    expect(saved).toHaveLength(1)
    expect(readFileSync(saved[0].path, 'utf8')).toBe('hello')
    expect(saved[0].size).toBe(5)
    expect(saved[0].name).toBe('a.txt')
    expect(noParts()).toEqual([])
  })

  it('rejects a type outside the allow-list and writes nothing', async () => {
    const { body, contentType } = form([{ body: 'x', filename: 'a.gif', type: 'image/gif' }])
    await expect(
      streamUploads({ body, contentType, maxFileBytes: 1024, accept: { 'image/png': '.png' }, place }),
    ).rejects.toMatchObject({ failure: { kind: 'bad-type' } })
    expect(readdirSync(dir)).toEqual([])
  })

  it('uses Object.hasOwn for the allow-list (prototype keys are rejected)', async () => {
    const { body, contentType } = form([{ body: 'x', filename: 'a', type: 'constructor' }])
    await expect(
      streamUploads({ body, contentType, maxFileBytes: 1024, accept: { 'image/png': '.png' }, place }),
    ).rejects.toBeInstanceOf(UploadError)
  })

  it('rejects an over-size file and leaves no temp behind', async () => {
    const { body, contentType } = form([{ body: new Uint8Array(2000), filename: 'big.bin', type: 'application/octet-stream' }])
    await expect(
      streamUploads({ body, contentType, maxFileBytes: 100, place }),
    ).rejects.toMatchObject({ failure: { kind: 'too-large' } })
    expect(readdirSync(dir)).toEqual([])
  })

  it('returns [] when the body has no file part', async () => {
    const { body, contentType } = form([{ body: 'field-value' }])
    expect(await streamUploads({ body, contentType, maxFileBytes: 1024, place })).toEqual([])
  })

  it('persists multiple files', async () => {
    const { body, contentType } = form([
      { body: 'one', filename: 'a.txt', type: 'text/plain' },
      { body: 'two', filename: 'b.txt', type: 'text/plain' },
    ])
    const saved = await streamUploads({ body, contentType, maxFileBytes: 1024, maxFiles: 5, place })
    expect(saved.map((s) => s.name).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('honours maxFiles', async () => {
    const { body, contentType } = form([
      { body: 'one', filename: 'a.txt', type: 'text/plain' },
      { body: 'two', filename: 'b.txt', type: 'text/plain' },
    ])
    const saved = await streamUploads({ body, contentType, maxFileBytes: 1024, maxFiles: 1, place })
    expect(saved).toHaveLength(1)
  })

  it('cleans up its temp when the client aborts mid-stream', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('--x\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n'))
        c.error(new Error('client aborted'))
      },
    })
    await expect(
      streamUploads({ body, contentType: 'multipart/form-data; boundary=x', maxFileBytes: 1_000_000, place }),
    ).rejects.toBeInstanceOf(UploadError)
    expect(noParts()).toEqual([])
  })

  it('recognises only the streaming upload routes', () => {
    expect(isStreamingUploadPath('/api/background/upload')).toBe(true)
    expect(isStreamingUploadPath('/api/sessions/abc/uploads')).toBe(true)
    expect(isStreamingUploadPath('/api/sessions/abc/messages')).toBe(false)
    expect(isStreamingUploadPath('/api/background/files/x.png')).toBe(false)
  })
})
