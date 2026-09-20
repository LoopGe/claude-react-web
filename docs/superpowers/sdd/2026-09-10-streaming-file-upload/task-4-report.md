# Task 4 Report: Path-aware global body limit

## What was implemented

Replaced the unconditional `bodyLimit` middleware in `server/app.ts` with a path-aware wrapper. Streaming upload paths (`/api/background/upload` and `/api/sessions/<id>/uploads`) bypass the body limit entirely; all other paths get the existing 32 MB cap. The predicate `isStreamingUploadPath` (from `server/stream-upload.ts`, Task 1) is used for the check, and it fails closed: any unrecognized path keeps its limit.

## Files changed

- `server/app.ts` — added `import { isStreamingUploadPath } from './stream-upload.js'` (line 37); replaced the `bodyLimit(...)` call (old lines 193-197) with a `smallBodyLimit` constant and a conditional middleware that skips it for streaming upload paths.

## Test results

- `npm run typecheck`: clean (both tsconfigs)
- `npm test`: 286 test files passed, 3785 tests passed, 0 failures
- No flaky failures observed (the known `cli-diagnostics.test.ts` truncation case did not trigger)

## Self-review findings

- **Completeness:** The exemption matches exactly the two streaming upload routes. The default is the small (32 MB) limit. Correct.
- **Quality:** Clear variable name (`smallBodyLimit`), descriptive comment explaining the fail-closed design. The one-liner middleware is idiomatic Hono.
- **Discipline:** Only the brief's block + import were added. No restructuring, no extra middleware, no unrelated changes.
- **Testing:** The predicate `isStreamingUploadPath` is already unit-tested by Task 1. This task has no test of its own, which is appropriate — it's a wiring change, not new logic.

## Issues/concerns

None.
