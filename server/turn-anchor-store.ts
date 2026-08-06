// Sidecar store of a session's successfully-completed turn anchors — the
// uuid of the LAST main-thread assistant message of each turn whose
// `result` had `subtype === 'success'`. Used by the "discard messages from
// here onward" feature: the user right-clicks an assistant message and we
// fork the session with `resumeSessionAt = <that uuid>`, keeping
// everything up to and including it and dropping everything after.
//
// Why a sidecar (not derived from disk): the on-disk JSONL has NO `result`
// frames (history-reader drops them), so "which assistant message is the
// last of a successfully-completed turn" cannot be reconstructed from the
// transcript alone — it's a runtime fact observed by the pump when a
// success `result` lands. We persist that fact here so any historical
// success turn (not just the most recent `lastSafeResumeUuid`, which is
// in-memory only) can serve as a discard cut point.
//
// One JSON file per session under <stateDir>/turn-anchors/<id>.json, kept
// out of sessions.json (same rationale as prompt-uuid-store: sessions.json
// is rewritten on every send and shipped to the frontend, so a per-turn
// list would bloat both). Sidecar is small, per-session, server-only.
//
// Inclusive semantics: `resumeSessionAt` keeps the anchor message (SDK
// docs: "up to and including the message with this UUID"), so forking from
// a turn's last assistant frame preserves that entire turn and drops only
// LATER turns — no mid-turn cut, no orphaned tool_use/tool_result.

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from './log.js'
import { writeAtomic } from './json-file-store.js'

const log = createLogger('turn-anchors')

/** One entry per successfully-completed turn, in completion order. */
export interface TurnAnchorEntry {
  /** uuid of the LAST main-thread assistant message of the turn (the SDK's
   *  on-disk uuid — assistant uuids are NOT rewritten by the prompt-uuid
   *  bridge, only top-level user prompts are). This is the value passed to
   *  `resumeSessionAt` when discarding from this turn. */
  assistantUuid: string
  /** Epoch ms when the turn's success `result` landed. Used for ordering
   *  (oldest→newest) and for display in the discard confirmation. */
  completedAt: number
}

/** Retain the newest `cap` entries. Older turns' cut points have
 *  diminishing value (the user is unlikely to discard back to turn 3 of a
 *  500-turn session), and capping keeps the sidecar bounded alongside the
 *  in-memory history ring (also `historyCap`). */
export function retainTurnAnchorEntries(entries: TurnAnchorEntry[], cap: number): TurnAnchorEntry[] {
  return entries.slice(-cap)
}

export class TurnAnchorStore {
  private readonly dir: string | null
  private readonly cap: number
  /** Serialises concurrent writes so two appends (or append + save) for the
   *  same session can't race on `writeAtomic`'s tmp+rename — on Windows a
   *  rename onto a file mid-write returns EPERM. The pump fires
   *  recordTurnAnchor as fire-and-forget, so back-to-back success results
   *  (or a discard-time save racing an in-flight append) would otherwise
   *  collide. Mirrors JsonFileStore's `writing` chain pattern. */
  private writing: Promise<void> = Promise.resolve()
  constructor(stateDir: string | undefined, historyCap: number) {
    // Tolerate an absent state dir (standalone buildApp / unit tests that
    // don't exercise discard): the store no-ops load/save/remove rather
    // than crashing path.join on `undefined`.
    this.dir = stateDir ? join(stateDir, 'turn-anchors') : null
    this.cap = historyCap
  }

  private file(sessionId: string): string | null {
    return this.dir ? join(this.dir, `${sessionId}.json`) : null
  }

  async load(sessionId: string): Promise<TurnAnchorEntry[] | null> {
    const file = this.file(sessionId)
    if (!file) return null
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as TurnAnchorEntry[]) : null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      log.warn(`load failed for ${sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  /** Append a new turn anchor, dedup by assistantUuid (a re-promoted anchor
   *  for the same uuid updates completedAt rather than duplicating), cap to
   *  the newest `cap` entries, and persist atomically. Fire-and-forget safe:
   *  callers (the pump) don't await this on the turn path. The whole
   *  load→modify→write sequence is serialised per-store so back-to-back
   *  appends can't race (one would otherwise read the pre-append state and
   *  clobber the other's entry on rename). */
  async append(sessionId: string, entry: TurnAnchorEntry): Promise<void> {
    // Run load+modify+write inside the serialised chain so two concurrent
    // appends for the same session see each other's writes. The returned
    // promise resolves when THIS append's write lands; callers that don't
    // await (the pump) just don't wait, but the chain still orders them.
    this.writing = this.writing.then(async () => {
      const existing = (await this.load(sessionId)) ?? []
      const idx = existing.findIndex((e) => e.assistantUuid === entry.assistantUuid)
      if (idx >= 0) {
        existing[idx] = entry
      } else {
        existing.push(entry)
      }
      const capped = retainTurnAnchorEntries(existing, this.cap)
      await this.writeRaw(sessionId, capped)
    }).catch((err) => {
      // Swallow so a failed write doesn't break the chain for the next one.
      log.warn(`append chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
  }

  async save(sessionId: string, entries: TurnAnchorEntry[]): Promise<void> {
    const capped = retainTurnAnchorEntries(entries, this.cap)
    this.writing = this.writing.then(() => this.writeRaw(sessionId, capped)).catch((err) => {
      log.warn(`save chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
  }

  /** Merge `entries` into the current sidecar (dedup by assistantUuid,
   *  keeping the merged entry's completedAt), capped, persist atomically.
   *  Unlike `save` (which overwrites), this preserves any anchors a
   *  concurrent pump `append` wrote between the caller's load and this
   *  write — the backfill path loads the sidecar, finds it empty, reads
   *  the disk transcript, and merges; if the pump appended a new anchor
   *  in that window, `merge` keeps it instead of clobbering it. The whole
   *  load→merge→write runs inside the serialised `writing` chain. */
  async merge(sessionId: string, entries: TurnAnchorEntry[]): Promise<void> {
    this.writing = this.writing.then(async () => {
      const existing = (await this.load(sessionId)) ?? []
      const byUuid = new Map<string, TurnAnchorEntry>()
      // Insert existing first (so a concurrent append is preserved), then
      // overwrite/add from `entries` (backfilled values win on dedup since
      // they carry the disk-derived completedAt). Sort by completedAt so the
      // slice(0, anchorIdx+1) in discard() inherits a correctly-ordered
      // prefix even when existing (new) and entries (backfilled old) interleave.
      for (const e of existing) byUuid.set(e.assistantUuid, e)
      for (const e of entries) byUuid.set(e.assistantUuid, e)
      const merged = retainTurnAnchorEntries(
        [...byUuid.values()].sort((a, b) => a.completedAt - b.completedAt),
        this.cap,
      )
      await this.writeRaw(sessionId, merged)
    }).catch((err) => {
      log.warn(`merge chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
  }

  /** Raw write, no cap/retry — callers pass already-capped entries. Runs
   *  inside the serialised `writing` chain. */
  private async writeRaw(sessionId: string, entries: TurnAnchorEntry[]): Promise<void> {
    const file = this.file(sessionId)
    if (!file || !this.dir) return
    await writeAtomic(this.dir, file, entries)
  }

  async remove(sessionId: string): Promise<void> {
    const file = this.file(sessionId)
    if (!file) return
    try {
      await unlink(file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.warn(`remove failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
  }
}
