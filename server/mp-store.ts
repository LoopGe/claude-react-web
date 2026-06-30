// Persistent store for the homegrown git-repo marketplace.
//
// Holds two slices of state in one file (`<stateDir>/marketplaces.json`):
//
//   - `marketplaces`: a keyed map of MpEntry, one per cloned marketplace.
//     Each entry caches the parsed manifest so route handlers don't have
//     to re-read disk on every list/plugin GET.
//
//   - `enabledPlugins`: a flat map keyed `"<plugin>@<marketplace>"` to
//     boolean. Mirrors the SDK's `Settings.enabledPlugins` shape so we
//     can hand the same key directly to `applyFlagSettings()`.
//
// We extend JsonFileStore to inherit the debounced atomic write machinery,
// using `index` as the marketplace map and tracking enabledPlugins as a
// side fiel?. Serialisation merges both back into the on-disk shape;
// parsing populates both in `load()`.

import { promises as fs, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { resolve as resolvePath, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'
import { createLogger } from './log.js'
import {
  MANIFEST_REL_PATH,
  PLUGIN_MANIFEST_REL_PATH,
  isValidParsedSource,
  parseRepoManifest,
  type MarketplaceManifest,
} from './marketplace-parser.js'

const log = createLogger('mp-store')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MpEntry {
  /** URL-safe slug used as the on-disk dir name and the route :id param. */
  id: string
  /** Display name pulled from the manifest. May contain spaces / unicode;
   *  unlike `id` it's NOT used for paths. */
  displayName: string
  source: { type: 'https'; url: string; ref?: string }
  /** Absolute path to the cloned repo on disk. */
  cloneDir: string
  /** Epoch ms when the marketplace was first adde?. */
  addedAt: number
  /** Epoch ms of the most recent successful refresh. Equals addedAt
   *  immediately after ad?. */
  lastRefreshedAt: number
  /** HEAD SHA of the most recent successful clone/pull. */
  lastSha: string
  /** Cached parsed manifest. Refreshed on every clone/pull. */
  manifest: MarketplaceManifest
}

interface MpFileShape {
  version: 1
  marketplaces: Record<string, MpEntry>
  enabledPlugins: Record<string, boolean>
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type MpStoreOptions = JsonFileStoreOptions

export class MpStore extends JsonFileStore<MpEntry> {
  /** Side state: `<plugin>@<marketplace>` ?enabled. Sits alongside the
   *  `index` (which JsonFileStore manages for us). Mutations call
   *  `markDirty()` which wraps the base class's debounce timer. */
  private enabled = new Map<string, boolean>()

  /** Subdir under `dir` where cloned repos live. Each marketplace gets its
   *  own folder name by its slug. */
  readonly cacheDir: string

  /** Holds clones of EXTERNAL repos referenced by `git-subdir` plugins.
   *  Keyed by a hash of (url, sha) so the same repo at the same commit is
   *  cloned once and shared across plugins / marketplaces. Deliberately a
   *  SIBLING of `cacheDir` (not a child) so it can never collide with a
   *  marketplace slug — a slug is always a child of `cacheDir`, so external
   *  clones living one level up are in a separate namespace entirely. This
   *  also keeps `gitPull --ff-only` on a marketplace repo from ever touching
   *  an external clone. */
  readonly externalCacheDir: string

  constructor(opts: MpStoreOptions = {}) {
    super(opts, 'marketplaces.json', DEFAULT_DIR_NAME, 'mp-store')
    this.cacheDir = join(this.dir, 'marketplace-cache')
    this.externalCacheDir = join(this.dir, 'external-cache')
  }

  /** Deterministic on-disk dir for an external repo pinned at `sha`. Same
   *  (url, sha) — same dir, so multiple git-subdir plugins from one repo
   *  clone it once. */
  externalCloneDir(url: string, sha: string): string {
    const hash = createHash('sha256').update(`${url}\0${sha}`).digest('hex').slice(0, 16)
    return join(this.externalCacheDir, hash)
  }

  protected getKey(entry: MpEntry): string {
    return entry.id
  }

  protected parseItems(raw: string): MpEntry[] {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn(`${this.file} is not an object; ignoring`)
      return []
    }
    const obj = parsed as Partial<MpFileShape>
    // Pull enabledPlugins straight off the parsed object ?load() reads
    // both halves, but only entries[] flows back through the base class
    // template. Overwrite our side state in place rather than via a
    // separate hook so we don't add a second template metho?.
    if (obj.enabledPlugins && typeof obj.enabledPlugins === 'object' && !Array.isArray(obj.enabledPlugins)) {
      this.enabled.clear()
      for (const [k, v] of Object.entries(obj.enabledPlugins)) {
        if (typeof v === 'boolean') this.enabled.set(k, v)
      }
    }
    const entries: MpEntry[] = []
    if (obj.marketplaces && typeof obj.marketplaces === 'object' && !Array.isArray(obj.marketplaces)) {
      for (const [id, value] of Object.entries(obj.marketplaces)) {
        const coerced = coerceMpEntry(value, id)
        if (coerced) entries.push(coerced)
      }
    }
    return entries
  }

  protected serializeForWrite(items: MpEntry[]): unknown {
    const marketplaces: Record<string, MpEntry> = {}
    for (const e of items) marketplaces[e.id] = e
    const enabledPlugins: Record<string, boolean> = {}
    for (const [k, v] of this.enabled) enabledPlugins[k] = v
    const out: MpFileShape = { version: 1, marketplaces, enabledPlugins }
    return out
  }

  /** Load both halves of the file into memory. Same shape as
   *  McpConfigStore.load() — missing/corrupt — empty store. */
  async load(): Promise<MpEntry[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const entries = this.parseItems(raw)
      this.initEntries(entries)
      await this.reparseCachedManifests(entries)
      return this.list()
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      log.warn(`failed to read ${this.file}: ${e.message}`)
      return []
    }
  }

  // ─── Marketplace operations ──────────────────────────────────────

  /** Generate a unique slug from a URL. Prefers the last path segment
   *  with `.git` stripped; sanitises to the safe charset; appends a
   *  numeric suffix on collision. */
  generateId(url: string): string {
    const stem = deriveSlug(url)
    if (!this.has(stem)) return stem
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem}-${i}`
      if (!this.has(candidate)) return candidate
    }
    // Pathological fallback (1000 collisions for the same stemd something
    // is very wrong) — append a timestamp to guarantee uniqueness.
    return `${stem}-${Date.now()}`
  }

  /** Compute the on-disk clone destination for a freshly-generated id.
   *  Caller is responsible for ensuring the dir doesn't exist before
   *  invoking gitClone (the JsonFileStore base writes to its `dir` lazily,
   *  so the cache dir is created on first write — we mkdir defensively
   *  before the clone in the route layer). */
  cloneDirFor(id: string): string {
    return join(this.cacheDir, id)
  }

  /** Hard-remove an entry: drop from index, drop all enabledPlugins
   *  scope to this marketplace, recursively delete the clone dir.
   *  Filesystem errors are swallowed — the store is still updated so a
   *  stale clone dir doesn't keep the user from re-adding. */
  async removeEntry(id: string): Promise<void> {
    const entry = this.get(id)
    this.remove(id)
    // Strip every enabledPlugin keyed `<x>@<id>`.
    for (const key of Array.from(this.enabled.keys())) {
      if (key.endsWith(`@${id}`)) this.enabled.delete(key)
    }
    await this.flush()
    if (entry?.cloneDir) {
      try {
        await rm(entry.cloneDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (err) {
        log.warn(`failed to remove clone dir ${entry.cloneDir}: ${(err as Error).message}`)
      }
    }
    // Drop any external git-subdir clones this marketplace's plugins were the
    // last enabled reference to.
    await this.pruneExternalClones()
  }

  // ─── Plugin enable/disable ───────────────────────────────────────

  /** Compose the canonical key. Mirrors the SDK's Settings.enabledPlugins
   *  format, so the same key can be passed straight to applyFlagSettings. */
  static keyOf(plugin: string, marketplace: string): string {
    return `${plugin}@${marketplace}`
  }

  isEnabled(plugin: string, marketplace: string): boolean {
    return this.enabled.get(MpStore.keyOf(plugin, marketplace)) === true
  }

  setEnabled(plugin: string, marketplace: string, enabled: boolean): void {
    const key = MpStore.keyOf(plugin, marketplace)
    if (enabled) {
      this.enabled.set(key, true)
    } else {
      // Drop entries on disable rather than persisting `false` — keeps
      // the file slim and matches how we'd treat an "unknown" plugin
      // (default off).
      this.enabled.delete(key)
    }
    // The JsonFileStore base class only schedules flushes on
    // upsert/remove of items in `index`. Side-state mutations need a
    // manual nudge ?re-upserting is the cheapest way to set dirty
    // without inventing a new template metho?.
    const owner = this.get(marketplace)
    if (owner) this.upsert(owner)
    else void this.flush()
  }

  /** Resolve a bare plugin name to the SDK compound key "<plugin>@<marketplace>".
   *  Returns undefined when the name isn't found in any marketplace, or when it
   *  appears in multiple marketplaces (ambiguous — the caller should fall back
   *  to the bare name or error). */
  resolveCompoundKey(bareName: string): string | undefined {
    let found: string | undefined
    for (const entry of this.list()) {
      if (entry.manifest.plugins.some((p) => p.name === bareName)) {
        if (found) return undefined // ambiguous ?same name in multiple marketplaces
        found = MpStore.keyOf(bareName, entry.id)
      }
    }
    return found
  }

  /** Snapshot the enabled flags for a single marketplace. Used to
   *  populate the plugin-list response. */
  enabledMapFor(marketplace: string): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    const suffix = `@${marketplace}`
    for (const [k, v] of this.enabled) {
      if (k.endsWith(suffix)) out[k.slice(0, -suffix.length)] = v
    }
    return out
  }

  /** Walk every enabled plugin and return its absolute on-disk dir.
   *  Used by SessionManager.spawn() to populate Options.plugins. Plugins
   *  whose marketplace is gone, or whose dir disappeared, are silently
   *  dropped — the consumer is the SDK and a non-existent path would
   *  fail the spawn outright. */
  getEnabledPluginAbsolutePaths(): string[] {
    const paths: string[] = []
    // Dedupe: two enabled plugins can resolve to the same dir (e.g. a `url`
    // git-subdir plugin pointing at a repo root, or the same path reached via
    // two marketplaces). The SDK loads each entry of Options.plugins, so a
    // duplicate path would register the plugin — and its commands/agents —    // twice. Collapse to a set.
    const seen = new Set<string>()
    const push = (p: string) => {
      if (seen.has(p)) return
      seen.add(p)
      paths.push(p)
    }
    for (const [key, on] of this.enabled) {
      if (!on) continue
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      const pluginName = key.slice(0, at)
      const marketplaceId = key.slice(at + 1)
      const entry = this.get(marketplaceId)
      if (!entry) continue
      const plugin = entry.manifest.plugins.find((p) => p.name === pluginName)
      if (!plugin) continue
      if (plugin.source && plugin.source.kind === 'git-subdir') {
        // The plugin's files live in an external repo cloned lazily on
        // enable. Resolve its eventual subdir; skip silently if the clone
        // hasn't happened (or vanished) ?handing the SDK a missing path
        // would fail the spawn.
        const abs = resolvePath(
          this.externalCloneDir(plugin.source.url, plugin.source.sha),
          plugin.source.subPath,
        )
        if (existsSync(abs)) push(abs)
      } else if (plugin.dir) {
        // In-repo plugin. Left unguarded (no existsSync) intentionally —        // the dir was verified to exist at parse time.
        push(plugin.dir)
      }
    }
    return paths
  }

  /** Like {@link getEnabledPluginAbsolutePaths}, but resolve only the
   *  plugins whose compound key is in `keys` (and which are still enabled).
   *  Used when a session explicitly requests a subset of enabled plugins.
   *  Disabled or unknown keys are silently dropped; the same path-dedupe
   *  and existsSync guards as the parent method apply. */
  getEnabledPluginAbsolutePathsFor(keys: string[]): string[] {
    const wanted = new Set(keys)
    const paths: string[] = []
    const seen = new Set<string>()
    const push = (p: string) => {
      if (seen.has(p)) return
      seen.add(p)
      paths.push(p)
    }
    for (const [key, on] of this.enabled) {
      if (!on) continue
      if (!wanted.has(key)) continue
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      const pluginName = key.slice(0, at)
      const marketplaceId = key.slice(at + 1)
      const entry = this.get(marketplaceId)
      if (!entry) continue
      const plugin = entry.manifest.plugins.find((p) => p.name === pluginName)
      if (!plugin) continue
      if (plugin.source && plugin.source.kind === 'git-subdir') {
        const abs = resolvePath(
          this.externalCloneDir(plugin.source.url, plugin.source.sha),
          plugin.source.subPath,
        )
        if (existsSync(abs)) push(abs)
      } else if (plugin.dir) {
        push(plugin.dir)
      }
    }
    return paths
  }

  /** Best-effort GC of external git-subdir clones no longer referenced by
   *  any still-enabled plugin across ALL marketplaces. Called after remove /
   *  refresh. Filesystem errors are swallowed — an orphaned clone only costs
   *  disk; deleting a still-referenced one would break a live plugin, so the
   *  reference set is computed across every marketplace, not just one. */
  async pruneExternalClones(): Promise<void> {
    if (!existsSync(this.externalCacheDir)) return
    // Compute the set of clone-dir basenames still referenced by an enabled
    // git-subdir plugin.
    const referenced = new Set<string>()
    for (const [key, on] of this.enabled) {
      if (!on) continue
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      const pluginName = key.slice(0, at)
      const marketplaceId = key.slice(at + 1)
      const entry = this.get(marketplaceId)
      if (!entry) continue
      const plugin = entry.manifest.plugins.find((p) => p.name === pluginName)
      if (plugin?.source && plugin.source.kind === 'git-subdir') {
        referenced.add(this.externalCloneDir(plugin.source.url, plugin.source.sha))
      }
    }
    try {
      const entries = await fs.readdir(this.externalCacheDir)
      for (const name of entries) {
        const full = join(this.externalCacheDir, name)
        if (!referenced.has(full)) {
          await rm(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
        }
      }
    } catch (err) {
      log.warn(`pruneExternalClones failed: ${(err as Error).message}`)
    }
  }

  /** Metadata for every enabled plugin across all marketplaces, for the
   *  New Session dialog's plugin picker. `key` is the compound key the
   *  dialog submits back as `enabledPlugins`. */
  enabledPluginEntries(): { key: string; name: string; marketplace: string; description?: string; version?: string }[] {
    const out: { key: string; name: string; marketplace: string; description?: string; version?: string }[] = []
    for (const [key, on] of this.enabled) {
      if (!on) continue
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      const pluginName = key.slice(0, at)
      const marketplaceId = key.slice(at + 1)
      const entry = this.get(marketplaceId)
      if (!entry) continue
      const plugin = entry.manifest.plugins.find((p) => p.name === pluginName)
      if (!plugin) continue
      out.push({
        key,
        name: plugin.name,
        marketplace: marketplaceId,
        description: plugin.description,
        version: plugin.version,
      })
    }
    return out
  }

  /** Snapshot of every enabled `<plugin>@<marketplace>` key. Used by the
   *  toggle route to push state into live sessions. */
  enabledKeys(): string[] {
    const out: string[] = []
    for (const [k, v] of this.enabled) {
      if (v) out.push(k)
    }
    return out
  }

  /** Re-parse already-cloned repo manifests with the current parser.
   *  The persisted file caches parsed manifests for fast route reads, but older
   *  app versions may have cached a lossy parse. Loading from the local clone
   *  lets parser fixes take effect without requiring a network refresh. Handles
   *  both manifest forms: a marketplace (marketplace.json) or a single-plugin
   *  repo (plugin.json) — skipping entries whose clone (and both manifests)
   *  has disappeared. */
  private async reparseCachedManifests(entries: MpEntry[]): Promise<void> {
    let changed = false
    for (const entry of entries) {
      const hasMarketplace = existsSync(join(entry.cloneDir, MANIFEST_REL_PATH))
      const hasPlugin = existsSync(join(entry.cloneDir, PLUGIN_MANIFEST_REL_PATH))
      if (!hasMarketplace && !hasPlugin) continue
      try {
        const { manifest } = await parseRepoManifest(entry.cloneDir)
        const displayName = manifest.name || entry.displayName
        if (displayName === entry.displayName && sameManifest(entry.manifest, manifest)) continue
        this.upsert({ ...entry, displayName, manifest })
        changed = true
      } catch (err) {
        log.warn(`failed to reparse cached marketplace ${entry.id}: ${(err as Error).message}`)
      }
    }
    if (changed) await this.flush()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default state directory. Mirrors `defaultStateDir` from persistence.ts — *  duplicated here so callers don't need to import that module. */
export function defaultMpStateDir(): string {
  return resolvePath(homedir(), DEFAULT_DIR_NAME)
}

/** Derive a slug from a git URL. Examples:
 *    https://github.com/owner/repo.git — repo
 *    https://github.com/owner/repo     — repo
 *    https://example.com/foo/bar/      — bar
 *  Falls back to "marketplace" for un-parseable inputs. */
function deriveSlug(url: string): string {
  let raw = url.trim()
  // Strip protocol + leading slashes so the last meaningful segment wins.
  raw = raw.replace(/^https:\/\//, '').replace(/\/+$/, '')
  // Drop trailing .git so https://.../foo.git ?foo, not foo.git.
  raw = raw.replace(/\.git$/i, '')
  const segs = raw.split('/').filter(Boolean)
  const last = segs[segs.length - 1] ?? ''
  // Sanitise: keep [a-zA-Z0-9._-], collapse runs of disallowed chars to
  // single dashes, trim leading/trailing dashes/dots.
  const sanitised = last
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (sanitised && sanitised.length > 0 && sanitised.length <= 64) return sanitised
  return 'marketplace'
}

/** Coerce a single MpEntry from raw JSON. Returns null if the entry can't
 *  be salvaged. We're lenient on optional fields but strict on the ones
 *  that drive route behaviour (id, cloneDir, source.url). */
function coerceMpEntry(raw: unknown, fallbackId: string): MpEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : fallbackId
  if (!id) return null
  const src = r.source && typeof r.source === 'object' && !Array.isArray(r.source)
    ? r.source as Record<string, unknown>
    : null
  if (!src || src.type !== 'https' || typeof src.url !== 'string' || !src.url) return null
  const cloneDir = typeof r.cloneDir === 'string' ? r.cloneDir : ''
  if (!cloneDir) return null
  const lastSha = typeof r.lastSha === 'string' ? r.lastSha : ''
  if (!/^[0-9a-f]{40}$/i.test(lastSha)) return null
  const manifestRaw = r.manifest
  if (!manifestRaw || typeof manifestRaw !== 'object') return null
  const manifest = manifestRaw as MarketplaceManifest
  if (typeof manifest.name !== 'string' || !Array.isArray(manifest.plugins)) return null
  // The file is untrusted (hand-editable). Drop any plugin whose persisted
  // git-subdir source fails the same checks the live parser enforces — a
  // tampered subPath like `../../..` must not survive load and reach
  // resolvePath in getEnabledPluginAbsolutePaths.
  manifest.plugins = manifest.plugins.filter((p) => isValidParsedSource(p?.source))
  return {
    id,
    displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : manifest.name || id,
    source: {
      type: 'https',
      url: src.url,
      ref: typeof src.ref === 'string' ? src.ref : undefined,
    },
    cloneDir,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now(),
    lastRefreshedAt: typeof r.lastRefreshedAt === 'number' ? r.lastRefreshedAt : Date.now(),
    lastSha,
    manifest,
  }
}

function sameManifest(current: MarketplaceManifest, next: MarketplaceManifest): boolean {
  return JSON.stringify(current) === JSON.stringify(next)
}
