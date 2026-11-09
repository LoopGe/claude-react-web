// Real-time CLI process health monitor.
//
// Uses the SDK's `Options.spawnClaudeCodeProcess` escape hatch to intercept
// every spawned CLI subprocess and listen for exit/error events. When a
// process exits unexpectedly, the `onExit` callback fires immediately
// (milliseconds, not 60s GC polling) so the SessionManager can clean up the
// session, deny pending permissions, and notify subscribers.
//
// Correlation: the SDK builds the `SpawnOptions` it hands to
// `spawnClaudeCodeProcess` internally, and the `signal` field on it is the
// transport's OWN `forwardedAbort.signal` — NOT the caller's
// `Options.abortController.signal` (see @anthropic-ai/claude-agent-sdk
// sdk.d.ts, `SpawnOptions.signal`). It is a fresh internal object on every
// spawn, so it CANNOT be used as a Map key to correlate a spawn back to a
// session. Instead, the provider captures the session id in a closure:
// `register(sessionId)` returns a `MonitoredSpawn` handle, the per-session
// `spawnClaudeCodeProcess` closure calls `spawnFor(reg, opts)`, and
// `unregister(reg)` is the destroy-time teardown. The handle's `exited`
// promise resolves with the real exit info (used by SessionManager.clear() to
// gate its respawn on the OLD process actually dying).

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from './log.js'

const log = createLogger('process-monitor')

const IS_WIN32 = process.platform === 'win32'

export interface ProcessExitInfo {
  sessionId: string
  code: number | null
  signal: NodeJS.Signals | null
  killed: boolean
  /** True only when the destroy-time safety timer synthesized completion
   *  without a real process 'exit'. Permanent deletion must reject this. */
  exitSafetyTimeout?: true
  /** Populated when ProcessMonitor receives a 'error' event from the
   *  child (typically a synchronous spawn failure: ENOENT, EACCES, etc.)
   *  rather than a real exit. Lets the SessionManager produce a useful
   *  error message ("claude binary not found") instead of the generic
   *  "code=null, signal=null" shown for both kills and spawn failures.
   *
   *  When set, the exit was a spawn-time failure and `code`/`signal` are
   *  both null (the child never started). When undefined, the exit
   *  followed normal exit/signal semantics. */
  spawnError?: { code?: string; message: string }
}

/** Handle returned by `ProcessMonitor.register()`. Carries the session id in
 *  closure so the per-session spawn wrapper can correlate back to it without
 *  relying on the SDK's internal AbortSignal. The provider reads `exited` to
 *  await the real process exit; `spawned` / `intentional` are mutated only by
 *  the monitor. */
export interface MonitoredSpawn {
  readonly sessionId: string
  /** Set true once `spawnFor` actually spawned a child process. Read by
   *  `unregister` to decide whether `exited` can resolve immediately (no
   *  process ever ran) or must wait for the real 'exit' event. */
  spawned: boolean
  /** Set true by `unregister()` so the impending exit is treated as an
   *  intentional close — `onExit` is NOT fired for it (the SessionManager is
   *  tearing the session down on purpose). Read by the exit handler. */
  intentional: boolean
  /** Resolves with the child's exit info once the process exits. For a
   *  session that never spawned a real process (mocked SDK in tests, a
   *  deferred-spawn Query, or a Query that errored before `initialize()`),
   *  `unregister()` resolves it immediately so awaiters don't hang. Never
   *  rejects. */
  readonly exited: Promise<ProcessExitInfo>
  /** Resolves ONLY for a real process exit/error (or no spawned process),
   *  never for the destroy-time safety timeout. Permanent deletion uses this
   *  stronger gate so a later real exit can still unblock a retry. */
  readonly realExited: Promise<ProcessExitInfo>
}

