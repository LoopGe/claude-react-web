# Win32 Job Object Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the whole CLI subprocess tree on Windows session teardown — including when the server itself is hard-killed — via kernel Job Objects, with a guarded taskkill fallback.

**Architecture:** One kill-on-close Job Object per CLI subprocess, created and owned in-process by `ProcessMonitor` through the existing `spawnClaudeCodeProcess` seam (koffi FFI, no runner). Graceful intentional exits retire survivor-bearing Jobs so backgrounded services live; killed/crashed exits and host exit terminate them. A creation-time-guarded `taskkill /T /F` fallback covers koffi absence. POSIX is untouched.

**Tech Stack:** TypeScript / Node ≥ 20 ESM, koffi 3.1.1 (Win32 FFI, optional dep), vitest (real-process tests), esbuild single-file bundle.

**Spec:** `.agents/notes/proposed/architecture/2026-11-17-win32-job-containment.md`

## Global Constraints

- koffi pinned `3.1.1` in `optionalDependencies`; loaded ONLY on win32 via synchronous `createRequire(import.meta.url)('koffi')` at first spawn; POSIX never loads it.
- `external: [..., 'koffi']` in `build.mjs` (both entries) and `desktop/build.mjs`; `node_modules/koffi/**` in `desktop/electron-builder.yml` `asarUnpack`.
- Win32 constants (verbatim from DSH `win32-process/src/abi.ts`): `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000`; `JobObjectExtendedLimitInformation = 9`, record size 144, LimitFlags offset 16; `JobObjectBasicAccountingInformation = 1`, record size 48, ActiveProcesses offset 40; `PROCESS_TERMINATE = 0x1`, `PROCESS_SET_QUOTA = 0x100`, `PROCESS_QUERY_LIMITED_INFORMATION = 0x1000`. No breakaway flags.
- Diagnostics only via `createLogger(scope)`; never bare `console.*`. Metrics: `metrics.count(name, labels?, by?)`, `metrics.gauge(name, value)`; finite enum labels only.
- POSIX/macOS behavior unchanged; every existing `it.runIf(process.platform !== 'win32')` test stays green. New win32 tests use `it.runIf(process.platform === 'win32')`.
- `taskkill` always fixed argv `['/PID', String(pid), '/T', '/F']`, `windowsHide: true`, never through a shell.
- Work on a feature branch; per-task commits there; run the `code-review` skill on the full branch diff before anything lands on `main` (repo rule). Commit messages: conventional commits, end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Test helpers reuse `server/process-monitor.test.ts` patterns: `spawnOpts`, `treeSpawnOpts`, `firstStdoutLine`, `expectGone`, `expectRealExitSoon`, `expectSettled`.

## Review Focus

- **PID reuse after CLI exit** → a fallback force-kill must never hit a recycled PID's tree. Pinned in Task 2 (stale-identity refusal test).
- **Broken-binary first spawn** (child dies before assignment) must not disable containment server-wide. Pinned in Task 3 (retryable-vs-sticky failure test).
- **Self-termination misclassification**: our own `TerminateJobObject` leaves `'exit'` with `killed=false, signal=null`; survivors must terminate, not retire. Pinned in Tasks 3–4 (escalation leaves zero descendants).
- **Retired-handle leak**: a retired Job whose survivors exit naturally must be closed by the GC tick. Pinned in Task 4 (reap test).
- **Host exit with live AND retired Jobs** must reap both synchronously. Pinned in Task 4 (exit-sweep test).

## File Structure

- Create `server/win32-job.ts` — Win32 primitives only: koffi bindings, `Win32Job`, process identity, guarded `killTreeWin32`. No session knowledge.
- Create `server/win32-job.test.ts` — win32 real-process pins for the primitives.
- Modify `server/process-monitor.ts` — Entry containment state, spawn/assign/probe, kill paths, exit classification, retired set + `reapRetiredJobs()`.
- Modify `server/process-monitor.test.ts` — win32 integration block.
- Modify `server/session-health.ts` + `server/session-health.test.ts` — terminate/terminated rider.
- Modify `server/session-manager.ts:1093` — GC tick calls `reapRetiredJobs()`.
- Modify `server/providers/native/tools/bash.ts:30-36`, `server/exec.ts:152-156` (+ their tests) — consolidate onto `killTreeWin32`.
- Modify `package.json`, `build.mjs:19,48`, `desktop/build.mjs:21`, `desktop/electron-builder.yml:50`, `.github/workflows/ci.yml:66-72`.
- Task 6: move the spec note to `implemented/`, update the 11-09 note's win32 sentences.

