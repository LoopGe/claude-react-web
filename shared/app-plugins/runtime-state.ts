// Runtime state for App Plugins — the state machine, the server-side record,
// and the client-facing info shape that flows over the WS snapshot frames.
//
// The state machine is the single source of truth for "what is this plugin
// doing right now". Transitions are validated in the manager; the values
// here are the legal nodes. v1 keeps the full set from the original plan
// (the runtime needs them all) — `permission-required` and `incompatible`
// are reachable at enable time even though `.crwp` updates are deferred.

import type { NormalisedPermission } from './permissions.js'
import type { ResolvedPluginContributions } from './contributions.js'

// ── State machine ────────────────────────────────────────────────────

export type PluginRuntimeState =
  | 'disabled' // user disabled; no subprocess, contributions unregistered
  | 'inactive' // enabled, no subprocess running (lazy activation)
  | 'activating' // subprocess spawning / activate() in flight
  | 'active' // subprocess up, activate() completed
  | 'deactivating' // deactivate() in flight (teardown)
  | 'crashed' // subprocess exited unexpectedly (under crash-loop window)
  | 'quarantined' // 3 crashes in 5 min; no auto-restart
  | 'incompatible' // engines/manifestVersion check failed at load
  | 'permission-required' // new version needs re-consent
  | 'corrupted' // manifest/entry failed to (re)load after install

export const ENABLED_RUNTIME_STATES: PluginRuntimeState[] = [
  'inactive',
  'activating',
  'active',
  'deactivating',
  'crashed',
  'quarantined',
]

export function isEnabledState(s: PluginRuntimeState): boolean {
  return s !== 'disabled'
}

/** Legal forward transitions from a given state. The manager calls this
 *  before mutating; illegal transitions throw (a programming error, not a
 *  user-facing condition). `crashed`→`activating` is allowed (re-activation
 *  on next command) unless the crash loop has quarantined the plugin. */
export function canTransition(from: PluginRuntimeState, to: PluginRuntimeState): boolean {
  if (from === to) return true
  const allowed: Record<PluginRuntimeState, PluginRuntimeState[]> = {
    disabled: ['inactive', 'incompatible', 'permission-required', 'corrupted', 'disabled'],
    inactive: ['activating', 'active', 'disabled', 'corrupted', 'incompatible', 'permission-required', 'inactive'],
    activating: ['active', 'crashed', 'inactive', 'quarantined', 'disabled', 'activating'],
    active: ['deactivating', 'crashed', 'inactive', 'disabled', 'permission-required', 'active'],
    deactivating: ['inactive', 'disabled', 'crashed', 'deactivating'],
    crashed: ['activating', 'active', 'quarantined', 'disabled', 'inactive', 'crashed'],
    quarantined: ['inactive', 'disabled', 'activating', 'quarantined'],
    incompatible: ['disabled', 'incompatible'],
    'permission-required': ['inactive', 'disabled', 'permission-required'],
    corrupted: ['disabled', 'corrupted'],
  }
  return allowed[from].includes(to)
}

// ── Server-side persisted record ─────────────────────────────────────
//
// Stored by AppPluginStore (extends JsonFileStore). Big data / cache live
// in their own partitioned dirs, not in this record.

export interface AppPluginRecord {
  id: string
  installedVersion: string
  enabled: boolean
  /** Install source. `local` = local-directory in-place reference (realpath-
   *  resolved at install). `marketplace` = installed from a cloned App
   *  Plugin marketplace; `path` is the plugin's subdir within the clone
   *  (stable across `gitPull`, so revalidate picks up content changes),
   *  and `marketplaceId`/`pluginName` link it back for updates/GC. */
  source:
    | { type: 'local'; path: string; addedAt: number }
    | { type: 'marketplace'; marketplaceId: string; pluginName: string; path: string; addedAt: number }
  manifestHash: string
  /** Manifest as last validated. Re-validated on every load; a mismatch
   *  with the on-disk file transitions to `corrupted`. */
  manifest: unknown
  /** Permissions the user has explicitly granted. Compared against the
   *  declared set on (re)enable / update to detect escalation. */
  grantedPermissions: NormalisedPermission[]
  runtimeState: PluginRuntimeState
  lastError?: string
  /** Crash timestamps (ms epoch) within the rolling 5-min window used by
   *  the crash-loop quarantine check. Trimmed to the window on each push. */
  crashTimestamps?: number[]
}

/** A plugin source without `addedAt` (used while building a record — the
 *  install branches stamp `addedAt` per-branch). */
export type PluginSourceBase =
  | { type: 'local'; path: string }
  | { type: 'marketplace'; marketplaceId: string; pluginName: string; path: string }

// ── Client-facing info (WS snapshot / REST GET) ──────────────────────

export interface AppPluginClientInfo {
  id: string
  name: string
  description?: string
  version: string
  publisher?: string
  license?: string
  enabled: boolean
  runtimeState: PluginRuntimeState
  lastError?: string
  /** Declared permissions (what the manifest asks for). */
  declaredPermissions: NormalisedPermission[]
  /** Granted permissions (what the user consented to). */
  grantedPermissions: NormalisedPermission[]
  /** Whether the current installed version requires re-consent. */
  permissionRequired: boolean
  /** Whether the host considers this version compatible. */
  compatible: boolean
  /** Secrets storage backend in effect (honest — 'plaintext' when keychain
   *  unavailable). Surfaced as a per-plugin banner in the management UI. */
  secretsBackend: 'keychain' | 'plaintext' | 'none'
  /** Static contributions, available without activating the subprocess. */
  contributions: ResolvedPluginContributions
}
