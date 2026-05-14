// Real-time CLI process health monitor.
//
// Uses the SDK's `Options.spawnClaudeCodeProcess` escape hatch to intercept
// every spawned CLI subprocess and listen for exit/error events. When a
// process exits unexpectedly, the `onExit` callback fires immediately
// (milliseconds, not 60s GC polling) so the SessionManager can clean up
// the session, deny pending permissions, and notify subscribers.
//
// Correlation: `spawnClaudeCodeProcess` receives `SpawnOptions` which
// includes the session's `AbortSignal`. Since the signal is the exact
// same object reference passed into `Options.abortController`, we use it
// as a Map key to correlate spawned processes back to sessions.

import { spawn } from 'node:child_process'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

export interface ProcessExitInfo {
  sessionId: string
  code: number | null
  signal: NodeJS.Signals | null
  killed: boolean
}

interface MonitoredEntry {
  id: string
  process: SpawnedProcess | null
  onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null
  onError: ((err: Error) => void) | null
}

/** Default process spawner — mirrors what the SDK does internally when
 *  no `spawnClaudeCodeProcess` override is provided. Uses Node's
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

export class ProcessMonitor {
  private sessions = new Map<object, MonitoredEntry>()
  private onExit: (info: ProcessExitInfo) => void

  constructor(onExit: (info: ProcessExitInfo) => void) {
    this.onExit = onExit
  }

  /** Register a session's AbortSignal before `query()` is called.
   *  The signal will be available when `spawnClaudeCodeProcess` fires. */
  register(signal: AbortSignal, sessionId: string): void {
    this.sessions.set(signal, { id: sessionId, process: null, onExit: null, onError: null })
  }

  /** Unregister a session (called from unload()). Removes exit listeners
   *  so we don't fire callbacks for intentionally-closed sessions. */
  unregister(signal: AbortSignal): void {
    const entry = this.sessions.get(signal)
    if (entry?.process && entry.onExit && entry.onError) {
      entry.process.off('exit', entry.onExit)
      entry.process.off('error', entry.onError)
    }
    this.sessions.delete(signal)
  }

  /** Create the spawn wrapper to inject into Options.spawnClaudeCodeProcess.
   *  Returns a function with the exact signature the SDK expects. */
  createSpawnWrapper(): (options: SpawnOptions) => SpawnedProcess {
    return (opts: SpawnOptions): SpawnedProcess => {
      const entry = this.sessions.get(opts.signal)
      if (!entry) {
        // Signal not recognized — shouldn't happen, but fall through to
        // default spawn so we don't break the SDK.
        console.warn('[process-monitor] spawn called with unregistered signal — using default spawn')
        return defaultSpawnFn(opts)
      }

      const process = defaultSpawnFn(opts)
      entry.process = process

      const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
        // Only fire if the session is still registered (not intentionally unloaded)
        if (!this.sessions.has(opts.signal)) return
        const sessionId = entry.id
        console.warn(
          `[process-monitor] CLI process exited for session ${sessionId}: ` +
          `code=${code}, signal=${signal}, killed=${process.killed}`,
        )
        // Clean up the entry — no need to keep listening
        this.sessions.delete(opts.signal)
        this.onExit({
          sessionId,
          code,
          signal,
          killed: process.killed,
        })
      }

      const errorHandler = (err: Error) => {
        if (!this.sessions.has(opts.signal)) return
        console.error(`[process-monitor] CLI process error for session ${entry.id}:`, err.message)
        // Treat spawn errors (ENOENT, EACCES, etc.) as an exit with null code
        this.sessions.delete(opts.signal)
        this.onExit({
          sessionId: entry.id,
          code: null,
          signal: null,
          killed: false,
        })
      }

      entry.onExit = exitHandler
      entry.onError = errorHandler
      process.on('exit', exitHandler)
      process.on('error', errorHandler)

      return process
    }
  }

  /** Number of currently monitored processes (for debug/status). */
  get size(): number {
    return this.sessions.size
  }
}
