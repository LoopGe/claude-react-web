# Agent Note: Subprocess tree containment and shutdown quiescence

Status: implemented

## Problem

A real orphan was observed on this machine: a `pnpm dsh web` server started by a
session's Bash tool kept listening on port 3080 for two days after the server
that hosted the session was gone. Post-mortem (2026-11-08/09 conversation) pinned
the mechanism: the CLI subprocess tree was torn down with **single-PID kills**
(the tracked wrapper died, the `pnpm → sh → node` tree was left in its own
process group and reparented to launchd), and nothing on the host-exit path
**waited for the tree to actually die**. Unix has no parent-death propagation
(macOS has no `PR_SET_PDEATHSIG`), so "children die with the parent" only holds
when teardown code actively kills the group and awaits quiescence.

Two guarantees were missing:

1. Teardown signals reached only the direct child PID, never the process group —
   a CLI that wedged was never killed at all (the destroy-time safety timer only
   stopped *waiting*), and CLI-spawned descendants survived every kill.
2. `SessionManager.shutdown()` awaited pump tasks (message-stream end), not real
   process exits — the CLI's own graceful shutdown, which kills ITS background
   task trees, could be cut off by host exit before it ran.

The reference design is deepseek-harness's `subprocess-local` containment layer
(group signalling via negative pgid, SIGTERM→SIGKILL escalation ladder,
quiescence awaits) — researched 2026-11-08; its documented boundary
("SIGKILL/crash/power loss need an external supervisor") is adopted here too.

## Decision

The claude provider already owned the spawn through the SDK's public
`Options.spawnClaudeCodeProcess` escape hatch (`server/process-monitor.ts`), so
both guarantees landed there plus one await in the manager. The SDK is an
external dependency and is unchanged; its graceful-close path
(stdin EOF → 2s grace → SIGTERM → 5s SIGKILL on the direct child) remains the
first leg of the ladder.

`server/process-monitor.ts`:

- `defaultSpawnFn` spawns the CLI `detached` on POSIX (unchanged on Windows), so
  the child leads its own process group and `entry.pgid = child.pid`.
- `signalTree(entry, sig)` delivers teardown signals to the whole group via
  `process.kill(-pgid, sig)`, falling back to the direct child when the group
  signal fails (ESRCH/EPERM). Windows has no POSIX groups: pgid stays undefined
  and only the direct child is signalled — deliberately weaker containment,
  documented in-code rather than papered over.
- The destroy-time safety timer no longer merely gives up waiting. At
  `safetyMs` (15s) it resolves `exited` with `exitSafetyTimeout` (preserving the
  clear()/respawn gate contract) **and escalates**: group SIGTERM, then — if the
  child survived (it traps SIGTERM) — group SIGKILL after `escalateMs` (2s).
  The real `'exit'` handler still owns finalization, so `realExited` settles
  with the actual signal.
- A single module-level `process.on('exit')` hook runs each live monitor's
  `sweepForProcessExit()`: a synchronous group SIGTERM to every unresolved tree.
  This mirrors the SDK's own `killAll` child sweep but reaches the whole group,
  and is the only teardown that runs on `process.exit()`.

`server/session-manager.ts` `shutdown()`: after unloading every session, await
all `closingHandles` real-exit promises (bounded at 8s — a pump ending only
proves the message stream closed, not that the subprocess died, and 8s covers
the SDK's full graceful-close ladder including its own SIGKILL leg; whatever
outlives the wait gets one group SIGTERM from the process-exit sweep at host
exit, and no escalation can run behind that hook — the same boundary DSH
declares for host SIGKILL).

Finalization adds one more sweep the review surfaced: when the CLI process dies
**unintentionally** (a crash, or an escalation leg that killed only the direct
child) while its group still has members, the monitor probes the departed
child's process group and SIGTERMs the leftovers, so they cannot reparent into
unmanaged orphans. An intentional exit skips the sweep on purpose: the CLI
already ran its own graceful shutdown there, and whatever it leaves in its
group may be an intentionally backgrounded service (`nohup server &`) the user
wants to keep.

`server/cli.ts` registers a SIGHUP handler alongside SIGINT/SIGTERM: terminal
close delivers SIGHUP to the foreground group only, and since the detached CLI
no longer shares that group, an unhandled SIGHUP (default signal death runs no
`exit` handlers) would orphan every live CLI tree. The handler routes terminal
hangup through the same graceful shutdown path.

