// Lightweight scope logger with level filtering.
//
// Usage:
//   const log = createLogger('broker')
//   log.info('canUseTool fired', { tool, agentID })
//   log.debug('detailed trace', { ... })
//
// Configuration sources (highest priority first):
//   1. Runtime: setLogConfig({ level, scopes }) — exposed via REST so the
//      frontend can flip levels without restart.
//   2. Env vars at boot:
//        LOG_LEVEL=error|warn|info|debug|trace  (default: info)
//        LOG_SCOPES=broker,pump                 (default: all scopes)
//          When set, ONLY listed scopes emit at any level. Use '*' to match
//          everything explicitly. Useful for muting noisy scopes while
//          debugging one specific module.
//   3. Back-compat: legacy DEBUG_SESSION=1 raises the default to 'debug'.
//
// File logging (opt-in):
//   enableFileLogging(stateDir) — writes to <stateDir>/logs/server-YYYY-MM-DD.log
//   with daily rotation. Disable via disableFileLogging(). Persists via
//   config.json `logToFile: true`.
//
// `passes()` reads the current config on every call so runtime mutations
// take effect immediately for every subsequent log line.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace']

function parseLevel(v: string | undefined, fallback: LogLevel): LogLevel {
  if (!v) return fallback
  const k = v.toLowerCase()
  return k in LEVELS ? (k as LogLevel) : fallback
}

function parseScopes(v: string | undefined): ReadonlySet<string> | null {
  if (!v) return null
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? new Set(items) : null
}

const DEBUG_SESSION_FORCED =
  process.env.DEBUG_SESSION === '1' || process.env.DEBUG_SESSION === 'true'
const DEFAULT_LEVEL: LogLevel = DEBUG_SESSION_FORCED ? 'debug' : 'info'

/** True when the boot-time level/scopes came from an explicit env var (or
 *  the DEBUG_SESSION back-compat flag). When set, env wins over any value
 *  persisted in config.json — env is a per-launch override. config.ts reads
 *  these to decide whether to restore persisted log settings on boot. */
export const LOG_LEVEL_FROM_ENV =
  (typeof process.env.LOG_LEVEL === 'string' && process.env.LOG_LEVEL.trim() !== '') ||
  DEBUG_SESSION_FORCED
export const LOG_SCOPES_FROM_ENV =
  typeof process.env.LOG_SCOPES === 'string' && process.env.LOG_SCOPES.trim() !== ''

interface ResolvedConfig {
  level: LogLevel
  scopes: ReadonlySet<string> | null
}

const state: ResolvedConfig = {
  level: parseLevel(process.env.LOG_LEVEL, DEFAULT_LEVEL),
  scopes: parseScopes(process.env.LOG_SCOPES),
}

function scopeAllowed(scope: string): boolean {
  if (!state.scopes) return true
  return state.scopes.has(scope) || state.scopes.has('*')
}

function passes(scope: string, level: LogLevel): boolean {
  if (LEVELS[level] > LEVELS[state.level]) return false
  return scopeAllowed(scope)
}

export interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
  /** True iff a message at `level` would be emitted under the current config.
   *  Use to gate expensive argument construction (e.g. JSON.stringify of a
   *  large object) so it only runs when the level is actually enabled — the
   *  variadic log methods receive pre-built args and cannot defer the work. */
  enabled: (level: LogLevel) => boolean
}

export function createLogger(scope: string): Logger {
  const tag = `[${scope}]`
  function emit(level: LogLevel, consoleFn: (...a: unknown[]) => void, args: unknown[]) {
    if (!passes(scope, level)) return
    consoleFn(tag, ...args)
    writeToFile(tag, args)
  }
  return {
    error: (...args) => emit('error', console.error, args),
    warn:  (...args) => emit('warn',  console.warn,  args),
    info:  (...args) => emit('info',  console.log,   args),
    debug: (...args) => emit('debug', console.log,   args),
    trace: (...args) => emit('trace', console.log,   args),
    enabled: (level) => passes(scope, level),
  }
}

export interface LogConfigSnapshot {
  level: LogLevel
  /** null = no scope filter (all allowed). [] is treated the same on input. */
  scopes: string[] | null
}

/** Current config snapshot. JSON-friendly — used by the GET endpoint. */
export function getLogConfig(): LogConfigSnapshot {
  return {
    level: state.level,
    scopes: state.scopes ? Array.from(state.scopes) : null,
  }
}

