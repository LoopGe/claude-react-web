# Streaming File Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make file uploads stream to disk instead of buffering in memory, so a background video larger than 32 MB uploads successfully and the size limit is governed by one configurable value.

**Architecture:** A new shared helper (`server/stream-upload.ts`) wraps `busboy` to parse `multipart/form-data` from `c.req.raw.body` and stream each part to a `<final>.<index>.part` temp file, atomically renaming it on success and unlinking every temp on any failure. Both upload routes (`/api/background/upload`, `/api/sessions/:id/uploads`) switch to it. The global `bodyLimit` becomes path-aware: a small limit protects the buffered JSON paths, while the two streaming routes are exempt (Hono's `bodyLimit` buffers chunked bodies — see the spec).

**Tech Stack:** TypeScript (ESM), Hono, Node 20 `stream/promises`, `busboy`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-streaming-file-upload-design.md`

## Global Constraints

- **One user-facing size knob:** `maxUploadBytes`. Default raised to `500 * 1024 * 1024`. The pasted-image cap is an internal constant (`MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024`) — never a second config knob.
- **The two streaming upload routes must NOT use `bodyLimit`.**
- **Existing contracts unchanged.** `server/background-routes.test.ts` (25 cases) and `server/routes/uploads.test.ts` (9 cases) must pass **unmodified** — they are the behaviour spec.
- **Filenames:** server-assigned uuid (background) / sanitised basename (session). Never trust a client filename as a path.
- **Temp files are always renamed or unlinked** — no `.part` may survive a request.
- **Logging** goes through `createLogger(scope)` from `server/log.ts`; never bare `console.*`.
- **Typecheck both projects:** `npm run typecheck` runs `tsc -p tsconfig.json` **and** `tsc -p tsconfig.node.json`.
- **Commits:** Conventional Commits, e.g. `feat(upload): …`.

---

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

### Task 2: Background upload route streams

**Files:**
- Modify: `server/background-routes.ts` (the `POST /upload` handler, lines ~99-127)
- Modify: `server/background-routes.test.ts` (add cases)
- Test: `server/background-routes.test.ts`

**Interfaces:**
- Consumes: `streamUploads`, `UploadError` from Task 1.
- Produces: no new interface — the route's response/status contract is unchanged.

- [ ] **Step 1: Add the failing tests**

Append inside the `describe('POST /api/background/upload', …)` block in `server/background-routes.test.ts`:

```ts
    it('400s when the request carries no file', async () => {
      const form = new FormData()
      form.append('note', 'no file here')
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })

    it('400s on a malformed multipart body', async () => {
      const res = await app.request('/api/background/upload', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=nope' },
        body: 'not-a-real-multipart-body',
      })
      expect(res.status).toBe(400)
    })

    it('leaves no .part file behind after a rejected upload', async () => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.gif', { type: 'image/gif' }))
      await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
    })
```

Add `readdirSync` to the existing `node:fs` import at the top of the file.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run server/background-routes.test.ts`
Expected: FAIL on the malformed-body and `.part` cases (the current `parseBody` path returns different results).

- [ ] **Step 3: Rewrite the handler**

In `server/background-routes.ts`, replace the body of `app.post('/upload', …)` with:

```ts
  app.post('/upload', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }
    if (!c.req.raw.body) return c.json({ error: 'no file in request' }, 400)

    await mkdir(dir, { recursive: true })
    let saved: SavedUpload[]
    try {
      saved = await streamUploads({
        body: c.req.raw.body,
        contentType: ct,
        maxFileBytes: maxBytes,
        maxFiles: 1,
        accept: ALLOWED_UPLOAD,
        place: ({ mimeType }) => {
          // The allow-list already passed, so the extension is present.
          const name = `${randomUUID()}${ALLOWED_UPLOAD[mimeType]}`
          return { tmp: join(dir, `${name}.part`), final: join(dir, name), name }
        },
      })
    } catch (e) {
      if (!(e instanceof UploadError)) throw e
      const f = e.failure
      if (f.kind === 'too-large') {
        return c.json({ error: `file exceeds ${f.limit} bytes` }, 413 as 400 | 404 | 410 | 500)
      }
      if (f.kind === 'bad-type') {
        return c.json({ error: `unsupported file type '${f.mimeType}'` }, 400)
      }
      return c.json({ error: 'invalid multipart payload' }, 400)
    }

    if (saved.length === 0) return c.json({ error: 'no file in request' }, 400)
    log.info(`upload background name=${saved[0].name} bytes=${saved[0].size}`)
    return c.json({ url: `/api/background/files/${saved[0].name}` })
  })
```

