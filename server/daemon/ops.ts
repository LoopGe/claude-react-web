// Shared daemon operations for BOTH surfaces: the /api/daemon REST routes and
// the `claude-react-web daemon` CLI group. The ordering rules live here once:
// enable = register FIRST, config write AFTER (a failed registration must not
// leave config claiming auto-start); disable = unregister FIRST, then clear.
// Platform command errors bubble up raw — no wrapping, no fallbacks.
import { spawn } from 'node:child_process'
import { config, updateConfigFile } from '../config.js'
import { HttpError } from '../errors.js'
import { resolveDaemonEntryPaths } from './paths.js'
import { execRunner } from './register/runner.js'
import type { CommandRunner } from './register/types.js'
import { getPlatformRegister } from './register/index.js'
import { readStatusFile, isStatusFresh, writeMarker, type DaemonState } from './control.js'

export interface DaemonStatusSnapshot {
  supported: boolean
  supportReason?: string
  mechanism: 'schtasks' | 'launchd' | 'systemd'
  configEnabled: boolean
  osRegistered: boolean
  osTargetMissing: boolean
  drift: boolean
  daemonAlive: boolean
  isDaemonChild: boolean
  child: { state: DaemonState; uptimeSec: number; restartCount: number; lastError: string | null; lastExitReason: string | null } | null
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function snapshot(stateDir: string, runner: CommandRunner): Promise<DaemonStatusSnapshot> {
  const reg = getPlatformRegister()
  const support = await reg.isSupported(runner).catch((err: Error) => ({ supported: false, reason: err.message }))
  const q = support.supported
    ? await reg.query(resolveDaemonEntryPaths(), runner)
    : { registered: false, targetMissing: false }
  const status = await readStatusFile(stateDir)
  const configEnabled = config.autoStart === true
  const osBroken = !q.registered || q.targetMissing
  return {
    supported: support.supported,
    supportReason: support.reason,
    mechanism: reg.mechanism,
    configEnabled,
    osRegistered: q.registered,
    osTargetMissing: q.targetMissing,
    drift: configEnabled && osBroken,
    daemonAlive: isStatusFresh(status) && isAlive(status!.daemonPid),
    isDaemonChild: process.env.CRW_DAEMON_CHILD === '1',
    child: status == null ? null : {
      state: status.state,
      uptimeSec: status.childStartedAt == null ? 0 : Math.max(0, Math.floor((Date.now() - status.childStartedAt) / 1000)),
      restartCount: status.restartCount,
      lastError: status.lastError,
      lastExitReason: status.lastExitReason,
    },
  }
}

export async function daemonEnable(stateDir: string, runner: CommandRunner = execRunner): Promise<DaemonStatusSnapshot> {
  const reg = getPlatformRegister()
  const support = await reg.isSupported(runner).catch((err: Error) => ({ supported: false, reason: err.message }))
  if (!support.supported) throw new HttpError(400, `daemon auto-start is not supported here: ${support.reason ?? 'unknown reason'}`)
  await reg.register(resolveDaemonEntryPaths(), stateDir, runner)
  await updateConfigFile(stateDir, { autoStart: true })
  return snapshot(stateDir, runner)
}

export async function daemonDisable(stateDir: string, runner: CommandRunner = execRunner): Promise<DaemonStatusSnapshot> {
  const reg = getPlatformRegister()
  const support = await reg.isSupported(runner).catch((err: Error) => ({ supported: false, reason: err.message }))
  if (support.supported) await reg.unregister(resolveDaemonEntryPaths(), runner)
  await updateConfigFile(stateDir, { autoStart: false })
  return snapshot(stateDir, runner)
}

export async function daemonStatus(stateDir: string, runner: CommandRunner = execRunner): Promise<DaemonStatusSnapshot> {
  return snapshot(stateDir, runner)
}

/** Start request from either surface. Daemon alive + child stopped → the
 *  supervisor poll picks up the start marker; daemon alive + child running →
 *  a no-op (NEVER a marker — a stale one would resurrect the server after a
 *  later intentional stop); no daemon → detached spawn. */
export async function daemonRequestStart(stateDir: string): Promise<{ started: 'marker' | 'spawn' | 'already-running' }> {
  const status = await readStatusFile(stateDir)
  if (isStatusFresh(status)) {
    if (status!.state === 'stopped') {
      await writeMarker(stateDir, 'start')
      return { started: 'marker' }
    }
    return { started: 'already-running' }
  }
  await spawnDaemonDetached(stateDir)
  return { started: 'spawn' }
}

/** Start the daemon NOW as a detached, hidden process. Resolves once the OS
 *  actually spawned it; rejects with the raw spawn error (e.g. ENOENT) so
 *  callers surface it instead of leaking an unhandled exception. */
export function spawnDaemonDetached(stateDir: string): Promise<void> {
  const { nodePath, daemonEntry } = resolveDaemonEntryPaths()
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [daemonEntry, '--state-dir', stateDir], {
      detached: true,
      stdio: 'ignore',
      // The daemon process is NOT a daemon child itself — REMOVE the marker
      // instead of blanking it, so nothing downstream can misread '' as set.
      env: (() => { const e = { ...process.env }; delete e.CRW_DAEMON_CHILD; return e })(),
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** CLI-side stop: marker FIRST (so the supervisor treats the exit as
 *  intentional), then SIGTERM the recorded child. On Windows SIGTERM is a
 *  hard kill — the marker still guarantees "no restart".
 *  Guarded on a LIVE child: a marker written while nothing runs would be
 *  orphaned and later swallow the daemon's first real crash as "intentional". */
export async function daemonStopBySignal(stateDir: string): Promise<void> {
  const status = await readStatusFile(stateDir)
  if (status?.childPid == null || !isAlive(status.childPid)) return
  await writeMarker(stateDir, 'stop')
  try { process.kill(status.childPid, 'SIGTERM') } catch { /* already gone */ }
}

/** `daemon uninstall` semantics (spec §5/§6): stop the supervised server AND
 *  the daemon itself — otherwise the daemon lingers, holding the singleton
 *  and reporting alive until the next logout. */
export async function daemonStopAll(stateDir: string): Promise<void> {
  const status = await readStatusFile(stateDir)
  await daemonStopBySignal(stateDir)
  if (status != null && isAlive(status.daemonPid)) {
    try { process.kill(status.daemonPid, 'SIGTERM') } catch { /* already gone */ }
  }
}
