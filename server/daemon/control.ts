// The daemon↔server control protocol is FILES ONLY (no sockets): one atomic
// status.json heartbeat written by the daemon, plus three one-byte marker
// files any party can drop. Everything derives from <stateDir>/daemon/.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../json-file-store.js'

export type DaemonState = 'starting' | 'running' | 'backoff' | 'stopped' | 'failed'

export interface DaemonStatusFile {
  daemonPid: number
  childPid: number | null
  state: DaemonState
  startedAt: number
  childStartedAt: number | null
  restartCount: number
  consecutiveFailures: number
  lastError: string | null
  lastExitReason: string | null
  updatedAt: number
}

export const HEARTBEAT_INTERVAL_MS = 2_000
export const HEARTBEAT_FRESH_MS = 10_000

export function daemonDirOf(stateDir: string): string { return join(stateDir, 'daemon') }
export function statusPathOf(stateDir: string): string { return join(daemonDirOf(stateDir), 'status.json') }
export function markerPathOf(stateDir: string, which: 'stop' | 'restart' | 'start'): string {
  return join(daemonDirOf(stateDir), `${which}-requested`)
}
export const stopRequestPathOf = (stateDir: string) => markerPathOf(stateDir, 'stop')
export const restartRequestPathOf = (stateDir: string) => markerPathOf(stateDir, 'restart')
export const startRequestPathOf = (stateDir: string) => markerPathOf(stateDir, 'start')

export async function writeStatusFile(stateDir: string, status: DaemonStatusFile): Promise<void> {
  await writeAtomic(daemonDirOf(stateDir), statusPathOf(stateDir), status)
}

export async function readStatusFile(stateDir: string): Promise<DaemonStatusFile | null> {
  try {
    const raw = await fs.readFile(statusPathOf(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as DaemonStatusFile
    if (typeof parsed?.daemonPid !== 'number' || typeof parsed?.state !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function isStatusFresh(status: DaemonStatusFile | null, now = Date.now()): boolean {
  if (!status) return false
  return now - status.updatedAt < HEARTBEAT_FRESH_MS
}

export async function writeMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<void> {
  await fs.mkdir(daemonDirOf(stateDir), { recursive: true })
  await fs.writeFile(markerPathOf(stateDir, which), '1', 'utf8')
}

export async function readMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<boolean> {
  try {
    await fs.access(markerPathOf(stateDir, which))
    return true
  } catch {
    return false
  }
}

export async function clearMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<void> {
  await fs.rm(markerPathOf(stateDir, which), { force: true })
}
