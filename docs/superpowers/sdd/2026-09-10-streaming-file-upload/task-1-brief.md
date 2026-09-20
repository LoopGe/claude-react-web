### Task 1: Streaming multipart helper

**Files:**
- Create: `server/stream-upload.ts`
- Create: `server/stream-upload.test.ts`
- Modify: `package.json` (add `busboy` dependency, `@types/busboy` devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `streamUploads(o: StreamUploadOptions): Promise<SavedUpload[]>` — rejects with `UploadError`.
  - `interface SavedUpload { path: string; name: string; filename: string; mimeType: string; size: number }`
  - `class UploadError extends Error { readonly failure: UploadFailure }`
  - `type UploadFailure = { kind: 'too-large'; filename: string; limit: number } | { kind: 'bad-type'; filename: string; mimeType: string } | { kind: 'parse'; message: string }`
  - `isStreamingUploadPath(path: string): boolean`

- [ ] **Step 1: Add the dependency**

```bash
npm install busboy
npm install -D @types/busboy
```

- [ ] **Step 2: Write the failing tests**

Create `server/stream-upload.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
    const { body, contentType } = form(['field-value'])
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
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run server/stream-upload.test.ts`
Expected: FAIL — `Cannot find module './stream-upload.js'`.

- [ ] **Step 4: Implement the helper**

Create `server/stream-upload.ts`:

```ts
// Streams a multipart/form-data body to disk without ever holding the whole
// file in memory. Shared by the global background upload and the per-session
// file upload. Each part is written to `<final>.<index>.part` and atomically
// renamed on success, so a truncated upload never becomes visible at a
// servable path.
//
// These routes must NOT be wrapped in Hono's `bodyLimit`: in the chunked case
// it reads the entire body into memory before calling next() (see
// node_modules/hono/dist/middleware/body-limit/index.js). The size limit is
// enforced here, while writing.

import Busboy from 'busboy'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'

export interface SavedUpload {
  path: string
  name: string
  filename: string
  mimeType: string
  size: number
}

export interface PlaceArgs {
  filename: string
  mimeType: string
  index: number
}

export interface StreamUploadOptions {
  body: ReadableStream<Uint8Array>
  contentType: string
  maxFileBytes: number
  maxFiles?: number
  /** mime → ext allow-list. Omitted = accept any type. */
  accept?: Record<string, string>
  place: (args: PlaceArgs) => { tmp: string; final: string; name: string }
}

export type UploadFailure =
  | { kind: 'too-large'; filename: string; limit: number }
  | { kind: 'bad-type'; filename: string; mimeType: string }
  | { kind: 'parse'; message: string }

export class UploadError extends Error {
  constructor(readonly failure: UploadFailure) {
    super(`upload failed: ${failure.kind}`)
    this.name = 'UploadError'
  }
}

/** The routes served by streamUploads — exempt from the global bodyLimit. */
const STREAM_UPLOAD_PATTERNS = [/^\/api\/background\/upload$/, /^\/api\/sessions\/[^/]+\/uploads$/]

export function isStreamingUploadPath(path: string): boolean {
  return STREAM_UPLOAD_PATTERNS.some((re) => re.test(path))
}

interface Pending {
  tmp: string
  final: string
  name: string
  filename: string
  mimeType: string
  size: number
}

export async function streamUploads(o: StreamUploadOptions): Promise<SavedUpload[]> {
  const maxFiles = o.maxFiles ?? 1
  const temps: string[] = []
  const pending: Pending[] = []
  const writes: Promise<void>[] = []
  let failure: UploadFailure | null = null
  let index = 0

  const bb = Busboy({
    headers: { 'content-type': o.contentType },
    limits: { fileSize: o.maxFileBytes, files: maxFiles },
  })

  bb.on('file', (_field, stream, info) => {
    const i = index++
    if (o.accept && !Object.hasOwn(o.accept, info.mimeType)) {
      failure ??= { kind: 'bad-type', filename: info.filename, mimeType: info.mimeType }
      stream.resume() // drain so the parser can advance
      return
    }
    if (failure) {
      stream.resume()
      return
    }

    const dest = o.place({ filename: info.filename, mimeType: info.mimeType, index: i })
    temps.push(dest.tmp)
    const ws = createWriteStream(dest.tmp)
    let size = 0
    let limited = false
    stream.on('data', (chunk: Buffer) => { size += chunk.length })
    stream.on('limit', () => { limited = true })
    writes.push(
      pipeline(stream, ws).then(
        () => {
          if (limited) {
            failure ??= { kind: 'too-large', filename: info.filename, limit: o.maxFileBytes }
            return
          }
          pending.push({ tmp: dest.tmp, final: dest.final, name: dest.name, filename: info.filename, mimeType: info.mimeType, size })
        },
        (e: Error) => { failure ??= { kind: 'parse', message: e.message } },
      ),
    )
  })

  bb.on('error', (e: Error) => { failure ??= { kind: 'parse', message: e.message } })

  await new Promise<void>((resolve) => {
    const src = Readable.fromWeb(o.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
    src.on('error', (e: Error) => { failure ??= { kind: 'parse', message: e.message }; resolve() })
    bb.on('close', resolve)
    src.pipe(bb)
  })
  await Promise.all(writes)

  if (failure) {
    // Every temp the caller handed us goes — the successful writes too.
    for (const t of temps) await unlink(t).catch(() => {})
    throw new UploadError(failure)
  }
  for (const p of pending) await rename(p.tmp, p.final)
  return pending.map((p) => ({ path: p.final, name: p.name, filename: p.filename, mimeType: p.mimeType, size: p.size }))
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run server/stream-upload.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server/stream-upload.ts server/stream-upload.test.ts
git commit -m "feat(upload): streaming multipart helper (busboy, temp + atomic rename)"
```

---

