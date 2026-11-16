# Native Provider readFile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement native `readFile` / `seedReadState` with Claude-compatible wire behavior, bounded file projection, current-version read-state, and guarded Edit.

**Architecture:** A shared low-level file module resolves real targets and binds every read or edit to one `FileHandle`. `NativeSession` adds a host-only permission path, while a per-session `NativeReadState` joins host observations, model Read windows, manager seeding, and Edit. Per-session Read/Edit tool instances prevent cross-session authorization.

**Tech Stack:** TypeScript, Node 20 `fs/promises` `FileHandle` + bigint stats + `TextDecoder`, Vitest, existing Hono routes and native provider test seams.

**Spec:** `docs/superpowers/specs/2026-11-16-native-read-file-design.md`

## Global Constraints

- Execute on `main`; do not create a worktree, pull, push, or add dependencies.
- Stage only files named by each task; preserve unrelated modified/untracked files.
- Keep REST and `FileReadResult` shapes unchanged. `truncated:false` may be omitted by existing narrowing.
- Do not persist read-state or emit transcript/git frames for host reads. Turn on `supportsReadFile` only in Task 3 after behavior is complete.
- Do not change Write, NotebookEdit, Bash, Structured Output, plugins, other wire protocols, or sandbox behavior.
- Use no real network in tests; native model turns use `NativeProvider._testStream`.
- Self-review the full task diff before every commit and complete the independent task review after it. Commit messages end with `Co-Authored-By: Kimi <noreply@moonshot.cn>`.

## Review Focus

- Path or in-place replacement must not certify bytes from another version; pinned by Task 1 race tests and Task 3 seed-window tests.
- Large files and multi-window reads must stay bounded without quadratic prefix scans; pinned by Task 1 window-offset tests and Task 3 continuation tests.
- Effective tool rules and permission rewrites must not bypass Read policy; pinned by Task 2 profile and `updatedInput` tests.
- Partial/failed reads must preserve only still-current older evidence, while replacement sessions inherit nothing; pinned by Task 3 state and E2E tests.
- Edit must handle `$` literally, count UTF-8 bytes, and bound `replace_all` output before allocation; pinned by Task 3 Edit regressions.

---

### Task 1: File identity and bounded projection

**Files:**
- Create: `server/providers/native/file-read.ts`
- Create: `server/providers/native/file-read.test.ts`
- Modify: `server/providers/native/tools/read.ts`
- Test: `server/providers/native/tools/read.test.ts`

**Interfaces:**
- Consumes: existing `FileReadResult`, `ToolContext`, and `ToolInputError` contracts.
- Produces:
  ```ts
  const DEFAULT_READ_MAX_BYTES = 1_048_576
  const MODEL_READ_WINDOW_MAX_BYTES = 1_048_576
  const MODEL_READ_MAX_LINES = 2000
  const MAX_EDIT_BYTES = 8 * 1024 * 1024

  interface NativeFileIdentity {
    dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint
  }
  interface NativeReadTarget {
    requestedPath: string; absolutePath: string; realPath: string
    identity: NativeFileIdentity
  }
  interface NativeReadObservation {
    target: NativeReadTarget; identity: NativeFileIdentity
  }
  interface NativeTextWindow {
    text: string; startLine: number; endLine: number
    endByteOffset: number; scannedByteCount: number; reachedEof: boolean
    observation: NativeReadObservation
  }

  class NativeFileUnavailableError extends Error {}
  class NativeFileChangedError extends Error {}
  class NativeFileEncodingError extends Error {}
  class NativeReadWindowTooLargeError extends Error {}

  function sameNativeFileIdentity(a: NativeFileIdentity, b: NativeFileIdentity): boolean
  function nativeMtimeFloor(identity: NativeFileIdentity): number
  function resolveNativeReadTarget(cwd: string, path: string): Promise<NativeReadTarget>
  function assertNativeTargetCurrent(target: NativeReadTarget): Promise<void>
  function withNativeFile<T>(
    target: NativeReadTarget,
    signal: AbortSignal,
    fn: (handle: import('node:fs/promises').FileHandle) => Promise<T>,
    opts?: { allowMutation?: boolean },
  ): Promise<{ value: T; observation: NativeReadObservation }>
  function readNativeTarget(
    target: NativeReadTarget,
    opts: { maxBytes?: number; encoding?: 'utf-8' | 'base64'; signal: AbortSignal },
  ): Promise<{ result: FileReadResult; observation?: NativeReadObservation }>
  function readNativeTextWindow(
    target: NativeReadTarget,
    opts: { offset?: number; limit?: number; startByteOffset?: number; signal: AbortSignal },
  ): Promise<NativeTextWindow>
  ```

