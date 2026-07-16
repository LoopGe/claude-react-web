// Sidecar store of a session's recent top-level prompt uuids (server-minted),
// used to bridge the uuid mismatch between the in-memory ring / client cache
// (server-minted `U`) and the on-disk SDK transcript (SDK `V`) for top-level
// user prompts. See `overlapAnchorUuid` / splitReplayAgainstCache in
// src/session-store/reducer.ts and the resume-seed rewrite in
// session-manager.ts.
//
// One JSON file per session under <stateDir>/prompt-uuids/<id>.json. Kept out
// of sessions.json on purpose: sessions.json is rewritten on every send and
// shipped to the frontend, so a per-prompt uuid list would bloat both. This
// sidecar is small, per-session, and server-only.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log.js'
import { DEFAULT_DIR_NAME } from './json-file-store.js'
import { promptContentFingerprint, hashStr, type PromptFingerprintInput } from '../shared/prompt-fingerprint.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const log = createLogger('prompt-uuids')

/** One entry per top-level user prompt ever sent by this session, in send
 *  order: the server-minted uuid (`u`) + a short hash of the prompt's content
 *  fingerprint (`h`). The hash lets the resume-seed rewrite verify positional
 *  alignment without persisting full prompt text, and bail (fall back to the
 *  signature dedup) on any desync. */
export interface PromptUuidEntry {
  u: string
  h: string
}

export class PromptUuidStore {
  private readonly dir: string
  private readonly cap: number
  constructor(stateDir: string | undefined, historyCap: number) {
    this.dir = join(stateDir ?? join(homedir(), DEFAULT_DIR_NAME), 'prompt-uuids')
    this.cap = historyCap
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`)
  }

  async load(sessionId: string): Promise<PromptUuidEntry[] | null> {
    try {
      const raw = await readFile(this.file(sessionId), 'utf8')
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
    try {
      await mkdir(this.dir, { recursive: true })
      // Cap to the newest `cap`: the resume-seed window is the newest
      // historyCap messages, so the newest historyCap prompts cover every
      // prompt that could appear in the seed.
      const capped = entries.length > this.cap ? entries.slice(entries.length - this.cap) : entries
      await writeFile(this.file(sessionId), JSON.stringify(capped), 'utf8')
    } catch (err) {
      log.warn(`save failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
  }

  async remove(sessionId: string): Promise<void> {
    try {
      await unlink(this.file(sessionId))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.warn(`remove failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
  }
}

/** Rewrite the top-level user-prompt uuids in a resume `historySeed` from
 *  their on-disk SDK uuids (`V`) to the server-minted uuids (`U`) recorded in
 *  `promptUuids`.
 *
 *  Positional alignment: the seed is the newest historyCap renderable messages,
 *  so its top-level prompts are the newest N prompts — matching the LAST N
 *  entries of `promptUuids` (offset = promptUuids.length - N). PLUS a
 *  content-hash verify per pair: any desync (a send that minted U but the SDK
 *  never persisted, an SDK-injected user frame like `<task-notification>` that
 *  promptUuids doesn't have, ordering drift from compaction) makes a pair's
 *  hash mismatch and the WHOLE rewrite is aborted — the seed is returned
 *  unchanged and the client's signature fallback handles dedup instead.
 *
 *  This makes bridging SAFE: the worst case is "no bridge for this session"
 *  (fall back to the pre-bridge behavior), never "wrong uuid on the wrong
 *  prompt" (which could mis-detect overlap). Pure + exported for unit tests.
 *
 *  Mutates and returns `seed` in place when rewriting (the seed is a freshly
 *  read array, not shared state). */
export function rewriteSeedPromptUuids(
  seed: SDKMessage[],
  promptUuids: PromptUuidEntry[] | undefined | null,
): SDKMessage[] {
  if (!promptUuids || promptUuids.length === 0) return seed // nothing recorded → no bridge (old / fresh session)
  // Collect seed slots that are top-level prompts, with their content hashes.
  const slots: number[] = []
  const seedHashes: string[] = []
  for (let k = 0; k < seed.length; k++) {
    const fp = promptContentFingerprint(seed[k] as unknown as PromptFingerprintInput)
    if (fp != null) {
      slots.push(k)
      seedHashes.push(hashStr(fp))
    }
  }
  const n = slots.length
  if (n === 0) return seed
  const offset = promptUuids.length - n
  if (offset < 0) return seed // disk has fewer prompts than promptUuids recorded → desync, bail
  // Verify every pair's hash BEFORE mutating. Any mismatch → bail (fall back).
  for (let j = 0; j < n; j++) {
    if (promptUuids[offset + j].h !== seedHashes[j]) return seed
  }
  // All pairs align → rewrite the uuids (V → U) in place.
  for (let j = 0; j < n; j++) {
    const k = slots[j]
    const newUuid = promptUuids[offset + j].u
    if (seed[k].uuid !== newUuid) {
      seed[k] = { ...seed[k], uuid: newUuid } as SDKMessage
    }
  }
  return seed
}