`detached: true` means the CLI no longer shares the server's foreground process
group, so a terminal Ctrl+C no longer hits it directly — no regression, because
the server's SIGINT handler drives `ctx.shutdown()` → unload → SDK stdin-EOF
graceful close, which the CLI receives either way. The same detachment also
means an EXTERNAL supervisor that group-kills the server's process group
(`kill -- -<server pgid>`) no longer takes the CLI tree down with it: the CLI's
group is separate now. This is the DSH trade, adopted knowingly — our own
teardown paths (unload escalation, exit-hook sweep) cover the tree, and a
supervisor that wants the whole forest must target each tree's group or use
SIGKILL-before-any-handler-runs, where no design can help.

## Alternatives considered

- **Fix it in the SDK.** Rejected: it is an external npm dependency (marked
  `external` in the bundle), and it already exposes the
  `spawnClaudeCodeProcess` seam designed for exactly this host-side ownership.
- **Kill the server's own process group at exit** (no `detached`, one
  `kill(-getpgrp())`): rejected — it would signal the server itself and any
  peer infrastructure sharing the group; per-tree groups are the precise tool.
- **Process-table scanning / adoption** (DSH's terminal.ts re-scans and adopts
  escaped descendants): rejected as out of proportion — our only child is
  spawned by us, and the genuinely unreachable set (CLI-spawned *background*
  tasks, which the CLI deliberately `setsid`s into their own sessions) is
  covered by letting the CLI's graceful shutdown run (the quiescence await),
  not by us adopting its children.
- **Await real exits unboundedly in shutdown**: rejected — a child wedged past
  SIGKILL delivery would hang Ctrl+C forever; the 5s bound plus the monitor's
  escalation ladder bounds the worst case while the exit-hook sweep guarantees
  a signal at host exit regardless.

## Consequences

Bought: a wedged or shutting-down CLI now dies **with its whole foreground
tree** instead of leaking it (the 3080 orphan class is closed for the graceful
and process.exit paths); shutdown no longer reports clean exit while a CLI is
still running; `realExited` is now a truthful "the process is gone" signal
(used by permanent-delete gating) instead of one that can stay pending forever.

Cost and remaining boundary, adopted knowingly: SIGKILL of the server itself,
fatal crashes, and power loss still orphan everything — no in-process handler
can run, matching DSH's "needs an external supervisor" declaration. CLI-spawned
background tasks that `setsid` into their own sessions are unreachable by group
signal; they are cleaned by the CLI's own graceful shutdown, which the
escalation ladder now gives time to run. On Windows, tree termination degrades
to direct-child kills (no POSIX groups). The safety timer now actively kills a
child it previously only abandoned — a wedged CLI mid-turn is terminated rather
than left running, which is the intended force-unload semantic. Three narrower
residuals from the review passes: the finalization sweep sends one SIGTERM with
no SIGKILL escalation behind it (a crash-orphaned survivor that traps SIGTERM
still escapes — no observed case, and no machinery was added for it); the
intentional-destroy path can still orphan a foreground child the SDK's SIGKILL
leg catches mid-run (that sweep is deliberately skipped to protect
intentionally backgrounded services); and `shutdown()` snapshots the
real-exit promise set once, so a handle destroyed during the 8s wait (an
in-flight delete racing Ctrl+C) is covered only by the exit-hook sweep, not the
bounded await. The finalize-time group probe also carries a theoretical
pid-reuse risk (a recycled pgid matching an unrelated group within the
probe-then-signal instant) — accepted as not a realistic race, and the signal
is SIGTERM, not SIGKILL, for that reason.

## Testing

`server/process-monitor.test.ts` pins the model with real processes: the child
leads its own group (`kill(-pid, 0)` probe), destroy escalation SIGTERMs a
child+grandchild tree, a SIGTERM-trapping tree dies on the SIGKILL leg with the
signal carried in `realExited`, finalization sweeps group-mates left by a
**crashed** CLI but deliberately spares the group after an intentional destroy,
the exit-hook sweep is installed once per process, signals every live
tree, and is released when a monitor's last entry settles, and the rewritten
`safety-timer-escalates` test pins that `realExited` stays pending through the
SIGTERM leg. `server/session-manager.test.ts` pins that `shutdown()` does not
resolve while a session's real process exit is pending.
