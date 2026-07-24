// Per-plugin declarative configuration persistence.
//
// Stores the user-edited values for the manifest's
// `contributes.configuration.properties` under
// <stateDir>/app-plugins/data/<id>/config.json. Defaults are applied on read
// (applyConfigDefaults) so a missing value resolves to the declared default.
// Values are validated against the property declarations on write.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../log.js'
import { applyConfigDefaults, validateConfigValue, type ConfigValue } from '../../shared/app-plugins/configuration.js'
import type { PluginConfigurationProperty } from '../../shared/app-plugins/contributions.js'

const log = createLogger('app-plugins:config')

export class ConfigurationStore {
  private cache: Record<string, unknown> | null = null
  /** In-flight load so concurrent first-access calls don't clobber each
   *  other's mutations with stale disk contents. */
  private loading: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly pluginId: string,
    private readonly dataDir: string,
  ) {}

  private file(): string {
    return join(this.dataDir, 'config.json')
  }

  private load(): Promise<Record<string, unknown>> {
    if (this.cache) return Promise.resolve(this.cache)
    if (this.loading) return this.loading.then(() => this.cache!)
    this.loading = (async () => {
      try {
        const raw = await fs.readFile(this.file(), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') log.warn(`[${this.pluginId}] failed to read config: ${e.message}`)
        this.cache = {}
      } finally {
        this.loading = null
      }
    })()
    return this.loading.then(() => this.cache!)
  }

  /** Read with defaults applied. */
  async get(props: PluginConfigurationProperty[]): Promise<Record<string, ConfigValue>> {
    const raw = await this.load()
    return applyConfigDefaults(props, raw)
  }

  /** Validate + merge `values` into the stored config. Returns the list of
   *  validation errors (empty on success). Only known, valid keys are
   *  persisted — unknown keys are silently dropped (the manifest is the
   *  schema source of truth). */
  async set(props: PluginConfigurationProperty[], values: Record<string, unknown>): Promise<string[]> {
    const known = new Map(props.map((p) => [p.key, p]))
    const errors: string[] = []
    const next = { ...(await this.load()) }
    for (const [key, value] of Object.entries(values)) {
      const prop = known.get(key)
      if (!prop) continue // unknown key — drop
      const verr = validateConfigValue(prop, value)
      if (verr) {
        errors.push(verr.message)
        continue
      }
      // null/undefined → clear the stored key so the next read applies the
      // declared default (applyConfigDefaults defaults only on missing keys,
      // not on stored null). This is how a user "clears" a field to revert it.
      if (value === null || value === undefined) {
        delete next[key]
      } else {
        next[key] = value
      }
    }
    if (errors.length > 0) return errors
    this.cache = next
    this.writing = this.writing.then(() => this.persist(next)).catch((err) => {
      log.warn(`[${this.pluginId}] config write failed: ${(err as Error).message}`)
    })
    await this.writing
    return errors
  }

  private async persist(values: Record<string, unknown>): Promise<void> {
    const file = this.file()
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(values, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { await fs.chmod(tmp, 0o600) } catch { /* Windows */ }
    await fs.rename(tmp, file)
  }
}
