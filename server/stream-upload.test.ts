import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
    expect(saved[0].digest).toBe(createHash('sha256').update('hello').digest('hex'))
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

  it('a write failure produces no file at the final path', async () => {
    // Point tmp into a directory that does not exist so createWriteStream errors.
    const badPlace = ({ filename, index }: { filename: string; index: number }) => ({
      tmp: join(dir, 'does-not-exist', `${index}.part`),
      final: join(dir, `${index}-${filename}`),
      name: filename,
    })
    const { body, contentType } = form([{ body: 'hello', filename: 'a.txt', type: 'text/plain' }])
    await expect(
      streamUploads({ body, contentType, maxFileBytes: 1024, place: badPlace }),
    ).rejects.toBeInstanceOf(UploadError)
    expect(readdirSync(dir)).toEqual([])
  })

  it('recognises only the streaming upload routes', () => {
    expect(isStreamingUploadPath('/api/background/upload')).toBe(true)
    expect(isStreamingUploadPath('/api/uploads')).toBe(true)
    expect(isStreamingUploadPath('/api/sessions/abc/uploads')).toBe(false)
    expect(isStreamingUploadPath('/api/sessions/abc/messages')).toBe(false)
    expect(isStreamingUploadPath('/api/background/files/x.png')).toBe(false)
  })

  it('hands streamed chunks to a sink and returns its SavedUpload', async () => {
    const { body, contentType } = form([{ body: 'hello', filename: 'a.txt', type: 'text/plain' }])
    const chunks: string[] = []
    const saved = await streamUploads({
      body, contentType, maxFileBytes: 1024,
      sink: async (part) => {
        for await (const chunk of part.data) chunks.push(Buffer.from(chunk).toString())
        return { path: '/alias/a.txt', name: part.filename, filename: part.filename, mimeType: part.mimeType, size: 5, digest: 'a'.repeat(64) }
      },
    })
    expect(chunks.join('')).toBe('hello')
    expect(saved).toEqual([{ path: '/alias/a.txt', name: 'a.txt', filename: 'a.txt', mimeType: 'text/plain', size: 5, digest: 'a'.repeat(64) }])
  })

  it('rejects an over-limit sink stream before the sink resolves', async () => {
    const { body, contentType } = form([{ body: '12345', filename: 'a.txt', type: 'text/plain' }])
    await expect(streamUploads({
      body, contentType, maxFileBytes: 3,
      sink: async (part) => { let bytes = 0; for await (const chunk of part.data) bytes += chunk.byteLength; return { path: 'x', name: 'a', filename: 'a', mimeType: 'text/plain', size: bytes, digest: 'a'.repeat(64) } },
    })).rejects.toMatchObject({ failure: { kind: 'too-large' } })
  })

  it('accepts a sink file whose size equals the limit', async () => {
    const { body, contentType } = form([{ body: 'abc', filename: 'a.txt', type: 'text/plain' }])
    const saved = await streamUploads({
      body, contentType, maxFileBytes: 3,
      sink: async (part) => { let bytes = 0; for await (const chunk of part.data) bytes += chunk.byteLength; return { path: 'x', name: part.filename, filename: part.filename, mimeType: part.mimeType, size: bytes, digest: 'a'.repeat(64) } },
    })
    expect(saved).toMatchObject([{ size: 3 }])
  })

  it('rejects without hanging when the client aborts mid-sink', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('--x\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n'))
        c.error(new Error('client aborted'))
      },
    })
    await expect(
      streamUploads({
        body, contentType: 'multipart/form-data; boundary=x', maxFileBytes: 1_000_000,
        sink: async (part) => {
          for await (const chunk of part.data) void chunk
          return { path: 'x', name: part.filename, filename: part.filename, mimeType: part.mimeType, size: 0, digest: 'a'.repeat(64) }
        },
      }),
    ).rejects.toBeInstanceOf(UploadError)
  })

  it('rejects without hanging when the sink fails before reading the part', async () => {
    const { body, contentType } = form([{ body: 'x'.repeat(500_000), filename: 'a.bin', type: 'application/octet-stream' }])
    await expect(
      streamUploads({
        body, contentType, maxFileBytes: 1_000_000,
        sink: async () => { throw new Error('cannot publish') },
      }),
    ).rejects.toBeInstanceOf(UploadError)
  }, 3000)

  it('rejects without hanging when the sink throws mid-stream', async () => {
    const { body, contentType } = form([{ body: 'x'.repeat(500_000), filename: 'a.bin', type: 'application/octet-stream' }])
    await expect(
      streamUploads({
        body, contentType, maxFileBytes: 1_000_000,
        sink: async (part) => {
          for await (const chunk of part.data) throw new Error(`stop at ${chunk.byteLength}`)
          return { path: 'x', name: 'a', filename: 'a', mimeType: 'text/plain', size: 0, digest: 'a'.repeat(64) }
        },
      }),
    ).rejects.toBeInstanceOf(UploadError)
  }, 3000)

  it('requires exactly one of place or sink', async () => {
    const a = form([{ body: 'hello', filename: 'a.txt', type: 'text/plain' }])
    await expect(
      streamUploads({ body: a.body, contentType: a.contentType, maxFileBytes: 1024 }),
    ).rejects.toThrow('streamUploads requires exactly one of place or sink')

    const b = form([{ body: 'hello', filename: 'a.txt', type: 'text/plain' }])
    await expect(
      streamUploads({
        body: b.body,
        contentType: b.contentType,
        maxFileBytes: 1024,
        place,
        sink: async () => ({ path: 'x', name: 'a', filename: 'a', mimeType: 'text/plain', size: 0, digest: 'a'.repeat(64) }),
      }),
    ).rejects.toThrow(TypeError)
  })

  it('decodes raw UTF-8 filenames as UTF-8, not latin1', async () => {
    // Browsers send raw UTF-8 bytes in multipart Content-Disposition. Busboy's
    // latin1 default would surface them as mojibake ("ææå¾…").
    const name = '截图 2026-10-26 22.47.58.png'
    const boundary = '----t'
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
          ),
        )
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.enqueue(new TextEncoder().encode(`\r\n--${boundary}--\r\n`))
        c.close()
      },
    })
    const saved = await streamUploads({
      body,
      contentType: `multipart/form-data; boundary=${boundary}`,
      maxFileBytes: 1024,
      place,
    })
    expect(saved[0].name).toBe(name)
  })
})
