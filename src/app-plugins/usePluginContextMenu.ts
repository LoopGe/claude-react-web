// Build context-menu items for a plugin menu location (e.g.
// message.selectionContextMenu), filtered by `when` and wired to fire the
// owning command. Returns ContextMenuItem[] compatible with the existing
// <ContextMenu> component.
//
// The caller owns the menu's open state + anchor position; this hook just
// produces the items given the live context. Each item's onClick runs the
// command with the supplied context + invocation anchor.

import { useCallback, useMemo } from 'react'
import { useAllContributions } from './PluginRegistryProvider'
import { usePluginCommands, type InvocationAnchor } from './usePluginCommands'
import { buildWhenContext, filterContributions } from './when'
import type { ContextMenuItem } from '../components/ContextMenu'
import type { PluginContextMenuContribution } from '../../shared/app-plugins/contributions.js'
import type { PluginCommandContext } from '../../shared/app-plugins/command-context.js'
import type { WhenContextInput } from './when'

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never

export interface MenuContext {
  /** The PluginCommandContext to send (already built, e.g. via
   *  buildSelectionContext). `commandId` + `invocationId` are filled per-item. */
  base: DistributiveOmit<PluginCommandContext, 'invocationId' | 'commandId'>
  /** Anchor captured at gesture time (message element + rect). */
  anchor?: InvocationAnchor
  /** When-context input for filtering (theme, session, message keys). */
  when: WhenContextInput
}

export function usePluginContextMenu(location: PluginContextMenuContribution['location']) {
  const all = useAllContributions()
  const { execute } = usePluginCommands()

  const menus = useMemo(() => {
    const items: Array<PluginContextMenuContribution & { pluginId: string }> = []
    for (const c of all) {
      for (const m of c.contextMenus) {
        if (m.location === location) items.push({ ...m, pluginId: c.pluginId })
      }
    }
    return items
  }, [all, location])

  /** Build the items for a specific gesture's context. Returns an empty list
   *  when no plugin's `when` holds (caller shows no menu). Memoised so
   *  PluginContextMenu's useMemo dep stays stable across renders. */
  const buildItems = useCallback((ctx: MenuContext): ContextMenuItem[] => {
    const whenCtx = buildWhenContext(ctx.when)
    const filtered = filterContributions(menus, whenCtx)
    return filtered.map((m) => ({
      label: m.title,
      onClick: () => {
        const commandId = m.commandId
        const context = { ...ctx.base, commandId } as PluginCommandContext
        void execute({ pluginId: m.pluginId, commandId, context: context as never, anchor: ctx.anchor })
      },
    }))
  }, [menus, execute])

  return { buildItems, hasAny: menus.length > 0 }
}
