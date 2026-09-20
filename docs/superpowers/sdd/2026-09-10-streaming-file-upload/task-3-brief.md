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

