# Task 2: Background upload route streams — Report

## What was implemented

Rewrote the `POST /api/background/upload` handler in `server/background-routes.ts` to use the streaming `streamUploads` helper from Task 1 (`server/stream-upload.ts`) instead of buffering the entire file in memory via `c.req.parseBody`.

Key changes:
- Replaced `writeFile` import with `streamUploads`, `UploadError`, `type SavedUpload` from `./stream-upload.js`
- Handler now streams the multipart body directly to disk via `streamUploads`, using a `place()` callback that generates `<uuid><ext>` filenames with `.part` temp suffixes
- Error mapping preserved exactly: `too-large` → 413, `bad-type` → 400, `parse` → 400 ("invalid multipart payload")
- Empty body / no file → 400 ("no file in request")
- Response contract unchanged: `{ url: "/api/background/files/<name>" }`

## What was tested and results

**All 23 pre-existing test cases pass unmodified.** The test file was not weakened — no cases were edited or removed.

3 new test cases added:
1. `400s when the request carries no file` — FormData with only a text field, no File
2. `400s on a malformed multipart body` — raw string body with invalid boundary
3. `leaves no .part file behind after a rejected upload` — verifies `streamUploads` cleanup on `UploadError` (bad-type rejection)

**Final: 26/26 passing in `server/background-routes.test.ts`**

Full suite: 273 test files passed, 13 failed (all pre-existing failures in app-plugins, mp-marketplace, system-stats — unrelated to this change).

## TDD Evidence

### RED
```
npx vitest run server/background-routes.test.ts
```
Result: 1 failure — `leaves no .part file behind after a rejected upload` threw `ENOENT: scandir '...backgrounds'` because the old `parseBody` handler never created the directory on a rejected upload. The other 2 new tests passed because the old handler already returned 400 for those cases.

### GREEN
```
npx vitest run server/background-routes.test.ts
```
Result: 26/26 passing. The new handler calls `mkdir(dir, { recursive: true })` before `streamUploads`, so the directory exists when the `.part` cleanup check runs. `streamUploads` itself unlinks all temp files on `UploadError`.

## Files changed

- `server/background-routes.ts` — rewrote POST /upload handler to use `streamUploads`
- `server/background-routes.test.ts` — added `readdirSync` import and 3 new test cases

## Self-review findings

- The diff is minimal and clean: +55 / -22 lines across 2 files
- `writeFile` correctly removed from imports (now unused)
- `SavedUpload` type import used only for the local variable type annotation
- `place()` callback uses `Object.hasOwn(ALLOWED_UPLOAD, mimeType)` semantics implicitly — `streamUploads` already checks `Object.hasOwn(o.accept, info.mimeType)` before calling `place()`, so the extension lookup inside `place` is safe
- Error status codes and messages match the old handler exactly
- No `bodyLimit` middleware involved (as required)
- Logging preserved: same `log.info` format with name and bytes

## Commit

`5614196` — `feat(upload): stream the background upload route to disk`
