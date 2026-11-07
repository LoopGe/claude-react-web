// Uploaded-file registry.
//
// Records every composer file upload (paperclip / drag-drop) so the
// Uploads Manager dialog can list, audit and delete them — including
// uploads whose session has since been deleted (orphans). Persisted as
// <stateDir>/upload-registry.json via the shared JsonFileStore base
// (atomic tmp+rename, debounced flush — same as snippet-store).
//
// Keying: `id` (a per-upload UUID) is the registry key and the reference
// id; `path` is where the bytes live and is NOT unique — the same published
// file can be recorded under one id per session. `digest` (sha256 of the
// bytes) is indexed so an entry can be found by content, and `getById`
// falls back to that index for `sha256:<digest>` ids. Provenance: `cwd` is
// the ownership key and `sessionTitle` is a snapshot — a deleted session
// must not take the record with it.

import { createReadStream, promises as fs } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import { createLogger } from './log.js'
export type { UploadEntry } from '../shared/uploads.js'
import type { UploadEntry } from '../shared/uploads.js'

const log = createLogger('upload-registry')

/** How many files `backfillDigests` hashes at once. */
const DIGEST_BACKFILL_CONCURRENCY = 4

/** A `sha256:<64 lowercase hex>` id names bytes rather than a registry entry;
 *  `getById` resolves it through the digest index. */
const SHA256_ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/** sha256 of a file's bytes, streamed. `undefined` when the file is gone —
 *  legacy entries can outlive their bytes. */
async function digestOfFile(path: string): Promise<string | undefined> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 16 })) {
      const bytes: Buffer = chunk
      hash.update(bytes)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  return hash.digest('hex')
}

/** Where per-session uploads land inside the session's cwd. Kept visible
 *  (not dot-prefixed) so users can see what the UI dropped in. Single
 *  source of truth for both the upload route and the backfill scan. */
export const UPLOAD_SUBDIR = 'claude-web-uploads'

export type UploadStoreOptions = { stateDir?: string }

/** Defensive parse of one on-disk entry. Returns null for entries missing
 *  required fields or with wrong-typed values (hand edits / version drift)
 *  instead of throwing. `sessionTitle` tolerates absence → ''. */
export function coerceStoredUpload(raw: unknown): UploadEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.path !== 'string' || !r.path) return null
  if (typeof r.cwd !== 'string' || !r.cwd) return null
  if (typeof r.name !== 'string' || !r.name) return null
  if (typeof r.size !== 'number' || !Number.isFinite(r.size)) return null
  if (typeof r.uploadedAt !== 'number' || !Number.isFinite(r.uploadedAt)) return null
  return {
    id: r.id,
    path: r.path,
    cwd: r.cwd,
    name: r.name,
    size: r.size,
    uploadedAt: r.uploadedAt,
    sessionTitle: typeof r.sessionTitle === 'string' ? r.sessionTitle : '',
    origin: r.origin === 'common' ? 'common' : undefined,
    ...(typeof r.sessionId === 'string' && r.sessionId !== '' ? { sessionId: r.sessionId } : {}),
    ...(typeof r.digest === 'string' && r.digest !== '' ? { digest: r.digest } : {}),
  }
}

interface BackfillSession {
  cwd?: string | null
  title?: string
}

export class UploadStore extends JsonFileStore<UploadEntry> {
  /** The base index is keyed by `id`, so it IS the id index. This index
   *  maps `digest` → the entries carrying it: `load`, `record` and the
   *  backfill passes rebuild it from the base map, and removal unindexes
   *  in place. */
  private readonly byDigest = new Map<string, UploadEntry[]>()

  constructor(opts: UploadStoreOptions = {}) {
    super(opts, 'upload-registry.json', DEFAULT_DIR_NAME, 'upload-registry')
  }

  protected getKey(entry: UploadEntry): string {
    return entry.id
  }

  private rebuildDigestIndex(): void {
    this.byDigest.clear()
    for (const entry of this.list()) {
      if (entry.digest === undefined) continue
      const bucket = this.byDigest.get(entry.digest)
      if (bucket) bucket.push(entry)
      else this.byDigest.set(entry.digest, [entry])
    }
  }

  /** Remove one entry from its digest bucket, dropping the bucket when it
   *  becomes empty. */
  private unindexDigest(entry: UploadEntry): void {
    if (entry.digest === undefined) return
    const bucket = this.byDigest.get(entry.digest)
    if (bucket === undefined) return
    const next = bucket.filter((e) => e.id !== entry.id)
    if (next.length === 0) this.byDigest.delete(entry.digest)
    else this.byDigest.set(entry.digest, next)
  }

  /** Removal keeps the digest index in step — every delete path
   *  (`removeById`, `removeByPath`) funnels through here. */
  override remove(key: string): void {
    const entry = this.index.get(key)
    super.remove(key)
    if (entry !== undefined) this.unindexDigest(entry)
  }

  override async clearAll(): Promise<void> {
    this.byDigest.clear()
    await super.clearAll()
  }

