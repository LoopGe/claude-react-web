# Task 5 Report: One size knob + pasted-image cap plumbing

## What was implemented

Separated the two concerns `maxUploadBytes` was conflating:

- **File uploads** (multipart, now streamed) -- governed by `maxUploadBytes`, default raised from 25 MB to 500 MB.
- **Pasted images** (base64 in JSON body, buffered in memory) -- governed by a new internal constant `MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024`, exposed to the client via `/api/config` as `maxPastedImageBytes`. Deliberately NOT a user setting.

The key change: `usePastedImages` now reads `getMaxPastedImageBytes()` (25 MB) instead of `getMaxUploadBytes()` (now 500 MB). Without this, raising the upload knob would silently reintroduce the OOM the streaming work removed.

## Files changed

| File | Change |
|------|--------|
| `server/config.ts` | Default raised to 500 MB; new exported `MAX_PASTED_IMAGE_BYTES` constant |
| `server/routes/config-routes.ts` | Import + `maxPastedImageBytes` in `/config/full` payload |
| `server/app.ts` | Import + `maxPastedImageBytes` in lightweight `/config` payload |
| `server/config.test.ts` | Default assertion updated to 500 MB |
| `src/types/config.ts` | `maxPastedImageBytes` added to `ConfigResponse` and `FullServerConfig` |
| `src/hooks/config-store.ts` | New `getMaxPastedImageBytes()` / `setMaxPastedImageBytes()` |
| `src/App.tsx` | Import + call `setMaxPastedImageBytes` from `/config` response |
| `src/hooks/usePastedImages.ts` | Now uses `getMaxPastedImageBytes` instead of `getMaxUploadBytes` |
| `src/hooks/usePastedImages.test.ts` | **New file** -- tests that pasted images are capped by the image cap, not the upload cap |
| `src/components/GlobalSettingsModal.tsx` | Updated hint copy for the upload-size knob |

## TDD Evidence

### RED phase

```
npx vitest run server/config.test.ts src/hooks/usePastedImages.test.ts
```

- `server/config.test.ts`: `expected 26214400 to be 524288000` -- default is still 25 MB, test expects 500 MB.
- `src/hooks/usePastedImages.test.ts`: `(0 , setMaxPastedImageBytes) is not a function` -- not yet exported from config-store.

### GREEN phase

```
npx vitest run server/config.test.ts src/hooks/usePastedImages.test.ts
```

- `server/config.test.ts`: 45 tests passed
- `src/hooks/usePastedImages.test.ts`: 1 test passed
- Total: 2 files, 46 tests, all green

## Full suite results

```
npm run test
```

- 287 test files, 286 passed, 1 failed
- 3786 tests, 3785 passed, 1 failed
- The single failure is `server/cli-diagnostics.test.ts > caps the jsonl file at ~5MB keeping the tail` (timeout) -- the known pre-existing flaky failure documented in the task brief.

## Typecheck

```
npm run typecheck
```

Both `tsconfig.json` and `tsconfig.node.json` pass cleanly.

## Self-review findings

- **Completeness**: All files listed in the brief changed. New test file created. Both test files pass.
- **Quality**: Names are accurate (`MAX_PASTED_IMAGE_BYTES`, `getMaxPastedImageBytes`, `setMaxPastedImageBytes`, `maxPastedImageBytes`). Client/server values consistent (both 25 MB).
- **Discipline**: Only what was requested. `getMaxUploadBytes()` kept exported (used by Task 6's BackgroundPicker). No extra changes.
- **Testing**: The new test verifies real behavior (setting cap to 5 bytes rejects a 10-byte image). Output clean. No new suite failures.

## Commit

`89ba70e` feat(config): one upload-size knob; pasted images keep an internal cap
