// Persistent registry for installed App Plugins.
//
// Extends JsonFileStore to inherit the debounced(500ms) + atomic tmp+rename
// + serial-flush write machinery used by every other Map-backed store in
// this repo (mcp-config, snippet-store, persistence, mp-store). The on-disk
// shape is one JSON document holding every plugin's record; big data /
// cache / logs live in their own partitioned dirs (storage-service,
// secrets-service), NOT in this file.
//
// Only the registry metadata lives here. Mutations go through the manager,
// which validates transitions before calling upsert/remove and refreshes the
// event-bus snapshot after each flush.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { JsonFileStore, DEFAULT_DIR_NAME } from '../json-file-store.js'
import type { JsonFileStoreOptions } from '../json-file-store.js'
import { createLogger } from '../log.js'
import { normalisePermissions } from '../../shared/app-plugins/permissions.js'
import type { AppPluginRecord } from '../../shared/app-plugins/runtime-state.js'

const log = createLogger('app-plugins')

interface AppPluginsFileShape {
  version: 1
  plugins: Record<string, AppPluginRecord>
}

export type AppPluginStoreOptions = JsonFileStoreOptions

export class AppPluginStore extends JsonFileStore<AppPluginRecord> {
  constructor(opts: AppPluginStoreOptions = {}) {
    super(opts, 'app-plugins/registry.json', DEFAULT_DIR_NAME, 'app-plugins')
  }

  protected getKey(record: AppPluginRecord): string {
    return record.id
  }

  protected parseItems(raw: string): AppPluginRecord[] {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn(`${this.file} is not an object; ignoring`)
      return []
    }
    const obj = parsed as Partial<AppPluginsFileShape>
    if (!obj.plugins || typeof obj.plugins !== 'object' || Array.isArray(obj.plugins)) return []
    const entries: AppPluginRecord[] = []
    for (const [id, value] of Object.entries(obj.plugins)) {
      const coerced = coerceRecord(value, id)
      if (coerced) entries.push(coerced)
    }
    return entries
  }

  protected serializeForWrite(items: AppPluginRecord[]): unknown {
    const plugins: Record<string, AppPluginRecord> = {}
    for (const r of items) plugins[r.id] = r
    const out: AppPluginsFileShape = { version: 1, plugins }
    return out
  }

  /** Load every record into memory. Missing/corrupt file → empty store
   *  (same shape as McpConfigStore.load / MpStore.load). */
  async load(): Promise<AppPluginRecord[]> {
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

  /** Ensure the registry file's parent dir exists before the base class
   *  writes. Unlike the other stores (flat filenames directly in stateDir),
   *  the App Plugin registry lives in a nested `app-plugins/` subdir that
   *  the base `writeAtomic(dir, file)` doesn't create — it only mkdirs
   *  `this.dir`. Without this, the first flush ENOENTs on the tmp file.
   *  The mkdir is best-effort: if it fails (e.g. the state dir was removed
   *  during teardown), super.flush()'s writeAtomic will fail too and that's
   *  already caught + re-marked dirty by the base — we don't want a mkdir
   *  rejection to surface as an unhandled rejection on a fire-and-forget
   *  flush. */
  override async flush(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.file), { recursive: true })
    } catch {
      /* fall through; super.flush handles the write failure */
    }
    return super.flush()
  }
}

/** Coerce a raw JSON record into a trusted AppPluginRecord. The registry
 *  file is hand-editable on disk, so every field is re-validated on load —
 *  a tampered runtimeState or missing source falls back to safe defaults
 *  rather than crashing the manager. */
function coerceRecord(raw: unknown, fallbackId: string): AppPluginRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id ? r.id : fallbackId
  const source = r.source as Record<string, unknown> | undefined
  const sourceRecord = coerceSource(source)
  if (!sourceRecord) return null
  const runtimeState = typeof r.runtimeState === 'string' ? (r.runtimeState as AppPluginRecord['runtimeState']) : 'disabled'
  // The registry file is hand-editable on disk, so grantedPermissions is
  // untrusted — a local attacker could inject hosts into a network.fetch
  // grant. Re-normalise (drops unknown permissions + cleans host lists)
  // rather than casting verbatim. This is the consent surface; silently
  // honouring hand-injected grants would defeat it.
  const grantedRaw = Array.isArray(r.grantedPermissions) ? (r.grantedPermissions as unknown[]) : []
  const { permissions: grantedPermissions } = normalisePermissions(grantedRaw as never)
  return {
    id,
    installedVersion: typeof r.installedVersion === 'string' ? r.installedVersion : '0.0.0',
    enabled: r.enabled === true,
    source: sourceRecord,
    manifestHash: typeof r.manifestHash === 'string' ? r.manifestHash : '',
    manifest: r.manifest,
    grantedPermissions,
    runtimeState,
    lastError: typeof r.lastError === 'string' ? r.lastError : undefined,
    crashTimestamps: Array.isArray(r.crashTimestamps) ? (r.crashTimestamps as number[]) : undefined,
  }
}

/** Coerce a raw `source` into a trusted record source. Accepts both `local`
 *  and `marketplace` provenance; requires a valid `path` for both. The
 *  registry file is hand-editable, so re-validate every field. */
function coerceSource(source: Record<string, unknown> | undefined): AppPluginRecord['source'] | null {
  if (!source || typeof source !== 'object') return null
  const addedAt = typeof source.addedAt === 'number' ? source.addedAt : 0
  if (source.type === 'local' && typeof source.path === 'string') {
    return { type: 'local', path: source.path, addedAt }
  }
  if (
    source.type === 'marketplace' &&
    typeof source.path === 'string' &&
    typeof source.marketplaceId === 'string' &&
    typeof source.pluginName === 'string'
  ) {
    return { type: 'marketplace', marketplaceId: source.marketplaceId, pluginName: source.pluginName, path: source.path, addedAt }
  }
  return null
}