  protected parseItems(raw: string): UploadEntry[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      log.warn(`${this.file} is not an array; ignoring`)
      return []
    }
    const entries: UploadEntry[] = []
    for (const item of parsed) {
      const entry = coerceStoredUpload(item)
      if (entry) entries.push(entry)
    }
    return entries
  }

  protected serializeForWrite(items: UploadEntry[]): unknown {
    return items
  }

  /** Load the registry from disk. Returns empty on ENOENT, corrupt JSON,
   *  or non-array root — never throws. */
  async load(): Promise<UploadEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      log.warn(`read failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
    // Validate JSON before passing to parseItems (which assumes valid JSON).
    try {
      JSON.parse(raw)
    } catch {
      log.warn(`${this.file} is corrupt; ignoring`)
      return []
    }
    const entries = this.parseItems(raw)
    this.initEntries(entries)
    this.rebuildDigestIndex()
    return entries
  }

  /** Record uploads. Idempotent by id — an existing id is updated in place,
   *  so a re-record never duplicates. Distinct ids sharing one path coexist.
   *  Flush is debounced by the base class. */
  record(entries: UploadEntry[]): void {
    for (const entry of entries) this.upsert(entry)
    this.rebuildDigestIndex()
  }

  /** Exact lookup by id, then — for a `sha256:<digest>` id — the first
   *  entry carrying that digest (the future content-addressed reference). */
  getById(id: string): UploadEntry | undefined {
    const direct = this.get(id)
    if (direct !== undefined) return direct
    const match = SHA256_ID_PATTERN.exec(id)
    if (match === null) return undefined
    return this.getByDigest(match[1])[0]
  }

  /** Every entry carrying `digest`, in registry order. Empty when the
   *  digest is unrecorded. */
  getByDigest(digest: string): readonly UploadEntry[] {
    return this.byDigest.get(digest) ?? []
  }

  /** Remove by id. Returns true when an entry was removed. */
  removeById(id: string): boolean {
    if (!this.has(id)) return false
    this.remove(id)
    return true
  }

  /** Remove every entry whose path matches — a path can be shared by
   *  several ids (same published file recorded per session). */
  removeByPath(path: string): void {
    for (const entry of this.list()) {
      if (entry.path === path) this.remove(entry.id)
    }
  }

  /** First entry recorded for `path`. Paths are no longer unique and the
   *  registry is small (hundreds at most), so this is a linear scan. */
  getByPath(path: string): UploadEntry | undefined {
    return this.list().find((entry) => entry.path === path)
  }

  /** Fill in `digest` for legacy entries that predate content addressing.
   *  Each file is streamed through sha256 (at most 4 at a time); entries
   *  whose bytes are gone are skipped, never thrown. A per-entry read error
   *  (EISDIR, EACCES, a locked file) is logged and skips that entry, so one
   *  bad registry row cannot turn boot into a fatal exit. Returns how many
   *  entries gained a digest. */
  async backfillDigests(): Promise<number> {
    const pending = this.list().filter((entry) => entry.digest === undefined)
    let updated = 0
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const entry = pending[next++]
        let digest: string | undefined
        try {
          digest = await digestOfFile(entry.path)
        } catch (err) {
          log.warn(
            `digest backfill skipped ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
          continue
        }
        if (digest === undefined) continue
        this.upsert({ ...entry, digest })
        updated++
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DIGEST_BACKFILL_CONCURRENCY, pending.length) }, worker),
    )
    if (updated > 0) {
      this.rebuildDigestIndex()
      log.info(`digest backfill updated ${updated} upload ${updated === 1 ? 'entry' : 'entries'}`)
    }
    return updated
  }

  /** Seed the registry from the on-disk `claude-web-uploads/` folders of
   *  the given sessions. Idempotent — already-recorded paths (matched by
   *  path) keep their original uploadedAt/sessionTitle; only new paths are
   *  added, with mtimeMs as uploadedAt. Runs on every boot; cheap (one
   *  readdir per known-cwd session). Returns how many entries were added.
   *  Sessions without a cwd and unreadable/missing dirs are skipped.
   *
   *  Deletions are never resurrected: every registry delete path unlinks
   *  the file too, so a deleted entry's file is gone and cannot be
   *  re-scanned. */
  async backfillFromSessions(sessions: BackfillSession[]): Promise<number> {
    let added = 0
    for (const session of sessions) {
      if (!session.cwd) continue
      const dir = resolvePath(session.cwd, UPLOAD_SUBDIR)
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue // no upload dir (or unreadable) — nothing to seed
      }
      for (const name of names) {
        const path = resolvePath(dir, name)
        let stat
        try {
          stat = await fs.stat(path)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        if (this.getByPath(path) !== undefined) continue
        this.upsert({
          id: randomUUID(),
          path,
          cwd: resolvePath(session.cwd),
          name: basename(path),
          size: stat.size,
          uploadedAt: stat.mtimeMs,
          sessionTitle: session.title ?? '',
        })
        added++
      }
    }
    if (added > 0) {
      this.rebuildDigestIndex()
      log.info(`backfill added ${added} upload ${added === 1 ? 'entry' : 'entries'}`)
    }
    return added
  }

  /** Scan `<stateDir>/claude-web-uploads/` and record any files not yet in
   *  the registry. Idempotent — already-recorded paths (matched by path)
   *  are skipped. Missing or unreadable dir → 0 without throwing. Each new
   *  entry gets `cwd: resolvePath(this.getDir())`, `sessionTitle: ''`,
   *  `origin: 'common'`, `uploadedAt: stat.mtimeMs`. */
  async backfillCommonDir(): Promise<number> {
    let added = 0
    const dir = resolvePath(this.getDir(), UPLOAD_SUBDIR)
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return 0 // no upload dir (or unreadable) — nothing to seed
    }
    for (const name of names) {
      const path = resolvePath(dir, name)
      let stat
      try {
        stat = await fs.stat(path)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (this.getByPath(path) !== undefined) continue
      this.upsert({
        id: randomUUID(),
        path,
        cwd: resolvePath(this.getDir()),
        name: basename(path),
        size: stat.size,
        uploadedAt: stat.mtimeMs,
        sessionTitle: '',
        origin: 'common',
      })
      added++
    }
    if (added > 0) {
      this.rebuildDigestIndex()
      log.info(`backfillCommonDir added ${added} upload ${added === 1 ? 'entry' : 'entries'}`)
    }
    return added
  }
}
