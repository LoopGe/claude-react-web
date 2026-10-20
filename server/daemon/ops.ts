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

/** Start the daemon NOW as a detached, hidden process. The caller decides
 *  between this and the start-requested marker (routes: alive daemon →
 *  marker; CLI/routes with no daemon → detached spawn). */
export function spawnDaemonDetached(stateDir: string): void {
  const { nodePath, daemonEntry } = resolveDaemonEntryPaths()
  const child = spawn(nodePath, [daemonEntry, '--state-dir', stateDir], {
    detached: true,
    stdio: 'ignore',
    // The daemon process is NOT a daemon child itself — strip the marker so
    // an inherited CRW_DAEMON_CHILD from a daemon-spawned server can't leak.
    env: { ...process.env, CRW_DAEMON_CHILD: '' },
    windowsHide: true,
  })
  child.unref()
}

/** CLI-side stop: marker FIRST (so the supervisor treats the exit as
 *  intentional), then SIGTERM the recorded child. On Windows SIGTERM is a
 *  hard kill — the marker still guarantees "no restart". */
export async function daemonStopBySignal(stateDir: string): Promise<void> {
  await writeMarker(stateDir, 'stop')
  const status = await readStatusFile(stateDir)
  if (status?.childPid != null) {
    try { process.kill(status.childPid, 'SIGTERM') } catch { /* already gone */ }
  }
}
