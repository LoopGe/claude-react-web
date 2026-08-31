// Uploaded-file registry.
//
// Records every composer file upload (paperclip / drag-drop) so the
// Uploads Manager dialog can list, audit and delete them — including
// uploads whose session has since been deleted (orphans). Persisted as
// <stateDir>/upload-registry.json via the shared JsonFileStore base
// (atomic tmp+rename, debounced flush — same as snippet-store).
//
// Keying: `path` is the unique key; `id` is for routes/UI. Provenance:
// `cwd` is the ownership key and `sessionTitle` is a snapshot — a deleted
// session must not take the record with it.

import { promises as fs } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import { createLogger } from './log.js'
import type { UploadEntry } from '../shared/uploads.js'

const log = createLogger('upload-registry')

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
  }
}

interface BackfillSession {
  cwd?: string | null
  title?: string
}

export class UploadStore extends JsonFileStore<UploadEntry> {
  constructor(opts: UploadStoreOptions = {}) {
    super(opts, 'upload-registry.json', DEFAULT_DIR_NAME, 'upload-registry')
  }

  protected getKey(entry: UploadEntry): string {
    return entry.path
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
    return entries
  }

  /** Record uploads. Idempotent by path — an existing path is updated in
   *  place, so a re-record never duplicates. Flush is debounced by the
   *  base class. */
  record(entries: UploadEntry[]): void {
    for (const entry of entries) this.upsert(entry)
  }

  /** Linear scan by id — registry sizes are small (hundreds at most), and
   *  the map is keyed by path, so no secondary index is warranted. */
  getById(id: string): UploadEntry | undefined {
    return this.list().find((e) => e.id === id)
  }

  /** Remove by id. Returns true when an entry was removed. */
  removeById(id: string): boolean {
    const entry = this.getById(id)
    if (!entry) return false
    this.remove(entry.path)
    return true
  }

  /** Remove by absolute path — used by the session-scoped chips DELETE so
   *  the two delete entry points cannot drift. */
  removeByPath(path: string): void {
    this.remove(path)
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
        if (this.has(path)) continue
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
      log.info(`backfill added ${added} upload ${added === 1 ? 'entry' : 'entries'}`)
    }
    return added
  }
}
