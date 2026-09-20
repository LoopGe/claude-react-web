# Final-fix-wave report

Date: 2026-09-10

## Fix 1 — config-store fallback aligned to 500 MB

**What changed:**
- `src/hooks/config-store.ts:8` — exported `DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024` (500 MB); the module-level `_maxUploadBytes` now initializes from that constant instead of the old inline `25 * 1024 * 1024`.
- `src/components/BackgroundPicker.test.tsx:13` — added `DEFAULT_MAX_UPLOAD_BYTES` to the import from `config-store`.
- `src/components/BackgroundPicker.test.tsx:35` — the `afterEach` reset now calls `setMaxUploadBytes(DEFAULT_MAX_UPLOAD_BYTES)` instead of the hardcoded `25 * 1024 * 1024` literal.

**Why this shape:** A single exported constant is the minimal change that removes the drift. The test imports the same constant it resets to, so both default and test-reset stay in sync with no additional coupling.

**What I did NOT do:** I did not change any other consumers. The test `'shows why an upload was refused'` still asserts on the string `26214400 bytes` (the 25 MB the mock server returns), which is correct — that test sets up its own mock and the assertion matches the mock, not the config-store default.

**Test:** `npx vitest run src/components/BackgroundPicker.test.tsx` — 34/34 passed.

## Fix 2 — write-failure test added to stream-upload.test.ts

**What changed:**
- `server/stream-upload.test.ts:101-112` — new test `'a write failure produces no file at the final path'`. It uses a `badPlace` that returns `tmp` inside a non-existent subdirectory (`join(dir, 'does-not-exist', ...)`) so `createWriteStream` errors. Asserts: `streamUploads` rejects with `UploadError`, nothing exists at `final`, and the `dir` is empty (no `*.part` residue).

**Test:** `npx vitest run server/stream-upload.test.ts` — 10/10 passed (including the new one).

## Fix 3 — spec behavior matrix row for maxFiles

**What changed:**
- `docs/superpowers/specs/2026-09-10-streaming-file-upload-design.md:238` — added a row to the Behavior matrix: "More than 20 file parts in one session-upload request → first 20 persisted; excess silently dropped by busboy `files` limit". Follows the existing table style.

**What I did NOT do:** No other text in the spec was changed.

## Fix 4 — e2e script pre-flight check

**What changed:**
- `scripts/e2e-stream-upload.mjs:13-16` — added `existsSync` import and a pre-flight check: if `dist/cli.mjs` is missing, prints `dist/cli.mjs not found — run \`npm run build\` first.` and exits with code 1.

**Test:** Ran the e2e script with `dist/cli.mjs` present (proceeds normally) and with `dist/` removed (prints message, exits 1).

## Verify results

- `npm run typecheck` — passed (both tsconfigs clean).
- `npm test` — 287 files, 3788 tests, all passed.
- `npm run lint` — 1 pre-existing error (`useDiagnostics.ts:41`, `react-hooks/set-state-in-effect`), identical before this wave. 8 pre-existing warnings.
- `npm run build` — client + server both built successfully.
