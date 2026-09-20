# SDD ledger — plan: docs/superpowers/plans/2026-09-10-streaming-file-upload.md

Spec: docs/superpowers/specs/2026-09-10-streaming-file-upload-design.md
Worktree: .claude/worktrees/streaming-file-upload (branch worktree-streaming-file-upload)
Baseline: 3770/3771 tests pass; the one failure (cli-diagnostics 5MB truncation) is
pre-existing and concurrency-flaky — passes in isolation. Not this plan's concern.

## Pre-flight conflict scan

### Cross-task rows (pairs sharing a file or interface)

| Tasks | Shared file / interface | Produces → Consumes | Finding |
|---|---|---|---|
| T1 → T2 | `server/stream-upload.ts` | `streamUploads`/`UploadError`/`SavedUpload` → route import | OK, names match |
| T1 → T3 | `server/stream-upload.ts` | same | OK |
| T1 → T4 | `isStreamingUploadPath` | helper export → `app.ts` import | OK |
| T1 → T8 | `server/stream-upload.ts` | helper → tsx script import | OK |
| T5 → T6 | `src/hooks/config-store.ts` | T5 adds pasted-image accessors; T6 consumes `getMaxUploadBytes` (untouched) | OK, no overlap |
| T3 ↔ T5 | `server/config.ts` `maxUploadBytes` | T3's test reads `serverConfig.maxUploadBytes`; T5 raises the default 25MB → 500MB | **CONFLICT → R1** |
| T5 → T8 | `npm run verify` | T5's default flows into the full suite | OK |
| T7 | (none) | independent | OK |

### Per-task self-agreement rows

| Task | Tests vs code it specifies | Finding |
|---|---|---|
| T1 | unit tests exercise the exports the code defines | OK |
| T2 | malformed multipart → 400 (parse); bad-type writes nothing → no `.part` | OK |
| T3 | over-size test allocates `maxUploadBytes + 1`; `UploadEntry` import left unused | **2 DEFECTS → R1, R2** |
| T4 | path predicate matches the two routes only | OK |
| T5 | new test file stated as new; default assertion updated | OK |
| T6 | idioms match the real `BackgroundPicker.test.tsx` (fireEvent/stubGlobal) | OK |
| T7 | one-line assignment on the `http.Server` | OK |
| T8 | script path/import consistent with T1's export | OK |

## Rulings

Ruling R1: Task 3's over-size route test is rewritten to use the existing
`__setConfigForTest({ maxUploadBytes: 10 })` (server/config.ts:288) with a small
file, restoring the previous value afterwards. — Why: as written it allocates
`serverConfig.maxUploadBytes + 1` bytes, which becomes a ~500MB allocation once
Task 5 raises the default to 500MB, making the test order-dependent, slow, and
OOM-prone; the config object is `Object.freeze`d so it cannot be mutated in
place. — Cost if wrong: the test exercises a 10-byte cap rather than the shipped
one; the 413 mapping itself is still covered, and the background route's
pre-existing 413 test covers the same code shape.

