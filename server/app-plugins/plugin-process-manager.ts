// Pool of active plugin subprocesses with lazy activation + crash quarantine.
//
// One PluginProcess per activated plugin. `ensureActive` dedupes concurrent
// activations (two tabs hitting the same command cold-start only spawn once).
// On unexpected exit, a crash timestamp is recorded; 3 crashes within a
// rolling 5-minute window quarantines the plugin (no auto-reactivation) and
// the manager transitions it to `quarantined`.
//
// The manager owns record state; this class reports crashes via `onCrash` and
// the manager decides the runtime-state transition.

import { mkdir } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { createLogger } from '../log.js'
import { PluginProcess } from './plugin-process.js'
import type { AppPluginRecord } from '../../shared/app-plugins/runtime-state.js'
import type { StatGridPayload } from '../../shared/app-plugins/widget.js'
import type { SessionManager } from '../session-manager.js'

const log = createLogger('app-plugins:pm')

const CRASH_WINDOW_MS = 5 * 60 * 1000
const CRASH_QUARANTINE_THRESHOLD = 3
const LOG_RATE_PER_MIN = 1000

export interface ProcessManagerOptions {
  stateDir: string
  sm: SessionManager
  isWindows: boolean
  onCrash: (pluginId: string, crashes: number) => void
  /** Called once after a successful activate() so the manager can transition
   *  the record inactive → active. */
  onActivated: (pluginId: string) => void
  onEvent?: (pluginId: string, widgetId: string, payload: StatGridPayload) => void
}

interface PoolEntry {
  proc: PluginProcess
  /** Shared activation promise so concurrent ensureActive calls coalesce. */
  activating: Promise<PluginProcess> | null
  /** Identity token captured when the placeholder was created, so the
   *  activating IIFE can detect whether teardown deleted/replaced it. */
  token: unknown
}

export class PluginProcessManager {
  private readonly pool = new Map<string, PoolEntry>()
  private readonly crashes = new Map<string, number[]>()
  /** Per-plugin log line counters for rate limiting (1k/min). */
  private readonly logCounters = new Map<string, { count: number; windowStart: number }>()

  constructor(private readonly opts: ProcessManagerOptions) {}

  async ensureActive(record: AppPluginRecord): Promise<PluginProcess> {
    const existing = this.pool.get(record.id)
    if (existing) {
      if (existing.activating) return existing.activating
      return existing.proc
    }
    // Lazy-activate: spawn + activate, deduping concurrent callers.
    const token = Symbol('activation')
    const activating = (async () => {
      const dataDir = resolvePath(this.opts.stateDir, 'app-plugins', 'data', record.id)
      await mkdir(dataDir, { recursive: true })
      const proc = new PluginProcess({
        record,
        dataDir,
        stateDir: this.opts.stateDir,
        sm: this.opts.sm,
        isWindows: this.opts.isWindows,
        onUnexpectedExit: (_code, _signal) => this.handleCrash(record.id),
        onLog: (line) => this.captureLog(record.id, line),
        onEvent: this.opts.onEvent,
      })
      // Spawn happens in the PluginProcess constructor; activate is the
      // lifecycle handshake.
      await proc.activate()
      // Teardown race: if disable/uninstall/crash deleted our placeholder
      // (or replaced it) while activation was in flight, the proc we just
      // brought up is an orphan — kill it and do NOT re-insert, otherwise
      // a later enable would resurrect a process that never got deactivate/
      // refreshGrants notifications.
      const current = this.pool.get(record.id)
      if (!current || current.token !== token) {
        await proc.kill().catch(() => {})
        return proc
      }
      this.pool.set(record.id, { proc, activating: null, token })
      this.opts.onActivated(record.id)
      return proc
    })()
    // Register the in-flight promise so a concurrent ensureActive joins it.
    this.pool.set(record.id, { proc: undefined as unknown as PluginProcess, activating, token })
    try {
      return await activating
    } catch (err) {
      // Activation failed — drop the placeholder so the next attempt can retry.
      this.pool.delete(record.id)
      throw err
    }
  }

