// Lightweight scoped logger with level filtering.
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
}

export function createLogger(scope: string): Logger {
  const tag = `[${scope}]`
  return {
    error: (...args) => { if (passes(scope, 'error')) console.error(tag, ...args) },
    warn:  (...args) => { if (passes(scope, 'warn'))  console.warn(tag, ...args) },
    info:  (...args) => { if (passes(scope, 'info'))  console.log(tag, ...args) },
    debug: (...args) => { if (passes(scope, 'debug')) console.log(tag, ...args) },
    trace: (...args) => { if (passes(scope, 'trace')) console.log(tag, ...args) },
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
