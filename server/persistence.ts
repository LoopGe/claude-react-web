// Session metadata persistence.
//
// The SDK itself writes full conversation history to ~/.claude/projects/;
// we only need to remember which sessions existed, their metadata, and
// whether they're resumable. On startup we load this list so dormant
// sessions can appear in the UI as "hibernated" — the user clicks to
// resume and we spin up a fresh Query with `options.resume = <id>`.
//
// Storage is a single JSON file in stateDir (default ~/.claude-react-web/).
// Writes are atomic (tmp + rename) and debounced so a burst of updates
// doesn't thrash the disk. We never block the API path on the write —
// callers fire-and-forget via upsert/remove; shutdown() flushes.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'

/** Metadata we need to resurrect a session. Deliberately a subset of
 *  Options — no auth tokens, no full SDK config. Everything here must
 *  be safe to ship to the frontend inside SessionInfo. */
export interface SessionMeta {
  id: string
  provider?: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  /** Anthropic beta flags forwarded verbatim to the SDK on every
   *  re-spawn (restart / resume / fork). Persists the 1M-context flag
   *  for Sonnet 4 across server restarts. */
  betas?: string[]
  /** User intent: whether fast mode was requested. Re-applied to the SDK
   *  on re-spawn (resume / restart). Only the intent is persisted — the
   *  SDK's runtime fast_mode_state is re-reported after respawn. */
  fastMode?: boolean
  /** User intent: reasoning effort level. Re-applied to the SDK on
   *  re-spawn (resume / restart / fork). */
  effortLevel?: EffortLevel
  /** Monotonic counter of user turns seen; used as a rough "is there
   *  anything to resume?" hint for the UI. */
  messageCount: number
  /** Present once the underlying Query has finished or errored. Terminated
   *  sessions stay in the index (so the user can read the transcript), but
   *  resume() refuses to re-spawn them. */
  terminated: boolean
  terminatedReason?: string
  error?: string
  /** Epoch ms of the last completed turn. Used by the frontend to flag
   *  unread badges when a turn completes while the user is looking at
   *  another session. */
  lastTurnAt?: number
  /** Snapshot of HEAD captured when the session was first spawned.
   *  Survives across process restarts so the GitPanel "This session"
   *  view stays anchored even if the server is bounced mid-conversation. */
  gitStartSha?: string
}

const FILE_NAME = 'sessions.json'

export function defaultStateDir(): string {
  return join(homedir(), DEFAULT_DIR_NAME)
}

export type PersistenceOptions = JsonFileStoreOptions

/**
 * SessionStore — owns the on-disk index and schedules debounced writes.
 *
 * Usage:
 *   const store = new SessionStore({ stateDir })
 *   await store.load()
 *   store.upsert(meta)
 *   store.remove(id)
 *   await store.flush()  // typically on SIGINT
 */
export class SessionStore extends JsonFileStore<SessionMeta> {
  constructor(opts: PersistenceOptions = {}) {
    super(opts, FILE_NAME, DEFAULT_DIR_NAME, 'persistence')
  }

  protected getKey(meta: SessionMeta): string {
    return meta.id
  }

  /** Parse the on-disk JSON array into SessionMeta entries. */
  protected parseItems(raw: string): SessionMeta[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      console.warn(`[persistence] ${this.file} is not an array; ignoring`)
      return []
    }
    const entries: SessionMeta[] = []
    for (const item of parsed) {
      const meta = coerceMeta(item)
      if (meta) entries.push(meta)
    }
    return entries
  }

  /** SessionMeta serialises as a JSON array. */
  protected serializeForWrite(items: SessionMeta[]): unknown {
    return items
  }

  /** Read the index from disk. A missing or corrupt file is treated as
   *  empty — we never want a bad file to prevent startup. */
  async load(): Promise<SessionMeta[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const entries = this.parseItems(raw)
      this.initEntries(entries)
      return entries
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      console.warn(`[persistence] failed to read ${this.file}: ${e.message}`)
      return []
    }
  }
}

/** Narrow and normalise untrusted JSON into a SessionMeta, or null if it's
 *  unusable. Forward-compatible: unknown extra fields are ignored. */
function coerceMeta(raw: unknown): SessionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : null
  if (!id) return null
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const lastActivityAt = typeof r.lastActivityAt === 'number' ? r.lastActivityAt : createdAt
  return {
    id,
    provider: typeof r.provider === 'string' ? r.provider : 'claude',
    createdAt,
    lastActivityAt,
    cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    permissionMode: typeof r.permissionMode === 'string' ? (r.permissionMode as PermissionMode) : undefined,
    title: typeof r.title === 'string' ? r.title : undefined,
    betas: Array.isArray(r.betas) && r.betas.every((b) => typeof b === 'string')
      ? (r.betas as string[])
      : undefined,
    fastMode: typeof r.fastMode === 'boolean' ? r.fastMode : undefined,
    effortLevel:
      r.effortLevel === 'low' || r.effortLevel === 'medium' || r.effortLevel === 'high' ||
      r.effortLevel === 'xhigh' || r.effortLevel === 'max'
        ? r.effortLevel
        : undefined,
    messageCount: typeof r.messageCount === 'number' ? r.messageCount : 0,
    terminated: typeof r.terminated === 'boolean' ? r.terminated : false,
    terminatedReason: typeof r.terminatedReason === 'string' ? r.terminatedReason : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
    lastTurnAt: typeof r.lastTurnAt === 'number' ? r.lastTurnAt : undefined,
    gitStartSha: typeof r.gitStartSha === 'string' ? r.gitStartSha : undefined,
  }
}
