// The daemon's core loop: spawn the server child, watch it, restart it on
// unexpected exits with capped exponential backoff, honor the file markers
// (stop = intentional exit, restart = immediate, start = revive), and keep a
// fresh status.json heartbeat on disk the whole time. spawnChild and schedule
// are injectable so tests drive it with fake children and a fake clock.
import {
  readStatusFile, writeStatusFile, readMarker, clearMarker,
  HEARTBEAT_INTERVAL_MS, type DaemonState, type DaemonStatusFile,
} from './control.js'

export interface SupervisorTimings {
  pollMs: number
  backoffBaseMs: number
  backoffCapMs: number
  maxConsecutiveFailures: number
  stableResetMs: number
}

const DEFAULT_TIMINGS: SupervisorTimings = {
  pollMs: HEARTBEAT_INTERVAL_MS,
  backoffBaseMs: 2_000,
  backoffCapMs: 30_000,
  maxConsecutiveFailures: 5,
  stableResetMs: 5 * 60_000,
}

export interface SupervisorDeps {
  stateDir: string
  spawnChild: () => { pid: number; on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void }
  schedule: (fn: () => void, ms: number) => () => void
  timings?: Partial<SupervisorTimings>
}

export function startSupervisor(deps: SupervisorDeps): { stop: () => void } {
  const t = { ...DEFAULT_TIMINGS, ...deps.timings }
  let stopped = false
  let childPid: number | null = null
  let childStartedAt: number | null = null
  let state: DaemonState = 'starting'
  let restartCount = 0
  let consecutiveFailures = 0
  let lastError: string | null = null
  let lastExitReason: string | null = null
  const cancelFns: Array<() => void> = []

  const writeHeartbeat = async (): Promise<void> => {
    const prev = await readStatusFile(deps.stateDir)
    const status: DaemonStatusFile = {
      daemonPid: process.pid,
      childPid,
      state,
      startedAt: prev && prev.daemonPid === process.pid ? prev.startedAt : Date.now(),
      childStartedAt,
      restartCount,
      consecutiveFailures,
      lastError,
      lastExitReason,
      updatedAt: Date.now(),
    }
    await writeStatusFile(deps.stateDir, status)
  }

  const schedule = (fn: () => void, ms: number) => {
    // Return the fn's promise through so a fake clock can await in-flight
    // async work; the runtime scheduler simply ignores the return value.
    const cancel = deps.schedule(() => { if (!stopped) return fn() }, ms)
    cancelFns.push(cancel)
    return cancel
  }

  const spawnNow = (): void => {
    if (stopped) return
    const child = deps.spawnChild()
    childPid = child.pid
    childStartedAt = Date.now()
    state = 'running'
    child.on('exit', (code, signal) => onChildExit(code, signal))
  }

  const onChildExit = async (code: number | null, signal: string | null): Promise<void> => {
    childPid = null
    childStartedAt = null
    lastExitReason = signal != null ? `signal:${signal}` : `code:${code}`
    if (await readMarker(deps.stateDir, 'stop')) {
      await clearMarker(deps.stateDir, 'stop')
      state = 'stopped'
      return
    }
    if (await readMarker(deps.stateDir, 'restart')) {
      await clearMarker(deps.stateDir, 'restart')
      restartCount += 1
      spawnNow()
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= t.maxConsecutiveFailures) {
      state = 'failed'
      lastError = `child exited ${lastExitReason} ${t.maxConsecutiveFailures}x in a row`
      return
    }
    state = 'backoff'
    const delay = Math.min(t.backoffBaseMs * 2 ** (consecutiveFailures - 1), t.backoffCapMs)
    schedule(() => { restartCount += 1; spawnNow() }, delay)
  }

  const poll = async (): Promise<void> => {
    if (childStartedAt != null && Date.now() - childStartedAt >= t.stableResetMs) consecutiveFailures = 0
    if (state === 'stopped' && await readMarker(deps.stateDir, 'start')) {
      await clearMarker(deps.stateDir, 'start')
      spawnNow()
    }
    await writeHeartbeat()
    schedule(() => poll(), t.pollMs)
  }

  spawnNow()
  schedule(() => poll(), t.pollMs)
  return {
    stop: () => { stopped = true; for (const c of cancelFns) c() },
  }
}