---

### Task 1: terminate/terminated rider bug

**Files:**
- Modify: `server/session-health.ts:32,114,132,145`
- Test: `server/session-health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HealthMonitorDeps.unload(id, opts: { terminated: boolean; reason: string })` — matches `SessionManager.unload`'s `opts.terminated`.

- [ ] **Step 1: Write the failing test**

Add to `server/session-health.test.ts` (fake timers, `unload: vi.fn(async () => {})`); fixture is a minimal running mid-turn session with empty history cast `as unknown as Session`:

```ts
it('escalated force-unload passes terminated (not terminate)', () => {
  vi.useFakeTimers()
  const unload = vi.fn(async () => {})
  const s = { running: true, terminated: false, exiting: false, recovering: false,
    pendingTurns: 1, pending: new Map(), lastActivityAt: 0,
    history: [], subagentHistory: [], handle: {} } as unknown as Session
  const monitor = new SessionHealthMonitor({
    sessions: new Map([['s1', s]]), workingStuckMs: 1000, unload })
  try {
    vi.advanceTimersByTime(60_000)
    expect(unload).toHaveBeenCalledWith('s1', { terminated: true, reason: 'init_stuck' })
  } finally { monitor.stop() }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-health.test.ts`
Expected: FAIL — received `{ terminate: true, reason: 'init_stuck' }`.

- [ ] **Step 3: Fix the field name**

In `server/session-health.ts`: deps type line 32 `terminate` → `terminated`; call sites 114, 132, 145 `{ terminate: true, … }` → `{ terminated: true, … }`. No other changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/session-health.test.ts server/session-manager.test.ts`
Expected: PASS (manager wiring at `session-manager.ts:1091` passes opts through verbatim).

- [ ] **Step 5: Commit**

```bash
git add server/session-health.ts server/session-health.test.ts
git commit -m "fix(session-health): pass terminated to unload so GC force-unload is terminal

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: win32-job primitives + dependency/bundle wiring

**Files:**
- Create: `server/win32-job.ts`, `server/win32-job.test.ts`
- Modify: `package.json` (optionalDependencies), `build.mjs:19,48`, `desktop/build.mjs:21`, `desktop/electron-builder.yml:50`

**Interfaces:**
- Consumes: nothing.
- Produces (exact signatures later tasks import from `./win32-job.js`):

```ts
export class Win32JobError extends Error {
  constructor(message: string, readonly capability: boolean) // capability=true → sticky fallback
}
export interface Win32Job {
  terminate(): void      // TerminateJobObject(job, 1); idempotent; counts containment_job_terminate once per effective call
  activeCount(): number  // class-1 query, u32 @ offset 40
  close(): void          // CloseHandle; idempotent
}
export function createJobForProcess(pid: number): Win32Job // throws Win32JobError
export function processIdentity(pid: number): string | null // decimal 100ns FILETIME ticks, FFI
export function captureBirthTime(pid: number): string | null // processIdentity ?? PowerShell ToFileTime()
export function killTreeWin32(pid: number, birthTime: string | null): boolean // true iff kill issued
```

- [ ] **Step 1: Install koffi and wire the bundles**

`npm install --save-optional koffi@3.1.1`. Add `'koffi'` to both `external` arrays in `build.mjs` and the one in `desktop/build.mjs`. Add `- node_modules/koffi/**` under `asarUnpack` in `desktop/electron-builder.yml`.
Verify: `npm run build` succeeds and `dist/cli.mjs` does NOT contain koffi source (it stays a runtime require).

- [ ] **Step 2: Write the failing tests**

