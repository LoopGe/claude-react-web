// Shared engine for the per-session JSON-array sidecars (turn anchors,
// result frames, prompt uuids). Each sidecar is one pretty-printed JSON
// array at <dir>/<id>.json, written with `writeAtomic`.
//
// Why a shared engine (modeled on SnapshotStore's chain/removed/revive):
//  - Writes are serialised PER SESSION. A store-wide chain made session A's
//    slow write block session B's append; a per-id chain only orders the
//    writes that actually race on the same tmp+rename (on Windows a rename
//    onto a file mid-write returns EPERM).
//  - remove() runs INSIDE the chain and tombstones the id synchronously, so
//    an append queued (or fired-and-forgotten) after a delete can't recreate
//    the file once it has been unlinked. revive() clears the tombstone when
//    a new session reuses the id (SessionManager.spawn).
//  - An in-memory cache of the last written / read array means an append is
//    load-modify-write against memory, not a full file re-read per frame.
//    The cache is bounded (LRU by session) so a long-running server doesn't
//    pin every session's sidecar it has ever touched.

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger, type Logger } from './log.js'
import { writeAtomic } from './json-file-store.js'

/** Sessions whose arrays stay cached. A miss only costs one file read. */
const DEFAULT_MAX_CACHED_SESSIONS = 64

export interface PerSessionSidecarOptions<E> {
  /** Directory holding `<id>.json`. `null` → every method no-ops (stores
   *  constructed without a stateDir: standalone buildApp / unit tests). */
  dir: string | null
  /** Logger label (e.g. 'turn-anchors'). */
  label: string
  /** Writer; defaults to `writeAtomic`. Injectable for tests. */
  write?: (dir: string, file: string, data: E[]) => Promise<void>
  /** Reader; defaults to `readFile(file, 'utf8')`. Injectable for tests. */
  read?: (file: string) => Promise<string>
  maxCachedSessions?: number
}

export class PerSessionSidecar<E> {
  private readonly dir: string | null
  private readonly log: Logger
  private readonly write: (dir: string, file: string, data: E[]) => Promise<void>
  private readonly read: (file: string) => Promise<string>
  private readonly maxCached: number
  /** Per-id chain tail. Never rejects; deleted once it settles while still
   *  the tail, so the map only holds sessions with in-flight work. */
  private readonly tails = new Map<string, Promise<void>>()
  /** Ids explicitly removed — update() no-ops until revive(). */
  private readonly removed = new Set<string>()
  /** Last known on-disk content per id (insertion order = LRU order). */
  private readonly cache = new Map<string, E[]>()

  constructor(opts: PerSessionSidecarOptions<E>) {
    this.dir = opts.dir
    this.log = createLogger(opts.label)
    this.write = opts.write ?? ((dir, file, data) => writeAtomic(dir, file, data))
    this.read = opts.read ?? ((file) => readFile(file, 'utf8'))
    this.maxCached = opts.maxCachedSessions ?? DEFAULT_MAX_CACHED_SESSIONS
  }

  private file(id: string): string {
    return join(this.dir!, `${id}.json`)
  }

  private chain<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve()
    const result = prev.then(fn)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(id, tail)
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id)
    })
    return result
  }

  private cacheSet(id: string, entries: E[]): void {
    this.cache.delete(id)
    this.cache.set(id, entries)
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** Read inside the chain: cache first, else disk (populating the cache).
   *  Returns the cached array itself — callers must copy before exposing. */
  private async readCurrent(id: string): Promise<E[] | null> {
    const cached = this.cache.get(id)
    if (cached) {
      this.cacheSet(id, cached) // refresh LRU position
      return cached
    }
    try {
      const parsed: unknown = JSON.parse(await this.read(this.file(id)))
      if (!Array.isArray(parsed)) return null
      const entries = parsed as E[]
      this.cacheSet(id, entries)
      return entries
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log.warn(`load failed for ${id}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  /** The session's entries, or null when absent/unreadable. Chained behind
   *  that session's pending writes (read-your-writes). Returns a copy. */
  load(id: string): Promise<E[] | null> {
    if (!this.dir) return Promise.resolve(null)
    return this.chain(id, async () => {
      const current = await this.readCurrent(id)
      return current ? current.slice() : null
    })
  }

  /** Replace the session's entries with `fn(prev)` (`prev` is a copy the fn
   *  may mutate; null when absent). `fn` returning null skips the write.
   *  No-op while tombstoned. Never rejects: a failed write is logged and
   *  drops the cache entry so the next read goes back to disk. */
  update(id: string, fn: (prev: E[] | null) => E[] | null): Promise<void> {
    if (!this.dir || this.removed.has(id)) return Promise.resolve()
    const dir = this.dir
    return this.chain(id, async () => {
      if (this.removed.has(id)) return
      try {
        const current = await this.readCurrent(id)
        const next = fn(current ? current.slice() : null)
        if (!next) return
        await this.write(dir, this.file(id), next)
        if (this.removed.has(id)) return
        this.cacheSet(id, next.slice())
      } catch (err) {
        this.cache.delete(id)
        this.log.warn(`write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  /** Tombstone the id now, then (after its queued writes) unlink the file. */
  remove(id: string): Promise<void> {
    this.removed.add(id)
    if (!this.dir) return Promise.resolve()
    return this.chain(id, async () => {
      this.cache.delete(id)
      try {
        await unlink(this.file(id))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') this.log.warn(`remove failed for ${id}: ${(err as Error).message ?? err}`)
      }
    })
  }

  /** Clear the tombstone so a new session reusing `id` can write again. */
  revive(id: string): void {
    this.removed.delete(id)
  }
}
