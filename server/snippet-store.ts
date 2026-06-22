// Composer snippet persistence.
//
// Stores user-defined composer snippets (reusable text macros) in
// <stateDir>/composer-snippets.json so they survive across sessions,
// browser profiles, and page reloads. Snippets used to live only in the
// browser's localStorage, which made them per-browser and prone to loss
// when the client tab that owned them unmounted before flushing.
//
// Storage is an ORDERED JSON array (not a keyed object like mcp-config)
// because the user can reorder snippets via move up/down, and that order
// is meaningful — it's the order they appear in the composer context menu.
// The base JsonFileStore preserves Map insertion order, and reordering
// goes through the base class's `reorder()` which rebuilds the Map.
//
// Writes are atomic (tmp + rename) and debounced, same as persistence.ts
// and mcp-config.ts.

import { promises as fs } from 'node:fs'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('composer-snippets')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A composer snippet stored on disk. `id` is the stable key (client- or
 *  server-generated); `label` shows in the context menu; `content` is the
 *  text inserted at the caret. */
export interface StoredSnippet {
  id: string
  label: string
  content: string
  createdAt: number
  updatedAt: number
}

export type SnippetStoreOptions = JsonFileStoreOptions

/** Result of a bulk import (used by the localStorage → server migration). */
export interface ImportResult {
  imported: number
  skipped: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * SnippetStore — ordered CRUD store for composer snippets.
 *
 * Usage:
 *   const store = new SnippetStore({ stateDir })
 *   await store.load()
 *   store.upsert(snippet)          // append (new id) or update in place
 *   store.reorder(idsInNewOrder)   // move up/down
 *   store.remove(id)
 *   await store.flush()
 */
export class SnippetStore extends JsonFileStore<StoredSnippet> {
  constructor(opts: SnippetStoreOptions = {}) {
    super(opts, 'composer-snippets.json', DEFAULT_DIR_NAME, 'composer-snippets')
  }

  protected getKey(snippet: StoredSnippet): string {
    return snippet.id
  }

  /** Parse the on-disk array. Non-array or malformed entries are dropped
   *  (defensive against hand edits / version drift) rather than throwing. */
  protected parseItems(raw: string): StoredSnippet[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      log.warn(`${this.file} is not an array; ignoring`)
      return []
    }
    const entries: StoredSnippet[] = []
    for (const value of parsed) {
      const snippet = coerceStoredSnippet(value)
      if (snippet) entries.push(snippet)
    }
    return entries
  }

  /** Serialise as a plain array — the base `flush()` snapshots the Map in
   *  insertion order, so this preserves the user's ordering. */
  protected serializeForWrite(items: StoredSnippet[]): unknown {
    return items
  }

  /** Load snippets from disk. Missing or corrupt file → empty store. */
  async load(): Promise<StoredSnippet[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const entries = this.parseItems(raw)
      this.initEntries(entries)
      return entries
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      log.warn(`failed to read ${this.file}: ${e.message}`)
      return []
    }
  }

  /** Bulk import (localStorage → server migration). Idempotent by id:
   *  snippets whose id already exists are skipped, so re-running import
   *  never duplicates. New snippets are appended in input order. */
  importMany(incoming: Array<{ id: string; label: string; content: string }>): ImportResult {
    let imported = 0
    let skipped = 0
    const now = Date.now()
    for (const raw of incoming) {
      const snippet = coerceStoredSnippet({ ...raw, createdAt: now, updatedAt: now })
      if (!snippet) { skipped++; continue }
      if (this.has(snippet.id)) { skipped++; continue }
      this.upsert(snippet)
      imported++
    }
    return { imported, skipped }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate and normalise raw JSON into a StoredSnippet. Returns null if
 *  the required string fields are missing/empty. Backfills timestamps. */
export function coerceStoredSnippet(raw: unknown): StoredSnippet | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const label = typeof r.label === 'string' ? r.label.trim() : ''
  const content = typeof r.content === 'string' ? r.content : ''
  // label may be trimmed-empty (reject); content can legitimately be any
  // non-empty string. id must be present.
  if (!id || !label || content === '') return null
  const now = Date.now()
  return {
    id,
    label,
    content,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
  }
}
