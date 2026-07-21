// Sidecar store of a session's recent top-level prompt uuids, used to bridge
// the uuid mismatch between the in-memory ring / client cache (server-minted
// `U`) and the on-disk SDK transcript (SDK `V`) for top-level user prompts.
// See `overlapAnchorUuid` / splitReplayAgainstCache in src/session-store/reducer.ts
// and the resume-seed rewrite in session-manager.ts.
//
// One JSON file per session under <stateDir>/prompt-uuids/<id>.json. Kept out
// of sessions.json on purpose: sessions.json is rewritten on every send and
// shipped to the frontend, so a per-prompt uuid list would bloat both. This
// sidecar is small, per-session, and server-only.
//
// DESIGN (echo-time pairing): an entry {u, v} is recorded only when the SDK
// echoes a top-level prompt — at which point both uuids are known and the
// echo's FIFO order unambiguously pairs the SDK uuid `v` with the server-minted
// `u` from the oldest still-unpaired send. The sidecar therefore NEVER contains
// a `u` whose `v` isn't also on disk (the SDK only echoes messages it has
// persisted), so the sidecar can never be "ahead" of disk. Resume rewrites the
// seed by an EXACT v→u lookup — no positional alignment, no content hash — so
// same-text prompts (which defeated the earlier positional+hash scheme) can no
// longer cause a shifted uuid assignment.

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from './log.js'
import { writeAtomic } from './json-file-store.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const log = createLogger('prompt-uuids')

/** One entry per top-level user prompt, in send order:
 *  - `u`: the server-minted uuid (minted at send(), used in the ring + client
 *    cache + broadcast).
 *  - `v`: the SDK's on-disk uuid for the same prompt, filled in when the SDK
 *    echoes the prompt back through the Query stream. Undefined until the echo
 *    lands (a prompt sent but not yet processed by the SDK).
 *
 *  Only entries with `v` set are useful to the resume-seed rewrite (they map a
 *  disk uuid to the server uuid). Entries with `v` undefined are in-flight
 *  (sent, not yet echoed) and are skipped at rewrite time. */
export interface PromptUuidEntry {
  u: string
  v?: string
}

/** Retain the newest completed mappings without dropping in-flight sends.
 *  Echoes may be delayed while a burst of queued prompts exceeds the normal
 *  history window; pruning unpaired entries would shift FIFO pairing and map
 *  later SDK uuids to the wrong server uuids. */
export function retainPromptUuidEntries(entries: PromptUuidEntry[], cap: number): PromptUuidEntry[] {
  const paired = entries.filter((entry) => entry.v != null)
  const retainedPaired = new Set(paired.slice(-cap))
  return entries.filter((entry) => entry.v == null || retainedPaired.has(entry))
}

export class PromptUuidStore {
  private readonly dir: string | null
  private readonly cap: number
  constructor(stateDir: string | undefined, historyCap: number) {
    // Tolerate an absent state dir (standalone buildApp / unit tests that
    // don't exercise resume-seed bridging): the store no-ops load/save/remove
    // rather than crashing path.join on `undefined`.
    this.dir = stateDir ? join(stateDir, 'prompt-uuids') : null
    this.cap = historyCap
  }

  private file(sessionId: string): string | null {
    return this.dir ? join(this.dir, `${sessionId}.json`) : null
  }

  async load(sessionId: string): Promise<PromptUuidEntry[] | null> {
    const file = this.file(sessionId)
    if (!file) return null
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PromptUuidEntry[]) : null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      log.warn(`load failed for ${sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  async save(sessionId: string, entries: PromptUuidEntry[]): Promise<void> {
    const file = this.file(sessionId)
    if (!file || !this.dir) return
    try {
      // Persist only the newest completed mappings. In-flight entries have no
      // SDK uuid yet and therefore cannot participate in resume rewriting; do
      // not persist them or let them affect the bounded sidecar window.
      const capped = retainPromptUuidEntries(entries, this.cap).filter((entry) => entry.v != null)
      await writeAtomic(this.dir, file, capped)
    } catch (err) {
      log.warn(`save failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
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

/** Rewrite the top-level user-prompt uuids in a resume `historySeed` from
 *  their on-disk SDK uuids (`v`) to the server-minted uuids (`u`) via an EXACT
 *  v→u lookup built from `promptUuids`.
 *
 *  Each seed prompt whose uuid (an SDK `v`) is present in the map gets its uuid
 *  rewritten to the paired server `u`. Seed prompts with no mapping (a prompt
 *  whose echo was never recorded — e.g. sent right before a crash, or an
 *  SDK-injected user frame like `<task-notification>` that was never "sent") are
 *  LEFT UNCHANGED; the client's signature fallback then handles their dedup.
 *
 *  Because the mapping is by exact uuid (not positional alignment + content
 *  hash), same-text prompts cannot cause a shifted assignment: each `v` maps to
 *  exactly one `u` or to nothing. Worst case is "no bridge for an unmapped
 *  prompt" (fall back), never "wrong uuid on the wrong prompt". Pure + exported
 *  for unit tests. Mutates and returns `seed` in place (a freshly read array). */
export function rewriteSeedPromptUuids(
  seed: SDKMessage[],
  promptUuids: PromptUuidEntry[] | undefined | null,
): SDKMessage[] {
  if (!promptUuids || promptUuids.length === 0) return seed
  // Build v -> u from paired entries only (v present). Unpaired entries
  // (sent, not yet echoed) carry no disk uuid and can't be looked up.
  const vToU = new Map<string, string>()
  for (const e of promptUuids) {
    if (e.v) vToU.set(e.v, e.u)
  }
  if (vToU.size === 0) return seed
  for (let k = 0; k < seed.length; k++) {
    const msg = seed[k]
    // Only top-level user prompts (the SDK's echo of our sent prompts) are
    // candidates. Other frames (assistant/system/tool_result-bearing user)
    // keep their own uuids.
    if (msg.type !== 'user') continue
    if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id != null) continue
    const v = typeof msg.uuid === 'string' ? msg.uuid : undefined
    if (!v) continue
    const u = vToU.get(v)
    if (u && u !== v) {
      seed[k] = { ...msg, uuid: u } as SDKMessage
    }
  }
  return seed
}
