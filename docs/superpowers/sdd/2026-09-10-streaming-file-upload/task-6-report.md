# Task 6 Report: BackgroundPicker client-side pre-check

## What was implemented

A client-side file-size pre-check in `BackgroundPicker.tsx`'s `handleUpload` function that compares `file.size` against `getMaxUploadBytes()` before constructing `FormData` or calling `fetch`. When the file exceeds the limit, an error message is set and the function returns early — no network request is made.

Error message format: `"File too large (X KB). Max Y MB."` — uses `formatBytes` for human-readable sizes, consistent with the picker's existing copy style.

## Files changed

- `src/components/BackgroundPicker.tsx` — added imports for `getMaxUploadBytes` and `formatBytes`; added pre-check block at top of `handleUpload`
- `src/components/BackgroundPicker.test.tsx` — added import for `setMaxUploadBytes`; added reset in `afterEach`; added new test case

## TDD Evidence

**RED** (before pre-check existed):
- Command: `npx vitest run src/components/BackgroundPicker.test.tsx`
- Result: `1 failed | 33 passed (34)` — the new test failed with `"Cannot read properties of undefined (reading 'json')"` because `fetch` was called (empty mock returned undefined for `.json()`)
- Expected failure: no pre-check means `fetch` runs, confirming the test correctly detects the missing guard

**GREEN** (after adding pre-check):
- Command: `npx vitest run src/components/BackgroundPicker.test.tsx`
- Result: `34 passed (34)` — all tests pass
- Ran twice to confirm order-independence: both runs `34/34 passed`

## Test results

- **File-level**: 34/34 passed (before: 33/34, after pre-existing tests; 34/34 after fix)
- **Full suite**: 287 files, 3787 tests, 0 failures (exited code 0)
- **Typecheck**: both tsconfigs pass cleanly

## Self-review findings

- **Completeness**: Pre-check runs before `new FormData()` and `fetch()` — the earliest possible point. Uses `getMaxUploadBytes()` which is the published limit.
- **Quality**: Error message is clear, uses `formatBytes` for readability, matches the picker's tone.
- **Discipline**: YAGNI — exactly the pre-check, nothing else added.
- **Test quality**: The test sets `setMaxUploadBytes(10)` and uploads a 50-byte file. If the pre-check accidentally used a different limit (e.g., the default 25 MB), the test would still pass — but only because the file is also under 25 MB. However, the test also asserts `fetchMock.not.toHaveBeenCalled()`, which would fail if the pre-check used the wrong limit and let the file through (since the empty mock would cause a crash). The test correctly validates both the error message and the absence of network calls.
- **Order-independence**: `setMaxUploadBytes(25 * 1024 * 1024)` in `afterEach` resets the module-global state, preventing the 10-byte cap from leaking into the existing 413 test.

## Commit

- `1c01e12` feat(background): refuse an over-size file client-side before uploading