interface Entry {
  sessionId: string
  process: ChildProcess | null
  hasSpawned: boolean
  resolveExit: (info: ProcessExitInfo) => void
  resolveRealExit: (info: ProcessExitInfo) => void
  exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null
  errorHandler: ((err: Error) => void) | null
  /** Diagnostic stderr listeners attached in spawnFor. Detached in
   *  finalizeEntry so a dead ChildProcess reference can't keep the `buf`
   *  closure (and potentially large captured stderr) alive. */
  stderrDataHandler: ((chunk: string) => void) | null
  stderrEndHandler: (() => void) | null
  /** stdin/stdout socket error listeners — attached in spawnFor so a
   *  post-exit write by the SDK (ECONNABORTED / EPIPE on a closed pipe)
   *  doesn't surface as an unhandled stream error. Detached in
   *  finalizeEntry alongside the stderr listeners. */
  stdinErrorHandler: ((err: Error) => void) | null
  stdoutErrorHandler: ((err: Error) => void) | null
  safetyTimer: NodeJS.Timeout | null
  /** Second-leg timer of the destroy escalation (SIGKILL tree). Null unless
   *  the safety timer has fired and the tree is still alive. */
  escalationTimer: NodeJS.Timeout | null
  /** Process-group id of the spawned CLI. Equal to the child pid because the
   *  POSIX spawn is detached (the child leads its own group). Undefined on
   *  Windows, where tree signalling degrades to direct-PID kills. */
  pgid: number | undefined
  resolved: boolean
}

/** Default process spawner — mirrors what the SDK does internally when no
 *  `spawnClaudeCodeProcess` override is provided. Uses Node's
 *  `child_process.spawn` with the command/args/cwd/env from SpawnOptions.
 *  On POSIX the child is spawned `detached`, making it the leader of its OWN
 *  process group (pgid == pid): every teardown signal can then reach the
 *  whole CLI tree via the negative-pgid group signal instead of only the
 *  direct child (see signalTree). Windows has no POSIX groups — the child
 *  stays attached and tree termination degrades to direct-PID kills. */
function defaultSpawnFn(opts: SpawnOptions): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !IS_WIN32,
  })
  return child as unknown as SpawnedProcess
}

/** Worst-case grace window before we stop waiting for the child's 'exit'.
 *  The SDK's own graceful-close path is stdin EOF -> 2s grace -> SIGTERM ->
 *  5s -> SIGKILL (~7s total on a well-behaved child); 15s leaves generous
 *  margin while still guaranteeing awaiters (e.g. clear()'s respawn gate)
 *  can't hang forever if the child wedges and never emits 'exit'. */
const EXIT_SAFETY_MS = 15_000

/** Gap between the destroy-escalation legs: SIGTERM tree first, then — if
 *  the child ignored it and is still alive — SIGKILL tree. Mirrors DSH's
 *  subprocess-local teardown ladder. */
const ESCALATE_MS = 2_000

/** Process-exit sweep closures, one per live ProcessMonitor that has spawned
 *  at least one child. A single module-level 'exit' hook runs them all
 *  synchronously on host exit: every unresolved tracked tree gets a group
 *  SIGTERM (no timers/promises are possible in an exit hook). This mirrors
 *  the SDK's own killAll child sweep, but reaches the whole tree. */
const processExitSweeps = new Set<() => void>()
let exitHookInstalled = false
function installProcessExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const sweep of processExitSweeps) sweep()
  })
}

export class ProcessMonitor {
  private entries = new Map<MonitoredSpawn, Entry>()
  private readonly onExit: (info: ProcessExitInfo) => void
  /** Safety-window used by the destroy-time timer. Injectable so tests can
   *  exercise the timer path without waiting 15s. Defaults to EXIT_SAFETY_MS. */
  private readonly safetyMs: number
  /** Gap between the destroy-escalation legs. Injectable for tests. */
  private readonly escalateMs: number
  /** Optional per-line stderr callback. Called with (sessionId, line) for
   *  every captured stderr line, in addition to the existing log.warn.
   *  Used by the claude provider to tee stderr into session-scoped log files. */
  private readonly stderrSink?: (sessionId: string, line: string) => void

