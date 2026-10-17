// Always-on client console/error capture ring.
//
// Installed once at boot (src/main.tsx, BEFORE installGlobalErrorCapture and
// gated on import.meta.env.DEV — a production bundle retains no ring) so the
// capture layer's own console.error output is recorded too. Wraps the six
// console methods below — recording a formatted entry into a bounded ring,
// then passing the call through UNCHANGED to the original method — while
// `error-capture.recordCrash` lands in the same ring through the captured
// console.error passthrough (no explicit funnel: that would double-record).
//
// Cost discipline: the ring only does work when console.* is actually called;
// formatting is shallow (per-arg string capped at CONSOLE_ARG_CAP, whole entry
// capped at CONSOLE_ENTRY_CAP, mirroring server RING_LINE_MAX) and each arg is
// formatted inside its own try/catch so a hostile arg can never break the
// app's own logging. Read-side is the `console_read` client-debug op: filters
// mirror server/log.ts readLogRing (level = minimum severity, grep =
// case-insensitive over the joined args, since = ts >=, limit = newest N).
//
// Multi-tab note: each tab owns its ring and the rings DIVERGE (one tab's
// crash is invisible to the others); the host broker's first-answer-wins
// semantics decide which tab's buffer a tool call sees.

import {
  CONSOLE_ARG_CAP,
  CONSOLE_ARGS_CAP,
  CONSOLE_ENTRY_CAP,
  CONSOLE_RING_CAP,
  CONSOLE_LEVELS,
  type ConsoleEntry,
  type ConsoleLevel,
  type ConsoleReadParams,
  type ConsoleReadResult,
} from '../../shared/client-debug.js'
// Shared truncation helper (ANSI-aware, ellipsis-suffixed) — one implementation
// across the client instead of a third local copy.
import { truncate } from '../utils/text'

// --- ring ---------------------------------------------------------------------

let entries: ConsoleEntry[] = []
let dropped = 0
let nextSeq = 1
let captureEnabled = false

/** Severity lookup — index into the shared ASCENDING-severity vocabulary, so
 *  "at least this severe" is `indexOf(entry) >= indexOf(query)`. */
const severityOf = (level: ConsoleLevel): number => CONSOLE_LEVELS.indexOf(level)

/** Record one already-leveled entry. Shared by the console hooks; per-arg
 *  (CONSOLE_ARG_CAP) and per-call (CONSOLE_ARGS_CAP) caps bound each
 *  argument, and the JOINED entry (join separators budgeted) is additionally
 *  capped at CONSOLE_ENTRY_CAP — mirroring server/log.ts's per-line
 *  RING_LINE_MAX — by dropping args once the budget is spent (the arg that
 *  crosses it is truncated with an ellipsis, later args are dropped). An
 *  optional `stack` (console.trace) is capped separately and stored OUT of
 *  args, so it neither enters the budget nor the grep surface. */
export function recordConsoleEntry(level: ConsoleLevel, args: unknown[], stack?: string): void {
  const formatted: string[] = []
  let budget = CONSOLE_ENTRY_CAP
  for (const arg of args.slice(0, CONSOLE_ARGS_CAP)) {
    const s = formatConsoleArg(arg)
    const sep = formatted.length > 0 ? 1 : 0 // reserved for the join separator
    if (s.length + sep > budget) {
      if (budget > sep) formatted.push(s.slice(0, budget - sep - 1) + '…')
      break
    }
    formatted.push(s)
    budget -= s.length + sep
  }
  entries.push({
    seq: nextSeq++,
    ts: Date.now(),
    level,
    args: formatted,
    ...(stack !== undefined ? { stack: truncate(stack, CONSOLE_ARG_CAP) } : {}),
  })
  if (entries.length > CONSOLE_RING_CAP) {
    entries.shift()
    dropped++
  }
}

// --- formatting ------------------------------------------------------------------