Update the imports at the top of the file — add the helper, and **drop `writeFile`** (now unused, which would fail `npm run lint`):

```ts
import { mkdir, stat, unlink } from 'node:fs/promises'
import { streamUploads, UploadError, type SavedUpload } from './stream-upload.js'
```

- [ ] **Step 4: Run the full route suite**

Run: `npx vitest run server/background-routes.test.ts`
Expected: PASS — all 25 pre-existing cases **unmodified** plus the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add server/background-routes.ts server/background-routes.test.ts
git commit -m "feat(upload): stream the background upload route to disk"
```

---

### Task 3: Session uploads route streams

**Files:**
- Modify: `server/routes/uploads.ts` (the `POST /sessions/:id/uploads` handler, lines ~36-106)
- Modify: `server/routes/uploads.test.ts` (add cases)
- Test: `server/routes/uploads.test.ts`

**Interfaces:**
- Consumes: `streamUploads`, `UploadError`, `SavedUpload` from Task 1.
- Produces: no new interface — response `{ uploads: [{ path, name, size }] }` and the `UploadStore` record shape are unchanged.

- [ ] **Step 1: Add the failing tests**

Append inside `describe('POST /sessions/:id/uploads', …)` in `server/routes/uploads.test.ts`:

```ts
    it('persists two files in one request', async () => {
      const form = new FormData()
      form.append('file', new File(['one'], 'a.txt', { type: 'text/plain' }))
      form.append('file', new File(['two'], 'b.txt', { type: 'text/plain' }))
      const res = await app.request('/sessions/s1/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { uploads: Array<{ name: string }> }
      expect(body.uploads.map((u) => u.name).sort()).toEqual(['a.txt', 'b.txt'])
    })

    it('413s an over-size file and leaves no partial file', async () => {
      const small = makeApp(makeSm(cwd), undefined) // no store needed
      const form = new FormData()
      form.append('file', new File([new Uint8Array(serverConfig.maxUploadBytes + 1)], 'big.bin'))
      const res = await small.request('/sessions/s1/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(413)
      const dir = join(cwd, 'claude-web-uploads')
      const leftover = existsSync(dir) ? readdirSync(dir) : []
      expect(leftover.filter((f) => f.endsWith('.part'))).toEqual([])
    })
```

Add `readdirSync` to the `node:fs` import, and add `import { config as serverConfig } from '../config.js'`.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run server/routes/uploads.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Rewrite the handler**

In `server/routes/uploads.ts`, replace `app.post('/sessions/:id/uploads', …)` with:

```ts
  app.post('/sessions/:id/uploads', async (c) => {
    const id = c.req.param('id')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd; uploads require a working directory' }, 400)
    }
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }
    if (!c.req.raw.body) return c.json({ error: 'no files in request' }, 400)

    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    await mkdir(uploadDir, { recursive: true })
    const now = Date.now()

    let files: SavedUpload[]
    try {
      files = await streamUploads({
        body: c.req.raw.body,
        contentType,
        maxFileBytes: serverConfig.maxUploadBytes,
        maxFiles: 20,
        place: ({ filename, index }) => {
          const baseName = filename.split(/[\\/]/).pop() || 'upload'
          const safeName = baseName.replace(/[\0/\\]/g, '_').slice(0, 200) || 'upload'
          const destName = `${now}-${safeName}`
          return { tmp: join(uploadDir, `${destName}.${index}.part`), final: join(uploadDir, destName), name: safeName }
        },
      })
    } catch (e) {
      if (!(e instanceof UploadError)) throw e
      const f = e.failure
      if (f.kind === 'too-large') {
        return c.json(
          { error: `file ${f.filename} exceeds ${f.limit} bytes` },
          413 as 400 | 404 | 410 | 500,
        )
      }
      return c.json({ error: 'invalid multipart payload' }, 400)
    }

    if (files.length === 0) return c.json({ error: 'no files in request' }, 400)

    const saved = files.map((f) => ({ path: f.path, name: f.name, size: f.size }))
    if (uploadStore) {
      try {
        uploadStore.record(
          files.map((f) => ({
            id: randomUUID(),
            path: f.path,
            cwd: resolvePath(info.cwd),
            name: f.name,
            size: f.size,
            uploadedAt: now,
            sessionTitle: info.title ?? '',
          })),
        )
      } catch (e) {
        log.warn(`upload registry record failed: ${(e as Error).message}`)
      }
    }
    log.info(`upload session=${id} files=${saved.length} totalBytes=${saved.reduce((s, f) => s + f.size, 0)}`)
    return c.json({ uploads: saved })
  })