Create `server/win32-job.test.ts`, `describe.runIf(process.platform === 'win32')`. Helper spawns a node child that spawns a sleeping grandchild (`stdio:'ignore'`), prints the grandchild pid, and stays alive (mirror `treeSpawnOpts`); read the pid from stdout. Tests:

```ts
it('createJobForProcess + terminate kills child and grandchild', async () => {
  const { child, grandchildPid } = await spawnTree()
  const job = createJobForProcess(child.pid!)
  expect(job.activeCount()).toBeGreaterThanOrEqual(2)
  job.terminate()
  await expectGone(child.pid!); await expectGone(grandchildPid)
  job.close()
})
it('processIdentity is stable per process and differs across processes', ...)
it('killTreeWin32 with matching birthTime kills the tree', ...) // expect true, both gone
it('killTreeWin32 with stale birthTime refuses and leaves the tree alive', ...) // expect false, both alive; cleanup via taskkill in afterEach
it('killTreeWin32 with null birthTime refuses', ...) // expect false, tree alive
```

`expectGone` = poll `process.kill(pid, 0)` until it throws (copy the helper). Every test cleans up its tree in `afterEach` (unconditional `taskkill /T /F` on the child pid).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server/win32-job.test.ts`
Expected: FAIL — cannot resolve `./win32-job.js`.

- [ ] **Step 4: Implement `server/win32-job.ts`**

Lazy cached bindings via `createRequire(import.meta.url)('koffi')`; `koffi.load('kernel32.dll')`, `kernel32.func('__stdcall', name, result, args)`, `PVOID = koffi.pointer('void')`. Cache the `FILETIME` koffi struct (`{dwLowDateTime:'uint32', dwHighDateTime:'uint32'}`) at module level — koffi's type registry is global per process. Bind: `CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`, `QueryInformationJobObject`, `TerminateJobObject`, `OpenProcess`, `GetProcessTimes`, `CloseHandle`, `GetLastError`.

- `createJobForProcess`: `CreateJobObjectW(null,null)` → `Buffer.alloc(144)`, `writeUInt32LE(0x2000, 16)`, `SetInformationJobObject(job, 9, buf, 144)` (create/set failures → `Win32JobError(msg, true)`, close job); `OpenProcess(0x1 | 0x100, 0, pid)` → `AssignProcessToJobObject(job, handle)` → `CloseHandle(handle)` (open/assign failures → `Win32JobError(msg, false)`, close job).
- `terminate`: `TerminateJobObject(job, 1)` behind a `terminated` boolean guard; on the first effective call `metrics.count('containment_job_terminate')`.
- `activeCount`: `Buffer.alloc(48)`, `QueryInformationJobObject(job, 1, buf, 48, null)`, `readUInt32LE(40)`.
- `processIdentity`: `OpenProcess(0x1000, 0, pid)` + `GetProcessTimes` → ticks = `BigInt(high) << 32n | BigInt(low)` → `String(ticks)`; null on any failure; always close the handle.
- `captureBirthTime`: `processIdentity(pid)` ?? `spawnSync('powershell', ['-NoProfile','-Command',`(Get-Process -Id ${pid}).StartTime.ToFileTime()`], {windowsHide:true})` stdout trimmed (null on non-zero/empty).
- `killTreeWin32`: `birthTime === null` → `log.error` + return false; `current = captureBirthTime(pid)`; null → `log.error` + false; `current !== birthTime` → `log.warn` (PID reused) + false; else `spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio:'ignore', windowsHide:true})` + return true.

The first real spawn attempt is the capability probe (Task 3) — no separate probe function.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/win32-job.test.ts`
Expected: PASS (5 tests). Then `npm run typecheck` — both configs green.

- [ ] **Step 6: Commit**

