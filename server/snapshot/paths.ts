import { join } from 'node:path'

export function snapshotRoot(stateDir: string): string {
  return join(stateDir, 'snapshots')
}
export function odbDir(stateDir: string, sessionId: string): string {
  return join(snapshotRoot(stateDir), 'odb', sessionId)
}
export function metaFile(stateDir: string, sessionId: string): string {
  return join(snapshotRoot(stateDir), 'meta', `${sessionId}.json`)
}
