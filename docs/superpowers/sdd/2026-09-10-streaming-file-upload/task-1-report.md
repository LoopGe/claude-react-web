# Task 1 Report: Streaming multipart helper

## What was implemented

Created `server/stream-upload.ts` -- a streaming multipart/form-data parser that writes file parts to disk via temp files with atomic rename on success. Exports:
- `streamUploads(o: StreamUploadOptions): Promise<SavedUpload[]>` -- the core async function
- `UploadError` class with `failure: UploadFailure` property
- `SavedUpload`, `PlaceArgs`, `StreamUploadOptions`, `UploadFailure` types
- `isStreamingUploadPath(path: string): boolean` -- route matcher for bodyLimit exemption

Added `busboy` (runtime) and `@types/busboy` (dev) dependencies.

## TDD Evidence

### RED
```
npx vitest run server/stream-upload.test.ts
```
Result: `Cannot find module './stream-upload.js'` -- expected, the implementation file did not exist yet.

### GREEN
```
npx vitest run server/stream-upload.test.ts
```
Result: `9 passed (9)` in 75ms. All tests green.

## What was tested (9 tests)

1. Single file write + size reporting
2. Type allow-list rejection (bad-type failure, no files written)
3. Prototype-key rejection via Object.hasOwn (`constructor` not in allow-list)
4. Over-size rejection (too-large failure, no temp files left behind)
5. Empty body (no file parts) returns `[]`
6. Multiple file persistence
7. maxFiles enforcement (excess files silently dropped)
8. Client abort mid-stream cleanup (ReadableStream error, no .part files remain)
9. isStreamingUploadPath route recognition (4 assertions)

## Self-review findings

Two typecheck errors from the brief's exact code were fixed:
1. **Unused import:** `existsSync` was imported but never used -- removed it.
2. **Type mismatch:** `form(['field-value'])` passed a bare string where the type expects `{ body: string | Uint8Array; ... }` -- changed to `form([{ body: 'field-value' }])`.

Both are minor correctness fixes to the brief's code, not semantic changes.

## Full suite result

285 of 286 test files pass (3779/3780 tests). The one failure is `server/cli-diagnostics.test.ts > caps the jsonl file at ~5MB keeping the tail` -- a pre-existing 30s timeout on a heavy I/O test, unrelated to this change.

## Files changed

- `server/stream-upload.ts` (new, 103 lines)
- `server/stream-upload.test.ts` (new, 107 lines)
- `package.json` (+1 dep, +1 devDep)
- `package-lock.json` (auto)

## Commit

```
4d284a4 feat(upload): streaming multipart helper (busboy, temp + atomic rename)
```
