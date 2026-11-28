// Durable death reporting for the server process.
//
// Every exit path used to print to the terminal only: signals via console.log,
// uncaught exceptions via Node's default stderr dump, boot fatals via
// console.error. Once the dev terminal scrolled past (or the tab closed), a
// death left NO trace anywhere — the file log showed the process simply stop,
// indistinguishable from an external kill. That made the recurring "WS keeps
// failing to reconnect" outages undiagnosable after the fact: the backend was
// provably down, but nothing recorded WHY.
//
// Death records are independent of the logger BY CONSTRUCTION:
//  - The install captures the state dir, so records land in the same daily
//    `logs/server-YYYY-MM-DD.log` whether or not opt-in file logging is on,
//    and even after shutdown's disableFileLogging() destroyed the stream.
//    A death is exactly when the record must not depend on the logger's
//    level/scope filters or its async WriteStream (process.exit() drops
//    pending stream writes — reporting failures needs an independent fallback).
//  - Every write is a SYNCHRONOUS append, so it survives process.exit().
//  - Crash semantics are preserved: report, then exit non-zero. An uncaught
//    exception leaves state undefined — logging alone is not recovery, and
//    continuing would mask the defect.
//
// The diagnostic decision tree a death leaves behind:
//   fatal record + exit code=1  → JS crash (uncaughtException / unhandledRejection / boot fatal)
//   signal record + exit code=0 → graceful shutdown (SIGINT / SIGTERM / SIGHUP / daemon-stop)
//   exit code=0 alone           → natural event-loop drain (no signal, no error)
//   NO record                   → external kill / hard native abort (no handlers run)
//
// cli.ts installs this once at server boot, before loadConfig so even a
// config-load crash is recorded.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { formatArg, formatFileLine, pruneOldLogs, serverLogFileName, todayKey } from './log.js'

/** Captured at install; null until then (a pre-install fatal still prints to
 *  the terminal, which is all that exists that early). */
let deathDir: string | null = null

/** Append one `[ts] [cli] msg` line (log.ts's file shape) synchronously.
 *  Creates the logs dir on demand — a default install's first death may be
 *  the first thing ever written under stateDir/logs. A failing append reports
 *  to the terminal (the one channel that always works) and never throws over
 *  the death it is reporting. */
function appendRecord(msg: string): void {
  if (!deathDir) return
  try {
    const dir = joinPath(deathDir, 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(joinPath(dir, serverLogFileName(todayKey())), formatFileLine('[cli]', msg))
    // Death records share the logger's retention-managed directory even when
    // opt-in file logging is off (openStream never runs to prune) — honor the
    // same cap here so a crash-looping default install cannot accumulate files.
    pruneOldLogs(dir)
  } catch (err) {
    console.error('[cli] could not write death record:', err)
  }
}

/** Print a fatal condition to the terminal AND record it durably. Bare
 *  console.error is the documented process-death exception to the logger rule
 *  (see CLAUDE.md Logging): the process is dying, and the report must not ride
 *  the logger's filtered async path. */
export function reportFatal(kind: string, err: unknown): void {
  console.error(`[cli] ${kind}:`, err)
  // formatArg handles Error→stack, string→verbatim, object→JSON; the outer
  // guard keeps a pathological reason (e.g. a circular null-prototype object)
  // from throwing inside the death handler itself.
  let msg: string
  try {
    msg = formatArg(err)
  } catch {
    msg = '<unformattable>'
  }
  appendRecord(`${kind}: ${msg}`)
}

/** Record a graceful-shutdown signal synchronously. Called from cli.ts's
 *  shutdown() BEFORE disableFileLogging(), but correctness does not depend on
 *  that ordering — the record is independent of the log stream. */
export function recordShutdown(signal: string): void {
  appendRecord(`received ${signal}, shutting down`)
}

/** Arm the process-wide death reporters against `stateDir`. Call once. */
export function installFatalReporting(stateDir: string): void {
  deathDir = stateDir
  process.on('uncaughtException', (err) => {
    reportFatal('uncaughtException', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    reportFatal('unhandledRejection', reason)
    process.exit(1)
  })
  process.on('exit', (code) => {
    appendRecord(`process exit code=${code}`)
  })
}
