// Sidecar store of a session's result frames — the SDK does NOT persist
// `result` messages to the on-disk transcript JSONL, so without this sidecar
// a resumed/dormant session loses the per-turn result summaries (cost /
// duration / turns / usage) that the client renders. The pump records each
// result frame here (keyed by the assistant message it follows), and
// resume()/discard() merge them back into the history seed at the correct
// position (right after the matching assistant frame).
//
// One JSON file per session under <stateDir>/result-frames/<id>.json. Kept
// out of sessions.json (same rationale as prompt-uuid-store / turn-anchor-
// store: sessions.json is rewritten on every send and shipped to the
// frontend). Sidecar is small, per-session, server-only.

import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** One entry per result frame, in completion order.
 *  - `resultUuid`: the result frame's own uuid (dedup key).
 *  - `assistantUuid`: the uuid of the turn's LAST main-thread assistant
 *    message — used to position the result in the seed (result goes right
 *    after this assistant frame).
 *  - `result`: the complete result frame (cost/duration/turns/usage). */
export interface ResultFrameEntry {
  resultUuid: string
  assistantUuid: string
  result: SDKMessage
}

/** Retain the newest `cap` entries, matching the in-memory history ring's
 *  window — older results correspond to assistant frames that have also
 *  scrolled out of the ring. */
export function retainResultFrameEntries(entries: ResultFrameEntry[], cap: number): ResultFrameEntry[] {
  return entries.slice(-cap)
}

export class ResultFrameStore {
  private readonly cap: number
  /** Per-session write chain + remove tombstone + cache, so two appends (or
   *  append + merge) for the same session can't race on writeAtomic's
   *  tmp+rename, and a delete can't be undone by a late append. */
  private readonly sidecar: PerSessionSidecar<ResultFrameEntry>
  constructor(stateDir: string | undefined, historyCap: number) {
    this.sidecar = new PerSessionSidecar({
      dir: stateDir ? join(stateDir, 'result-frames') : null,
      label: 'result-frames',
    })
    this.cap = historyCap
  }

  load(sessionId: string): Promise<ResultFrameEntry[] | null> {
    return this.sidecar.load(sessionId)
  }

  /** Append a result frame, dedup by resultUuid (a replayed result updates
   *  in place rather than duplicating), cap to the newest `cap` entries,
   *  and persist atomically. Fire-and-forget safe on the turn path. */
  async append(sessionId: string, entry: ResultFrameEntry): Promise<void> {
    await this.sidecar.update(sessionId, (prev) => {
      const existing = prev ?? []
      const idx = existing.findIndex((e) => e.resultUuid === entry.resultUuid)
      if (idx >= 0) {
        existing[idx] = entry
      } else {
        existing.push(entry)
      }
      return retainResultFrameEntries(existing, this.cap)
    })
  }

  /** Merge `entries` into the current sidecar (dedup by resultUuid), capped,
   *  persist atomically. Used by discard() to copy X's result frames to Y
   *  (truncated to the cut point). Preserves any frames a concurrent pump
   *  append wrote between the caller's load and this write. */
  async merge(sessionId: string, entries: ResultFrameEntry[]): Promise<void> {
    await this.sidecar.update(sessionId, (prev) => {
      const existing = prev ?? []
      const byUuid = new Map<string, ResultFrameEntry>()
      for (const e of existing) byUuid.set(e.resultUuid, e)
      for (const e of entries) byUuid.set(e.resultUuid, e)
      return retainResultFrameEntries(
        [...byUuid.values()].sort((a, b) => {
          // Sort by the result frame's timestamp if available, otherwise
          // keep insertion order (Map preserves it).
          const ats = (a.result as { timestamp?: string }).timestamp
          const bts = (b.result as { timestamp?: string }).timestamp
          const ta = typeof ats === 'string' ? Date.parse(ats) : 0
          const tb = typeof bts === 'string' ? Date.parse(bts) : 0
          return ta - tb
        }),
        this.cap,
      )
    })
  }

  async save(sessionId: string, entries: ResultFrameEntry[]): Promise<void> {
    const capped = retainResultFrameEntries(entries, this.cap)
    await this.sidecar.update(sessionId, () => capped)
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
