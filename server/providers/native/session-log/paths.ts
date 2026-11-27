// server/providers/native/session-log/paths.ts
//
// State-dir and file layout for native session logs:
//   <stateDir>/native-sessions/<id>/session.v1.jsonl
//
// `header.v` is the actual format version. The v1 filename is only a stable
// storage key, retained so migration never creates a second log of truth.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_DIR_NAME, isSafeSessionId } from '../../../../shared/transcript-format.js'

const NATIVE_SESSIONS_DIR = 'native-sessions'
const SESSION_LOG_FILE = 'session.v1.jsonl'

export function resolveNativeStateDir(stateDir?: string): string {
  return stateDir ?? join(homedir(), DEFAULT_DIR_NAME)
}

/** The native session-log tree root — the dream consolidation's read-only
 *  source material. Shared by the log path helpers, the dream run's read root
 *  and the broker's memory-root read exemption so the three never drift. */
export function nativeSessionsDir(stateDir: string): string {
  return join(stateDir, NATIVE_SESSIONS_DIR)
}

export function nativeSessionDir(stateDir: string, id: string): string {
  if (!isSafeSessionId(id)) throw new Error(`Invalid session id: ${id}`)
  return join(nativeSessionsDir(stateDir), id)
}

export function nativeSessionLogPath(stateDir: string, id: string): string {
  return join(nativeSessionDir(stateDir, id), SESSION_LOG_FILE)
}

export function nativeSessionMigrationTempPath(stateDir: string, id: string): string {
  return `${nativeSessionLogPath(stateDir, id)}.migrating`
}