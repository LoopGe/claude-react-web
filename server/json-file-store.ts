// Shared base class for debounced, atomic JSON file persistence.
//
// Extracts the common pattern used by SessionStore (persistence.ts) and
// McpConfigStore (mcp-config.ts): an in-memory Map backed by a JSON file
// with debounced writes, atomic tmp+rename, and serialized flush scheduling.

import { promises as fs } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_DIR_NAME = '.claude-react-web'
export const DEBOUNCE_MS = 500

export interface JsonFileStoreOptions {
  /** Override the state directory (CLI --state-dir). */
  stateDir?: string
}

/**
 * Abstract base for a Map-backed JSON file store with debounced atomic writes.
 *
 * Subclasses implement three template methods to control serialization format:
 *   - `getKey(item)` — extract the map key from an entry
 *   - `parseItems(raw)` — parse the raw file into entries
 *   - `serializeForWrite(items)` — convert the snapshot to the on-disk shape
 */
export abstract class JsonFileStore<T> {
  protected readonly dir: string
  protected readonly file: string
  protected readonly index = new Map<string, T>()
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  /** Serialises concurrent flushes so we never start a write while a previous
   *  one is still renaming in. */
  private writing: Promise<void> = Promise.resolve()
  /** Label for log messages — set by subclass for clarity. */
  protected label: string

  constructor(opts: JsonFileStoreOptions, fileName: string, defaultDirName = DEFAULT_DIR_NAME, label?: string) {
    this.dir = resolvePath(opts.stateDir ?? join(homedir(), defaultDirName))
    this.file = join(this.dir, fileName)
    this.label = label ?? fileName
  }

  // ─── Template methods ────────────────────────────────────────────

  /** Extract the map key from an entry. */
  protected abstract getKey(item: T): string

  /** Parse the raw file contents into an array of entries.
   *  Called during `load()` after reading the file. */
  protected abstract parseItems(raw: string): T[]

  /** Convert the current snapshot to the on-disk shape (array or record). */
  protected abstract serializeForWrite(items: T[]): unknown

  // ─── Shared concrete methods ─────────────────────────────────────

  list(): T[] {
    return Array.from(this.index.values())
  }

  /** Number of entries in the store without allocating an array. */
  count(): number {
    return this.index.size
  }

  get(key: string): T | undefined {
    return this.index.get(key)
  }

  /** Insert or replace an entry. Triggers a debounced flush. */
  upsert(item: T): void {
    this.index.set(this.getKey(item), { ...item } as T)
    this.schedule()
  }

  remove(key: string): void {
    if (this.index.delete(key)) this.schedule()
  }

  /** Populate the index from parsed entries. Called by subclass `load()`. */
  protected initEntries(entries: T[]): void {
    for (const entry of entries) {
      this.index.set(this.getKey(entry), entry)
    }
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
    const snapshot = this.serializeForWrite(Array.from(this.index.values()))
    this.dirty = false
    this.writing = this.writing.then(() => writeAtomic(this.dir, this.file, snapshot)).catch((err) => {
      // Re-mark dirty so the next schedule retries. Log but don't throw —
      // persistence failures should never crash the server.
      this.dirty = true
      console.warn(`[${this.label}] write failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    await this.writing
    // If a concurrent upsert() set dirty=true while we were writing, we
    // must schedule another flush — otherwise those changes are stranded
    // (no timer, no pending flush). The next flush() will snapshot the
    // updated index and write again.
    if (this.dirty && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, DEBOUNCE_MS)
      this.timer.unref?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

export async function writeAtomic(dir: string, file: string, data: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  // Pretty-print so the file is human-inspectable.
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  // chmod after writeFile because the `mode` option is only respected on
  // POSIX systems — on Windows NTFS the option is silently ignored.
  try { await fs.chmod(tmp, 0o600) } catch { /* Windows: no POSIX perms */ }
  await fs.rename(tmp, file)
}
