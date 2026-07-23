// App Plugin Manifest v1 — the declaration file (`crw-plugin.json`) every
// plugin ships at its root.
//
// This module is the TYPE ONLY. Parsing raw JSON + structural validation
// lives in server/app-plugins/manifest-validator.ts (it needs path-security
// + realpath, which are server-side). The shape here is the contract both
// ends import so the server (validate) and client (display) can't drift.

import type { PluginContributions } from './contributions.js'
import type { PermissionSpec } from './permissions.js'

export const MANIFEST_VERSION = 1
export const MANIFEST_FILE = 'crw-plugin.json'

export interface PluginManifestEngines {
  /** SemVer range against the host's package version. Required. */
  claudeReactWeb: string
  /** SemVer range against the plugin API version. OPTIONAL in v1 — inferred
   *  from manifestVersion (1 ⟹ pluginApi 1.x) until @claude-react-web/plugin-api
   *  is actually published. Making it required now would assert against a
   *  package that doesn't exist. */
  pluginApi?: string
  /** SemVer range against the Node major the host runs. Required. */
  node: string
}

export interface PluginManifestRuntime {
  /** Entry to the background service, relative to the plugin root. v1
   *  requires an ESM `.mjs` pre-built artifact — the host never runs
   *  install/build steps. */
  service: string
}

export interface PluginManifest {
  /** Schema URL (informational; not fetched). */
  $schema?: string
  manifestVersion: 1
  /** Stable reverse-DNS id, lowercase, immutable after install. */
  id: string
  name: string
  description?: string
  version: string
  publisher?: string
  license?: string
  engines: PluginManifestEngines
  runtime: PluginManifestRuntime
  /** When to lazily activate the subprocess. v1 supports `onCommand:<id>`
   *  and `onStartup` (the latter activates at host boot). */
  activationEvents?: string[]
  permissions: PermissionSpec[]
  contributes: PluginContributions
}

/** Discriminator helper for narrowing parsed JSON. */
export function isManifestShape(v: unknown): v is PluginManifest {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { manifestVersion?: unknown }).manifestVersion === 1 &&
    typeof (v as { id?: unknown }).id === 'string'
  )
}
