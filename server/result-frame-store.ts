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

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from './log.js'
import { writeAtomic } from './json-file-store.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const log = createLogger('result-frames')

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
  private readonly dir: string | null
  private readonly cap: number
  /** Serialises concurrent writes so two appends (or append + merge) for the
   *  same session can't race on writeAtomic's tmp+rename — mirrors
   *  TurnAnchorStore / JsonFileStore's `writing` chain. */
  private writing: Promise<void> = Promise.resolve()
  constructor(stateDir: string | undefined, historyCap: number) {
    this.dir = stateDir ? join(stateDir, 'result-frames') : null
    this.cap = historyCap
  }

  private file(sessionId: string): string | null {
    return this.dir ? join(this.dir, `${sessionId}.json`) : null
  }

  async load(sessionId: string): Promise<ResultFrameEntry[] | null> {
    const file = this.file(sessionId)
    if (!file) return null
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as ResultFrameEntry[]) : null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      log.warn(`load failed for ${sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  /** Append a result frame, dedup by resultUuid (a replayed result updates
   *  in place rather than duplicating), cap to the newest `cap` entries,
   *  and persist atomically. Fire-and-forget safe on the turn path. */
  async append(sessionId: string, entry: ResultFrameEntry): Promise<void> {
    this.writing = this.writing.then(async () => {
      const existing = (await this.load(sessionId)) ?? []
      const idx = existing.findIndex((e) => e.resultUuid === entry.resultUuid)
      if (idx >= 0) {
        existing[idx] = entry
      } else {
        existing.push(entry)
      }
      const capped = retainResultFrameEntries(existing, this.cap)
      await this.writeRaw(sessionId, capped)
    }).catch((err) => {
      log.warn(`append chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
  }

  /** Merge `entries` into the current sidecar (dedup by resultUuid), capped,
   *  persist atomically. Used by discard() to copy X's result frames to Y
   *  (truncated to the cut point). Preserves any frames a concurrent pump
   *  append wrote between the caller's load and this write. */
  async merge(sessionId: string, entries: ResultFrameEntry[]): Promise<void> {
    this.writing = this.writing.then(async () => {
      const existing = (await this.load(sessionId)) ?? []
      const byUuid = new Map<string, ResultFrameEntry>()
      for (const e of existing) byUuid.set(e.resultUuid, e)
      for (const e of entries) byUuid.set(e.resultUuid, e)
      const merged = retainResultFrameEntries(
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
      await this.writeRaw(sessionId, merged)
    }).catch((err) => {
      log.warn(`merge chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
  }

  async save(sessionId: string, entries: ResultFrameEntry[]): Promise<void> {
    const capped = retainResultFrameEntries(entries, this.cap)
    this.writing = this.writing.then(() => this.writeRaw(sessionId, capped)).catch((err) => {
      log.warn(`save chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
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

  private async writeRaw(sessionId: string, entries: ResultFrameEntry[]): Promise<void> {
    const file = this.file(sessionId)
    if (!file || !this.dir) return
    await writeAtomic(this.dir, file, entries)
  }
}