```

Update the imports at the top of the file. The current lines are
`import { mkdir, writeFile, unlink, stat } from 'node:fs/promises'` and
`import { resolve as resolvePath } from 'node:path'` — `writeFile` becomes
unused (`npm run lint` would fail) and `join` is needed:

```ts
import { mkdir, unlink, stat } from 'node:fs/promises'
import { resolve as resolvePath, join } from 'node:path'
import { streamUploads, UploadError, type SavedUpload } from '../stream-upload.js'
```

- [ ] **Step 4: Run the full route suite**

Run: `npx vitest run server/routes/uploads.test.ts`
Expected: PASS — all 9 pre-existing cases **unmodified** plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add server/routes/uploads.ts server/routes/uploads.test.ts
git commit -m "feat(upload): stream the session uploads route to disk"
```

---

### Task 4: Path-aware global body limit

**Files:**
- Modify: `server/app.ts` (the `bodyLimit` block, lines ~193-197)

**Interfaces:**
- Consumes: `isStreamingUploadPath` from Task 1.
- Produces: no new interface.

- [ ] **Step 1: Rewrite the body-limit block**

In `server/app.ts`, replace lines ~185-197 with:

```ts
  // Reject oversized request bodies early. This covers the *buffered* paths —
  // JSON message payloads (base64 images inflate ~1.33x) and the config/store
  // routes. The two file-upload routes are exempt: they stream, and Hono's
  // bodyLimit reads a chunked body into memory before calling next(), which
  // would defeat that. Their size limit is enforced by streamUploads while it
  // writes. Keep this default (the small one) — only listed paths are exempt,
  // so a path-detection mistake fails closed.
  const MAX_BODY_BYTES = 32 * 1024 * 1024
  const smallBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  })
  app.use('*', (c, next) => (isStreamingUploadPath(c.req.path) ? next() : smallBodyLimit(c, next)))
```

Add the import near the other server imports:

```ts
import { isStreamingUploadPath } from './stream-upload.js'
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add server/app.ts
git commit -m "feat(upload): exempt streaming upload routes from the global body limit"
```

---

### Task 5: One size knob + pasted-image cap plumbing

**Files:**
- Modify: `server/config.ts` (defaults, new exported constant)
- Modify: `server/routes/config-routes.ts` (lightweight `/config` payload)
- Modify: `server/config.test.ts` (the 25 MB default assertion)
- Modify: `src/types/config.ts` (`ConfigResponse`)
- Modify: `src/hooks/config-store.ts` (accessor for the image cap)
- Modify: `src/App.tsx` (store the published image cap)
- Modify: `src/hooks/usePastedImages.ts` (use the image cap, not `maxUploadBytes`)
- Modify: `src/components/GlobalSettingsModal.tsx` (hint copy)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MAX_PASTED_IMAGE_BYTES: number` exported from `server/config.ts`
  - `/api/config` payload gains `maxPastedImageBytes: number`
  - `getMaxPastedImageBytes(): number` / `setMaxPastedImageBytes(v: number): void` in `src/hooks/config-store.ts`

- [ ] **Step 1: Write the failing tests**

In `server/config.test.ts`, change the default assertion at line ~20:

```ts
    expect(config.maxUploadBytes).toBe(500 * 1024 * 1024)
```

Create `src/hooks/usePastedImages.test.ts` (it does not exist yet):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedImages } from './usePastedImages'
import { setMaxUploadBytes, setMaxPastedImageBytes } from './config-store'

describe('usePastedImages cap', () => {
  beforeEach(() => {
    setMaxUploadBytes(500 * 1024 * 1024)
    setMaxPastedImageBytes(25 * 1024 * 1024)
  })

  it('caps the pasted-image total by the pasted-image cap, not the upload cap', async () => {
    setMaxPastedImageBytes(5) // 5 bytes
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }))
    })
    expect(result.current.error).toMatch(/too large/i)
    expect(result.current.images).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run server/config.test.ts src/hooks/usePastedImages.test.ts`
Expected: FAIL — `setMaxPastedImageBytes` is not exported; the default is still 25 MB.

- [ ] **Step 3: Server config**

In `server/config.ts`, change the default:

```ts
  maxUploadBytes: 500 * 1024 * 1024,
```

Add the exported constant next to `DEFAULTS`:

```ts
/** Hard cap on the total size of pasted images in one message. NOT a user
 *  setting: those bytes ride the buffered JSON message body (base64, ×~1.33),
 *  so this is a memory-safety limit, not a preference. The user-facing file
 *  upload knob is `maxUploadBytes`. */
export const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024
```

- [ ] **Step 4: Publish it in `/api/config`**

