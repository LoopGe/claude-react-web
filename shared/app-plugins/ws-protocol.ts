// WebSocket frame shapes for App Plugin state sync and plugin-pushed events.
//
// v1 adds exactly FOUR new server→client frame kinds (per the cut-down
// review decision — there is no *generic* `app-plugin-event` tunnel;
// plugins do not push arbitrary cross-tab messages. The one exception is
// `WsAppPluginEvent`, which carries narrow widget payloads (pluginId +
// widgetId + StatGridPayload) from plugin background code to the UI).
// These are added to the canonical closed union in shared/ws-protocol.ts
// during Stage B1 wiring, then aliased in server/ws-protocol.ts and
// src/ws-types.ts.

import type { AppPluginClientInfo } from './runtime-state.js'
import type { ResolvedPluginContributions } from './contributions.js'
import type { StatGridPayload } from './widget.js'

/** Sent on connection (after the sessions snapshot) and whenever the full
 *  plugin set changes in a way that's cheaper to re-broadcast wholesale
 *  than diff (install/uninstall/bulk re-enable). Clients replace their
 *  entire plugin map. */
export interface WsAppPluginsSnapshot {
  kind: 'app-plugins-snapshot'
  plugins: AppPluginClientInfo[]
}

/** A single plugin's runtime state or metadata changed (enable/disable,
 *  crash, quarantine, permission grant). Clients upsert the plugin entry. */
export interface WsAppPluginStateChanged {
  kind: 'app-plugin-state-changed'
  plugin: AppPluginClientInfo
}

/** A plugin's static contributions changed (re-validate after a manifest
 *  edit, or contributions registered on enable). Clients replace just that
 *  plugin's contributions. Separate from state-changed so a contributions
 *  refresh doesn't force a full state resync. */
export interface WsAppPluginContributionsChanged {
  kind: 'app-plugin-contributions-changed'
  pluginId: string
  contributions: ResolvedPluginContributions
}

/** A plugin-pushed widget payload (e.g. stat-grid data from a background
 *  plugin). Narrow by design — carries only pluginId, widgetId, and a
 *  typed payload; no generic message bus. */
export interface WsAppPluginEvent {
  kind: 'app-plugin-event'
  pluginId: string
  widgetId: string
  payload: StatGridPayload
}

export type AppPluginWsFrame =
  | WsAppPluginsSnapshot
  | WsAppPluginStateChanged
  | WsAppPluginContributionsChanged
  | WsAppPluginEvent
