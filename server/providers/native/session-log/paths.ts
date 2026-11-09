// server/providers/native/session-log/paths.ts
//
// State-dir and file layout for native session logs:
//   <stateDir>/native-sessions/<id>/session.v1.jsonl
//
// The version segment lives in the file name so a future format bump can
// coexist with existing logs instead of guessing at their shape.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSafeSessionId } from '../../../history-reader.js'
import { DEFAULT_DIR_NAME } from '../../../json-file-store.js'

const NATIVE_SESSIONS_DIR = 'native-sessions'
const SESSION_LOG_FILE = 'session.v1.jsonl'

export function resolveNativeStateDir(stateDir?: string): string {
  return stateDir ?? join(homedir(), DEFAULT_DIR_NAME)
}

export function nativeSessionDir(stateDir: string, id: string): string {
  if (!isSafeSessionId(id)) throw new Error(`Invalid session id: ${id}`)
  return join(stateDir, NATIVE_SESSIONS_DIR, id)
}

export function nativeSessionLogPath(stateDir: string, id: string): string {
  return join(nativeSessionDir(stateDir, id), SESSION_LOG_FILE)
}