// Durable screen persistence for the embedded terminal: one JSON file per
// session at <stateDir>/terminal-screens/<sessionId>.json, holding the
// serialized headless screen plus the terminal meta it reflects. A server
// restart kills the PTY but restores the output history from this file;
// explicit close and session delete remove it.
//
// Writes are trailing-debounced (TERMINAL_SCREEN_DEBOUNCE_MS after the last
// schedule, so an output burst costs one write) and atomic (tmp + rename):
// a crash mid-write leaves at most a stray tmp file, never a truncated
// canonical one. Debounced writes are best-effort: a failure is logged, never
// process-fatal; flush() surfaces write errors to its caller. load() guards
// corrupt JSON — the proven failure mode this store exists to survive — by
// treating it as absent with one warn.
//
// Lazy production (I3): schedule() takes a PRODUCER, not a finished payload.
// Serializing the headless screen is O(scrollback) (~4 ms at 120x30, ~41 ms
// at 500x200 — measured), and under sustained output the trailing debounce
// never fires, so an eager per-chunk serialize is computed and discarded on
// every chunk. The producer runs only when the debounce timer fires or
// flush() is called, reading the LIVE screen at that moment — one serialize
// per quiet window instead of one per chunk. The caller must cancel() the
// pending producer before releasing the generation it reads.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createLogger } from './log.js'
import { TERMINAL_SCREEN_DEBOUNCE_MS, type TerminalState } from '../shared/terminal.js'

const log = createLogger('terminal')

/** What survives a restart: the serialized screen, the meta it reflects,
 *  and when it was saved (epoch ms, stamped by the caller). */
export interface PersistedTerminal {
  screen: string
  state: TerminalState
  savedAt: number
}

interface PendingWrite {
  produce: () => PersistedTerminal
  timer: NodeJS.Timeout
}

export class TerminalScreenStore {
  private readonly dir: string
  private readonly pending = new Map<string, PendingWrite>()

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'terminal-screens')
  }

  /** Trailing debounce: replaces any pending producer for the session and
   *  restarts the window, so only the last screen of a burst is written.
   *  The producer runs at WRITE time (timer fire or flush), never here —
   *  the output path only marks the session dirty. */
  schedule(sessionId: string, produce: () => PersistedTerminal): void {
    this.cancel(sessionId)
    const timer = setTimeout(() => {
      this.pending.delete(sessionId)
      try {
        this.write(sessionId, produce())
      } catch (err) {
        // Best-effort persistence (the spec accepts the crash window): a
        // failed debounced write is logged loudly but must not crash the
        // process from a timer callback. flush() — caller-driven — still
        // throws to its caller.
        log.error(`[${sessionId}] screen persistence write failed: ${(err as Error).message}`)
      }
    }, TERMINAL_SCREEN_DEBOUNCE_MS)
    // A pending persistence write must not keep the process alive.
    timer.unref()
    this.pending.set(sessionId, { produce, timer })
  }

  /** Cancel the timer and produce + write the pending screen synchronously
   *  (shell-exit and graceful-shutdown paths). No-op when nothing is
   *  pending. The producer reads live state, so callers must flush BEFORE
   *  releasing the generation it serializes. */
  flush(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    this.cancel(sessionId)
    this.write(sessionId, entry.produce())
  }

  /** The persisted screen, or null when absent or corrupt. Corrupt JSON is
   *  the one proven failure mode (crash-truncated file): treat it as absent
   *  with one warn — restoring history must never crash a boot. */
  load(sessionId: string): PersistedTerminal | null {
    const file = this.fileFor(sessionId)
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    try {
      return JSON.parse(raw) as PersistedTerminal
    } catch (err) {
      log.warn(`[${sessionId}] corrupt persisted screen, treating as absent: ${(err as Error).message}`)
      return null
    }
  }

  /** Delete the file and cancel any pending write so it cannot resurrect. */
  remove(sessionId: string): void {
    this.cancel(sessionId)
    rmSync(this.fileFor(sessionId), { force: true })
  }

  /** Drop a pending producer WITHOUT writing. The producer reads live
   *  generation state, so a caller replacing that generation (a fresh
   *  spawn) must cancel first — a fired producer would serialize a
   *  disposed screen. */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(sessionId)
  }

  private fileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`)
  }

  /** Atomic full-replace: write a uniquely-named tmp file, then rename it
   *  over the canonical path. Random suffix so concurrent writes (even
   *  across stores sharing the directory) never collide on one tmp path —
   *  on Windows a second write to a locked tmp returns EPERM. */
  private write(sessionId: string, data: PersistedTerminal): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(sessionId)
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  }
}
