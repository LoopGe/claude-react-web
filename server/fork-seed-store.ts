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
// One JSON object per fork at <stateDir>/fork-seeds/<id>.json, written durably
// (writeAtomicDurable: fsync tmp + dir sync) — spawnStarted is written ONLY at
// fork time (not re-derived later), so a power loss dropping it would reopen
// the fail-open window; the marker class warrants the same durability as the
// reset journal. The snapshot can be large (the inherited renderable transcript).
//
// NOTE: the snapshot-fallback branch (spawnStarted:false) is DEFENSIVE-ONLY in
// production: spawn() persists meta after provider.createSession starts, so
// every visible fork already has spawnStarted:true durable. The fallback covers
// a fork whose meta never persisted (crash between save and mark) — an invisible
// session. The reachable, valuable half is the fail-closed source-lost verdict.

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomicDurable } from './json-file-store.js'

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

  /** null ONLY on verified absence (ENOENT) or absent stateDir. IO/parse/shape
   *  errors PROPAGATE (spec §7.1: app stores distinguish ok/missing/error; a
   *  swallowed error would read as "not a fork" → silent empty healthy
   *  transcript instead of degraded). ensureTranscriptReconciled's catch
   *  converts a throw to degraded. */
  async load(id: string): Promise<ForkSeedState | null> {
    if (!this.dir) return null
    let raw: string
    try {
      raw = await readFile(this.file(id), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = JSON.parse(raw) as Partial<ForkSeedState>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.snapshot)) {
      throw new Error(`corrupt-fork-seed: ${id}`)
    }
    return {
      snapshot: parsed.snapshot,
      spawnStarted: parsed.spawnStarted === true,
      targetLogObserved: parsed.targetLogObserved === true,
    }
  }

  /** Persist the pre-seed snapshot at fork creation (spawn not yet started). */
  async save(id: string, snapshot: unknown[]): Promise<void> {
    if (!this.dir) return
    const state: ForkSeedState = { snapshot, spawnStarted: false, targetLogObserved: false }
    await writeAtomicDurable(this.dir, this.file(id), state)
  }

  /** Mark the fork's provider spawn started (BEFORE the CLI copies the log). */
  async markSpawnStarted(id: string): Promise<void> {
    if (!this.dir) return
    const current = (await this.load(id)) ?? { snapshot: [], spawnStarted: false, targetLogObserved: false }
    await writeAtomicDurable(this.dir, this.file(id), { ...current, spawnStarted: true })
  }

  /** Mark the fork's target log confirmed present + readable (first reconcile
   *  that reads it). Once observed, a later missing log is source-lost. */
  async markTargetLogObserved(id: string): Promise<void> {
    if (!this.dir) return
    const current = await this.load(id)
    if (!current) return
    if (current.targetLogObserved) return
    await writeAtomicDurable(this.dir, this.file(id), { ...current, targetLogObserved: true })
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