  get(pluginId: string): PluginProcess | undefined {
    return this.pool.get(pluginId)?.proc
  }

  /** Resolve the live subprocess for `pluginId`, waiting out an in-flight
   *  activation if one is underway (during activation `get()` returns
   *  undefined). Returns undefined when the plugin has no pool entry at all —
   *  not active, never activated, or mid-teardown. */
  async waitForActive(pluginId: string): Promise<PluginProcess | undefined> {
    const entry = this.pool.get(pluginId)
    if (!entry) return undefined
    if (entry.activating) {
      try {
        await entry.activating
      } catch {
        return undefined
      }
    }
    // Re-fetch: activation may have deleted the entry (teardown race).
    return this.pool.get(pluginId)?.proc
  }

  isQuarantined(pluginId: string): boolean {
    const ts = this.crashes.get(pluginId) ?? []
    return ts.length >= CRASH_QUARANTINE_THRESHOLD
  }

  async deactivate(pluginId: string, reason: 'disable' | 'uninstall' | 'shutdown' | 'reload'): Promise<void> {
    const entry = this.pool.get(pluginId)
    if (!entry) return
    this.pool.delete(pluginId)
    // During activation `proc` is undefined — the ensureActive IIFE will see
    // the entry was deleted and kill the orphan itself, so nothing to do here.
    if (!entry.proc) return
    try {
      await entry.proc.deactivate(reason)
    } catch (err) {
      log.warn(`[${pluginId}] deactivate error: ${(err as Error).message}`)
    }
  }

  async kill(pluginId: string): Promise<void> {
    const entry = this.pool.get(pluginId)
    if (!entry) return
    this.pool.delete(pluginId)
    if (!entry.proc) return // orphan handled by ensureActive's teardown-race check
    try { await entry.proc.kill() } catch (err) { log.warn(`[${pluginId}] kill error: ${(err as Error).message}`) }
  }

  /** Clear quarantine (e.g. after the user explicitly re-enables). */
  clearQuarantine(pluginId: string): void {
    this.crashes.delete(pluginId)
  }

  /** Push updated grants to a live subprocess. If the process is mid-
   *  activation, await it first so the grant refresh isn't dropped (the
   *  subprocess was constructed with the OLD grant set). */
  async refreshGrants(pluginId: string, grants: AppPluginRecord['grantedPermissions']): Promise<void> {
    const entry = this.pool.get(pluginId)
    if (!entry) return
    if (entry.activating) {
      try { await entry.activating } catch { return }
    }
    // Re-fetch: activation may have deleted the entry (teardown race).
    this.pool.get(pluginId)?.proc.refreshGrants(grants)
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.pool.keys())
    await Promise.all(ids.map((id) => this.deactivate(id, 'shutdown')))
  }

  // ── Internals ──────────────────────────────────────────────────────

  private handleCrash(pluginId: string): void {
    const now = Date.now()
    const ts = (this.crashes.get(pluginId) ?? []).filter((t) => now - t < CRASH_WINDOW_MS)
    ts.push(now)
    this.crashes.set(pluginId, ts)
    this.pool.delete(pluginId)
    log.warn(`[${pluginId}] subprocess crashed (${ts.length}/${CRASH_QUARANTINE_THRESHOLD} in 5min)`)
    this.opts.onCrash(pluginId, ts.length)
  }

  private captureLog(pluginId: string, line: string): void {
    // Rate-limit: 1000 lines/minute per plugin. Over the cap, drop (the
    // count is visible in the management UI via the logs endpoint in B2).
    let counter = this.logCounters.get(pluginId)
    if (!counter) {
      counter = { count: 0, windowStart: Date.now() }
      this.logCounters.set(pluginId, counter)
    }
    const now = Date.now()
    if (now - counter.windowStart > 60_000) {
      counter.count = 0
      counter.windowStart = now
    }
    counter.count++
    if (counter.count > LOG_RATE_PER_MIN) return
    // The manager wires this into a ring buffer exposed by GET /logs.
    log.info(`[plugin:${pluginId}] ${line}`)
  }
}
