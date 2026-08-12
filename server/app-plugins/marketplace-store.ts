// Persistent store for App Plugin marketplaces (one record per cloned repo).
//
// Extends JsonFileStore (mirrors MpStore's pattern) but is deliberately
// separate from the Claude Plugin Marketplace — own file (`app-plugins/
// marketplaces.json`), own cache dir, no SDK enabled-plugin side map (App
// Plugins are tracked in AppPluginStore once installed). The clone dir for
// marketplace `id` is `<stateDir>/app-plugins/marketplace-cache/<id>`.

import { existsSync, promises as fs } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { JsonFileStore, DEFAULT_DIR_NAME } from '../json-file-store.js'
import type { JsonFileStoreOptions } from '../json-file-store.js'
import { createLogger } from '../log.js'
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
import type { AppPluginMarketplaceRecord, AppPluginMarketplaceSource } from '../../shared/app-plugins/marketplace.js'

const log = createLogger('app-plugins:mp-store')

interface AppPluginMarketplacesFileShape {
  version: 1
  marketplaces: Record<string, AppPluginMarketplaceRecord>
}

export type AppPluginMarketplaceStoreOptions = JsonFileStoreOptions

export class AppPluginMarketplaceStore extends JsonFileStore<AppPluginMarketplaceRecord> {
  /** Cloned marketplace repos live one-per-slug under this dir. */
  readonly cacheDir: string

  constructor(opts: AppPluginMarketplaceStoreOptions = {}) {
    super(opts, 'app-plugins/marketplaces.json', DEFAULT_DIR_NAME, 'app-plugins:mp-store')
    this.cacheDir = join(this.dir, 'app-plugins', 'marketplace-cache')
  }

  protected getKey(record: AppPluginMarketplaceRecord): string {
    return record.id
  }

  protected parseItems(raw: string): AppPluginMarketplaceRecord[] {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn(`${this.file} is not an object; ignoring`)
      return []
    }
    const obj = parsed as Partial<AppPluginMarketplacesFileShape>
    if (!obj.marketplaces || typeof obj.marketplaces !== 'object' || Array.isArray(obj.marketplaces)) return []
    const entries: AppPluginMarketplaceRecord[] = []
    for (const [id, value] of Object.entries(obj.marketplaces)) {
      const coerced = coerceRecord(value, id)
      if (coerced) entries.push(coerced)
    }
    return entries
  }

  protected serializeForWrite(items: AppPluginMarketplaceRecord[]): unknown {
    const marketplaces: Record<string, AppPluginMarketplaceRecord> = {}
    for (const r of items) marketplaces[r.id] = r
    return { version: 1, marketplaces } satisfies AppPluginMarketplacesFileShape
  }

  async load(): Promise<AppPluginMarketplaceRecord[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const entries = this.parseItems(raw)
      this.initEntries(entries)
      return this.list()
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      log.warn(`failed to read ${this.file}: ${e.message}`)
      return []
    }
  }

  /** Deterministic clone destination for a freshly-generated id. Caller
   *  ensures the dir doesn't exist before cloning. */
  cloneDirFor(id: string): string {
    return join(this.cacheDir, id)
  }

  /** Derive a URL-safe slug from a marketplace URL (mirrors MpStore). */
  generateId(url: string): string {
    const stem = deriveSlug(url)
    if (!this.has(stem)) return stem
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem}-${i}`
      if (!this.has(candidate)) return candidate
    }
    return `${stem}-${Date.now()}`
  }

  /** Hard-remove a marketplace: drop from index, recursively delete the
   *  clone dir. Filesystem errors are swallowed so a stale clone doesn't
   *  block removal. A `local` (bundled) marketplace points at app code
   *  (dist/plugins/) and its dir is never deleted. */
  async removeEntry(id: string): Promise<void> {
    const entry = this.get(id)
    this.remove(id)
    await this.flush()
    if (entry?.source.type === 'https' && entry.cloneDir) {
      try {
        await rm(entry.cloneDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (err) {
        log.warn(`failed to remove clone dir ${entry.cloneDir}: ${(err as Error).message}`)
      }
    }
  }

  /** True when the store file has never been written — the boundary for the
   *  built-in marketplace seeding ("seed on first launch only"). */
  isFirstRun(): boolean {
    return !existsSync(this.file)
  }

  /** Seed the built-in marketplace record on the very first launch. Returns
   *  whether the record was actually seeded (no-op when the store file
   *  already exists or a record with the same id is present). The explicit
   *  flush guarantees the file exists after boot 1, which is exactly the
   *  "first run" boundary the next boot checks. */
  async seedBuiltinIfFirstRun(record: AppPluginMarketplaceRecord): Promise<boolean> {
    if (!this.isFirstRun()) return false
    if (this.has(record.id)) return false
    this.upsert(record)
    await this.flush()
    return true
  }

  /** Like AppPluginStore: ensure the nested `app-plugins/` parent exists
   *  before the base writes (base writeAtomic only mkdirs `this.dir`). */
  override async flush(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.file), { recursive: true })
    } catch {
      /* fall through; super.flush handles the write failure */
    }
    return super.flush()
  }
}

/** Coerce a raw JSON record into a trusted marketplace record. The file is
 *  hand-editable, so re-validate the source, subdir + cloneDir. */
function coerceRecord(raw: unknown, fallbackId: string): AppPluginMarketplaceRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id ? r.id : fallbackId
  const source = r.source as Record<string, unknown> | undefined
  if (!source) return null
  let coercedSource: AppPluginMarketplaceSource
  if (source.type === 'https' && typeof source.url === 'string') {
    coercedSource = {
      type: 'https',
      url: source.url,
      ref: typeof source.ref === 'string' ? source.ref : undefined,
    }
  } else if (source.type === 'local' && typeof source.path === 'string' && source.path) {
    coercedSource = { type: 'local', path: source.path }
  } else {
    return null
  }
  if (typeof r.cloneDir !== 'string' || !r.cloneDir) return null
  // Optional subdir: the marketplace content lives under cloneDir/subdir
  // (e.g. the official host repo keeps its catalog in plugins/). Must stay
  // contained — reject records that try to escape the clone.
  let coercedSubdir: string | undefined
  if (r.subdir !== undefined) {
    if (typeof r.subdir !== 'string' || !r.subdir) return null
    const subErr = validateRelativePath(r.subdir, { isWindows: process.platform === 'win32' })
    if (subErr) return null
    coercedSubdir = r.subdir
  }
  const manifest = (r.manifest && typeof r.manifest === 'object' && !Array.isArray(r.manifest)
    ? r.manifest
    : { plugins: [] }) as AppPluginMarketplaceRecord['manifest']
  return {
    id,
    displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : id,
    source: coercedSource,
    subdir: coercedSubdir,
    cloneDir: r.cloneDir,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
    lastRefreshedAt: typeof r.lastRefreshedAt === 'number' ? r.lastRefreshedAt : 0,
    lastSha: typeof r.lastSha === 'string' ? r.lastSha : '',
    manifest,
  }
}

function deriveSlug(url: string): string {
  const raw = url.trim().replace(/^https:\/\//, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const segs = raw.split('/').filter(Boolean)
  const last = segs[segs.length - 1] ?? ''
  const sanitised = last.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (sanitised && sanitised.length > 0 && sanitised.length <= 64) return sanitised
  return 'marketplace'
}
