// Generic completion-based update scheduler. Semantics ported from DSH's
// DesktopUpdateSchedule (apps/desktop/src/update-schedule.ts): the next
// deadline is armed when the previous check SETTLES (not on a fixed rate),
// consecutive failures double the delay up to a cap, ±jitter spreads fleets
// of installs, a monotonic clock ignores wall-clock corrections, and
// concurrent callers share one in-flight probe.
//
// Two instances exist: the web host's npm probe schedule (startUpdateSchedule,
// wired in cli.ts) and the desktop feed check (desktop/updater.ts). The class
// is generic over the check result so both share the scheduling semantics
// without sharing a result vocabulary.

import { createLogger } from './log.js'
import { config } from './config.js'
import { checkForUpdates, getCachedUpdateInfo } from './update-checker.js'
import type { UpdateInfo } from '../shared/update-info.js'

const log = createLogger('update-schedule')

export interface UpdateScheduleConfig {
  readonly intervalMs: number
  readonly maxBackoffMs: number
  readonly jitter: number
}

export interface UpdateScheduleDeps<R> {
  /** Run one probe. `manual` marks an explicit user-triggered check. */
  check: (manual: boolean) => Promise<R>
  /** Whether a settled result counts as a failure (drives backoff). */
  failed: (result: R) => boolean
  /** The observable state returned when a non-manual check is not due. */
  current: () => R
}

/** Validate/derive polling settings from the configured interval. `0` means
 *  periodic checking is disabled (null — the caller runs no schedule);
 *  nonzero intervals clamp to a 60 s floor, backoff caps at 4× the interval
 *  (floor 1 h), jitter is ±20%. */
export function resolveUpdateScheduleConfig(intervalMs: number): UpdateScheduleConfig | null {
  if (intervalMs === 0) return null
  const interval = Math.max(60_000, intervalMs)
  return { intervalMs: interval, maxBackoffMs: Math.max(4 * interval, 3_600_000), jitter: 0.2 }
}

export class UpdateSchedule<R> {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<R> | undefined
  private activeChecks = 0
  private disposed = false
  private nextCheck = -Infinity
  private delay: number

  constructor(
    private readonly deps: UpdateScheduleDeps<R>,
    private readonly config: UpdateScheduleConfig,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.delay = config.intervalMs
  }

  /** Due → run (or join) one probe; not due → current() without probing.
   *  `manual` bypasses the deadline and is passed through to deps.check;
   *  `force` bypasses the deadline without marking the probe manual (the
   *  re-arm timer uses it). Concurrent non-manual callers join the pending
   *  probe rather than stacking a second one. */
  async check(manual = false, force = manual): Promise<R> {
    if (this.disposed) throw new Error('update schedule: disposed')
    if (this.pending !== undefined && !manual) return this.pending
    if (!force && this.now() < this.nextCheck) return this.deps.current()
    clearTimeout(this.timer)
    this.timer = undefined
    this.activeChecks++
    let probe: Promise<R>
    try {
      probe = this.deps.check(manual)
    } catch (err) {
      probe = Promise.reject(err)
    }
    this.pending = probe.then(
      (result) => {
        this.complete(this.deps.failed(result))
        return result
      },
      (error: unknown) => {
        this.complete(true)
        throw error
      },
    )
    return this.pending
  }

  /** Arm the first deadline WITHOUT probing — the caller already ran the
   *  startup/launch check and the schedule takes over from its completion. */
  arm(): void {
    this.schedule(false)
  }

  /** Stop timers and reject new work; in-flight probes settle on their own. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private complete(failed: boolean): void {
    // Joined callers advance the retry delay only once, at the last settlement.
    if (--this.activeChecks !== 0) return
    this.pending = undefined
    this.schedule(failed)
  }

  private schedule(failed: boolean): void {
    if (this.disposed) return
    const { intervalMs, maxBackoffMs, jitter } = this.config
    this.delay = failed ? Math.min(maxBackoffMs, this.delay * 2) : intervalMs
    const lower = Math.max(1_000, this.delay * (1 - jitter))
    const upper = Math.min(maxBackoffMs, this.delay * (1 + jitter))
    const delay = Math.round(lower + (upper - lower) * this.random())
    this.nextCheck = this.now() + delay
    this.timer = setTimeout(() => {
      void this.check(false, true).catch((error: unknown) => {
        log.warn(`scheduled check failed: ${(error as Error)?.message ?? error}`)
      })
    }, delay)
  }
}

/** Web-host npm-probe schedule. null when periodic checking is disabled
 *  (interval 0). Scheduled ticks force the probe — the scheduler is the
 *  freshness authority, bypassing the checker's TTL; the checker's in-flight
 *  dedup still coalesces concurrent callers. Ticks read live config through
 *  checkForUpdates, so an unconfigured registry takes the no-network disabled
 *  path and probing resumes without a restart once it is set. The desktop
 *  host never runs cli.ts (it composes createServerContext directly), so this
 *  factory is web-only by construction. */
export function startUpdateSchedule(): UpdateSchedule<UpdateInfo> | null {
  const scheduleConfig = resolveUpdateScheduleConfig(config.updateCheckIntervalMs)
  if (!scheduleConfig) return null
  return new UpdateSchedule<UpdateInfo>(
    {
      check: () => checkForUpdates(true),
      failed: (r) => !!r.error && !r.disabled,
      current: () => getCachedUpdateInfo(),
    },
    scheduleConfig,
  )
}