/** Apply a partial update. Pass `scopes: null` to clear the scope filter
 *  (= allow all). Pass an empty array equivalently. Returns the new
 *  resolved snapshot so callers can echo it back. */
export function setLogConfig(update: { level?: LogLevel; scopes?: string[] | null }): LogConfigSnapshot {
  if (update.level && update.level in LEVELS) {
    state.level = update.level
  }
  if (update.scopes !== undefined) {
    if (update.scopes === null || update.scopes.length === 0) {
      state.scopes = null
    } else {
      const cleaned = update.scopes.map((s) => s.trim()).filter(Boolean)
      state.scopes = cleaned.length > 0 ? new Set(cleaned) : null
    }
  }
  return getLogConfig()
}

// ── File logging ──────────────────────────────────────────────────

import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs'
import { join as joinPath } from 'node:path'

let fileStream: WriteStream | null = null
let fileStreamDate = ''
let fileLoggingDir: string | null = null

/** Cached "YYYY-MM-DD" key + the UTC-day-boundary (epoch ms) it expires at.
 *  Recomputing the ISO string on every log line was a measurable hot-path
 *  cost; the boundary check is a single integer compare. */
let cachedDayKey = ''
let cachedDayKeyExpiresAt = 0

/** Maximum number of `server-YYYY-MM-DD.log` files to keep. Anything older
 *  than this on a rotation gets unlinked. Bounded so a long-running
 *  installation doesn't accumulate logs forever. */
const MAX_LOG_FILES = 14

function todayKey(): string {
  const now = Date.now()
  if (now < cachedDayKeyExpiresAt) return cachedDayKey
  const d = new Date(now)
  cachedDayKey = d.toISOString().slice(0, 10) // YYYY-MM-DD
  // Next UTC midnight in epoch ms.
  cachedDayKeyExpiresAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return cachedDayKey
}

function openStream(dir: string): void {
  const date = todayKey()
  const logDir = joinPath(dir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const filePath = joinPath(logDir, `server-${date}.log`)
  fileStream = createWriteStream(filePath, { flags: 'a' })
  fileStreamDate = date
  pruneOldLogs(logDir)
}

/** Drop the oldest `server-*.log` files past `MAX_LOG_FILES`. Failures are
 *  swallowed — log retention is best-effort and must never break logging. */
function pruneOldLogs(logDir: string): void {
  try {
    const files = readdirSync(logDir)
      .filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort() // ISO date prefix sorts lexicographically = chronologically
    const excess = files.length - MAX_LOG_FILES
    if (excess <= 0) return
    for (let i = 0; i < excess; i++) {
      try { unlinkSync(joinPath(logDir, files[i])) } catch { /* file gone — ignore */ }
    }
  } catch { /* readdir failed — ignore */ }
}

/** Enable file logging. Logs are written to `<stateDir>/logs/server-YYYY-MM-DD.log`. */
export function enableFileLogging(stateDir: string): void {
  if (fileStream) {
    // Already active — just update the dir in case it changed.
    fileLoggingDir = stateDir
    return
  }
  fileLoggingDir = stateDir
  openStream(stateDir)
}

/** Disable file logging and close the stream. */
export function disableFileLogging(): void {
  if (fileStream) {
    fileStream.end()
    fileStream = null
  }
  fileLoggingDir = null
  fileStreamDate = ''
}

/** Whether file logging is currently active. */
export function isFileLoggingEnabled(): boolean {
  return fileStream !== null
}

/** Current log file path (if enabled), or null. */
export function getLogFilePath(): string | null {
  if (!fileStream || !fileLoggingDir) return null
  return joinPath(fileLoggingDir, 'logs', `server-${fileStreamDate}.log`)
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  try { return JSON.stringify(arg) } catch { return String(arg) }
}

function writeToFile(tag: string, args: unknown[]): void {
  if (!fileStream || !fileLoggingDir) return
  // Daily rotation: check if the date has changed.
  const date = todayKey()
  if (date !== fileStreamDate) {
    fileStream.end()
    openStream(fileLoggingDir)
  }
  const ts = new Date().toISOString()
  const msg = args.map(formatArg).join(' ')
  fileStream!.write(`[${ts}] ${tag} ${msg}\n`)
}
