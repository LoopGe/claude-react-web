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

  /** Validate + merge `values` into the stored config. Only known, valid keys
   *  are persisted — unknown keys are silently dropped (the manifest is the
   *  schema source of truth). Returns the validation errors (empty on success)
   *  plus whether the persisted config actually changed, so a caller can skip
   *  downstream work (like a service reload) on a no-op PUT. */
  async set(
    props: PluginConfigurationProperty[],
    values: Record<string, unknown>,
  ): Promise<{ errors: string[]; changed: boolean }> {
    const known = new Map(props.map((p) => [p.key, p]))
    const errors: string[] = []
    const loaded = await this.load()
    const next = { ...loaded }
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
    if (errors.length > 0) return { errors, changed: false }
    // Compare the EFFECTIVE config (defaults applied) before vs after the merge,
    // not the raw stored representation: writing the declared default explicitly
    // (or clearing a stored key back to its default) leaves what a plugin reads
    // unchanged, so it is a no-op and must not trigger a service reload.
    const before = applyConfigDefaults(props, loaded)
    const after = applyConfigDefaults(props, next)
    const changed = !configsEqual(before, after)
    if (!changed) return { errors, changed: false }
    this.cache = next
    this.writing = this.writing.then(() => this.persist(next)).catch((err) => {
      log.warn(`[${this.pluginId}] config write failed: ${(err as Error).message}`)
    })
    await this.writing
    return { errors, changed: true }
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

/** Deep equality for persisted config values (JSON-serializable: string /
 *  number / boolean / string[] / nested objects). Key order is ignored. */
function configsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => configsEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ka = Object.keys(ao)
    const kb = Object.keys(bo)
    return ka.length === kb.length && ka.every((k) => configsEqual(ao[k], bo[k]))
  }
  return false
}
