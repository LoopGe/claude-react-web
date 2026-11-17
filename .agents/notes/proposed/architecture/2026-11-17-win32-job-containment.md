# Agent Note: Windows Job Object containment for CLI subprocess trees

Status: proposed

## Problem

[Subprocess tree containment](../../implemented/architecture/2026-11-09-subprocess-tree-containment.md)
closed the POSIX orphan class (the 3080 incident) but deliberately left Windows
degraded: "On Windows, tree termination degrades to direct-child kills (no POSIX
groups)." That gap accumulated into a real incident on 2026-11-17: a
`powershell.exe` aborted with MSVC runtime error **R6016 — not enough space for
thread data** under memory pressure (16 GB machine, ~1 GB available). A process
audit found five orphaned tool trees (~30 processes, ~2.6 GB working set), none
owned by any live session, every root `bash.exe` parent dead:

- a single-file `vitest run` hung for 23 h with one tinypool worker at **2068 MB**;
- a 23 h test-fixture server on port 45678 (`crw-icon-test-state-45678`);
- a 3.9-day-old `server/cli.ts` on port 3457 plus its app-plugin subprocess;
- a 4-day-old vite dev server on port 5175;
- a 5.7-day-old `tsx -` stdin process with no port and no owner.

The mechanism, proven against `@anthropic-ai/claude-agent-sdk` 0.3.311
(`sdk.mjs`) and `server/process-monitor.ts`:

- `interrupt` is a stdin control frame — no OS kill anywhere; tool-tree cleanup
  is entirely the CLI's internal responsibility.
- The destroy ladder is stdin EOF → 2 s → **win32 skips the SIGTERM leg** → +5 s
  `SIGKILL`, which on Windows is `TerminateProcess` on the **direct child only**.
  The CLI never runs its own cleanup, so its `bash.exe → npx → node` descendants
  orphan at that instant.
- `Entry.pgid` is undefined on win32 (`detached: !IS_WIN32`), so `signalTree`,
  the crash-path leftover sweep, and the host-exit sweep all degrade to
  direct-PID operations. Nothing enumerates descendants: no `taskkill /T`, no
  Job Object, no PPID walk anywhere in the claude path.
- The SDK's own host-exit `killAll` only closes stdin on win32.

Windows has no process groups, but it has a stronger kernel primitive than POSIX
groups: **Job Objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**. Descendants
cannot escape a Job (no breakaway flag set), and the kernel closes the handle —
killing every member — even when the owning process is hard-killed. That closes
the boundary the 11-09 note declared open on POSIX ("SIGKILL of the server
itself, fatal crashes, and power loss still orphan everything").

A rider defect surfaced in the same audit: `server/session-health.ts` passes
`{ terminate: true }` to its `unload` dep, but `SessionManager.unload` reads
`opts.terminated` (`session-manager.ts:8651`). TypeScript's structural typing
accepts the mismatch silently (the shared `reason` field defeats weak-type
detection), so GC-escalated force-unloads execute as dormant unloads and the
session remains resumable — defeating the terminate intent.

## Proposal

Extend the existing spawn seam (`ProcessMonitor`, via the SDK's
`Options.spawnClaudeCodeProcess`) with **in-process Win32 Job Object containment**:
the harness itself creates and owns one kill-on-close Job per CLI subprocess and
assigns the child immediately after spawn. No runner process. koffi FFI for the
Win32 APIs Node lacks. A guarded `taskkill /PID /T /F` fallback when Job
containment is unavailable. POSIX and macOS are unchanged.

The design ports DSH's kernel plumbing (`deepseek-harness`
`packages/subprocess/win32-process` struct layouts and API signatures, the
no-breakaway choice, Job-accounting emptiness checks, the taskkill fallback
shape, the synchronous host-exit finalizer, pid+start-time identity guards) but
**not** its private-runner substrate — see Alternatives.

### Semantics

One Job per CLI subprocess, owned by the harness. The scenario table is the
contract; every row preserves or strengthens the 11-09 decision:

