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

