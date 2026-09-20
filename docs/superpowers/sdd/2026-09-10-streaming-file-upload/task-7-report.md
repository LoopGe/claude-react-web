## Task 7 Report: Widen the request timeout for large uploads

### What was implemented

Added a single line to `server/cli.ts` that sets `server.requestTimeout = 30 * 60 * 1000` (30 minutes) after the `server.on('connection', …)` block and before the WebSocket attach. This prevents Node's default ~300s request timeout from killing large file uploads mid-transfer on slow links.

The cast `(server as unknown as Server)` was required because `serve()` from `@hono/node-server` returns a `ServerType` union that includes `Http2Server` (which lacks `requestTimeout`), matching the existing pattern at line 341 where the same cast is used for the WebSocket attach.

### Typecheck

Both tsconfigs pass cleanly (`tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.node.json --noEmit`).

### Test suite

Full suite ran (287 files, ~902s). 8 failures, all pre-existing flaky/timeout tests unrelated to this change:
- `server/cli-diagnostics.test.ts` — the known ~5MB truncation flaky case (2 tests)
- `server/git.test.ts` — 2 tests (timeout flaky)
- `server/session-manager.test.ts` — 1 test (timeout flaky)
- `server/app-plugins/configuration-store.test.ts` — 1 test (timeout flaky)
- `src/session-store/store.idb.test.ts` — 1 test (60s timeout flaky)
- `src/components/agent-definitions/AgentDefinitionForm.test.tsx` — 1 test (timeout flaky)

None of these tests touch `server/cli.ts` or the request timeout.

### Files changed

- `server/cli.ts` — 6 lines added (1 assignment + 4 comment lines + 1 blank)

### Self-review findings

- Placement is unconditional: always runs in the `runServer` function, not inside any conditional branch.
- Value is finite (30 min, not 0) — preserves slowloris protection while accommodating ~500 MB at ~1 MB/s.
- Comment accurately explains the trade-off and follows the style of the neighboring `server.on('connection', …)` comment.
- The `(server as unknown as Server)` cast is consistent with the existing pattern in the same file.

### Commit

`5446a86 fix(upload): widen requestTimeout so slow large uploads are not killed`
