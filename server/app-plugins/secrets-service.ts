// Per-plugin secrets storage.
//
// v1 is honest about the storage backend: when the system keychain is
// unavailable (the default in v1 — no cross-platform keychain binding yet),
// secrets are written to <stateDir>/app-plugins/secrets/<id>.json with 0600
// perms (POSIX) and the management UI shows a per-plugin "plaintext" banner.
// We do NOT claim encryption. A future revision swaps in a real keychain.
//
// Secrets are never returned in bulk — only via per-key get, and only to the
// plugin's own subprocess over RPC (never to the client).

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../log.js'

const log = createLogger('app-plugins:secrets')

export type SecretsBackend = 'keychain' | 'plaintext'

export class SecretsService {
  readonly backend: SecretsBackend
  private cache: Record<string, string> | null = null
  /** In-flight load so concurrent first-access calls don't clobber each
   *  other's mutations with stale disk contents. */
  private loading: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly pluginId: string,
    private readonly stateDir: string,
  ) {
    // v1: no keychain binding — always plaintext (0600). The field exists so
    // AppPluginClientInfo.secretsBackend can report the REAL mode, not an
    // aspiration.
    this.backend = 'plaintext'
  }

  private file(): string {
    return join(this.stateDir, 'app-plugins', 'secrets', `${this.pluginId}.json`)
  }

  private load(): Promise<Record<string, string>> {
    if (this.cache) return Promise.resolve(this.cache)
    if (this.loading) return this.loading.then(() => this.cache!)
    this.loading = (async () => {
      try {
        const raw = await fs.readFile(this.file(), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {}
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') log.warn(`[${this.pluginId}] failed to read secrets: ${e.message}`)
        this.cache = {}
      } finally {
        this.loading = null
      }
    })()
    return this.loading.then(() => this.cache!)
  }

  async get(key: string): Promise<{ value: string } | { found: false }> {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return { found: false }
    const data = await this.load()
    if (!Object.prototype.hasOwnProperty.call(data, key)) return { found: false }
    return { value: data[key] }
  }

  async set(key: string, value: string): Promise<void> {
    // Guard prototype-polluting keys — `data['__proto__'] = obj` would set
    // the cache's prototype via the setter (unlike spread, which defines).
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`illegal secret key: ${key}`)
    }
    const data = await this.load()
    data[key] = value
    await this.persist()
  }

  async delete(key: string): Promise<void> {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return
    const data = await this.load()
    if (!Object.prototype.hasOwnProperty.call(data, key)) return
    delete data[key]
    await this.persist()
  }

  private persist(): Promise<void> {
    this.writing = this.writing.then(() => this.writeNow()).catch((err) => {
      log.warn(`[${this.pluginId}] secrets write failed: ${(err as Error).message}`)
    })
    return this.writing
  }

  private async writeNow(): Promise<void> {
    const file = this.file()
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.cache ?? {}, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { await fs.chmod(tmp, 0o600) } catch { /* Windows: no POSIX perms */ }
    await fs.rename(tmp, file)
  }
}