- [ ] **Step 1: Write failing target and host-read tests**

  Cover these exact assertions in `file-read.test.ts`:
  - relative and absolute cwd-internal paths and an internal symlink succeed; `..`, absolute escape, an internal link/junction pointing outside, a directory, and a missing path throw `NativeFileUnavailableError`;
  - empty text, exact `maxBytes`, `maxBytes + 1`, and default-cap reads return the expected contents and `truncated` values; only complete reads return an observation;
  - a cap in the middle of a multibyte codepoint retains only the complete prefix; invalid UTF-8 and NUL throw `NativeFileEncodingError`; base64 preserves `00 ff` bytes;
  - non-integers, zero, negatives, non-safe integers, and `Number.MAX_SAFE_INTEGER` are rejected before streaming;
  - mutating the file inside the default `withNativeFile` callback rejects with `NativeFileChangedError`; replacing the resolved target before open also rejects, proving target/opened-handle identity is compared;
  - replacing the path with B after a successful read rejects at the final path check; a gated-open A→B→A fixture that returns an opened B handle after restoring path A also rejects, so neither check can be omitted;
  - same-size replacement with the original mtime restored is still rejected by the remaining identity fields;
  - abort after a controlled first chunk stops subsequent reads, and abort/decode failures close the captured `FileHandle` and stream rather than leaking them.

- [ ] **Step 2: Run the low-level tests and confirm RED**

  Run: `npx vitest run server/providers/native/file-read.test.ts`
  Expected: FAIL because `file-read.ts` and its exports do not exist.

- [ ] **Step 3: Implement target resolution and bounded host reads**

  Implement the interfaces above in `file-read.ts`. Use lexical + realpath containment, bigint stats, ordinary-file checks, one opened handle for callback/pre/post identity, and a final path/realpath check. Check abort before open and after every chunk/await. By default `withNativeFile` rejects pre/post identity changes; `allowMutation:true` is reserved for Task 3 Edit and instead binds the final path to the post-callback identity. Map ENOENT/ENOTDIR/EACCES/EPERM to unavailable while preserving other I/O errors. Stream at most `maxBytes + 1`; use fatal UTF-8, NUL rejection, complete-codepoint trimming, and raw-prefix base64. Close the handle and cancel the stream on every exit.

- [ ] **Step 4: Run the low-level tests and confirm GREEN**

  Run: `npx vitest run server/providers/native/file-read.test.ts`
  Expected: all target, encoding, truncation, and identity tests PASS.

- [ ] **Step 5: Add failing model-window regressions**

  Extend `read.test.ts` and `file-read.test.ts`:
  - existing line numbers, offset/limit, trailing-newline, and empty-file behavior remain unchanged;
  - a small window in a multi-MiB file has `scannedByteCount` far below file size;
  - a continuation with `startByteOffset` scans only the continuation rather than the preceding prefix;
  - invalid UTF-8/NUL and a requested window over 1 MiB throw tool/encoding errors without partial output;
  - a 2001-line file returns line 2001 through a continuation with correct offsets.

- [ ] **Step 6: Implement bounded model projection**

  Implement `readNativeTextWindow` and migrate `readTool` to it. Scan only to the requested endpoint plus EOF probe, retain at most 2000 requested lines and 1 MiB of requested raw text, decode across chunks, and honor `startByteOffset` for continuations. Preserve line-number formatting and existing offset/limit normalization.

- [ ] **Step 7: Verify, self-review, and commit**

  Run: `npx vitest run server/providers/native/file-read.test.ts server/providers/native/tools/read.test.ts`
  Expected: all tests PASS. Run `git diff --check`, review the full diff, then:
  ```bash
  git add server/providers/native/file-read.ts server/providers/native/file-read.test.ts server/providers/native/tools/read.ts server/providers/native/tools/read.test.ts
  git commit -m "feat(native): add bounded file reads" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
  ```

### Task 2: Native host readFile, permissions, and manager integration

