// In-memory registry of the static contributions from every ENABLED plugin.
//
// Built from validated manifests at enable time (and re-built on disable /
// uninstall). The manager owns this; the WS snapshot reads from it to ship
// `AppPluginClientInfo.contributions` to clients. Filtering by `when` happens
// client-side (where the live context keys live) — the registry only stores
// the raw contributions + pre-compiled `when` ASTs are NOT stored (the
// client re-compiles; the `when` string travels in the contribution).

import type {
  PluginActionContribution,
  PluginCommandContribution,
  PluginContextMenuContribution,
  PluginConfigurationContribution,
  ResolvedPluginContributions,
} from '../../shared/app-plugins/contributions.js'

interface RegistryEntry {
  pluginId: string
  contributions: ResolvedPluginContributions
}

export class ContributionRegistry {
  private byPlugin = new Map<string, RegistryEntry>()

  /** Register/replace a plugin's contributions. Idempotent — re-registering
   *  the same plugin replaces its entry. */
  register(pluginId: string, contributions: ResolvedPluginContributions): void {
    this.byPlugin.set(pluginId, { pluginId, contributions })
  }

  unregister(pluginId: string): void {
    this.byPlugin.delete(pluginId)
  }

  clear(): void {
    this.byPlugin.clear()
  }

  get(pluginId: string): ResolvedPluginContributions | undefined {
    return this.byPlugin.get(pluginId)?.contributions
  }

  has(pluginId: string): boolean {
    return this.byPlugin.has(pluginId)
  }

  /** All commands across all enabled plugins, tagged with their owning
   *  plugin id. Used by the Command Palette merge. */
  allCommands(): Array<PluginCommandContribution & { pluginId: string }> {
    const out: Array<PluginCommandContribution & { pluginId: string }> = []
    for (const entry of this.byPlugin.values()) {
      for (const c of entry.contributions.commands) out.push({ ...c, pluginId: entry.pluginId })
    }
    return out
  }

  /** All context-menu contributions for a given location (e.g.
   *  `message.selectionContextMenu`). Order is plugin-stable then by each
   *  contribution's `order` field (undefined sorts last, stably). */
  contextMenusFor(location: PluginContextMenuContribution['location']): Array<PluginContextMenuContribution & { pluginId: string }> {
    const out: Array<PluginContextMenuContribution & { pluginId: string }> = []
    for (const entry of this.byPlugin.values()) {
      for (const m of entry.contributions.contextMenus) {
        if (m.location === location) out.push({ ...m, pluginId: entry.pluginId })
      }
    }
    return withStableOrder(out)
  }

  /** All actions for a given slot location (e.g. `chat.header`). */
  actionsFor(location: PluginActionContribution['location']): Array<PluginActionContribution & { pluginId: string }> {
    const out: Array<PluginActionContribution & { pluginId: string }> = []
    for (const entry of this.byPlugin.values()) {
      for (const a of entry.contributions.actions) {
        if (a.location === location) out.push({ ...a, pluginId: entry.pluginId })
      }
    }
    return withStableOrder(out)
  }

  /** Configuration properties across all enabled plugins (for the settings
   *  UI's per-plugin configuration editor). */
  configurationFor(pluginId: string): PluginConfigurationContribution | undefined {
    return this.byPlugin.get(pluginId)?.contributions.configuration
  }
}

/** Stable sort by `order` (undefined → last), preserving insertion order
 *  among equal-keyed items. Avoids the non-determinism of `Array.sort` when
 *  the comparator returns 0 across plugins. */
function withStableOrder<T extends { order?: number }>(items: T[]): T[] {
  return items
    .map((item, idx) => ({ item, idx, order: item.order ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.order - b.order || a.idx - b.idx)
    .map((x) => x.item)
}
