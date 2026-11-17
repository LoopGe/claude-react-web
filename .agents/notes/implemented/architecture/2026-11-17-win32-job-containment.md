# Agent Note: Windows Job Object containment for CLI subprocess trees

Status: implemented

## Problem

[Subprocess tree containment](2026-11-09-subprocess-tree-containment.md)
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

A rider defect surfaced in the same audit: `server/session-health.ts` passed
`{ terminate: true }` to its `unload` dep, but `SessionManager.unload` reads
`opts.terminated`. TypeScript's structural typing accepted the mismatch
silently (the shared `reason` field defeats weak-type detection), so
GC-escalated force-unloads executed as dormant unloads and the session remained
resumable — defeating the terminate intent.

## Decision

The existing spawn seam (`ProcessMonitor`, via the SDK's
`Options.spawnClaudeCodeProcess`) carries **in-process Win32 Job Object
containment**: the harness itself creates and owns one kill-on-close Job per
CLI subprocess and assigns the child synchronously immediately after spawn. No
runner process. koffi FFI for the Win32 APIs Node lacks. A guarded
`taskkill /PID /T /F` fallback when Job containment is unavailable. POSIX and
macOS are unchanged.

The design ports DSH's kernel plumbing (`deepseek-harness`
`packages/subprocess/win32-process` struct layouts and API signatures, the
no-breakaway choice, Job-accounting emptiness checks, the taskkill fallback
shape, the synchronous host-exit finalizer, pid+start-time identity guards) but
**not** its private-runner substrate — see Alternatives.

Two riders ship with it:

- **terminate/terminated field fix**: `SessionHealthMonitor`'s deps type and its
  three call sites pass `terminated` (not `terminate`), so a health-escalated
  force-unload marks the session terminated (`'stuck'` / `'init_stuck'` are
  hard-terminal reasons — no later resume). A regression test in
  `server/session-health.test.ts` pins the field name.
- **Same-class win32 leaks consolidated**: `server/exec.ts` `onAbort` and the
  native provider's Bash tool `killTree` both kill through the shared
  `killTreeWin32` helper with a spawn-captured birth time. Their host-hard-kill
  residual stays open — Jobs cover the claude provider's CLI subprocess only,
  which is this decision's stated scope.

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

Retired Jobs are reaped by the existing 60 s GC tick: `SessionManager`'s
`onGcTick` calls `reapRetiredJobs()` (exported from `process-monitor.ts`), which
queries each retired Job's active-process count and closes the empty ones, so a
retired handle whose survivors exit naturally does not leak until host exit.

### Architecture

