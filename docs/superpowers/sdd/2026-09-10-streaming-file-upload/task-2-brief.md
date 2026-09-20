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