```bash
git add server/win32-job.ts server/win32-job.test.ts package.json package-lock.json build.mjs desktop/build.mjs desktop/electron-builder.yml
git commit -m "feat(win32-job): Job Object primitives and guarded taskkill tree-kill

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: ProcessMonitor kill paths (spawn/assign/probe, signalTree, escalation)

**Files:**
- Modify: `server/process-monitor.ts` (Entry, constructor opts, `spawnFor`, `signalTree`, `unregister`)
- Test: `server/process-monitor.test.ts`
- Modify: `.github/workflows/ci.yml:66-72`

**Interfaces:**
- Consumes: Task 2's `Win32Job`, `Win32JobError`, `createJobForProcess`, `captureBirthTime`, `killTreeWin32`.
- Produces: `Entry.job: Win32Job | null`, `Entry.birthTime: string | null`, `Entry.selfTerminated: boolean`; constructor `opts.jobFactory?: (pid: number) => Win32Job` (test seam, default `createJobForProcess`); `get containmentMode(): 'job' | 'fallback' | 'posix'` (monitor-level sticky state: `'fallback'` only after a capability failure). Task 4 reads these fields and the mode.

- [ ] **Step 1: Write the failing tests**

Append a win32 block to `server/process-monitor.test.ts` (`it.runIf(process.platform === 'win32')`), reusing `treeSpawnOpts(false)` + `firstStdoutLine` + `expectGone`:

```ts
it('win32: spawn assigns a Job and destroy escalation terminates the whole tree', async () => {
  const mon = new ProcessMonitor(vi.fn(), { safetyMs: 100, escalateMs: 50 })
  const reg = mon.register('s-job'); const proc = mon.spawnFor(reg, treeSpawnOpts(false))
  const grandchildPid = await firstStdoutLine(proc)
  expect(mon.containmentMode).toBe('job')
  mon.unregister(reg)
  await expectRealExitSoon(reg, 5000)
  await expectGone((proc as unknown as ChildProcess).pid!); await expectGone(grandchildPid)
})
it('win32: capability failure sticks to fallback; fallback still tree-kills', async () => {
  const factory = vi.fn(() => { throw new Win32JobError('probe', true) })
  const mon = new ProcessMonitor(vi.fn(), { safetyMs: 100, jobFactory: factory })
  // spawn tree, unregister, expectRealExitSoon, expectGone child + grandchild
  expect(mon.containmentMode).toBe('fallback')
  // second register+spawn: factory NOT called again (sticky)
})
it('win32: dead-child assignment failure is retryable, not sticky', async () => {
  // factory throws Win32JobError('gone', false) on the first call, then delegates to createJobForProcess
  // first spawn: entry.job null, containmentMode still 'job' (not sticky)
  // second register+spawn: factory called again, tree dies via Job on escalation (expectGone both)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/process-monitor.test.ts`
Expected: FAIL — `containmentMode` undefined / trees survive.

- [ ] **Step 3: Implement the kill paths**

- Entry: add `job: null`, `birthTime: null`, `selfTerminated: false` (register initializes).
- Constructor: store `jobFactory` (default `createJobForProcess`); private `jobStickyFailed = false`; `get containmentMode()`: POSIX → `'posix'`; win32 → `jobStickyFailed ? 'fallback' : 'job'`.
- `spawnFor` (win32 only, after `defaultSpawnFn`): `entry.birthTime = captureBirthTime(pid)`; if `!jobStickyFailed` try `entry.job = this.jobFactory(pid)`; catch `Win32JobError`: `capability` → `jobStickyFailed = true` + `log.warn` once; else `log.warn` retryable. Never throw out of `spawnFor` for containment failures.
- `signalTree`: win32 branch before the pgid branch — `entry.job` → `entry.selfTerminated = true; entry.job.terminate()`; else `killTreeWin32(pid, entry.birthTime)`. POSIX path unchanged.
- `unregister` safety-timer escalation: win32 → single `this.signalTree(entry, 'SIGKILL')`, no `escalationTimer` leg; POSIX two-leg ladder unchanged.
- `metrics.count('containment_fallback_treekill')` when `killTreeWin32` returns true. (The Job-terminate counter lives inside `Win32Job.terminate()` — Task 2.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/process-monitor.test.ts`
Expected: PASS — new win32 tests AND all existing POSIX `runIf` tests (they skip on this win32 host; CI ubuntu runs them).

- [ ] **Step 5: Wire CI**

Add `server/process-monitor.test.ts`, `server/win32-job.test.ts`, `server/session-health.test.ts` to the `windows-platform` job's vitest file list (`.github/workflows/ci.yml:66-72`).

- [ ] **Step 6: Commit**

```bash
git add server/process-monitor.ts server/process-monitor.test.ts .github/workflows/ci.yml
git commit -m "feat(process-monitor): win32 Job containment on spawn and teardown kill paths

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: ProcessMonitor exit paths (classification, retired set, GC reap, exit sweep)

**Files:**
- Modify: `server/process-monitor.ts` (`finalizeEntry`, `sweepForProcessExit`, module-level retired set, `reapRetiredJobs`)
- Modify: `server/session-manager.ts:1093` (`onGcTick`)
- Test: `server/process-monitor.test.ts`

**Interfaces:**
- Consumes: Task 3's `Entry.job` / `birthTime` / `selfTerminated`, `containmentMode`.
- Produces: `export function reapRetiredJobs(): void` (closes empty retired Jobs, `metrics.gauge('retired_jobs', size)`); `get retiredCount(): number` on ProcessMonitor (test seam).

- [ ] **Step 1: Write the failing tests**

Win32 block additions. Graceful-survivor helper: child spawns grandchild (`stdio:'ignore'`), prints its pid, then `process.exit(0)`.

```ts
it('win32: graceful intentional exit retires survivors; exit sweep reaps them', async () => {
  const mon = new ProcessMonitor(vi.fn())
  const reg = mon.register('s-retire'); const proc = mon.spawnFor(reg, gracefulSurvivorOpts())
  const grandchildPid = await firstStdoutLine(proc)
  mon.unregister(reg); await expectRealExitSoon(reg)
  expect(mon.retiredCount).toBe(1)
  process.kill(grandchildPid, 0) // survivor alive (no throw)
  mon.sweepForProcessExit()
  await expectGone(grandchildPid) // kill-on-close reaped it
})
it('win32: killed intentional exit terminates survivors instead of retiring', async () => {
  // spawn treeSpawnOpts(false); unregister; (proc as ChildProcess).kill('SIGKILL')
  // await expectRealExitSoon; expectGone grandchild; retiredCount === 0
})
it('win32: crash terminates survivors and surfaces onExit', async () => {
  // child spawns grandchild then process.exit(2); NO unregister
  // await expectExitSoon; expectGone grandchild; onExit called once
})
it('win32: reapRetiredJobs closes a retired Job whose survivors exited', async () => {
  // retire as above; taskkill grandchild; reapRetiredJobs(); retiredCount === 0
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/process-monitor.test.ts`
Expected: FAIL — survivors orphan / `retiredCount` undefined.

- [ ] **Step 3: Implement the exit paths**

- Module-level `const retiredJobs = new Set<Win32Job>()`; `export function reapRetiredJobs()`: for each, `activeCount() === 0` → `close()` + delete; `metrics.gauge('retired_jobs', retiredJobs.size)`.
- `finalizeEntry` win32 branch (after listener detach, before `onExit` surfacing), replacing the pgid-gated sweep on win32:
  - `entry.job`: `count = entry.job.activeCount()`; 0 → `close()`; else classify — terminate when `!reg.intentional || info.killed || info.signal !== null || entry.selfTerminated` (`terminate()` + `close()`); otherwise retire (`retiredJobs.add(entry.job)`, keep open).
  - fallback (no job): terminate via `killTreeWin32(pid, entry.birthTime)` under the same classify predicate; intentional-graceful → skip (POSIX-parity trust).
  - POSIX pgid sweep unchanged.
- `sweepForProcessExit`: win32 live entries → `job.terminate()` or `killTreeWin32` (both synchronous); then `for (const j of retiredJobs) j.close()` + clear (kill-on-close reaps survivors). POSIX unchanged.
- `get retiredCount()` returns `retiredJobs.size`.
- `session-manager.ts:1093`: `onGcTick: () => { void this.recordRetentionMetrics(); reapRetiredJobs() }` (import from `./process-monitor.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/process-monitor.test.ts server/session-manager.test.ts`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/process-monitor.ts server/process-monitor.test.ts server/session-manager.ts
git commit -m "feat(process-monitor): win32 exit classification, retired Jobs, GC reap and exit sweep

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: consolidate native Bash and host exec onto killTreeWin32

**Files:**
- Modify: `server/providers/native/tools/bash.ts:30-36`, `server/exec.ts:152-156`
- Test: `server/providers/native/tools/bash.test.ts`, `server/exec.test.ts`
- Modify: `.github/workflows/ci.yml` (windows-platform file list)

**Interfaces:**
- Consumes: Task 2's `killTreeWin32(pid, birthTime)`, `captureBirthTime(pid)`.
- Produces: nothing new (single-writer consolidation).

- [ ] **Step 1: Write the failing tests**

In each existing test file add a win32 pin (`it.runIf(process.platform === 'win32')`): spawn a real command whose shell launches a sleeping descendant (e.g. bash `-c 'node -e "setInterval(()=>{},1000)" & wait'` via the tool/exec path), abort it, then poll the descendant pid gone. Capture the descendant pid from the command's stdout before aborting.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/tools/bash.test.ts server/exec.test.ts`
Expected: FAIL on win32 — descendant survives the direct-child kill (exec.ts path; bash.ts already tree-kills but unguarded).

- [ ] **Step 3: Consolidate**

- `bash.ts`: capture `birthTime = captureBirthTime(child.pid)` right after spawn (win32); replace `killTree`'s win32 branch with `killTreeWin32(child.pid, birthTime)`; POSIX `child.kill('SIGKILL')` unchanged. Delete the now-unused local `execFile` taskkill code.
- `exec.ts` `onAbort`: win32 → `killTreeWin32(child.pid, birthTime)` (capture at spawn); POSIX unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/tools/bash.test.ts server/exec.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire CI**

Add `server/providers/native/tools/bash.test.ts` and `server/exec.test.ts` to the `windows-platform` job's vitest file list (their new win32 pins must run in CI). Confirm both files' full suites pass on this win32 host first.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/tools/bash.ts server/providers/native/tools/bash.test.ts server/exec.ts server/exec.test.ts .github/workflows/ci.yml
git commit -m "refactor(exec): route win32 tree-kill through the guarded killTreeWin32 helper

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: full verification, manual acceptance, note lifecycle

**Files:**
- Move: `.agents/notes/proposed/architecture/2026-11-17-win32-job-containment.md` → `implemented/`
- Modify: `.agents/notes/implemented/architecture/2026-11-09-subprocess-tree-containment.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: shipped reality documented.

- [ ] **Step 1: Full verify**

Run: `npm run verify` then `npm run build:desktop`
Expected: typechecks (all four), lint, `verify:agent-notes`, full vitest suite, build, desktop server bundle — all green (koffi stays external everywhere).

- [ ] **Step 2: Manual hard-kill acceptance (win32)**

Start `npm run dev:once`, create a session, run a long Bash tool command (e.g. `node -e "setInterval(()=>{},1000)"`), note the CLI + descendant pids. In another shell: `taskkill /PID <serverPid> /F`. Poll: every CLI descendant pid gone within ~2 s (kernel kill-on-close). Record the result (pids, timings) in the note's Testing section.

- [ ] **Step 3: Manual graceful-survivor acceptance**

Same setup; background a long task, delete the session → survivor still running; stop the server gracefully (Ctrl+C) → survivor gone. Record.

- [ ] **Step 4: Move the note to implemented**

Rewrite `## Proposal` → present-tense `## Decision`; fold `## Acceptance criteria` + `## Risks` into `## Consequences` (keep the manual-acceptance record as `## Testing`); `Status: implemented`. Update the 11-09 note: its win32-degradation sentence and hard-kill-boundary sentence now cross-link this note as partially superseded on Windows (POSIX decision stands). Run `npm run verify:agent-notes`.

- [ ] **Step 5: Whole-branch review, then commit**

Run the `code-review` skill on the full branch diff; fix confirmed findings; re-review non-trivial fixes. Then:

```bash
git add .agents/notes
git commit -m "docs(notes): win32 Job containment shipped; supersede 11-09 win32 gap

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

Merge to main only after the review is clean (repo rule).