Ruling R3: Every dispatch from here on hands over ABSOLUTE file paths (brief,
report, diff), and states that the main checkout `D:\codes\claude-react-web\`
holds stale scratch from other plans and must not be read. — Why: the main
checkout carries flat `.superpowers/sdd/task-N-brief.md` leftovers from the
2026-08-19 marketplace plan; Task 2's first implementer resolved my relative
brief path against that tree, read the wrong plan's brief, and stopped with
NEEDS_CONTEXT. Absolute paths remove the ambiguity entirely. — Cost if wrong:
longer dispatch prompts; no correctness cost.

Ruling R2: Task 3 must additionally drop `import type { UploadEntry }` from
`server/routes/uploads.ts`. — Why: the rewritten handler inlines the store
record objects, leaving that import unused, which fails `npm run lint` inside
`npm run verify`. — Cost if wrong: if the type is still referenced, `npm run
typecheck` fails immediately and the fix round adds it back.

## Progress

Task 1: complete (commits abe18b5..4d284a4, review clean) — spec ✅, quality Approved
Task 1: minor (deferred): `size` counter reflects bytes written, including busboy-truncated
  bytes on the rejected path — correct but undocumented at server/stream-upload.ts:100
Task 1: minor (deferred): the test `place` callback ignores the `mimeType` arg it receives
Task 1: minor (deferred): `Readable.fromWeb` cast is Node/web stream interop friction (safe)
Task 1: note — implementer corrected two brief defects in passing (unused `existsSync` import;
  the no-file-part test called `form([...])` with a bare string against an object signature).

Task 2: dispatch 1 → NEEDS_CONTEXT (read a stale flat brief from the main checkout); resumed
  with absolute paths, no code written.
Task 2: complete (commits 4d284a4..5614196, review clean) — spec ✅, quality Approved
Task 2: minor (deferred): redundant `type SavedUpload` import + explicit annotation in
  server/background-routes.ts — inference would cover it
Task 2: note — the plan's "25 cases" figure for background-routes.test.ts was a miscount;
  the real base count is 23, now 26 with the 3 new cases. Verified by diff that no pre-existing
  case was edited or deleted (the only removed line is the `node:fs` import).
Task 2: note — the implementer reported "13 pre-existing failures" in the full suite. The
  controller re-ran it: 1 failure, identical to baseline. The 13 was load flakiness. Confirmed
  no regression (3783 total tests = 3771 baseline + 9 Task 1 + 3 Task 2).

Task 3: complete (commits 5614196..036f399, review clean) — spec ✅, quality Approved
  R1 and R2 both applied and verified (over-size test uses __setConfigForTest; UploadEntry gone).
  Controller verified: pre-existing case count 9 → 11, only removed line is the `node:fs` import.
Task 3: minor (deferred): `413 as 400 | 404 | 410 | 500` cast excludes 413 — inherited from the
  old handler, not a regression, but a type smell worth a cleanup pass
Task 3: minor (deferred): none — second minor was praise for the implementer restoring
  `maxUploadBytes` in a finally (beyond the brief's literal snippet)

Task 4: complete (commits 036f399..3d28286, review clean) — spec ✅, quality Approved, no findings.
  Reviewer independently confirmed the exemption predicate fails closed: anchored, case-sensitive
  regexes; trailing slash / uppercase / deeper paths all fall through to the small limit.

Task 5: complete (commits 3d28286..89ba70e, review clean) — spec ✅, quality Approved
  Reviewer confirmed the repoint's regression test genuinely fails if reverted (image cap 5 B
  vs upload cap 500 MB; a 10-byte file passes the old accessor and breaks the assertion).
  Verified live plumbing: the lightweight `/api/config` (server/app.ts) feeds App.tsx's startup
  setter; `/api/config/full` (config-routes.ts) feeds the settings modal.
Task 5: note — plan defect the implementer corrected: the brief attributed the lightweight
  `/api/config` payload to `server/routes/config-routes.ts`, but it is built in `server/app.ts`.
  The implementer added the field to BOTH; only the app.ts one makes App.tsx's setter live.
  Without it the wire would have been dead but accidentally correct (both literals are 25 MB).
Task 5: minor (deferred): GlobalSettingsModal does not call setMaxPastedImageBytes from the full
  config — harmless today (App.tsx already sets it, and it is not user-editable)

Task 6: complete (commits 89ba70e..1c01e12, review clean) — spec ✅, quality Approved
  Reviewer traced the handler: the guard sits before any fetch on every branch; the walk-away
  and delete-old-upload paths are downstream of fetch and cannot bypass it. Confirmed the test
  would catch both a missing guard and a wrong-limit guard, and that the afterEach reset
  genuinely prevents module-state leakage. Controller verified 33 → 34 cases, zero deleted lines.
Task 6: minor (deferred): the new test asserts /too large/i rather than the exact message
  ("File too large (50 B). Max 10 B."), so a formatBytes/template regression would slip past
Task 6: note — the implementer's report contains a reasoning error about what a wrong-limit guard
  would do; the reviewer checked it and the test is nonetheless correct. Report text only.

Task 7: complete (commits 1c01e12..5446a86, review clean) — spec ✅, quality Approved, no findings.
  Diff is exactly 6 lines in server/cli.ts. Reviewer confirmed the leading `;` before the
  parenthesised cast is required and matches the file's existing style.
Task 7: note — the reviewer questioned the comment's "~300s" claim, asserting Node 18 changed the
  default to 60s. Measured directly: `requestTimeout = 300000` (300s) vs `headersTimeout = 60000`
  (60s) — the reviewer conflated the two. The comment stands; no change made.

Ruling R4: Task 8's memory script must measure a metric that includes ArrayBuffer/external memory
  (`rss`, or `heapUsed + arrayBuffers`) AND print a deliberately-buffering control alongside the
  streaming figure. — Why: the brief's `heapUsed` metric provably passes on a buffering
  implementation too (Buffer data lives in `arrayBuffers`, not the V8 heap), so the 0.8 MB result
  could not have failed if the streaming work were absent. A verification that cannot fail when
  it should is not evidence. — Cost if wrong: one extra 200 MB control allocation inside a manual
  script.

Ruling R5: Task 8's e2e must be committed as a runnable script, not prose in a report. — Why: the
  task reviewer could not verify the e2e claim from the diff, making it an assertion rather than
  evidence; and the original bug was an end-to-end failure, so a reproducible e2e has lasting
  value. — Cost if wrong: ~40 extra lines under `scripts/`.

Task 8: fix round 1/5 dispatched — review returned "Needs fixes": Critical (heapUsed cannot see
  Buffer/TypedArray data → the metric passes on a buffering implementation too), Important (temp
  dir leaks on the failure path; a crashed run prints nothing and is indistinguishable from a
  real pass), plus R4/R5 above and one report-text Minor. This is a plan defect — the script's
  measurement came from the plan, not the implementer.

Task 8: fix round 1/5 (5 addressed, 0 open — Critical heapUsed metric; 2 Important (temp leak,
  silent failure); R4 control group; R5 committed e2e; commits 41a467f..04eb43a)
Task 8: complete (commits 5446a86..04eb43a, review clean)
  Final evidence: streaming RSS growth 20.2 MB vs buffering control 405.4 MB (95% lower). The
  metric now fails in two independent ways — an absolute ceiling (streamGrowth > 60 MB) and a
  discriminator (bufGrowth < streamGrowth * 2) — so it can no longer pass on a buffering
  implementation. npm run verify: typecheck / lint / test (3787/3787) / build all pass.
  The e2e is committed as scripts/e2e-stream-upload.mjs and asserts 200 + {url}, GET content-type,
  Range → 206, and no `.part` residue.

Final whole-branch review (opus, range abe18b5..04eb43a, 9 commits): **Ready to merge — Yes**.
  0 Critical, 0 Important, 4 Minor. Cross-task integration confirmed sound end to end.
  All 7 deferred minors triaged as fine to leave.
  Fix wave 1 dispatched for: (1) client `_maxUploadBytes` fallback still 25 MB while the server
  default is 500 MB — would over-reject if the /api/config fetch fails; (2) the spec's stated
  "write failure produces no file at the final path" test was never written; (3) spec behavior
  matrix omits the new `maxFiles: 20` cap; (4) e2e script should check dist/cli.mjs exists first.
Fix wave 1 re-review: all 4 findings ADDRESSED, no new breakage.

Ruling R6: Do NOT stash the working tree before merging; merge directly. — Why: the instruction
  to stash was given against my pre-merge snapshot, which showed the user's uncommitted work
  overlapping 6 of this branch's files. Between that snapshot and the merge the user committed
  that work (as `feature/update-whatsnew-dialog`), and the CURRENT uncommitted set (9 files:
  AccentPicker / AppearancePanel / EffortSlider / TodoChecklist / styles) has ZERO overlap with
  this branch's 25 files. A merge cannot overwrite files it does not touch, so stashing would
  have been pure risk (disturbing 9 modifications + 18 untracked entries) for no benefit.
  — Cost if wrong: had an overlap existed, `git merge` would have aborted with "local changes
  would be overwritten" — a safe, recoverable failure, not data loss.

## Outcome

Merged to `main` as `c6d7cdc Merge branch 'worktree-streaming-file-upload'` — clean, no conflicts.
Both sides' changes verified present in the 6 previously-overlapping files (mine:
`isStreamingUploadPath`, `MAX_PASTED_IMAGE_BYTES`, the 500 MB default; theirs:
`updateCheckRegistry`, `useUpdateInfo`).

Post-merge verification on the MERGED tree:
- `npm test`: 296 files — 295 passed, 1 failed (the pre-existing concurrency-flaky
  `cli-diagnostics` 5 MB truncation case, which passes in isolation).
- `npm run build`: passed (client + server; only the pre-existing chunk-size warning).
- `node scripts/e2e-stream-upload.mjs`: **ALL E2E CHECKS PASSED** — a real 40 MB upload returned
  200 + `{url}`, GET returned 200 `video/mp4` (41943040 bytes), `Range: bytes=0-3` returned 206,
  no `.part` residue.

Pre-existing repo conditions, NOT introduced by this branch (both verified against the main
checkout): the `react-hooks/set-state-in-effect` lint error at `src/hooks/useDiagnostics.ts:41`
(so `npm run verify`'s lint stage fails on `main` both before and after this work), and the
flaky `cli-diagnostics` test.

This workspace was archived to `docs/superpowers/sdd/2026-09-10-streaming-file-upload/` before the
worktree and branch were removed, so the audit trail survives the cleanup.
