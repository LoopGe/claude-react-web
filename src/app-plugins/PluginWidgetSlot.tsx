import { memo, useMemo } from 'react'
import { useAllContributions } from './PluginRegistryProvider'
import { buildWhenContext, filterContributions } from './when'
import { StatGridWidget } from './StatGridWidget'
import type { PluginWidgetContribution, PluginWidgetLocation } from '../../shared/app-plugins/contributions.js'

/** Renders every plugin's widgets at a given location, filtered by `when`.
 *  Renders nothing when no plugin contributes — zero-cost when unused. */
export const PluginWidgetSlot = memo(function PluginWidgetSlot({ location }: { location: PluginWidgetLocation }) {
  const all = useAllContributions()

  const widgets = useMemo(() => {
    const items: Array<PluginWidgetContribution & { pluginId: string }> = []
    for (const c of all) {
      for (const w of c.widgets) {
        if (w.location === location) items.push({ ...w, pluginId: c.pluginId })
      }
    }
    const ctx = buildWhenContext({ theme: undefined, sessionActive: false, sessionProvider: undefined })
    // filterContributions already filters by `when` AND sorts by `order`.
    return filterContributions(items, ctx)
  }, [all, location])

  if (widgets.length === 0) return null

  return (
    <div className="plugin-widget-slot">
      {widgets.map((w) =>
        w.kind === 'stat-grid' ? (
          <StatGridWidget key={`${w.pluginId}:${w.id}`} pluginId={w.pluginId} widget={w} />
        ) : null,
      )}
    </div>
  )
})
