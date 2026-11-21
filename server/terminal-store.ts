// Durable screen persistence for the embedded terminal: one JSON file per
// session at <stateDir>/terminal-screens/<sessionId>.json, holding the
// serialized headless screen plus the terminal meta it reflects. A server
// restart kills the PTY but restores the output history from this file;
// explicit close and session delete remove it.
//
// Writes are trailing-debounced (TERMINAL_SCREEN_DEBOUNCE_MS after the last
// schedule, so an output burst costs one write) and atomic (tmp + rename):
// a crash mid-write leaves at most a stray tmp file, never a truncated
// canonical one. load() still guards corrupt JSON — the proven failure mode
// this store exists to survive — by treating it as absent with one warn.

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
  data: PersistedTerminal
  timer: NodeJS.Timeout
}

export class TerminalScreenStore {
  private readonly dir: string
  private readonly pending = new Map<string, PendingWrite>()

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'terminal-screens')
  }

  /** Trailing debounce: replaces any pending data for the session and
   *  restarts the window, so only the last screen of a burst is written. */
  schedule(sessionId: string, data: PersistedTerminal): void {
    this.cancelPending(sessionId)
    const timer = setTimeout(() => {
      this.pending.delete(sessionId)
      this.write(sessionId, data)
    }, TERMINAL_SCREEN_DEBOUNCE_MS)
    // A pending persistence write must not keep the process alive.
    timer.unref()
    this.pending.set(sessionId, { data, timer })
  }

  /** Cancel the timer and write the pending data synchronously (shell-exit
   *  and graceful-shutdown paths). No-op when nothing is pending. */
  flush(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    this.cancelPending(sessionId)
    this.write(sessionId, entry.data)
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
    this.cancelPending(sessionId)
    rmSync(this.fileFor(sessionId), { force: true })
  }

  private fileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`)
  }

  private cancelPending(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(sessionId)
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