In `server/routes/config-routes.ts`, add to the lightweight `/config` payload (beside `maxUploadBytes`):

```ts
      maxPastedImageBytes: MAX_PASTED_IMAGE_BYTES,
```

and add the constant to the file's existing config import (line ~13), which currently reads
`import { config as serverConfig, loadConfig, readConfigFile, updateConfigFile } from '../config.js'`:

```ts
import { config as serverConfig, loadConfig, readConfigFile, updateConfigFile, MAX_PASTED_IMAGE_BYTES } from '../config.js'
```

- [ ] **Step 5: Client store + types + App**

`src/hooks/config-store.ts` — add beside the existing pair:

```ts
let _maxPastedImageBytes = 25 * 1024 * 1024

export function getMaxPastedImageBytes(): number {
  return _maxPastedImageBytes
}

export function setMaxPastedImageBytes(v: number): void {
  if (v > 0) _maxPastedImageBytes = v
}
```

`src/types/config.ts` — add to `ConfigResponse`:

```ts
  maxPastedImageBytes?: number
```

`src/App.tsx` — import `setMaxPastedImageBytes` and call it beside the existing line:

```ts
        if (r.maxUploadBytes != null) setMaxUploadBytes(r.maxUploadBytes)
        if (r.maxPastedImageBytes != null) setMaxPastedImageBytes(r.maxPastedImageBytes)
```

`src/hooks/usePastedImages.ts` — change the import and the read:

```ts
import { getMaxPastedImageBytes } from './config-store'
```
```ts
    const maxTotal = getMaxPastedImageBytes()
```

- [ ] **Step 6: UI copy**

In `src/components/GlobalSettingsModal.tsx`, change the "Max upload size" hint:

```ts
          hint="Largest uploaded file accepted (backgrounds, session files). Pasted images are capped separately. 0 = no override (server default 500 MB)."
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run server/config.test.ts src/hooks/usePastedImages.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add server/config.ts server/routes/config-routes.ts server/config.test.ts src/types/config.ts src/hooks/config-store.ts src/App.tsx src/hooks/usePastedImages.ts src/hooks/usePastedImages.test.ts src/components/GlobalSettingsModal.tsx
git commit -m "feat(config): one upload-size knob; pasted images keep an internal cap"
```

---

### Task 6: BackgroundPicker client-side pre-check

**Files:**
- Modify: `src/components/BackgroundPicker.tsx` (`handleUpload`)
- Modify: `src/components/BackgroundPicker.test.tsx`

**Interfaces:**
- Consumes: `getMaxUploadBytes()` from `src/hooks/config-store.ts`.
- Produces: no new interface.

- [ ] **Step 1: Write the failing test**

In `src/components/BackgroundPicker.test.tsx` the suite's `afterEach` must reset the shared module state the pre-check reads (module state survives `restoreAllMocks`). Change it to:

```tsx
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setMaxUploadBytes(25 * 1024 * 1024) // config-store is module-global
  })
```

and add the import `import { setMaxUploadBytes } from '../hooks/config-store'`.

Append this case to the same describe block, matching the file's existing idioms (`fireEvent`, `vi.stubGlobal('fetch', …)`, `setting(...)`):

```tsx
  it('refuses an over-size file before sending any request', async () => {
    setMaxUploadBytes(10) // 10 bytes
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(50)], 'big.mp4', { type: 'video/mp4' })] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/too large/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/components/BackgroundPicker.test.tsx`
Expected: FAIL — no pre-check exists, so `fetch` is called.

- [ ] **Step 3: Add the pre-check**

In `src/components/BackgroundPicker.tsx`, at the top of `handleUpload`:

```ts
  const handleUpload = async (file: File) => {
    const forMedia = media
    const max = getMaxUploadBytes()
    if (file.size > max) {
      setApplied(false)
      setError(`File too large (${formatBytes(file.size)}). Max ${formatBytes(max)}.`)
      return
    }
    const form = new FormData()
    …
```

Add imports:

```ts
import { getMaxUploadBytes } from '../hooks/config-store'
import { formatBytes } from '../utils/format'
```

- [ ] **Step 4: Run the test file**

Run: `npx vitest run src/components/BackgroundPicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/BackgroundPicker.tsx src/components/BackgroundPicker.test.tsx
git commit -m "feat(background): refuse an over-size file client-side before uploading"
```

---

### Task 7: Widen the request timeout for large uploads

**Files:**
- Modify: `server/cli.ts` (after `serve(...)`, near the existing `server.on('connection', …)`)

**Interfaces:**
- Consumes: nothing.
- Produces: no new interface.

