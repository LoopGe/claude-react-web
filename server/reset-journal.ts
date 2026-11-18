// Per-session persisted reset journal (spec §8.3). Records the durable
// clearEpoch / rebaseEpoch counters and the latest generation reset's
// prepared/committed state, so a clear / native in-place compact can be
// committed two-phase (prepare BEFORE the provider op; commit AFTER the reset
// batch is fsynced) and recovered across a crash.
//
// One JSON object per session at <stateDir>/reset-journals/<id>.json, written
// with writeAtomic (tmp + rename). Unlike the array sidecars, write failures
// PROPAGATE: a reset journal that silently lost a prepare/commit would break
// the two-phase publication marker, so persist() rejects and the caller fails
// closed rather than publishing an unjournalled reset.
//
// Recovery (spec §8.3):
//   prepared + no provider floor  → undo prepared, keep the old projection
//   prepared + provider floor     → complete the interrupted reset (commit)
//   committed  + provider floor   → committed-ok (nothing to do)
//   committed  + no provider floor→ journal-inconsistent (fail closed)
//
// `providerFloorExists` abstracts the provider-side evidence (a compact floor
// for compact; a fresh init / empty floor for clear) so this module stays free
// of provider coupling. The journal covers ONLY same-id in-band clear / native
// in-place compact — app /clear (X→fresh Y) writes no journal on X.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('reset-journal')

export type ResetReason = 'clear' | 'compact' | 'recovery'

export interface ResetJournalEntry {
  generation: number
  reason: ResetReason
  /** Compact seed floor uuid (compact only); the boundary the reset projects from. */
  seedBoundaryUuid?: string
  state: 'prepared' | 'committed'
}

interface JournalState {
  clearEpoch: number
  rebaseEpoch: number
  latest: ResetJournalEntry | null
}

export type RecoverOutcome = 'undone' | 'completed' | 'committed-ok' | 'journal-inconsistent'

export class ResetJournal {
  private state: JournalState = { clearEpoch: 0, rebaseEpoch: 0, latest: null }
  /** Serializes persists per instance; the tail never rejects so a failed
   *  write does not wedge later ones (the error still propagates to its caller). */
  private chain: Promise<void> = Promise.resolve()
  /** Resolves when the on-disk state has loaded. Async ops await it; callers
   *  reading the sync getters on a fresh instance must await it first. */
  readonly ready: Promise<void>

  constructor(
    private readonly dir: string | undefined,
    private readonly id: string,
  ) {
    this.ready = this.load()
  }

  get clearEpoch(): number {
    return this.state.clearEpoch
  }
  get rebaseEpoch(): number {
    return this.state.rebaseEpoch
  }
  get latest(): ResetJournalEntry | null {
    return this.state.latest
  }

  private file(): string {
    return join(this.dir!, `${this.id}.json`)
  }

  private async load(): Promise<void> {
    if (!this.dir) return
    try {
      const parsed = JSON.parse(await readFile(this.file(), 'utf8')) as Partial<JournalState>
      if (parsed && typeof parsed === 'object') {
        this.state = {
          clearEpoch: typeof parsed.clearEpoch === 'number' ? parsed.clearEpoch : 0,
          rebaseEpoch: typeof parsed.rebaseEpoch === 'number' ? parsed.rebaseEpoch : 0,
          latest: parsed.latest ?? null,
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`[${this.id}] load failed: ${(err as Error).message ?? err}`)
        throw err
      }
    }
  }

  private persist(): Promise<void> {
    if (!this.dir) return Promise.resolve()
    const snapshot: JournalState = {
      clearEpoch: this.state.clearEpoch,
      rebaseEpoch: this.state.rebaseEpoch,
      latest: this.state.latest ? { ...this.state.latest } : null,
    }
    const run = this.chain.then(() => writeAtomic(this.dir!, this.file(), snapshot))
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Record a prepared reset BEFORE the provider op. Overwrites any prior
   *  latest entry (epochs accumulate across resets). */
  async prepare(entry: { generation: number; reason: ResetReason; seedBoundaryUuid?: string }): Promise<void> {
    await this.ready
    this.state.latest = { ...entry, state: 'prepared' }
    await this.persist()
  }

  /** Mark the prepared reset committed AFTER its reset batch is fsynced, and
   *  advance the matching epoch (clear/compact → clearEpoch; recovery →
   *  rebaseEpoch). Throws without a matching prepared entry. */
  async commit(generation: number): Promise<void> {
    await this.ready
    const latest = this.state.latest
    if (!latest || latest.state !== 'prepared') {
      throw new Error('reset-journal: commit without a prepared entry')
    }
    if (latest.generation !== generation) {
      throw new Error('reset-journal: commit generation mismatch')
    }
    latest.state = 'committed'
    this.bumpEpoch(latest.reason)
    await this.persist()
  }

  /** Drop a prepared (uncommitted) entry without advancing epochs. */
  async undoPrepared(): Promise<void> {
    await this.ready
    if (this.state.latest?.state === 'prepared') this.state.latest = null
    await this.persist()
  }

  /** Crash recovery against provider-side evidence (spec §8.3). */
  async recover(providerFloorExists: (generation: number) => boolean): Promise<RecoverOutcome> {
    await this.ready
    const latest = this.state.latest
    if (!latest) return 'committed-ok'
    if (latest.state === 'prepared') {
      if (providerFloorExists(latest.generation)) {
        latest.state = 'committed'
        this.bumpEpoch(latest.reason)
        await this.persist()
        return 'completed'
      }
      this.state.latest = null
      await this.persist()
      return 'undone'
    }
    // committed: requires provider evidence, else the journal is inconsistent.
    if (!providerFloorExists(latest.generation)) return 'journal-inconsistent'
    return 'committed-ok'
  }

  private bumpEpoch(reason: ResetReason): void {
    if (reason === 'clear' || reason === 'compact') this.state.clearEpoch++
    else this.state.rebaseEpoch++
  }
}