**Files:**
- Modify: `server/providers/native/native-session.ts`
- Create: `server/providers/native/native-session-read-file.test.ts`
- Modify: `server/providers/native/native-session.test.ts`
- Modify: `server/session-manager.ts`
- Modify: `server/session-manager.test.ts`
- Modify: `server/routes/sessions.ts`
- Test: `server/routes/sessions-read-file.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveNativeReadTarget` / `readNativeTarget` and error classes.
- Produces:
  ```ts
  NativeSession.readFile(
    path: string,
    opts?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' },
  ): Promise<FileReadResult>
  ```
  `supportsReadFile` remains `false` in this task.

- [ ] **Step 1: Write failing host permission tests**

  In `native-session-read-file.test.ts`, use real temp files and direct provider sessions to assert:
  - default missing-handler denies, bypass allows, and allow/deny callbacks receive `toolName='Read'`, normalized input, a `host-read-file:<uuid>` id, effective mode (including `auto`), and `sessionAbort.signal`;
  - `allowedTools:['Read']` auto-allows without a callback but still rejects an outside path;
  - effective visibility follows `persona.tools ?? base.tools` and `persona.disallowedTools ?? base.disallowedTools`: base `tools:['Edit']` + persona `tools:['Read']` allows, while base `disallowedTools:['Read']` remains denied unless the persona supplies `disallowedTools:[]`;
  - a callback rewrite of `file_path`, `maxBytes`, or `encoding` returns `available:false` and the mocked `readNativeTarget` spy is never called;
  - host read resolves while a model turn is blocked, does not await `assistantFlush`, emits no message frame, an ordinary turn interrupt does not cancel it, and destroy aborts a pending permission/read.

- [ ] **Step 2: Run host tests and confirm RED**

  Run: `npx vitest run server/providers/native/native-session-read-file.test.ts`
  Expected: FAIL because `NativeSession.readFile` is absent.

- [ ] **Step 3: Implement the host-only permission path**

  Extract the post-flush decision logic from `requestPermission` into a shared private helper without changing model-turn behavior. `readFile` checks field-wise effective Read visibility, resolves the target, honors base `allowedTools`, then uses the helper with `sessionAbort.signal` and `this.ctx.uuid()`. Require `updatedInput` to equal the exact normalized three-key input; map only `NativeFileUnavailableError` and denials to `{available:false}` and preserve real errors.

- [ ] **Step 4: Add failing route and relative-seed tests**

  Extend route tests with `1.5`, `NaN`, `Infinity`, `Number.MAX_SAFE_INTEGER`, and unsafe integer strings, all returning 400. Extend `session-manager.test.ts`:
  ```ts
  await sm.readFile(id, 'a.txt')
  expect(stat).toHaveBeenCalledWith(resolve(session.cwd, 'a.txt'))
  expect(seedReadState).toHaveBeenCalledWith('a.txt', 12345)
  ```
  Keep the existing absolute-path, unavailable, and best-effort assertions unchanged.

- [ ] **Step 5: Implement route validation and cwd-correct seed stat**

  Require a positive safe integer whose `+ 1` is also safe in `sessions.ts`. In `SessionManager.readFile`, stat the original absolute path or `resolve(s.cwd, path)` for a relative path; pass the original path to provider `seedReadState`.

- [ ] **Step 6: Verify, self-review, and commit**

  Run: `npx vitest run server/providers/native/native-session-read-file.test.ts server/providers/native/native-session.test.ts server/session-manager.test.ts server/routes/sessions-read-file.test.ts`
  Expected: all PASS and `supportsReadFile` still false. Run `git diff --check`, review the full diff, then stage exactly the seven files above and commit:
  ```bash
  git add server/providers/native/native-session.ts server/providers/native/native-session-read-file.test.ts server/providers/native/native-session.test.ts server/session-manager.ts server/session-manager.test.ts server/routes/sessions.ts server/routes/sessions-read-file.test.ts
  git commit -m "feat(native): wire host file permissions" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
  ```

### Task 3: Read-state, guarded Edit, recovery, and final gate