  constructor(onExit: (info: ProcessExitInfo) => void, opts?: { safetyMs?: number; escalateMs?: number; stderrSink?: (sessionId: string, line: string) => void }) {
    this.onExit = onExit
    this.safetyMs = opts?.safetyMs ?? EXIT_SAFETY_MS
    this.escalateMs = opts?.escalateMs ?? ESCALATE_MS
    this.stderrSink = opts?.stderrSink
  }

  /** Register a session before `query()` is called. Returns a handle whose
   *  `exited` promise resolves with the eventual CLI process exit info. The
   *  same handle is passed to `spawnFor()` (from the spawn wrapper) and
   *  `unregister()` (from the handle's destroy path). */
  register(sessionId: string): MonitoredSpawn {
    let resolveExit!: (info: ProcessExitInfo) => void
    const exited = new Promise<ProcessExitInfo>((resolve) => {
      resolveExit = resolve
    })
    let resolveRealExit!: (info: ProcessExitInfo) => void
    const realExited = new Promise<ProcessExitInfo>((resolve) => {
      resolveRealExit = resolve
    })
    const reg: MonitoredSpawn = { sessionId, spawned: false, intentional: false, exited, realExited }
    this.entries.set(reg, {
      sessionId,
      process: null,
      hasSpawned: false,
      resolveExit,
      resolveRealExit,
      exitHandler: null,
      errorHandler: null,
      stderrDataHandler: null,
      stderrEndHandler: null,
      stdinErrorHandler: null,
      stdoutErrorHandler: null,
      safetyTimer: null,
      escalationTimer: null,
      pgid: undefined,
      resolved: false,
    })
    return reg
  }

  /** Spawn (or re-spawn) the CLI subprocess for `reg`, attaching exit/error
   *  listeners. Returns the `SpawnedProcess` the SDK expects. Called from the
   *  per-session `spawnClaudeCodeProcess` closure the provider injects. */
  spawnFor(reg: MonitoredSpawn, opts: SpawnOptions): SpawnedProcess {
    const entry = this.entries.get(reg)
    const sid = entry?.sessionId ?? reg.sessionId
    if (!entry || reg.intentional) {
      // Deferred SDK initialization may arrive after destroy(). Refuse before
      // creating a process: even an immediately-killed child gets a write window.
      throw new Error(`cannot spawn CLI for unregistered session ${sid}`)
    }
    log.warn(
      `[process-monitor] spawn fired sid=${sid} ` +
      `intentional=${reg.intentional} cmd=${opts.command}`,
    )

    const process = defaultSpawnFn(opts)
    if (entry) {
      reg.spawned = true
      entry.process = process as unknown as ChildProcess
      // POSIX spawns are detached, so the child leads its own process group:
      // pgid == pid. Group teardown (signalTree / sweepForProcessExit) keys
      // off this. Windows has no groups — pgid stays undefined.
      const pid = (process as unknown as ChildProcess).pid
      if (!IS_WIN32 && pid) entry.pgid = pid
    }
    installProcessExitHook()
    processExitSweeps.add(this.processExitSweep)
    this.sweepRegistered = true

    // DIAGNOSTIC: capture the CLI subprocess's stderr. The SDK surfaces a
    // generic "Claude Code process exited with code N" but discards the
    // stderr body, so a spawn-time rejection (e.g. /clear's respawned fresh
    // Query exiting with code 1) leaves no actionable clue. We only add an
    // extra listener; the SDK keeps its own stderr consumer, so this never
    // steals data. Captured for EVERY spawn (registered or not) so the
    // diagnostic survives even a stray post-unregister spawn.
    const child = process as unknown as ChildProcess
    // Declared in the outer scope so the `!entry` stray-spawn path below can
    // detach them; assigned inside `if (child.stderr)`.
    let stderrDataHandler: ((chunk: string) => void) | null = null
    let stderrEndHandler: (() => void) | null = null
    if (child.stderr) {
      let buf = ''
      child.stderr.setEncoding('utf8')
      stderrDataHandler = (chunk: string) => {
        buf += chunk
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trimEnd()
          buf = buf.slice(idx + 1)
          if (line) {
            log.warn(`[process-monitor] stderr[${sid}]: ${line}`)
            this.stderrSink?.(sid, line)
          }
        }
      }
      stderrEndHandler = () => {
        const tail = buf.trimEnd()
        if (tail) {
          log.warn(`[process-monitor] stderr[${sid}]: ${tail}`)
          this.stderrSink?.(sid, tail)
        }
      }
      child.stderr.on('data', stderrDataHandler)
      child.stderr.on('end', stderrEndHandler)
      // Stash on the entry so finalizeEntry can detach them — otherwise the
      // handlers (and the `buf` closure they share) stay attached to the
      // ChildProcess until it's GC'd, retaining captured stderr.
      if (entry) {
        entry.stderrDataHandler = stderrDataHandler
        entry.stderrEndHandler = stderrEndHandler
      }
    }