| Scenario | Windows behavior | Relation to POSIX |
| --- | --- | --- |
| Session destroy, CLI exits gracefully, Job empty | `CloseHandle` | same |
| Session destroy, CLI exits gracefully, Job has survivors (background tasks the CLI chose to leave) | **Retire** the handle to a module-level set, keep it open; survivors keep running | preserves the 11-09 `nohup server &` contract |
| Session destroy, CLI killed by the SDK's SIGKILL leg (`killed`/signal set) | `TerminateJobObject` + close — a hard-killed CLI never ran cleanup, so nothing it leaves is trustworthy | stronger; closes the 11-09 "intentional-destroy orphans a foreground child" residual on Windows |
| Destroy escalation (CLI wedged past `safetyMs`) | `TerminateJobObject` immediately — Windows owners terminate without a TERM stage (DSH `spawn.ts` doctrine) | stronger: POSIX group signals cannot reach the CLI's `setsid`-ed background tasks; a stuck session's whole forest dies, matching force-unload intent |
| CLI crash (non-intentional exit), Job has members | `TerminateJobObject` + close | stronger, same direction as the POSIX crash sweep |
| Host graceful exit | exit hook synchronously terminates live Jobs and closes retired handles (kill-on-close reaps survivors) | closes the 3080 class fully on Windows |
| Host hard-kill / fatal crash | kernel closes every Job handle → whole forest dies | **closes the 11-09 declared boundary on Windows** |

Retired Jobs are reaped by the existing 60 s GC tick (`session-health`
`onGcTick`): query each retired Job's active-process count and close the empty
ones, so a retired handle whose survivors exit naturally does not leak until
host exit.

### Architecture

