import { writeMarker } from './control.js'

export function isDaemonChild(): boolean {
  return process.env.CRW_DAEMON_CHILD === '1'
}

/** Markers are the daemon's restart-decision input. A manually-started server
 *  must never leave one behind: a stale stop marker would swallow the
 *  daemon's FIRST child exit as "user asked to stop". */
export async function requestStop(stateDir: string): Promise<void> {
  if (isDaemonChild()) await writeMarker(stateDir, 'stop')
}

export async function requestRestart(stateDir: string): Promise<void> {
  if (isDaemonChild()) await writeMarker(stateDir, 'restart')
}
