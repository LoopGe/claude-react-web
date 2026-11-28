# Agent Note: Server death records are independent of the logger

Status: implemented

## Problem

Recurring "the WS keeps failing to reconnect" outages were undiagnosable after the fact. The Vite proxy errors (`ECONNABORTED`, then `ECONNREFUSED` floods) proved the backend process was down, but every server exit path printed to the terminal only: signals via `console.log`, uncaught exceptions via Node's default stderr dump, boot fatals via `console.error`. Once the dev terminal scrolled past, a death left no trace anywhere — the file log showed the process simply stop, indistinguishable from an external kill. With the no-watch dev scripts (`dev:*:once`) nothing restarts a dead server, so each silent death became a long outage ending in a manual restart that erased the evidence.

## Decision

`server/fatal-report.ts` records every process death durably, independent of the logger by construction:

- `installFatalReporting(stateDir)` is called once in `runServer` **before** `loadConfig`, capturing the state dir. Records append synchronously to the same daily `logs/server-YYYY-MM-DD.log` the logger uses — whether or not opt-in file logging is on, and even after shutdown's `disableFileLogging()` destroyed the stream. The logs dir is created on demand, and the shared `pruneOldLogs` retention cap is honored on every append (with file logging off, `openStream` never runs to prune). File naming and line shape are shared pure helpers exported from log.ts (`todayKey` / `serverLogFileName` / `formatFileLine`), so the two writers cannot drift apart.
- Boot-window signals are covered: `runServer` arms record-and-exit SIGINT/SIGTERM/SIGHUP handlers immediately after install and retires them when the real graceful shutdown registers at the end of boot. A Ctrl+C during the slow context build otherwise dies by default disposition — no `exit` event, no record. Once `createServerContext` resolves, the boot handler tears down plugin subprocesses (`prepareForShutdown` + `shutdown`) before exiting; a signal *during* `initialize()` can still orphan the children spawned so far (on a Windows console Ctrl+C they die with the host's console signal regardless).
- `shutdown()` carries a once-latch: a second signal during teardown (double Ctrl+C, daemon-stop racing SIGTERM) neither re-runs teardown nor duplicates the durable record — one death, one record.
- `uncaughtException` / `unhandledRejection` handlers `reportFatal` (terminal + durable record) and then `process.exit(1)`. Crash semantics are preserved: logging alone is not recovery, and continuing in an undefined state would mask the defect.
- An `exit` backstop records the final code, catching the silent natural event-loop drain (exit 0, no signal, no error).
- `recordShutdown(signal)` appends the signal synchronously from cli.ts's `shutdown()`.

The record a server death leaves is a diagnostic decision tree: fatal record + code 1 → JS crash; signal record + code 0 → graceful shutdown; code 0 alone → natural drain; **no record → external kill / hard native abort** (no handlers run). The guarantee is server-mode only: one-shot management subcommands never install the reporters and report to the terminal only.

Death records reuse log.ts's exported `formatArg` (Error→stack, object→JSON) so a plain-object rejection reason is not flattened to `[object Object]`.

## Alternatives considered

**Route death reports through `createLogger`.** Lost because the logger's file write is an async `WriteStream` write that `process.exit()` drops, and `passes()` filters by level/scope — a death report could vanish exactly when it matters, under a documented configuration (`LOG_SCOPES=ws,session`). Reporting failures needs an independent fallback; the sync append is that fallback.

**Record only when opt-in file logging is enabled.** Lost because `logToFile` defaults to false: the motivating outage would stay undiagnosable on default installs. Death records are a handful of lines per process death, not hot-path diagnostics, so writing them unconditionally to the daily log path costs nothing and keeps one place to look.

**Keep the signal record as a `log.warn` in `shutdown()`.** Lost for the same stream-lifecycle reason: `disableFileLogging()` uses `destroy()` (not `end()`), dropping unflushed writes, and the warn is scope-filterable. The synchronous `recordShutdown` does not depend on the ordering or the filters.

**Auto-restart the dev server (watch mode or a supervisor).** Not chosen here: it changes the dev workflow rather than closing the diagnostic gap, and with several agent sessions writing files in the shared tree a whole-cwd watch would restart-loop. The cause of the deaths must be proven from records first.

## Consequences

- The next silent death diagnoses itself from the log file; an external kill is identifiable by the *absence* of a record (the tree-containment note's kill paths are the in-repo candidates: [subprocess tree containment](2026-11-09-subprocess-tree-containment.md)).
- A default install's first death creates `stateDir/logs/` even with file logging off — death records are deliberately not gated by the opt-in.
- Bare `console.error` in fatal-report.ts is a documented exception to the logger rule (CLAUDE.md Logging): the process is dying and the terminal is the one channel that always works.
- External kills and hard native aborts still leave no record — no user-space handler can run for them; that absence is itself the signal.
- The daemon host (`server/daemon/main.ts`) deliberately does not install the reporters: it supervises the production server with its own restart loop and `daemon/server.log`, a different failure class from the dev-server outages this closes. One-shot management subcommands are likewise terminal-only.
- `server/fatal-report.test.ts` spawns real child processes (the handlers are process-global) and pins each branch of the decision tree, including the destroyed-stream ordering, the object-rejection formatting, and the no-reason rejection. The cli.ts signal *wiring* (boot handler install/retire, real signal delivery) is not process-tested — a faithful test would spawn the full server boot; the wiring is typechecked and self-reviewed, and the record functions it calls are pinned.