- **New module `server/win32-job.ts`** — synchronous, platform-guarded
  `createRequire('koffi')` load at the first win32 spawn. The SDK seam forces
  `spawnFor` to be synchronous, so an async preload racing the first spawn is
  not an option: with the sticky-fallback rule below it would permanently
  degrade most server runs. koffi is CJS and the bundle already injects
  `createRequire`. FFI signatures and `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`
  layout ported from DSH `win32-process/src/abi.ts` + `process.ts`:
  `CreateJobObjectW`, `SetInformationJobObject`
  (`JobObjectExtendedLimitInformation`,
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000`, **no breakaway flags**),
  `AssignProcessToJobObject`, `QueryInformationJobObject`
  (`JobObjectBasicAccountingInformation` → active-process count),
  `TerminateJobObject`, `OpenProcess` + `GetProcessTimes` (creation-time
  identity for the fallback guard), `CloseHandle`. Exposes a small `Win32Job`
  handle type (`terminate()`, `activeCount()`, `close()`) plus the shared
  fallback helper below. All calls synchronous where the exit hook needs them.
- **Capability probe** — the first real spawn attempt is the probe: create Job,
  assign, and on a *capability* failure (create / set-info / nested-Job / token)
  mark the monitor `fallback` for its lifetime and `log.warn` once. An
  assignment failure because the child already died is **retryable**, not
  sticky — one broken-binary first spawn must not disable containment
  server-wide. Assignment failure never fails the spawn; the session runs with
  degraded containment, loudly logged.
- **`ProcessMonitor` integration** (`server/process-monitor.ts`):
  - `Entry` gains `job: Win32Job | null`, `birthTime` (process creation time
    captured at spawn: `GetProcessTimes` when koffi is loaded, else one
    PowerShell `(Get-Process -Id <pid>).StartTime` query — spawn is a
    low-frequency operation, so the ~200 ms cost is acceptable), and a
    `selfTerminated` marker; the monitor carries a containment mode
    (`job` / `fallback`; POSIX keeps `pgid` and is untouched).
  - `spawnFor`: after `defaultSpawnFn` returns, synchronously create + assign
    the Job (win32 only). The assignment race window is milliseconds of CLI
    runtime init; the first tool subprocess spawns seconds later. A child that
    beat assignment lands outside the Job exactly as today — never worse.
  - `signalTree` win32 branch: Job → `terminate()`; fallback → shared
    `killTreeWin32(pid, birthTime)`.
  - `finalizeEntry` win32 branch (replaces the pgid-gated sweep): query active
    count; 0 → close; >0 and intentional **graceful** exit → retire; >0 and
    (crash, intentional-but-killed, or `selfTerminated`) → terminate + close.
    The marker is required because our own `TerminateJobObject` leaves the
    ChildProcess `'exit'` with `killed=false, signal=null` — without it the
    entry would misclassify as graceful and retire the survivors.
  - `unregister` escalation win32: single immediate `terminate()` (no two-leg
    ladder — Windows has no trappable TERM); fallback: single
    `taskkill /T /F`. The POSIX two-leg ladder is unchanged.
  - `sweepForProcessExit` win32: synchronous `terminate()` on live entries +
    `close()` on the retired set (koffi sync calls are legal in an exit hook);
    fallback entries: `spawnSync('taskkill', ['/PID', pid, '/T', '/F'])` (DSH
    precedent for sync tree-kill at host exit).
  - `realExited` contract unchanged: it still settles on the direct CLI's
    `'exit'`. Job accounting decides retire-vs-terminate only; there is **no
    quiescence await** on intentional exit, because survivors are meant to live.
- **Shared fallback helper `killTreeWin32(pid, birthTime?)`** in
  `server/win32-job.ts` — uniform guard contract: the creation-time comparison
  runs in **every** fallback mode against the spawn-captured `birthTime`; when
  identity is unavailable the helper **refuses the kill and `log.error`s
  loudly** rather than force-killing an unverified PID. With identity verified,
  `taskkill /PID <pid> /T /F` with `windowsHide`. Single writer: consolidate
  `server/providers/native/tools/bash.ts` `killTree` and `server/exec.ts`
  `onAbort` onto it.
- **Dependency & bundle** — `koffi` in `optionalDependencies` (prebuilt binaries,
  no postinstall); `external: [..., 'koffi']` in `build.mjs` (both entries) and
  `desktop/build.mjs`; loaded only on win32, so POSIX never touches it. koffi is
  Node-API based, so it loads under Electron without an ABI rebuild;
  electron-builder inclusion / `asarUnpack` is verified at implementation time.
  Absence degrades to fallback, never breaks a session.
- **Logging & metrics** — `createLogger('win32-job')`; per-spawn containment
  mode log; counters `containment_job_terminate` / `containment_fallback_treekill`;
  gauge `retired_jobs`. Finite enum labels only.
- **CI** — the new win32 real-process tests join the existing `windows-platform`
  job's file list in `.github/workflows/ci.yml`; POSIX suites stay untouched.
- **Doc lifecycle** — on implementation, move this note to `implemented/` and
  update the 11-09 note's win32-degradation and hard-kill-boundary sentences to
  cross-link here (partial supersession; its POSIX decision stands).

### Riders

- **terminate/terminated field bug**: change `SessionHealthMonitor`'s deps type
  and its three call sites (`session-health.ts:32,114,132,145`) from `terminate`
  to `terminated`; update `server/session-health.test.ts` deps; add a regression
  test pinning that a health-escalated unload marks the session terminated
  (`'stuck'` / `'init_stuck'` are hard-terminal reasons, so the fix delivers
  "no later resume").
- **Same-class win32 leaks**: `server/exec.ts` `onAbort` (direct `SIGKILL` only)
  and the native provider's Bash tool consolidate onto `killTreeWin32`. Their
  host-hard-kill residual stays open — Jobs cover the claude provider's CLI
  subprocess only, which is this proposal's stated scope.

## Alternatives considered

- **Port DSH's private-runner architecture (full parity).** Rejected with
  explicit user sign-off after a side-by-side review. DSH's runner exists for
  its generic seam (arbitrary commands/stdio specs, dual-purpose Linux execve
  bootstrap), for `waitForExit` quiescence *proof* via 10 ms Job-accounting
  polling, and to decouple handle lifetime from its cordis fibers. None of
  those apply here: our seam is one specialized child the SDK demands as a real
  `ChildProcess`, our teardown is a single funnel (`unregister`), and our
  contract intentionally keeps survivors. The runner would cost one extra Node
  process per session (~30–50 MB — directionally wrong for an incident caused
  by process accumulation), an IPC protocol plus a `SUBPROCESS_RUNNER_*`
  failure taxonomy, a reimplementation of Windows executable resolution for
  `CreateProcessW`, and a stdio/exit-code facade mapping target-exit onto
  runner-exit. The only guarantee-level difference is suspended-create race
  closure; the in-process millisecond window cannot make things worse than the
  status quo, and the kernel containment guarantee is identical.
- **`taskkill /T` only, no Job Object.** Rejected as the ceiling: a PPID-walk
  tree kill cannot cover host hard-kill or fatal crash (the headline boundary
  this proposal closes) and is race-prone. Retained as the degraded fallback.
- **Unguarded or two-tier fallback guard.** Rejected by user decision. The
  creation-time guard itself needs `OpenProcess`/`GetProcessTimes` (koffi), so
  "koffi absent" would silently drop a guarantee this design calls mandatory,
  and a two-tier contract would describe two different safety postures. Uniform
  coverage instead: birth time captured at spawn via FFI or one PowerShell
  query; identity unavailable → refuse the kill + loud error. The PowerShell
  skepticism below concerns PowerShell as the *containment mechanism*
  (suspended create + stdio plumbing); a one-shot timestamp query at spawn is a
  different, trivial use.
- **PowerShell `Add-Type` runner (no npm dependency).** Rejected: suspended
  creation plus inheritable-stdio plumbing in Windows PowerShell is fragile,
  per-spawn PowerShell startup is slow, and it assumes inline C# compilation
  availability. koffi ships prebuilt with zero postinstall and is DSH-proven.
- **Fix it in the SDK.** Rejected, inherited from the 11-09 note: external
  pinned dependency, and `spawnClaudeCodeProcess` is the seam designed for
  host-side ownership.
- **Linux cgroup-scope parity (DSH's `systemd-run --user --scope`).** Rejected
  as a non-goal: POSIX pgid already covers the foreground tree, and the `setsid`
  escape it cannot reach is precisely the intentional-survivor semantic this
  design preserves.
- **Status quo.** Rejected: the 2026-11-17 incident proved accumulation is
  unbounded and eventually takes the machine down with it.

## Acceptance criteria

1. win32 real-process test: destroying a session whose CLI spawned a
   child+grandchild tool tree leaves **zero** descendants (poll PID absence).
2. Manual acceptance, recorded in the note at implementation: `taskkill /F` the
   server → every CLI descendant dies via kernel kill-on-close.
3. An intentional background survivor (graceful CLI exit leftover) persists
   across session unload and dies at host exit; a retired Job whose survivors
   exit naturally is closed by the GC tick.
4. Fallback mode (koffi load or Job assignment failure injected) still
   tree-kills on destroy and on escalation, with the creation-time guard
   verified; an identity-unavailable kill is refused and logged, never
   executed unguarded.
5. Stuck-CLI escalation terminates the whole Job; `realExited` settles with the
   real exit info; an intentional-but-killed or self-terminated CLI exit
   terminates survivors rather than retiring them.
6. Health-escalated unload marks the session terminated (no later resume);
   regression test green.
7. The POSIX suite (`process-monitor.test.ts`, `session-manager.test.ts`
   shutdown gate) is unchanged and green.
8. `npm run verify` green (typechecks, lint, `verify:agent-notes`, tests, build).

## Risks

- **Assignment race (ms).** A descendant spawned before assignment escapes the
  Job. Bounded by CLI runtime-init duration; outcome equals the status quo,
  never worse. Recorded as a known limitation, as DSH records its own.
- **koffi in the npx footprint.** Prebuilt availability (win32 x64/arm64) is
  assumed, not guaranteed; `optionalDependencies` + probe + fallback means
  absence degrades loudly instead of breaking. Three bundle configs must mark
  it external; desktop packaging must ship it — verified at implementation.
- **Nested-Job / token restrictions.** A server already inside a Job without
  nested support, or a restricted token, fails assignment → fallback mode.
- **Deliberate POSIX divergences.** On Windows, crash / escalation / host-exit
  kill background tasks that POSIX cannot reach; a `nohup`-ed service survives
  session unload but not app exit (POSIX: survives both). This is the 3080
  goal's direction, adopted knowingly — the 11-09 "user wants to keep" contract
  is preserved for session unload, which is the case it was written for.
- **Fallback PID reuse.** Guarded uniformly by spawn-captured creation time
  (FFI or one PowerShell query). If identity is unavailable the helper refuses
  the kill and logs loudly, accepting a residual orphan in that rare
  double-failure rather than a wrong-tree force-kill. The check-then-kill
  window after a successful guard is accepted in the same class as the 11-09
  pgid-reuse acceptance.
- **Retired-handle accumulation.** Bounded by sessions that left survivors;
  kernel Job objects are cheap, the GC tick closes empty ones, and host exit
  closes the rest.
- **SDK ladder unchanged.** The SDK still kills the direct child first; the Job
  is the backstop, not a replacement. A graceful CLI exit that leaves foreground
  children is retired (trusted), matching the POSIX residual; only killed or
  crashed exits terminate survivors.
