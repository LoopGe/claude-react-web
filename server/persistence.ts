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
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** Metadata we need to resurrect a session. Deliberately a subset of
 *  Options — no auth tokens, no full SDK config. Everything here must
 *  be safe to ship to the frontend inside SessionInfo. */
export interface SessionMeta {
  id: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  /** Monotonic counter of user turns seen; used as a rough "is there
   *  anything to resume?" hint for the UI. */
  messageCount: number
  /** Present once the underlying Query has finished or errored. Terminated
   *  sessions stay in the index (so the user can read the transcript), but
   *  resume() refuses to re-spawn them. */
  terminated: boolean
  error?: string
  /** Epoch ms of the last completed turn. Used by the frontend to flag
   *  unread badges when a turn completes while the user is looking at
   *  another session. */
  lastTurnAt?: number
}

const DEFAULT_DIR_NAME = '.claude-react-web'
const FILE_NAME = 'sessions.json'
const DEBOUNCE_MS = 500

export function defaultStateDir(): string {
  return join(homedir(), DEFAULT_DIR_NAME)
}

export interface PersistenceOptions {
  /** Override the state directory (CLI --state-dir). */
  stateDir?: string
}

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
export class SessionStore {
  private readonly dir: string
  private readonly file: string
  private readonly index = new Map<string, SessionMeta>()
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  /** Serialises concurrent flushes so we never start a write while a previous
   *  one is still renaming in. */
  private writing: Promise<void> = Promise.resolve()

  constructor(opts: PersistenceOptions = {}) {
    this.dir = resolvePath(opts.stateDir ?? defaultStateDir())
    this.file = join(this.dir, FILE_NAME)
  }

  /** Read the index from disk. A missing or corrupt file is treated as
   *  empty — we never want a bad file to prevent startup. */
  async load(): Promise<SessionMeta[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) {
        console.warn(`[persistence] ${this.file} is not an array; ignoring`)
        return []
      }
      const entries: SessionMeta[] = []
      for (const item of parsed) {
        const meta = coerceMeta(item)
        if (meta) {
          this.index.set(meta.id, meta)
          entries.push(meta)
        }
      }
      return entries
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      console.warn(`[persistence] failed to read ${this.file}: ${e.message}`)
      return []
    }
  }

  list(): SessionMeta[] {
    return Array.from(this.index.values())
  }

  get(id: string): SessionMeta | undefined {
    return this.index.get(id)
  }

  /** Insert or replace a session's metadata. Triggers a debounced flush. */
  upsert(meta: SessionMeta): void {
    this.index.set(meta.id, { ...meta })
    this.schedule()
  }

  remove(id: string): void {
    if (this.index.delete(id)) this.schedule()
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Write immediately; safe to call from shutdown paths. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    // Snapshot before the await so concurrent upserts during the write
    // don't race with the serialisation.
    const snapshot = Array.from(this.index.values())
    this.dirty = false
    this.writing = this.writing.then(() => writeAtomic(this.dir, this.file, snapshot)).catch((err) => {
      // Re-mark dirty so the next schedule retries. Log but don't throw —
      // persistence failures should never crash the server.
      this.dirty = true
      console.warn(`[persistence] write failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
  }
}

async function writeAtomic(dir: string, file: string, data: SessionMeta[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  // Pretty-print so the file is human-inspectable in ~/.claude-react-web.
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, file)
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
    createdAt,
    lastActivityAt,
    cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    permissionMode: typeof r.permissionMode === 'string' ? (r.permissionMode as PermissionMode) : undefined,
    title: typeof r.title === 'string' ? r.title : undefined,
    messageCount: typeof r.messageCount === 'number' ? r.messageCount : 0,
    terminated: typeof r.terminated === 'boolean' ? r.terminated : false,
    error: typeof r.error === 'string' ? r.error : undefined,
    lastTurnAt: typeof r.lastTurnAt === 'number' ? r.lastTurnAt : undefined,
  }
}

// Re-export so callers don't need a second import for the path helper.
export { dirname }
