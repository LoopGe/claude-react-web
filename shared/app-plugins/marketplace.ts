// App Plugin Marketplace types.
//
// A marketplace is a git repo (GitHub) the host clones. It either ships an
// `app-plugins-marketplace.json` at root listing its plugins, or the host
// auto-scans top-level subdirectories for a `crw-plugin.json` (the plugin
// manifests are the catalog). This is the App Plugin analogue of the Claude
// Plugin Marketplace — deliberately separate (own store/parser/routes/UI).

/** One plugin entry discovered in a marketplace clone. `dir` is relative to
 *  the clone root (validated for containment — no `..` / absolute). The
 *  name/description/version are hints from the catalog; the source of truth
 *  is each plugin's own `crw-plugin.json` (re-validated at install). */
export interface AppPluginMarketplacePlugin {
  name: string
  dir: string
  description?: string
  version?: string
}

/** Parsed marketplace catalog. */
export interface AppPluginMarketplaceManifest {
  name?: string
  plugins: AppPluginMarketplacePlugin[]
}

/** A marketplace record persisted in the store (one per cloned repo). */
export interface AppPluginMarketplaceRecord {
  /** URL-safe slug used as the on-disk clone dir name + route :id. */
  id: string
  displayName: string
  source: { type: 'https'; url: string; ref?: string }
  /** Absolute path to the cloned repo on disk. */
  cloneDir: string
  addedAt: number
  lastRefreshedAt: number
  /** HEAD SHA of the most recent successful clone/pull. */
  lastSha: string
  /** Cached parsed catalog. Refreshed on every clone/pull. */
  manifest: AppPluginMarketplaceManifest
}

/** Client-facing marketplace DTO (no cloneDir / raw manifest blob). */
export interface AppPluginMarketplaceInfo {
  id: string
  displayName: string
  url: string
  ref?: string
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
}