- **`server/win32-job.ts`** — synchronous, platform-guarded
  `createRequire('koffi')` load at first use. The SDK seam forces `spawnFor` to
  be synchronous, so an async preload racing the first spawn is not an option:
  with the sticky-fallback rule below it would permanently degrade most server
  runs. koffi is CJS and the bundle already injects `createRequire`. FFI
  signatures and `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` layout ported from DSH
  `win32-process/src/abi.ts` + `process.ts` (x64-verified): `CreateJobObjectW`,
  `SetInformationJobObject` (`JobObjectExtendedLimitInformation`,
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000`, **no breakaway flags**),
  `AssignProcessToJobObject`, `QueryInformationJobObject`
  (`JobObjectBasicAccountingInformation` → active-process count),
  `TerminateJobObject`, `OpenProcess` + `GetProcessTimes` (creation-time
  identity for the fallback guard), `CloseHandle`. Exports
  `createJobForProcess(pid)` returning a small `Win32Job` handle
  (`terminate()`, `activeCount()`, `close()` — all idempotent, all synchronous
  where the exit hook needs them), `processIdentity` / `captureBirthTime`, the
  shared `killTreeWin32` fallback helper, and `Win32JobError` with a
  `capability` flag. No session or monitor knowledge lives in the module.
- **Capability probe** — the first real spawn attempt is the probe: create Job,
  assign. A *capability* failure (`Win32JobError.capability === true`: koffi
  absent or broken native load, create / set-info failure) marks the monitor
  `fallback` for its lifetime and `log.warn`s once. An open/assign failure
  (`capability === false` — e.g. the child already died, or a nested-Job /
  token restriction refuses assignment) is **retryable**, not sticky — one
  broken-binary first spawn must not disable containment server-wide.
  Assignment failure never fails the spawn; the session runs with degraded
  containment, loudly logged.
- **`ProcessMonitor` integration** (`server/process-monitor.ts`):
  - `Entry` carries `job: Win32Job | null`, `birthTime` (process creation time
    captured at spawn: `GetProcessTimes` when koffi is loaded, else one
    PowerShell `(Get-Process -Id <pid>).StartTime.ToFileTime()` query — spawn is
    a low-frequency operation, so the ~200 ms cost is acceptable; both sources
    yield the same UTC 100 ns FILETIME ticks), and a `selfTerminated` marker.
    The `containmentMode` getter reports `job` / `fallback` / `posix`; POSIX
    keeps `pgid` and is untouched.
  - `spawnFor`: after `defaultSpawnFn` returns, synchronously captures the birth
    time and creates + assigns the Job (win32 only). The assignment race window
    is milliseconds of CLI runtime init; the first tool subprocess spawns
    seconds later. A child that beat assignment lands outside the Job exactly
    as before containment — never worse.
  - `signalTree` win32 branch: Job → `terminate()` (setting `selfTerminated`
    first); fallback → shared `killTreeWin32(pid, birthTime)`.
  - `finalizeWin32Job` (the win32 counterpart of the POSIX pgid sweep): query
    active count; 0 → close; >0 and intentional **graceful** exit → retire; >0
    and (crash, intentional-but-killed, or `selfTerminated`) → terminate +
    close. The predicate is
    `!intentional || killed || signal !== null || selfTerminated`. The marker is
    required because our own `TerminateJobObject` leaves the ChildProcess
    `'exit'` with `killed=false, signal=null` — without it the entry would
    misclassify as graceful and retire the survivors. With no Job, the same
    predicate gates the guarded taskkill; a trusted graceful exit skips it.
    Every path closes or retires the handle — none drops it on the floor.
  - `unregister` escalation win32: single immediate forceful leg (Job terminate
    or guarded taskkill) — no two-leg ladder, Windows has no trappable TERM.
    The POSIX two-leg ladder is unchanged.
  - `sweepForProcessExit` win32: synchronous `signalTree` on every live entry
    (Job terminate, or `killTreeWin32`'s `spawnSync` taskkill in fallback) plus
    `close()` on the whole module-level retired set (koffi sync calls are legal
    in an exit hook). A monitor whose last entry retired a Job releases its
    sweep registration; that leaks nothing, because when the host process dies
    the kernel closes its handle table and kill-on-close reaps the survivors.
  - `realExited` contract unchanged: it still settles on the direct CLI's
    `'exit'`. Job accounting decides retire-vs-terminate only; there is **no
    quiescence await** on intentional exit, because survivors are meant to live.
- **Shared fallback helper `killTreeWin32(pid, birthTime)`** in
  `server/win32-job.ts` — uniform guard contract: the creation-time comparison
  runs in **every** fallback mode against the spawn-captured `birthTime`; when
  identity is unavailable (no captured birth time, or unreadable live identity)
  the helper **refuses the kill and `log.error`s loudly** rather than
  force-killing an unverified PID; a mismatch (recycled PID) refuses with a
  `log.warn`. With identity verified, `taskkill /PID <pid> /T /F` with
  `windowsHide`, fixed argv, never through a shell. Single writer: the native
  Bash tool and `server/exec.ts` `onAbort` both kill through it.
- **Dependency & bundle** — `koffi` 3.1.1 in `optionalDependencies`. koffi 3.1.1
  distributes its prebuilt binaries via platform-specific optional packages
  (`@koromix/koffi-<platform>`, e.g. `@koromix/koffi-win32-x64`); the actual
  `.node` lives at `node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`,
  and koffi's loader tries that package before any `koffi/build` path. It **has
  an install script** (`cnoke --prebuild`) that validates/selects those prebuilt
  packages and needs `APPDATA` / `LOCALAPPDATA` on win32; where those vars are
  absent the optional dep is skipped and containment degrades loudly to the
  guarded taskkill fallback. CI (plain `npm ci`; the windows runner has the
  vars) installs it. `external: [..., 'koffi']` in `build.mjs` (both entries)
  and `desktop/build.mjs`; loaded only on win32, so POSIX never touches it.
  koffi is Node-API based, so it loads under Electron without an ABI rebuild;
  desktop packaging must `asarUnpack` `node_modules/@koromix/**` (the real
  `.node` location) in addition to `node_modules/koffi/**` — LoadLibrary cannot
  read the native addon out of asar, and unpacking only the koffi tree would
  leave the `.node` packed and silently degrade the packaged win32 host to the
  fallback. Absence degrades to fallback, never breaks a session.
- **Logging & metrics** — `createLogger('win32-job')`; loud warns on sticky /
  retryable containment failure, a warn per survivor-terminating exit and an
  info per retire; counters `containment_job_terminate` /
  `containment_fallback_treekill`; gauge `retired_jobs` (updated by the GC
  reap). Finite enum labels only.
- **CI** — the win32 real-process tests (`server/win32-job.test.ts`,
  `server/process-monitor.test.ts`, plus the `session-health`, native `bash` and
  `exec` suites) ride the existing `windows-platform` job's file list in
  `.github/workflows/ci.yml`; POSIX suites stay untouched.

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
  this decision closes) and is race-prone. Retained as the degraded fallback.
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
  availability. koffi's install script selects a prebuilt binary (no compile
  on the common path) and is DSH-proven.
- **Fix it in the SDK.** Rejected, inherited from the 11-09 note: external
  pinned dependency, and `spawnClaudeCodeProcess` is the seam designed for
  host-side ownership.
- **Linux cgroup-scope parity (DSH's `systemd-run --user --scope`).** Rejected
  as a non-goal: POSIX pgid already covers the foreground tree, and the `setsid`
  escape it cannot reach is precisely the intentional-survivor semantic this
  design preserves.
- **Status quo.** Rejected: the 2026-11-17 incident proved accumulation is
  unbounded and eventually takes the machine down with it.

## Consequences

Bought: the 2026-11-17 orphan-accumulation class is closed on Windows for the
claude provider's CLI trees. Destroy escalation and crashes terminate the whole
forest; an intentional-but-killed or self-terminated CLI exit terminates
survivors rather than retiring them; host graceful exit terminates live Jobs
and closes retired handles; and host hard-kill / fatal crash is reaped by the
kernel's kill-on-close — the boundary the 11-09 note declared open is closed on
Windows (POSIX still declares it). The 11-09 intentional-survivor contract is
preserved for session unload: a graceful CLI exit with survivors retires the
Job and the survivors keep running. Health-escalated force-unloads are truly
terminal (the rider fix), and native Bash + host exec share one guarded
tree-kill writer.

Costs and remaining boundaries, adopted knowingly:

- **Assignment race (ms).** A descendant spawned before assignment escapes the
  Job. Bounded by CLI runtime-init duration; outcome equals the pre-containment
  status quo, never worse. A known limitation, as DSH records its own.
- **koffi in the npx footprint.** An optional dependency whose install script
  selects a prebuilt binary (win32 x64/arm64) and needs `APPDATA` /
  `LOCALAPPDATA`; where those are absent the dep is skipped and the probe +
  fallback degrade loudly instead of breaking. Three bundle configs mark it
  external; desktop packaging ships it via `asarUnpack`.
- **Nested-Job / token restrictions.** A server already inside a Job without
  nested support, or a restricted token, fails assignment → that spawn runs in
  fallback mode. The failure is retryable, so each spawn retries (and logs)
  rather than sticking the whole monitor.
- **Deliberate POSIX divergences.** On Windows, crash / escalation / host-exit
  kill background tasks that POSIX cannot reach; a `nohup`-ed service survives
  session unload but not app exit (POSIX: survives both). This is the 3080
  goal's direction, adopted knowingly — the 11-09 "user wants to keep" contract
  is preserved for session unload, which is the case it was written for.
- **Fallback PID reuse.** Guarded uniformly by spawn-captured creation time
  (FFI or one PowerShell query). If identity is unavailable the helper refuses
  the kill and logs loudly, accepting a residual orphan rather than a
  wrong-tree force-kill. In fallback mode a dead root can never be
  identity-verified (`captureBirthTime` of a dead PID is always null), so
  survivor reaping on crash/killed exits is refused by design (loud
  `log.error`) — inherent to any dead-root exit without a Job, not a rare
  double-failure. The Job path does not have this limitation: handle identity
  is kernel-guaranteed. The check-then-kill window after a successful guard is
  accepted in the same class as the 11-09 pgid-reuse acceptance.
- **Retired-handle accumulation.** Bounded by sessions that left survivors;
  kernel Job objects are cheap, the GC tick closes empty ones, host exit closes
  the rest, and the kernel's handle-table close is the final backstop.
- **SDK ladder unchanged.** The SDK still kills the direct child first; the Job
  is the backstop, not a replacement. A graceful CLI exit that leaves foreground
  children is retired (trusted), matching the POSIX residual; only killed or
  crashed exits terminate survivors.
- **Scope residual.** `server/exec.ts` and the native Bash tool tree-kill on
  abort, but their host-hard-kill residual stays open — Jobs cover the claude
  provider's CLI subprocess only.

## Testing

`server/win32-job.test.ts` pins the primitives with five win32 real-process
tests: Job create/assign/terminate kills child+grandchild, `activeCount`
membership, identity stability, and guarded `killTreeWin32` match/stale/null
refusal. The `server/process-monitor.test.ts` win32 block pins the integration:
spawn assigns a Job and escalation terminates the whole tree; a capability
failure sticks to fallback and still tree-kills; a dead-child assignment failure
is retryable; a graceful intentional exit retires a detached survivor which
stays alive, then the exit-sweep close reaps it; a killed intentional exit
terminates survivors; a crash terminates survivors and surfaces `onExit`;
`reapRetiredJobs` closes an empty retired Job. The POSIX suites are unchanged
and green. Full `npm run verify` (typechecks ×4, lint, `verify:agent-notes`,
full vitest suite, build) and `npm run build:desktop` exit 0.

Manual hard-kill acceptance (2026-11-17, PASS): an isolated worktree server
(pid 29632, port 3460, temp state-dir) hard-killed via `Stop-Process -Force`
(`TerminateProcess`, no `/T`, no graceful handlers) loses every descendant
within 126 ms — CLI 39772, bash 748/17056/41760, node sleeper 14272 (a 4-level
tree). The live production server and the controller's own session are
confirmed untouched. This closes the 11-09 host-hard-kill boundary end-to-end
via kernel `KILL_ON_JOB_CLOSE`.

Manual intentional-but-killed acceptance (PASS, end-to-end): deleting a session
whose CLI had a backgrounded Bash tool tree produces
`CLI process exited … code=null, signal=SIGKILL, killed=true` then
`CLI exited with 5 Job survivor(s) — terminating the tree` — the SDK's win32
close ladder SIGKILLs the CLI (it does not honor stdin EOF within the grace
window on this setup), and the classify predicate correctly terminates the
survivors rather than retiring them.

The graceful-retire row is pinned by the real-process unit test above (graceful
code-0 exit + detached survivor retired and alive, then sweep-reaped).
End-to-end graceful-retire is NOT driven: the CLI takes the SIGKILL leg on
delete in this environment rather than exiting gracefully — recorded as
unit-proven, not end-to-end. Host graceful-exit reap is unit-pinned by the
exit-sweep test; Windows lacks a cross-process SIGINT to drive graceful host
shutdown end-to-end, and the hard-kill acceptance corroborates the same
kill-on-close mechanism.
