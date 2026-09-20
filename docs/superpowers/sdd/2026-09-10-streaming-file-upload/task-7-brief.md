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

