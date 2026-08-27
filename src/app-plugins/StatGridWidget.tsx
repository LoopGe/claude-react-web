import { usePluginWidgetStream } from './usePluginWidgetStream'
import type { PluginWidgetContribution } from '../../shared/app-plugins/contributions.js'

export function StatGridWidget({ pluginId, widget }: { pluginId: string; widget: PluginWidgetContribution }) {
  const state = usePluginWidgetStream(pluginId, widget.id)
  if (!state) return null
  const values = state.payload.values
  // Owns the slot container so PluginWidgetSlot renders nothing (not an empty
  // bordered box) until this widget actually has a payload to show.
  return (
    <div className="plugin-widget-slot">
      <div className="stat-grid" role="group" aria-label={widget.title ?? 'System stats'}>
        {values.map((row) => (
          <div className="stat-row" key={row.id} data-tone={row.tone ?? 'ok'}>
            <span className="stat-label">{row.label}</span>
            <span className="stat-value">
              {row.value}
              {row.unit ? <span className="stat-unit">{row.unit}</span> : null}
            </span>
            {row.progress != null ? (
              <span className="stat-bar" aria-hidden="true">
                <span className="stat-bar-fill" style={{ width: `${Math.round(row.progress * 100)}%` }} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
