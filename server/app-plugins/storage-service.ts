// Per-plugin partitioned key-value storage (global / workspace / cache).
//
// Lives under <stateDir>/app-plugins/data/<id>/storage/{global,workspace,cache}.json.
// Each scope is one JSON document (a map of key → value). Writes are serialised
// per-scope via a promise chain so concurrent writes to the SAME key are
// ordered (last-write-wins, no torn JSON) — this is the per-key atomicity the
// plan requires for multi-tab concurrency. Quotas are enforced per scope.
//
// `workspace` scope is keyed per-cwd in v1? No — v1 keeps one workspace store
// per plugin (the session cwd is not part of the key). A future revision can
// partition by cwd; the API takes `scope` only.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../log.js'
import { LIMITS, utf8ByteLength } from '../../shared/app-plugins/validation.js'

const log = createLogger('app-plugins:storage')

export type StorageScope = 'global' | 'workspace' | 'cache'

const SCOPE_QUOTA: Record<StorageScope, number> = {
  global: LIMITS.storageGlobalBytes,
  workspace: LIMITS.storageWorkspaceBytes,
  cache: LIMITS.storageCacheBytes,
}

interface ScopeStore {
  data: Record<string, unknown>
  writing: Promise<void>
  dirty: boolean
  /** In-flight load so concurrent first-access calls don't each read the file
   *  and then clobber each other's mutations with stale disk contents. */
  loading?: Promise<void>
}

export class StorageService {
  private readonly scopes = new Map<StorageScope, ScopeStore>()

  constructor(
    private readonly pluginId: string,
    private readonly dataDir: string,
  ) {}

  private dir(): string {
    return join(this.dataDir, 'storage')
  }

  private file(scope: StorageScope): string {
    return join(this.dir(), `${scope}.json`)
  }

  private async ensureScope(scope: StorageScope): Promise<ScopeStore> {
    let s = this.scopes.get(scope)
    if (s) {
      if (s.loading) await s.loading
      return s
    }
    s = { data: {}, writing: Promise.resolve(), dirty: false }
    this.scopes.set(scope, s)
    s.loading = (async () => {
      try {
        const raw = await fs.readFile(this.file(scope), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          s!.data = parsed as Record<string, unknown>
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') log.warn(`[${this.pluginId}] failed to read ${scope} storage: ${e.message}`)
      } finally {
        s!.loading = undefined
      }
    })()
    await s.loading
    return s
  }

  async get(scope: StorageScope, key: string): Promise<{ value: unknown } | { found: false }> {
    const s = await this.ensureScope(scope)
    // hasOwnProperty, not `in`, so `__proto__`/`constructor`/`prototype`
    // (inherited from Object.prototype) don't read back as "found".
    if (!Object.prototype.hasOwnProperty.call(s.data, key)) return { found: false }
    return { value: s.data[key] }
  }

  async set(scope: StorageScope, key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string; quota?: boolean }> {
    const s = await this.ensureScope(scope)
    const serialized = JSON.stringify(value)
    if (utf8ByteLength(serialized) > LIMITS.configValueBytes) {
      return { ok: false, error: `value exceeds ${LIMITS.configValueBytes} bytes`, quota: true }
    }
    // Quota: projected size of the whole scope document.
    const next = { ...s.data, [key]: value }
    const docSize = utf8ByteLength(JSON.stringify(next))
    if (docSize > SCOPE_QUOTA[scope]) {
      return { ok: false, error: `${scope} storage quota exceeded (${docSize} > ${SCOPE_QUOTA[scope]})`, quota: true }
    }
    s.data = next
    s.dirty = true
    // Serialise writes per-scope so same-key concurrent writes order cleanly.
    s.writing = s.writing.then(() => this.persist(scope, s)).catch((err) => {
      log.warn(`[${this.pluginId}] ${scope} storage write failed: ${(err as Error).message}`)
    })
    await s.writing
    return { ok: true }
  }

  async delete(scope: StorageScope, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = await this.ensureScope(scope)
    if (!(key in s.data)) return { ok: true }
    delete s.data[key]
    s.dirty = true
    s.writing = s.writing.then(() => this.persist(scope, s)).catch((err) => {
      log.warn(`[${this.pluginId}] ${scope} storage delete failed: ${(err as Error).message}`)
    })
    await s.writing
    return { ok: true }
  }

  private async persist(scope: StorageScope, s: ScopeStore): Promise<void> {
    if (!s.dirty) return
    const file = this.file(scope)
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(s.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { await fs.chmod(tmp, 0o600) } catch { /* Windows */ }
    await fs.rename(tmp, file)
    s.dirty = false
  }
}