**Files:**
- Create: `server/providers/native/read-state.ts`
- Create: `server/providers/native/read-state.test.ts`
- Modify: `server/providers/native/tools/read.ts`
- Modify: `server/providers/native/tools/edit.ts`
- Test: `server/providers/native/tools/read.test.ts`
- Test: `server/providers/native/tools/write-edit.test.ts`
- Modify: `server/providers/native/loop.test.ts`
- Modify: `server/providers/native/subagent.test.ts`
- Modify: `server/providers/native/tools/attachment-read.test.ts`
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/providers/native/native-provider.ts`
- Modify: `server/providers/native/native-session.test.ts`
- Create: `server/providers/native/e2e-read-file.test.ts`
- Modify: `CLAUDE.md`
- Move: `.agents/notes/proposed/architecture/2026-11-16-native-read-file.md` → `.agents/notes/implemented/architecture/2026-11-16-native-read-file.md`

**Interfaces:**
- Consumes: all Task 1 file primitives and Task 2 host `readFile`.
- Produces:
  ```ts
  class NativeReadState {
    observeHost(observation: NativeReadObservation): void
    seedReadState(cwd: string, path: string, mtimeMs: number): Promise<void>
    continuation(target: NativeReadTarget, startLine: number): { byteOffset: number } | undefined
    recordModelWindow(window: NativeTextWindow, continued: boolean): void
    assertEditable(cwd: string, path: string): Promise<NativeReadTarget>
    completeEdit(observation: NativeReadObservation): void
    clear(): void
  }

  function createReadTool(state: NativeReadState): ToolDef<{
    file_path: string; offset?: number; limit?: number
  }>
  function createEditTool(state: NativeReadState): ToolDef<{
    file_path: string; old_string: string; new_string: string; replace_all?: boolean
  }>

  NativeSession.seedReadState(path: string, mtimeMs: number): Promise<void>
  ```
  `NativeSessionOptions.readState` is required; `NativeProvider` constructs one state and the matching Read/Edit tools per session.

- [ ] **Step 1: Write failing read-state tests**

  Use real files and Task 1 observations to prove:
  - a complete host observation seeds only when manager mtime and current identity match; direct seed without an observation is a no-op;
  - changes during provider return → stat → seed and same-size/same-mtime replacement do not seed;
  - truncated, partial, denied, invalid, or failed later reads neither seed nor revoke an older still-current seeded entry;
  - file-identity change invalidates the old entry; a fresh complete read authorizes again;
  - one full model window seeds directly; 2001 lines through offsets 1 then 2001 seeds only after the second window; skipped, overlapping, out-of-order, cross-version, and over-8-MiB candidates never seed;
  - 257 distinct targets evict the oldest from the 256-entry LRU, and an evicted target requires another complete read.

- [ ] **Step 2: Run state tests and confirm RED**

  Run: `npx vitest run server/providers/native/read-state.test.ts`
  Expected: FAIL because `NativeReadState` does not exist.

- [ ] **Step 3: Implement the bounded per-session state machine**

  Implement `NativeReadState` with one 256-target LRU containing pending host observations, seeded identities, and one contiguous model candidate per target. `seedReadState` revalidates path and identity; `continuation` resumes only an exact identity + next-line match; `assertEditable` resolves and compares the current target. Failed/partial operations leave existing seeded evidence untouched.

- [ ] **Step 4: Add failing Read/Edit integration regressions**

  Update tool tests to use per-session factories. Existing Edit cases establish a full read first, plus add:
  - no current read, stale version, invalid UTF-8, `new_string`/computed `next` containing NUL, empty `old_string`, original over 8 MiB, and precomputed `next` over 8 MiB all reject without changing bytes; oversized original input and externally extended readback stop at their byte caps rather than allocating to EOF;
  - `$&$&` is inserted literally; non-ASCII old/new sizes use UTF-8 bytes, not JS `.length`; `replace_all` overflow is rejected before allocation;
  - shortening and expansion both truncate/write from position 0 and read back from position 0; a controlled same-handle change after Edit's internal read but before truncate rejects without writing;
  - readback equal to `next` refreshes state, while changed readback or unstable identity leaves the file unseeded. Use a controlled `FileHandle` wrapper around the internal positioned write/readback helper for the mismatch case, including an external change after the last expected byte is returned but before readback `fstat`; do not use timing-sensitive concurrent writers.

- [ ] **Step 5: Add failing provider/session and real-manager E2E coverage**

  Migrate the existing static imports in `loop.test.ts`, `subagent.test.ts`, and `tools/attachment-read.test.ts` to fresh per-test factories. In `e2e-read-file.test.ts`, use `NativeProvider` + `ProviderRegistry` + `SessionManager`, fake model streams, and no network:
  - `sm.readFile(id, 'a.txt')` succeeds under `dontAsk` and `auto`, seeds through the manager, and a following model Edit succeeds without a prior model Read;
  - an external edit makes the next model Edit reject until a fresh complete read;
  - two simultaneously live sessions from one provider do not share evidence: a complete read in A never authorizes Edit in B;
  - in-place compact preserves evidence; plain `/clear`, manual compact clear-with-seed replacement, resume, and fork require rereading;
  - host reads produce no message/git/capacity events and no read-state event appears in `session.v1.jsonl`;
  - `supportsReadFile` is true only with working `readFile` and `seedReadState` methods.

- [ ] **Step 6: Run integration tests and confirm RED**

  Run: `npx vitest run server/providers/native/tools/read.test.ts server/providers/native/tools/write-edit.test.ts server/providers/native/loop.test.ts server/providers/native/subagent.test.ts server/providers/native/tools/attachment-read.test.ts server/providers/native/e2e-read-file.test.ts`
  Expected: the new factory/read-before-edit/capability/recovery assertions FAIL before Task 3 wiring; no test is added only after its implementation.

- [ ] **Step 7: Implement session binding, guarded Edit, capability, and docs**

  Replace static Read/Edit usage with factories. `NativeProvider` creates `NativeReadState` and ordered per-session tools before rendering prompts and passing `readState` to `NativeSession`. Host `readFile` stores complete observations; `seedReadState` delegates to the state; `destroy` clears it. `compactInPlace` does not clear it.

  Edit uses `assertEditable` + `withNativeFile(..., { allowMutation: true })`, fatal text checks, non-empty `old_string`, literal replacement via function replacer or concatenation, and precomputed `next` UTF-8 size. Its internal original-file read stops at `MAX_EDIT_BYTES + 1`, so oversize input is rejected before whole-file allocation. After the internal full read and before `truncate(0)`, it re-reads `fstat` and rejects if identity differs from the opened/read version. Factor positioned write/readback into an internal helper that accepts a `FileHandle`, so the mismatch test can control returned bytes. Write from position 0, then `fstat` immediately before readback and again after it. Read back from 0 with a hard cap of `nextByteLength + 1`; any missing, mismatched, or extra byte fails verification without buffering to EOF. Require pre-readback, post-readback, and outer `withNativeFile` identities to match as well as the exact `next` bytes before calling `completeEdit`, so a change after the last returned byte cannot be certified.

  Set `supportsReadFile: true` only after the integration behavior works. In `CLAUDE.md`, document the per-session `NativeReadState`, one-handle identity chain, bounded Read/Edit limits, and replacement-session rule. Move the Agent Note to `implemented`, change `Status: proposed` to `Status: implemented`, rewrite `## Proposal` as present-tense `## Decision`, and replace `## Acceptance criteria` + `## Risks` with `## Consequences` describing shipped tradeoffs and verification while retaining the design link.