    // Attach 'error' listeners on stdin/stdout pipe sockets. When the CLI
    // subprocess exits, its stdin/stdout pipes close; if the SDK then writes
    // to stdin (control message, queued input), the write fails with
    // ECONNABORTED or EPIPE. Without a listener on the socket, Node treats
    // this as an unhandled stream error and prints a raw stack trace to the
    // terminal (all-internal frames, no application context). The process
    // exit is already handled by exitHandler — these listeners just suppress
    // the socket-level noise.
    if (child.stdin) {
      const stdinErrorHandler = (err: Error) => {
        log.debug(`[process-monitor] stdin socket error [${sid}]: ${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`)
      }
      child.stdin.on('error', stdinErrorHandler)
      if (entry) entry.stdinErrorHandler = stdinErrorHandler
    }
    if (child.stdout) {
      const stdoutErrorHandler = (err: Error) => {
        log.debug(`[process-monitor] stdout socket error [${sid}]: ${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`)
      }
      child.stdout.on('error', stdoutErrorHandler)
      if (entry) entry.stdoutErrorHandler = stdoutErrorHandler
    }

    // Track whether the child has actually started. Node emits 'spawn'
    // exactly once on successful spawn (Node 15+); 'error' before 'spawn' is
    // a spawn-time failure (ENOENT, EACCES). 'error' AFTER 'spawn' is a
    // post-spawn IO failure (EPIPE on closed stdin, etc.) — those must not be
    // reported as spawn failures because the session/UI would surface a
    // misleading "claude binary not found" message even though the CLI ran.
    let hasSpawned = false

