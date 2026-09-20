# Task 3: Session uploads route streams — Report

## What was implemented

Rewired `POST /sessions/:id/uploads` in `server/routes/uploads.ts` from in-memory buffering (`c.req.parseBody` + `f.arrayBuffer()` + `writeFile`) to the streaming `streamUploads` helper from Task 1. Files are now written to `.part` temp files and atomically renamed on success — no truncated upload is ever visible at a servable path.

### Handler changes
- Removed `parseBody`-based file collection; replaced with `streamUploads` streaming pipeline
- Removed `writeFile` import (no longer needed); added `join` import (needed for temp/final paths)
- Removed unused `type { UploadEntry }` import from `shared/uploads.js` (R2 ruling)
- Added `const cwd = info.cwd` capture to preserve TypeScript narrowing across `await`
- `UploadError` catch maps `too-large` → 413, other failures → 400
- `streamUploads` receives `maxFileBytes: serverConfig.maxUploadBytes`, `maxFiles: 20`
- Response shape `{ uploads: [{ path, name, size }] }` unchanged
- `UploadStore` record fields (`id, path, cwd, name, size, uploadedAt, sessionTitle`) unchanged
- No `bodyLimit` middleware added (streaming routes must not use it)

## Testing

### TDD Evidence

**RED phase:** Both new tests were added to the test file. However, both passed immediately against the old implementation — the old `parseBody`-based code already handled multi-file uploads (via `{ all: true }`) and per-file size checking. The streaming rewrite is a memory-efficiency improvement, not a behavioral change for these test inputs. No old tests were weakened.

**GREEN phase:** All 11 tests pass (9 pre-existing + 2 new) after the handler rewrite.

### Full suite
- `npx vitest run` → **3785 passed across 286 test files**, 0 failures
- `npm run typecheck` → clean (both tsconfigs)
- `npx eslint server/routes/uploads.ts server/routes/uploads.test.ts` → clean

### Pre-existing tests (9 cases, UNMODIFIED)
1. writes the file, returns 200, and records a registry entry
2. still succeeds without a store (unrecorded)
3. lists entries with live exists flags
4. 404s when no store is mounted
5. unlinks the file and removes the entry
6. removes a missing entry without unlinking (already gone)
7. 404s on unknown id
8. 400s when the entry path escapes <cwd>/claude-web-uploads
9. removes the file AND syncs the registry (chips path)

### New tests (2 cases)
1. **persists two files in one request** — sends two files, expects 200 with both names returned
2. **413s an over-size file and leaves no partial file** — uses `__setConfigForTest({ maxUploadBytes: 10 })` per R1, sends 50-byte file, expects 413 and no `.part` files remaining

## Files changed

| File | Change |
|------|--------|
| `server/routes/uploads.ts` | Handler rewrite: streaming via `streamUploads`, import cleanup |
| `server/routes/uploads.test.ts` | Added 2 new test cases, added `readdirSync` + config imports |

## Self-review findings

1. **TypeScript narrowing** — `info.cwd` is `string | undefined`. The `if (!info.cwd) return` guard narrows it, but the narrowing is lost after `await streamUploads(...)`. Fixed by capturing `const cwd = info.cwd` before the await. This is a genuine TS flow-analysis limitation, not a workaround.

2. **R1 compliance** — The over-size test uses `__setConfigForTest` to set `maxUploadBytes: 10` instead of allocating ~500MB, exactly as the ruling specified.

3. **No behavioral regression** — The response shape, record fields, error codes, and filename sanitization logic are all preserved from the original handler.

## Issues/concerns

None. The task is straightforward and the change is minimal in scope.
