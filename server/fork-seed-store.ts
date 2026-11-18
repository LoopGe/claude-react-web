// Per-session fork pre-seed snapshot + spawn markers (spec §11). A fork's CLI
// copies the source transcript into the fork's OWN JSONL only when its
// subprocess starts (async after spawn). The pre-seed snapshot is the canonical
// fallback for a fork whose spawn never started; the spawn markers distinguish
// "log provably never created" from "log may have existed and was lost":
//
//   spawnStarted:false + missing log  → the CLI never copied → snapshot fallback
//   spawnStarted:true  + !targetLogObserved + missing log → cannot prove the log
//                                        was never created → source-lost
//   targetLogObserved:true + missing log → the log existed and is now lost →
//                                        source-lost
//
// One JSON object per fork at <stateDir>/fork-seeds/<id>.json (writeAtomic).
// The snapshot can be large (the inherited renderable transcript); it is a
// recovery fallback, so process-crash-safe atomic write suffices (the markers
// are re-derived from the provider log on the next reconcile).

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('fork-seed')

export interface ForkSeedState {
  /** The pre-seeded canonical projection (composed source entries), used as
   *  the fallback when the fork's target log was provably never created. */
  snapshot: unknown[]
  spawnStarted: boolean
  targetLogObserved: boolean
}

export class ForkSeedStore {
  private readonly dir: string | null
  constructor(stateDir: string | undefined) {
    this.dir = stateDir ? join(stateDir, 'fork-seeds') : null
  }

  private file(id: string): string {
    return join(this.dir!, `${id}.json`)
  }

  async load(id: string): Promise<ForkSeedState | null> {
    if (!this.dir) return null
    try {
      const parsed = JSON.parse(await readFile(this.file(id), 'utf8')) as Partial<ForkSeedState>
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.snapshot)) {
        return {
          snapshot: parsed.snapshot,
          spawnStarted: parsed.spawnStarted === true,
          targetLogObserved: parsed.targetLogObserved === true,
        }
      }
      return null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`[${id}] load failed: ${(err as Error).message ?? err}`)
      }
      return null
    }
  }

  /** Persist the pre-seed snapshot at fork creation (spawn not yet started). */
  async save(id: string, snapshot: unknown[]): Promise<void> {
    if (!this.dir) return
    const state: ForkSeedState = { snapshot, spawnStarted: false, targetLogObserved: false }
    await writeAtomic(this.dir, this.file(id), state)
  }

  /** Mark the fork's provider spawn started (BEFORE the CLI copies the log). */
  async markSpawnStarted(id: string): Promise<void> {
    if (!this.dir) return
    const current = (await this.load(id)) ?? { snapshot: [], spawnStarted: false, targetLogObserved: false }
    await writeAtomic(this.dir, this.file(id), { ...current, spawnStarted: true })
  }

  /** Mark the fork's target log confirmed present + readable (first reconcile
   *  that reads it). Once observed, a later missing log is source-lost. */
  async markTargetLogObserved(id: string): Promise<void> {
    if (!this.dir) return
    const current = await this.load(id)
    if (!current) return
    if (current.targetLogObserved) return
    await writeAtomic(this.dir, this.file(id), { ...current, targetLogObserved: true })
  }

  async remove(id: string): Promise<void> {
    if (!this.dir) return
    try {
      await unlink(this.file(id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}