function formatConsoleArg(v: unknown): string {
  if (typeof v === 'string') return truncate(v, CONSOLE_ARG_CAP)
  if (typeof v === 'bigint') return v.toString() + 'n'
  if (typeof v === 'number' || typeof v === 'boolean' || v === undefined || v === null) return String(v)
  if (typeof v === 'symbol') return v.toString()
  if (typeof v === 'function') return `[Function ${(v as { name?: string }).name || 'anonymous'}]`
  if (v instanceof Error) return truncate(v.stack ?? `${v.name}: ${v.message}`, CONSOLE_ARG_CAP)
  try {
    return truncate(JSON.stringify(v) ?? String(v), CONSOLE_ARG_CAP)
  } catch {
    // Circular structure, throwing getter, … — the app's log call must still
    // go through, so degrade to a descriptive placeholder.
    return Object.prototype.toString.call(v)
  }
}

// --- capture hooks ---------------------------------------------------------------

type PatchedMethod = 'debug' | 'info' | 'log' | 'warn' | 'error' | 'trace'
type ConsoleFn = (...args: unknown[]) => void

const PATCHED_METHODS: readonly PatchedMethod[] = ['debug', 'info', 'log', 'warn', 'error', 'trace']
const LEVEL_OF_METHOD: Record<PatchedMethod, ConsoleLevel> = {
  debug: 'debug',
  info: 'info',
  log: 'info',
  warn: 'warn',
  error: 'error',
  trace: 'debug',
}

/** console.trace prints the caller stack; the browser does NOT pass it as an
 *  argument. Synthesize it from a fresh Error and drop the capture module's
 *  own frames (matched by module name — worst case in a bundled build two
 *  wrapper lines leak in, harmless noise for a debug aid). */
function traceStack(): string {
  const lines = (new Error().stack ?? '').split('\n').filter((l) => !l.includes('console-buffer'))
  return lines.join('\n')
}

let originals: Partial<Record<PatchedMethod, ConsoleFn>> = {}
let installed = false

/** True while a passthrough call is in flight. Some environments implement
 *  one console method on top of another (happy-dom's trace prints via
 *  console.error) — the nested call is console-internal output, not an app
 *  log, and must not be captured twice. Native browser methods never
 *  re-enter, so the guard is a no-op there. */
let inPassthrough = false

/** Patch the console methods. Idempotent — a second call is a no-op, so HMR
 *  or a re-invoked boot path can never double-wrap (which would double-record). */
export function installConsoleCapture(): void {
  if (installed) return
  installed = true
  captureEnabled = true
  for (const method of PATCHED_METHODS) {
    const original = console[method] as ConsoleFn
    originals[method] = original
    const level = LEVEL_OF_METHOD[method]
    console[method] = (...args: unknown[]) => {
      try {
        if (!inPassthrough) {
          if (method === 'trace') recordConsoleEntry(level, args, traceStack())
          else recordConsoleEntry(level, args)
        }
      } catch {
        // The ring must never break the app's own logging.
      }
      inPassthrough = true
      try {
        original.apply(console, args)
      } finally {
        inPassthrough = false
      }
    }
  }
}

// --- read side ------------------------------------------------------------------

/** Mirror of server/log.ts `readLogRing`: filters AND together, `level` is a
 *  minimum-severity bound, `limit` keeps the NEWEST N. Entries are oldest
 *  first; `total` is the pre-filter ring size, `dropped` counts entries
 *  evicted by the ring cap since install, and `captureEnabled` reports
 *  whether this tab has the ring installed at all (false = production
 *  bundle — empty results are then honest, not a signal that nothing was
 *  logged). */
export function readConsoleBuffer(params: ConsoleReadParams): ConsoleReadResult {
  const { level, grep, since, limit } = params
  const needle = grep?.toLowerCase()
  let matched = entries.filter(
    (e) =>
      (level === undefined || severityOf(e.level) >= severityOf(level)) &&
      (since === undefined || e.ts >= since) &&
      (needle === undefined || e.args.join(' ').toLowerCase().includes(needle)),
  )
  if (limit !== undefined && matched.length > limit) matched = matched.slice(matched.length - limit)
  return { entries: matched, total: entries.length, dropped, captureEnabled }
}

// --- test reset -------------------------------------------------------------------

/** Restore the pristine console and clear the ring (test isolation only). */
export function resetConsoleForTests(): void {
  if (installed) {
    for (const method of PATCHED_METHODS) {
      const original = originals[method]
      if (original) console[method] = original
    }
  }
  originals = {}
  installed = false
  captureEnabled = false
  entries = []
  dropped = 0
  nextSeq = 1
}
