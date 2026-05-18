// Debug logging gate.
//
// The pump, pushable, and session-manager hot paths emit one log line
// per SDK message / pushable push / send event. Useful when chasing
// stuck-session bugs but a serious noise source in normal operation.
// These call sites use `debugLog` / `debugWarn` so they default off
// and can be re-enabled with DEBUG_SESSION=1.
//
// Errors and lifecycle events (spawn, pump ended, GC kicks) keep using
// plain `console.log` / `console.error` — they're rare and useful.

const enabled =
  process.env.DEBUG_SESSION === '1' ||
  process.env.DEBUG_SESSION === 'true'

export function debugLog(...args: unknown[]): void {
  if (enabled) console.log(...args)
}

export function debugWarn(...args: unknown[]): void {
  if (enabled) console.warn(...args)
}
