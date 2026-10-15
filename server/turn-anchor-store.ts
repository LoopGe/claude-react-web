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

import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'

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
  private readonly cap: number
  /** Per-session write chain + remove tombstone + cache. Serialising per
   *  session keeps two appends (or append + save) for the same session off
   *  `writeAtomic`'s tmp+rename at the same time — on Windows a rename onto
   *  a file mid-write returns EPERM. The pump fires recordTurnAnchor as
   *  fire-and-forget, so back-to-back success results (or a discard-time
   *  save racing an in-flight append) would otherwise collide. */
  private readonly sidecar: PerSessionSidecar<TurnAnchorEntry>
  constructor(stateDir: string | undefined, historyCap: number) {
    // Tolerate an absent state dir (standalone buildApp / unit tests that
    // don't exercise discard): the store no-ops load/save/remove rather
    // than crashing path.join on `undefined`.
    this.sidecar = new PerSessionSidecar({
      dir: stateDir ? join(stateDir, 'turn-anchors') : null,
      label: 'turn-anchors',
    })
    this.cap = historyCap
  }

  load(sessionId: string): Promise<TurnAnchorEntry[] | null> {
    return this.sidecar.load(sessionId)
  }

  /** Append a new turn anchor, dedup by assistantUuid (a re-promoted anchor
   *  for the same uuid updates completedAt rather than duplicating), cap to
   *  the newest `cap` entries, and persist atomically. Fire-and-forget safe:
   *  callers (the pump) don't await this on the turn path. The whole
   *  load→modify→write sequence runs in the session's chain so back-to-back
   *  appends can't race (one would otherwise read the pre-append state and
   *  clobber the other's entry on rename). */
  async append(sessionId: string, entry: TurnAnchorEntry): Promise<void> {
    await this.sidecar.update(sessionId, (prev) => {
      const existing = prev ?? []
      const idx = existing.findIndex((e) => e.assistantUuid === entry.assistantUuid)
      if (idx >= 0) {
        existing[idx] = entry
      } else {
        existing.push(entry)
      }
      return retainTurnAnchorEntries(existing, this.cap)
    })
  }

  async save(sessionId: string, entries: TurnAnchorEntry[]): Promise<void> {
    const capped = retainTurnAnchorEntries(entries, this.cap)
    await this.sidecar.update(sessionId, () => capped)
  }

  /** Merge `entries` into the current sidecar (dedup by assistantUuid,
   *  keeping the merged entry's completedAt), capped, persist atomically.
   *  Unlike `save` (which overwrites), this preserves any anchors a
   *  concurrent pump `append` wrote between the caller's load and this
   *  write — the backfill path loads the sidecar, finds it empty, reads
   *  the disk transcript, and merges; if the pump appended a new anchor
   *  in that window, `merge` keeps it instead of clobbering it. The whole
   *  load→merge→write runs inside the session's chain. */
  async merge(sessionId: string, entries: TurnAnchorEntry[]): Promise<void> {
    await this.sidecar.update(sessionId, (prev) => {
      const existing = prev ?? []
      const byUuid = new Map<string, TurnAnchorEntry>()
      // Insert existing first (so a concurrent append is preserved), then
      // overwrite/add from `entries` (backfilled values win on dedup since
      // they carry the disk-derived completedAt). Sort by completedAt so the
      // slice(0, anchorIdx+1) in discard() inherits a correctly-ordered
      // prefix even when existing (new) and entries (backfilled old) interleave.
      for (const e of existing) byUuid.set(e.assistantUuid, e)
      for (const e of entries) byUuid.set(e.assistantUuid, e)
      return retainTurnAnchorEntries(
        [...byUuid.values()].sort((a, b) => a.completedAt - b.completedAt),
        this.cap,
      )
    })
  }

  /** Delete the sidecar. Tombstones the id first, so an append still in
   *  flight (or fired after this) can't recreate the file. */
  remove(sessionId: string): Promise<void> {
    return this.sidecar.remove(sessionId)
  }

  /** Clear the remove() tombstone for a new session reusing `sessionId`. */
  revive(sessionId: string): void {
    this.sidecar.revive(sessionId)
  }
}
