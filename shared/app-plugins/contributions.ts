// App Plugin contribution points — the declarative surface a plugin adds to
// the host UI without running any code. Validating the manifest registers
// these; activating the subprocess only happens when a command is invoked.
//
// A contribution carries ONLY data: ids, titles, a host-icon id, a command
// id, a location, an order, and a `when` clause. Never functions, HTML, or
// React nodes. Everything dynamic comes back through the command result
// contract (command-result.ts) which the host renders.

import type { WhenLiteral } from './when.js'

// ── Locations ────────────────────────────────────────────────────────

export type PluginContextMenuLocation =
  | 'message.contextMenu'
  | 'message.selectionContextMenu'
  | 'message.codeBlockContextMenu'
  | 'session.contextMenu'
  | 'git.fileContextMenu'

export type PluginActionLocation = 'chat.header' | 'chat.composer' | 'sidebar.footer'

/** v1 has no iframe Views (deferred). The location union is kept for forward
 *  compatibility but no view contribution type is exported. */
export type PluginViewLocation = 'global.sidebar' | 'global.page' | 'chat.tab' | 'chat.overlay' | 'settings.plugin'

// ── Icon ─────────────────────────────────────────────────────────────
//
// Plugins reference host-provided icons by id (e.g. 'translate', 'copy') so
// the UI never loads arbitrary plugin image bytes into the trusted document.
// v1 ships a small fixed set; an unknown icon id falls back to a generic
// glyph. (Asset serving for plugin-supplied SVGs is a Phase 4 concern.)

export type PluginHostIconId = string

// ── Commands ─────────────────────────────────────────────────────────

export interface PluginCommandContribution {
  /** `<pluginId>.<name>` — must be prefixed by the plugin id. */
  id: string
  title: string
  /** Short tooltip / aria description. */
  description?: string
  /** Host icon id shown in palettes / menus. */
  icon?: PluginHostIconId
  /** Where this command is reachable. If omitted, the command is only
   *  reachable via the Command Palette (global). */
  category?: 'global' | 'session' | 'message' | 'message.selection' | 'git.file'
  /** Show in the Command Palette. Default true. */
  showInPalette?: boolean
  when?: string
  order?: number
}

// ── Context menus ────────────────────────────────────────────────────

export interface PluginContextMenuContribution {
  /** `<pluginId>.<name>`. */
  id: string
  location: PluginContextMenuLocation
  commandId: string
  title: string
  icon?: PluginHostIconId
  when?: string
  order?: number
}

// ── Header / composer / footer actions ───────────────────────────────

export interface PluginActionContribution {
  /** `<pluginId>.<name>`. */
  id: string
  location: PluginActionLocation
  commandId: string
  title: string
  icon?: PluginHostIconId
  when?: string
  order?: number
}

// ── Declarative configuration ────────────────────────────────────────
//
// A restricted JSON-Schema subset the host renders into a settings form.
// Complex settings are deferred to (future) iframe Views — v1 renders only
// these primitive fields. See configuration.ts for the schema subset.

export interface PluginConfigurationProperty {
  /** `<pluginId>.<key>` — must be prefixed by the plugin id. */
  key: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array'
  title: string
  description?: string
  default?: unknown
  /** For `enum`: the selectable values. */
  enum?: Array<string | number>
  /** For `array`: element type (string only in v1). */
  items?: 'string'
  /** For `string`/`array`: max length / max item count. */
  maxLength?: number
}

export interface PluginConfigurationContribution {
  properties: PluginConfigurationProperty[]
}

// ── Status indicator override ────────────────────────────────────────
//
// A declarative UI override: the plugin provides an image (GIF/SVG/PNG)
// that the host renders INSTEAD OF the default "working..." indicator when
// the `when` clause holds. The image is served via
// GET /api/app-plugins/:id/assets/<asset>. No iframe, no subprocess —
// pure declarative replacement. This is the first substitutive (vs
// additive) contribution point.

export interface PluginStatusIndicatorContribution {
  /** `<pluginId>.<name>` — must be prefixed by the plugin id. */
  id: string
  /** Relative path to the image under the plugin dir (GIF/SVG/PNG/WEBP).
   *  Validated via validateRelativePath (no .. / absolute / symlink). */
  asset: string
  /** When clause, e.g. "session.working == true". */
  when?: string
  order?: number
}

// ── Widgets ────────────────────────────────────────────────────────────
//
// A data-driven live widget: the plugin pushes JSON payloads (via the
// `app.event` RPC notification) and the host renders them with a built-in
// renderer (`kind`). The plugin never ships DOM — this keeps the v1
// "declarative contributions" contract intact while enabling live data.

export type PluginWidgetLocation = 'global.bottomLeft'
export type PluginWidgetKind = 'stat-grid'

export interface PluginWidgetContribution {
  /** `<pluginId>.<name>` — must be prefixed by the plugin id. */
  id: string
  location: PluginWidgetLocation
  /** Host renderer key. v1 ships 'stat-grid'. */
  kind: PluginWidgetKind
  title?: string
  when?: string
  order?: number
}

// ── Aggregate ────────────────────────────────────────────────────────

export interface PluginContributions {
  commands?: PluginCommandContribution[]
  contextMenus?: PluginContextMenuContribution[]
  actions?: PluginActionContribution[]
  configuration?: PluginConfigurationContribution
  statusIndicators?: PluginStatusIndicatorContribution[]
  widgets?: PluginWidgetContribution[]
}

/** A plugin's contributions after manifest validation, with `when` clauses
 *  pre-compiled. Unknown contribution locations / categories are dropped at
 *  validation time and reported as diagnostics, not stored. */
export interface ResolvedPluginContributions {
  commands: PluginCommandContribution[]
  contextMenus: PluginContextMenuContribution[]
  actions: PluginActionContribution[]
  configuration: PluginConfigurationContribution
  statusIndicators: PluginStatusIndicatorContribution[]
  widgets: PluginWidgetContribution[]
  /** Contribution-level diagnostics (unknown location, duplicate id, etc.)
   *  that did not block registration. Surfaced in the management UI. */
  diagnostics: string[]
}

/** Context keys the host publishes for `when` evaluation, keyed by the
 *  location the contribution lives in. The host merges these into a single
 *  WhenContext before filtering. Re-exported here so adapters and the client
 *  agree on the key vocabulary. */
export type WhenContextKey =
  | 'plugin.enabled'
  | 'workspace.trusted'
  | 'session.active'
  | 'session.working'
  | 'session.provider'
  | 'message.hasSelection'
  | 'message.selectionLength'
  | 'message.contentType'
  | 'git.isRepo'
  | 'git.dirty'
  | 'theme'

export type WhenContextMap = Record<WhenContextKey, WhenLiteral | undefined>