- [ ] **Step 1: Set the timeout**

In `server/cli.ts`, after the `const server = serve(...)` call, add:

```ts
  // Node's default `requestTimeout` (~300s) covers receiving the ENTIRE request,
  // so a large file over a slow link (phone on LAN) can be killed mid-upload.
  // Raise it well past a 500 MB upload at ~1 MB/s; a finite value keeps some
  // slowloris protection rather than disabling the timeout outright.
  server.requestTimeout = 30 * 60 * 1000
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (`serve()` returns a Node `http.Server`, already cast elsewhere in the file).

- [ ] **Step 3: Commit**

```bash
git add server/cli.ts
git commit -m "fix(upload): widen requestTimeout so slow large uploads are not killed"
```

---

### Task 8: Verification — memory, bundle, end-to-end

**Files:**
- Create: `scripts/verify-stream-upload.mjs`

**Interfaces:**
- Consumes: the built/compiled `server/stream-upload.ts` via `tsx`.
- Produces: nothing (a manual verification tool).

- [ ] **Step 1: Write the memory-verification script**

Create `scripts/verify-stream-upload.mjs`:

```js
// Proves the upload path truly streams: feeds a large synthetic multipart body
// through streamUploads and prints the peak heap growth. A buffering
// implementation grows ~linearly with the file; a streaming one stays flat.
// Run: npx tsx scripts/verify-stream-upload.mjs
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamUploads } from '../server/stream-upload.ts'

const MB = 1024 * 1024
const SIZE = 200 * MB
const dir = mkdtempSync(join(tmpdir(), 'verify-up-'))

const form = new FormData()
form.append('file', new File([new Uint8Array(SIZE)], 'big.bin', { type: 'application/octet-stream' }))
const req = new Request('http://localhost/upload', { method: 'POST', body: form })

let peak = 0
const sample = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().heapUsed)
}, 5)

const base = process.memoryUsage().heapUsed
const saved = await streamUploads({
  body: req.body,
  contentType: req.headers.get('content-type'),
  maxFileBytes: 500 * MB,
  place: ({ index }) => ({ tmp: join(dir, `${index}.part`), final: join(dir, `${index}-big.bin`), name: 'big.bin' }),
})
clearInterval(sample)

const onDisk = statSync(saved[0].path).size
const growth = (peak - base) / MB
console.log(`wrote ${onDisk / MB} MB to disk`)
console.log(`peak heap growth: ${growth.toFixed(1)} MB`)
console.log(growth < 60 ? 'PASS — memory stayed flat (streaming)' : 'FAIL — heap grew with the file (buffering)')

rmSync(dir, { recursive: true, force: true })
process.exit(growth < 60 ? 0 : 1)
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/verify-stream-upload.mjs`
Expected: `PASS — memory stayed flat (streaming)` with peak heap growth far below the 200 MB file size.

- [ ] **Step 3: Full verification**

Run: `npm run verify`
Expected: typecheck + lint + tests + build all pass. This also confirms `busboy` (CJS) bundles correctly into `dist/cli.mjs` via the `createRequire` banner in `build.mjs`.

- [ ] **Step 4: Manual end-to-end checklist**

Start the app (`npm run dev`), then:

1. Settings → Appearance → Video → **Upload video…** with a **>32 MB** file → uploads, wallpaper plays.
2. Same with a **>100 MB** file → uploads; confirm the `<video>` seeks (range requests work).
3. Try a file **larger than "Max upload size"** → a friendly inline message, **not** `Failed to fetch`, and the browser Network tab shows **no** request.
4. Inspect `<stateDir>/backgrounds/` → no `*.part` files remain.
5. Paste a large image into the composer → still capped and accepted as before.
6. Server log shows `upload background name=… bytes=…` for each successful upload.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-stream-upload.mjs
git commit -m "test(upload): memory-flatness verification script for streamUploads"
```

---

## Self-Review Notes

- **Spec coverage:** streaming helper (§2 → Task 1), background route (§3 → Task 2), session route (§4 → Task 3), path-aware body limit (§1 → Task 4), single knob + image cap (§1/§5 → Task 5), client pre-check (§5 → Task 6), requestTimeout (§6 → Task 7), memory/bundle/e2e (Testing §4-6 → Task 8). All spec sections map to a task.
- **Ordering:** Task 1 is a hard dependency of Tasks 2-4. Tasks 5-7 are independent of each other and of Tasks 2-4, so they may be executed in any order after Task 1.
- **Naming:** `streamUploads` / `UploadError` / `isStreamingUploadPath` / `SavedUpload` / `getMaxPastedImageBytes` are used identically across all tasks.
