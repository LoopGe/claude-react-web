// Embedded-terminal capability probe. node-pty is an optionalDependency: a
// host where it is absent (or its native prebuild fails to load) simply has no
// terminal, so every later terminal task gates on this one cached result
// instead of re-probing. The load is lazy (createRequire on first call) so
// importing this module never touches the native addon on a host that will
// never open a terminal.
import { createRequire } from 'node:module'
import { createLogger } from './log.js'

const log = createLogger('terminal')

export interface TerminalCapability {
  supported: boolean
  /** Short human-readable failure cause when unsupported. */
  reason?: string
}

let cached: TerminalCapability | undefined

/** Probe node-pty once and cache the result for the process lifetime. */
export function terminalCapability(): TerminalCapability {
  if (cached) return cached
  try {
    // API-contract guard: node-pty is optional, so its absence (or a broken
    // native load) is a real deployment state, not a bug to surface loudly.
    createRequire(import.meta.url)('node-pty')
    cached = { supported: true }
  } catch (err) {
    // First line only: a MODULE_NOT_FOUND message trails a multi-line require
    // stack, and `reason` is meant to be a short human-readable cause.
    const msg = err instanceof Error ? err.message : String(err)
    const reason = msg.split('\n')[0]
    log.warn(`node-pty unavailable; embedded terminal disabled: ${reason}`)
    cached = { supported: false, reason }
  }
  return cached
}
