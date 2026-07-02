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

export interface ProcessExitInfo {
  sessionId: string
  code: number | null
  signal: NodeJS.Signals | null
  killed: boolean
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
}

interface Entry {
  sessionId: string
  process: ChildProcess | null
  hasSpawned: boolean
  resolveExit: (info: ProcessExitInfo) => void
  exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null
  errorHandler: ((err: Error) => void) | null
  /** Diagnostic stderr listeners attached in spawnFor. Detached in
   *  finalizeEntry so a dead ChildProcess reference can't keep the `buf`
   *  closure (and potentially large captured stderr) alive. */
  stderrDataHandler: ((chunk: string) => void) | null
  stderrEndHandler: (() => void) | null
  safetyTimer: NodeJS.Timeout | null
  resolved: boolean
}

/** Default process spawner — mirrors what the SDK does internally when no
 *  `spawnClaudeCodeProcess` override is provided. Uses Node's
 *  `child_process.spawn` with the command/args/cwd/env from SpawnOptions. */
function defaultSpawnFn(opts: SpawnOptions): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })
  return child as unknown as SpawnedProcess
}

/** Worst-case grace window before we stop waiting for the child's 'exit'.
 *  The SDK's own graceful-close path is stdin EOF -> 2s grace -> SIGTERM ->
 *  5s -> SIGKILL (~7s total on a well-behaved child); 15s leaves generous
 *  margin while still guaranteeing awaiters (e.g. clear()'s respawn gate)
 *  can't hang forever if the child wedges and never emits 'exit'. */
const EXIT_SAFETY_MS = 15_000

export class ProcessMonitor {
  private entries = new Map<MonitoredSpawn, Entry>()
  private readonly onExit: (info: ProcessExitInfo) => void
  /** Safety-window used by the destroy-time timer. Injectable so tests can
   *  exercise the timer path without waiting 15s. Defaults to EXIT_SAFETY_MS. */
  private readonly safetyMs: number

  constructor(onExit: (info: ProcessExitInfo) => void, opts?: { safetyMs?: number }) {
    this.onExit = onExit
    this.safetyMs = opts?.safetyMs ?? EXIT_SAFETY_MS
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
    const reg: MonitoredSpawn = { sessionId, spawned: false, intentional: false, exited }
    this.entries.set(reg, {
      sessionId,
      process: null,
      hasSpawned: false,
      resolveExit,
      exitHandler: null,
      errorHandler: null,
      stderrDataHandler: null,
      stderrEndHandler: null,
      safetyTimer: null,
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
    if (entry) reg.spawned = true

    log.warn(
      `[process-monitor] spawn fired sid=${sid} ` +
      `intentional=${reg.intentional} cmd=${opts.command}`,
    )

    const process = defaultSpawnFn(opts)
    if (entry) entry.process = process as unknown as ChildProcess

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
          if (line) log.warn(`[process-monitor] stderr[${sid}]: ${line}`)
        }
      }
      stderrEndHandler = () => {
        const tail = buf.trimEnd()
        if (tail) log.warn(`[process-monitor] stderr[${sid}]: ${tail}`)
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

    if (!entry) {
      // No registered entry (e.g. a stray spawn after unregister). Fall
      // through to default spawn so we don't break the SDK; we just won't
      // track its exit or fire onExit for it. We still attached stderr
      // listeners above so the diagnostic survives this stray spawn — but
      // finalizeEntry never runs for unregistered entries, so detach them
      // ourselves on child exit/close. Otherwise the `buf` closure (which may
      // hold a large captured stderr body) stays pinned to the ChildProcess
      // until it's GC'd — exactly the leak finalizeEntry guards against for
      // registered entries.
      if (stderrDataHandler && stderrEndHandler) {
        const data = stderrDataHandler
        const end = stderrEndHandler
        const detachStderr = () => {
          if (child.stderr) {
            child.stderr.off('data', data)
            child.stderr.off('end', end)
          }
          child.off('exit', detachStderr)
          child.off('close', detachStderr)
        }
        child.on('exit', detachStderr)
        child.on('close', detachStderr)
      }
      log.warn(`[process-monitor] spawn for unregistered session ${sid} — not tracking exit`)
      return process
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
    entry.resolveExit(info)
    this.entries.delete(reg)
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
        entry.resolveExit({ sessionId: reg.sessionId, code: null, signal: null, killed: false })
      }
      this.entries.delete(reg)
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
      log.warn(
        `[process-monitor] exit safety timer fired for session ${reg.sessionId} ` +
        `after ${this.safetyMs}ms with no 'exit' event`,
      )
      this.finalizeEntry(reg, entry, {
        sessionId: reg.sessionId,
        code: null,
        signal: null,
        killed: entry.process?.killed ?? false,
      })
    }, this.safetyMs)
    ;(entry.safetyTimer as { unref?: () => void }).unref?.()
  }

  /** Number of currently tracked registrations (for debug/status). Includes
   *  registered-but-unspawned and spawned-but-not-yet-exited entries. */
  get size(): number {
    return this.entries.size
  }
}