    const finalize = (info: ProcessExitInfo) => this.finalizeEntry(reg, entry, info)

    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      log.warn(
        `[process-monitor] CLI process exited for session ${sid}: ` +
        `code=${code}, signal=${signal}, killed=${process.killed}`,
      )
      finalize({ sessionId: sid, code, signal, killed: process.killed })
    }

    const errorHandler = (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code
      const phase = hasSpawned ? 'runtime' : 'spawn'
      log.error(
        `[process-monitor] CLI ${phase} error for session ${sid}: ` +
        `${code ?? 'unknown'} — ${err.message}`,
      )
      if (!hasSpawned) {
        // True spawn-time failure: the child never started. Forward err.code
        // / err.message via spawnError so the SessionManager can produce a
        // meaningful "binary not found" message instead of the generic
        // "code=null, signal=null".
        finalize({
          sessionId: sid,
          code: null,
          signal: null,
          killed: false,
          spawnError: { code, message: err.message },
        })
        return
      }
      // Post-spawn IO error (most often EPIPE when the SDK writes to a stdin
      // that the child has already closed). The 'exit' event will arrive
      // separately with the real exit code/signal — let it own the cleanup
      // so we don't synthesize a fake spawn failure here. We log for
      // visibility but otherwise no-op.
    }

    entry.exitHandler = exitHandler
    entry.errorHandler = errorHandler
    // The SDK's `SpawnedProcess` type only declares 'exit' and 'error', but
    // the underlying object is a Node ChildProcess which emits 'spawn' once
    // on successful spawn (Node 15+). Cast through EventEmitter so the
    // typecheck passes; the runtime contract is stable.
    ;(process as unknown as NodeJS.EventEmitter).on('spawn', () => {
      hasSpawned = true
    })
    process.on('exit', exitHandler)
    process.on('error', errorHandler)

    return process
  }

  /** Signal one tracked tree. POSIX delivers to the whole process group via
   *  the negative pgid (the detached child leads it, so CLI-spawned foreground
   *  descendants die with it); a failed group signal (ESRCH — group already
   *  gone, or EPERM) falls back to the direct child. Windows has no process
   *  groups: only the direct child can be killed, so CLI-spawned descendants
   *  that outlive it are NOT covered here — containment is weaker and the
   *  escape hatch is the CLI's own graceful shutdown, which we preserve by
   *  escalating SIGTERM before SIGKILL. Never throws: delivery races exit. */
  private signalTree(entry: Entry, sig: NodeJS.Signals): void {
    const child = entry.process
    const pid = child?.pid
    if (!child || !pid) return
    if (entry.pgid !== undefined) {
      try {
        process.kill(-entry.pgid, sig)
        return
      } catch {
        // Group gone (already exited) or signal refused — try the direct pid.
      }
    }
    try {
      child.kill(sig)
    } catch {
      // Already exited.
    }
  }

  /** Synchronous teardown of every live tree this monitor tracks. This is the
   *  body of the module-level `process.on('exit')` hook: the host is dying and
   *  won't get another scheduler tick, so only sync kill syscalls are possible
   *  (no timers, no awaits). The SIGTERM gives each CLI a chance to run its own
   *  graceful shutdown — including killing ITS background task trees — even
   *  though nothing will ever SIGKILL-escalate behind this signal. */
  sweepForProcessExit(): void {
    for (const entry of this.entries.values()) {
      if (entry.resolved) continue
      this.signalTree(entry, 'SIGTERM')
    }
  }
  private readonly processExitSweep = (): void => this.sweepForProcessExit()
  /** Whether this monitor's sweep currently sits in the module-level exit
   *  registry. True from the first spawn until every tracked tree has
   *  settled — a retired monitor must not be retained for the process
   *  lifetime. */
  private sweepRegistered = false
  /** Drop this monitor's exit-sweep registration when nothing is tracked. */
  private releaseSweepIfIdle(): void {
    if (this.entries.size === 0 && this.sweepRegistered) {
      processExitSweeps.delete(this.processExitSweep)
      this.sweepRegistered = false
    }
  }

  /** Resolve a tracked entry's `exited` promise exactly once, detach the
   *  child's listeners, and surface the exit to the SessionManager unless the
   *  close was intentional (destroy-driven: clear / auto-resume / unload set
   *  `reg.intentional` first). Shared by the 'exit'/'error' handlers attached
   *  in `spawnFor` and the destroy-time safety timer armed in `unregister`,
   *  so the cleanup path is identical for real exits and timer-driven ones. */
  private finalizeEntry(reg: MonitoredSpawn, entry: Entry, info: ProcessExitInfo): void {
    if (entry.resolved) return
    entry.resolved = true
    if (entry.safetyTimer) {
      clearTimeout(entry.safetyTimer)
      entry.safetyTimer = null
    }
    if (entry.escalationTimer) {
      clearTimeout(entry.escalationTimer)
      entry.escalationTimer = null
    }
    // Detach listeners so a lingering ChildProcess reference can't re-fire.
    if (entry.process && entry.exitHandler) entry.process.off('exit', entry.exitHandler)
    if (entry.process && entry.errorHandler) entry.process.off('error', entry.errorHandler)
    // Detach the diagnostic stderr listeners too — otherwise the `buf`
    // closure they share (which may hold a large captured stderr body)
    // stays pinned to the ChildProcess until it's GC'd.
    if (entry.process?.stderr) {
      if (entry.stderrDataHandler) entry.process.stderr.off('data', entry.stderrDataHandler)
      if (entry.stderrEndHandler) entry.process.stderr.off('end', entry.stderrEndHandler)
    }
    // Detach the stdin/stdout error listeners for the same GC reason.
    if (entry.process?.stdin && entry.stdinErrorHandler) {
      entry.process.stdin.off('error', entry.stdinErrorHandler)
    }
    if (entry.process?.stdout && entry.stdoutErrorHandler) {
      entry.process.stdout.off('error', entry.stdoutErrorHandler)
    }
    entry.resolveRealExit(info)
    entry.resolveExit(info)
    this.entries.delete(reg)
    this.releaseSweepIfIdle()
    // Leftover group-mates, CRASH PATH ONLY: the CLI may die before its own
    // foreground children (a crash, or an escalation leg that killed only
    // the direct child). Once the direct child is gone nobody owns those
    // descendants — probe the group and SIGTERM any survivor so it cannot
    // reparent into an unmanaged orphan (the 3080-orphan class). An
    // INTENTIONAL exit skips this: the CLI already ran its own graceful
    // shutdown, and what it leaves in its group may be an intentionally
    // backgrounded service (`nohup server &`) that must survive. The
    // probe-then-signal window is microscopic, so pgid reuse hitting an
    // unrelated group is not a realistic race; the signal is SIGTERM rather
    // than SIGKILL for the same reason.
    if (entry.pgid !== undefined && !reg.intentional) {
      try {
        process.kill(-entry.pgid, 0)
        log.warn(
          `CLI exited but process group ${entry.pgid} still has members — ` +
          `SIGTERM to leftovers [${entry.sessionId}]`,
        )
        process.kill(-entry.pgid, 'SIGTERM')
      } catch {
        // Group empty or already gone — the normal clean-exit path.
      }
    }
    // Only surface to SessionManager when the exit was NOT an intentional
    // close. `unregister()` sets `reg.intentional = true` before the SDK's
    // graceful-close path kills the child, so a destroy-driven exit (clear,
    // auto-resume, unload) resolves `exited` for awaiters without firing
    // handleProcessExit (which would otherwise double-broadcast / re-terminate).
    if (!reg.intentional) {
      this.onExit(info)
    } else {
      log.info(
        `[process-monitor] intentional exit for session ${entry.sessionId} ` +
        `(code=${info.code}, spawnError=${info.spawnError ? 'yes' : 'no'}) — not surfacing`,
      )
    }
  }

  /** Unregister a session (called from the handle's destroy()/cleanup).
   *  Marks the (impending) exit intentional so `onExit` does NOT fire, and
   *  resolves `exited` immediately when no real process ever spawned — so
   *  awaiters such as `SessionManager.clear()`'s respawn gate don't block on
   *  a process that will never exit (mocked SDK in tests, a deferred-spawn
   *  Query, or a Query that errored before `initialize()`). For a real
   *  running process the entry is kept so its 'exit' resolves `exited`; the
   *  safety timer armed here (in `unregister`) bounds the wait. */
  unregister(reg: MonitoredSpawn): void {
    const entry = this.entries.get(reg)
    reg.intentional = true
    if (!entry) return
    if (!reg.spawned) {
      // No real subprocess was ever spawned. Resolve immediately so awaiters
      // don't block on a process that will never exit.
      if (!entry.resolved) {
        entry.resolved = true
        if (entry.safetyTimer) {
          clearTimeout(entry.safetyTimer)
          entry.safetyTimer = null
        }
        entry.resolveRealExit({ sessionId: reg.sessionId, code: null, signal: null, killed: false })
        entry.resolveExit({ sessionId: reg.sessionId, code: null, signal: null, killed: false })
      }
      this.entries.delete(reg)
      this.releaseSweepIfIdle()
      return
    }
    // A real process is (or was) running: keep the entry so its real 'exit'
    // resolves `exited`. Arm the safety timer NOW (at destroy time) — NOT at
    // spawn. A spawn-time timer would fire 15s into ANY healthy long-running
    // session (its process is alive, so 'exit' never comes) and tear it down
    // as a false "exited unexpectedly (code=null, signal=null)" — orphaning
    // the still-alive child. The timer only matters once we're actually
    // waiting for the old child to die, so clear()'s respawn gate can't hang
    // on a wedged process that never emits 'exit'. The SDK's graceful-close
    // path is ~7s (stdin EOF -> 2s grace -> SIGTERM/SIGKILL); 15s is margin.
    entry.safetyTimer = setTimeout(() => {
      if (entry.resolved) return
      entry.safetyTimer = null
      log.warn(
        `[process-monitor] exit safety timer fired for session ${reg.sessionId} ` +
        `after ${this.safetyMs}ms with no 'exit' event`,
      )
      // Preserve only the process exit/error listeners needed by realExited.
      // Diagnostic stream listeners and their stderr buffer must not stay
      // pinned for the lifetime of a wedged child.
      if (entry.process?.stderr) {
        if (entry.stderrDataHandler) entry.process.stderr.off('data', entry.stderrDataHandler)
        if (entry.stderrEndHandler) entry.process.stderr.off('end', entry.stderrEndHandler)
      }
      if (entry.process?.stdin && entry.stdinErrorHandler) {
        entry.process.stdin.off('error', entry.stdinErrorHandler)
      }
      if (entry.process?.stdout && entry.stdoutErrorHandler) {
        entry.process.stdout.off('error', entry.stdoutErrorHandler)
      }
      // Preserve the legacy `exited` backstop for clear()/respawn, but do NOT
      // delete the entry: realExited must still settle if the wedged child
      // eventually dies, allowing a safe permanent-delete retry.
      entry.resolveExit({
        sessionId: reg.sessionId,
        code: null,
        signal: null,
        killed: entry.process?.killed ?? false,
        exitSafetyTimeout: true,
      })
      // The SDK's graceful close has had its full window and the child is
      // still alive — stop waiting passively and tear the TREE down: group
      // SIGTERM first (lets the CLI run its own graceful shutdown, including
      // killing its background task trees), then a group SIGKILL for a child
      // that ignored it. The real 'exit' handler still owns finalization, so
      // realExited settles with the actual signal.
      log.warn(`escalating teardown for session ${reg.sessionId}: SIGTERM to process group ${entry.pgid ?? 'n/a'}`)
      this.signalTree(entry, 'SIGTERM')
      entry.escalationTimer = setTimeout(() => {
        entry.escalationTimer = null
        if (entry.resolved) return
        log.warn(`session ${reg.sessionId} survived SIGTERM — SIGKILL to process group ${entry.pgid ?? 'n/a'}`)
        this.signalTree(entry, 'SIGKILL')
      }, this.escalateMs)
      ;(entry.escalationTimer as { unref?: () => void }).unref?.()
    }, this.safetyMs)
    ;(entry.safetyTimer as { unref?: () => void }).unref?.()
  }

  /** Number of currently tracked registrations (for debug/status). Includes
   *  registered-but-unspawned and spawned-but-not-yet-exited entries. */
  get size(): number {
    return this.entries.size
  }
}