- [ ] **Step 8: Run focused verification**

  Run: `npx vitest run server/providers/native/read-state.test.ts server/providers/native/file-read.test.ts server/providers/native/tools/read.test.ts server/providers/native/tools/write-edit.test.ts server/providers/native/loop.test.ts server/providers/native/subagent.test.ts server/providers/native/tools/attachment-read.test.ts server/providers/native/native-session-read-file.test.ts server/providers/native/native-session.test.ts server/providers/native/e2e-read-file.test.ts server/session-manager.test.ts server/routes/sessions-read-file.test.ts`
  Expected: all PASS. Run `npm run typecheck` and `npm run verify:agent-notes`; both exit 0.

- [ ] **Step 9: Run the final repository gate, self-review, and commit**

  Run `npm run test`, `npm run typecheck`, `npm run lint`, `npm run verify:agent-notes`, and `git diff --check`. Report any unrelated baseline failure precisely rather than adding workarounds. Review the complete three-task diff and address confirmed findings before staging exactly this task's files. Commit:
  ```bash
  git add server/providers/native/read-state.ts server/providers/native/read-state.test.ts server/providers/native/tools/read.ts server/providers/native/tools/edit.ts server/providers/native/tools/read.test.ts server/providers/native/tools/write-edit.test.ts server/providers/native/loop.test.ts server/providers/native/subagent.test.ts server/providers/native/tools/attachment-read.test.ts server/providers/native/native-session.ts server/providers/native/native-provider.ts server/providers/native/native-session.test.ts server/providers/native/e2e-read-file.test.ts CLAUDE.md .agents/notes/proposed/architecture/2026-11-16-native-read-file.md .agents/notes/implemented/architecture/2026-11-16-native-read-file.md
  git commit -m "feat(native): guard edits with read state" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
  ```
  Finish with the independent whole-branch review; do not pull or push without separate authorization.
