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
