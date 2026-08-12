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
 *  is each plugin's own `crw-plugin.json` (re-validated at install).
 *
 *  `installed` / `installedVersion` are NOT part of the persisted catalog —
 *  they are annotated by `GET /:id/plugins` so the UI can show an already-
 *  installed plugin as "Installed" (or "Update" on a newer catalog version)
 *  instead of a bare Install button. */
export interface AppPluginMarketplacePlugin {
  name: string
  dir: string
  description?: string
  version?: string
  /** True when a plugin with this catalog name is already installed from
   *  this marketplace. Omitted on the persisted manifest; set only by the
   *  plugins route's annotation. */
  installed?: boolean
  /** Installed version, present when `installed`. */
  installedVersion?: string
}

/** Parsed marketplace catalog. */
export interface AppPluginMarketplaceManifest {
  name?: string
  plugins: AppPluginMarketplacePlugin[]
}

/** Where a marketplace's plugin content comes from. `https` = a user-added
 *  cloned git repo; `local` = a bundled dir shipped with the app
 *  (dist/plugins/) that is read in place, never cloned. */
export type AppPluginMarketplaceSource =
  | { type: 'https'; url: string; ref?: string }
  | { type: 'local'; path: string }

/** A marketplace record persisted in the store (one per cloned repo). */
export interface AppPluginMarketplaceRecord {
  /** URL-safe slug used as the on-disk clone dir name + route :id. */
  id: string
  displayName: string
  source: AppPluginMarketplaceSource
  /** Optional relative path within cloneDir that holds the marketplace
   *  content (catalog + plugin dirs). The official host repo keeps its
   *  catalog in `plugins/`, so a marketplace seeded from it uses
   *  subdir: 'plugins'. Absent = content is at cloneDir root. */
  subdir?: string
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
  sourceType: 'https' | 'local'
  url?: string
  ref?: string
  subdir?: string
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
}
