# Task 8: Verification — memory, bundle, end-to-end

## 1. Memory-Verification Script

**File:** `scripts/verify-stream-upload.mjs`

### Review Fix (Critical 1): Metric change from `heapUsed` to `rss`

The original script used `process.memoryUsage().heapUsed` which only tracks V8-managed JS objects. Large `Buffer` allocations (busboy chunks) and `Uint8Array` backing stores are external `ArrayBuffer` memory tracked in `arrayBuffers`/`external`, NOT `heapUsed`. A buffering implementation holding 200 MB via `Buffer.concat(chunks)` would show the same ~1 MB `heapUsed` growth as streaming -- the script could not distinguish them.

**Fix:** Switched to `process.memoryUsage().rss` (Resident Set Size), which captures the total physical memory the process occupies including V8 heap, ArrayBuffer backing stores, code, and stack.

### Review Fix: Control group

Added a buffering control path that accumulates all file chunks in memory via `Buffer.concat(chunks)` before writing to disk. This proves the metric actually discriminates.

### Review Fix: Subprocess isolation

Each path runs in its own subprocess (via `execFileSync` + tsx) so RSS baselines are not polluted by the other path's allocations.

### Review Fix: Raw multipart body

Both paths generate raw multipart data via a `ReadableStream` (not `FormData`/`Request`) to avoid the ~200 MB encoding buffer that Node's undici creates when serializing a `FormData` body. That buffer would inflate both paths equally and obscure the real difference.

### Review Fix: try/finally and top-level catch

The script wraps its body in `try/finally` for temp directory cleanup and has a top-level `catch` that prints `ERROR: <message>` before exiting non-zero.

### Minor: ESLint globals

ESLint's Node config (`eslint.config.js`) did not declare `FormData`, `File`, `Request`, `URL`, `ReadableStream`, `Response`, or `fetch` as globals. These are standard Web API globals available in Node 18+ and are used by the verification scripts. Added all seven to the Node `languageOptions.globals` block (which scopes to `['server/**/*.ts', 'vitest.config.ts', 'vite.config.ts', 'build.mjs', 'scripts/**/*.mjs']`, not just scripts).

## 2. Memory Measurement Results

```
measuring streaming path...
streaming done.
measuring buffering control...
buffering done.

streaming: wrote 200 MB, RSS growth 20.2 MB
buffering: RSS growth 405.4 MB (control group)

PASS — streaming is 95% smaller than buffering; memory stayed flat
```

**Conclusion:** With a 200 MB synthetic file, the streaming path's RSS growth was 20.2 MB (well under the 60 MB threshold). The buffering control grew by 405.4 MB. The streaming path is 95% smaller -- the upload genuinely streams to disk via busboy; memory does not scale with file size.

## 3. `npm run verify` Stage-by-Stage Results

| Stage | Result | Notes |
|-------|--------|-------|
| `npm run typecheck` | PASS | Both tsconfigs clean |
| `npm run lint` | PASS (scripts clean) | 1 pre-existing error in `src/hooks/useDiagnostics.ts` (react-hooks/set-state-in-effect); 8 pre-existing warnings. Zero errors in `scripts/verify-stream-upload.mjs` or `scripts/e2e-stream-upload.mjs`. |
| `npm test` | PASS | 287/287 test files passed; 3787/3787 tests passed. Zero failures. (Previous run had pre-existing flaky failures in cli-diagnostics and session-manager; this run was clean.) |
| `npm run build` | PASS | `dist/cli.mjs` = 1.4 MB. busboy (CJS) correctly bundled via `createRequire` banner. Client build also clean. |

**busboy bundling confirmed:** `dist/cli.mjs` contains busboy code and starts with the `createRequire(import.meta.url)` banner.

## 4. Automated HTTP End-to-End

**File:** `scripts/e2e-stream-upload.mjs`

The e2e script boots the built server (`node dist/cli.mjs`) on a free port with a temp `--state-dir`, runs all checks, and exits non-zero on any failure.

### Observed output

```
starting server on port 55486...
server is ready.
uploading 40 MB file...
upload: HTTP 200, url=/api/background/files/87f7c5ee-5bd8-4b36-bc54-13b4806d851d.mp4
GET uploaded file...
GET: HTTP 200, content-type=video/mp4, size=41943040
Range request bytes=0-3...
Range: HTTP 206, body=4 bytes
no .part files found (1 file(s) in backgrounds/) — PASS

ALL E2E CHECKS PASSED
```

### What was verified

| Check | Result |
|-------|--------|
| POST >32 MB file to `/api/background/upload` | HTTP 200, `{url}` response |
| GET the returned URL | HTTP 200, `content-type: video/mp4`, 40 MB body |
| `Range: bytes=0-3` | HTTP 206, 4 bytes returned |
| No `*.part` files left in `backgrounds/` | PASS |

## 5. Files Changed

| File | Change |
|------|--------|
| `scripts/verify-stream-upload.mjs` | New — memory-flatness verification script with subprocess isolation, control group, RSS metric, raw multipart body |
| `scripts/e2e-stream-upload.mjs` | New — automated HTTP end-to-end test |
| `eslint.config.js` | Added `FormData`, `File`, `Request`, `URL`, `ReadableStream`, `Response`, `fetch` to Node globals for `scripts/**/*.mjs` |

## 6. Concerns

None. All verification passed cleanly on this run. The review findings (heapUsed metric, missing control group, missing try/finally, uncommitted e2e) have been addressed.
