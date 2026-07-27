// PluginStatusIndicator — declarative UI override for the "working..." indicator.
//
// When a plugin contributes a `statusIndicators` entry whose `when` clause
// holds against the current context (session.working, theme), the host
// renders the plugin's image (via /api/app-plugins/:id/assets/<asset>) instead
// of the default dot + "working..." text. If no plugin matches, the default
// indicator (passed as children) renders.
//
// This is a substitutive (vs additive) contribution — the first of its kind.

import { memo, useMemo, type ReactNode } from 'react'
import { useAllContributions } from './PluginRegistryProvider'
import { buildWhenContext, filterContributions } from './when'
import type { PluginStatusIndicatorContribution } from '../../shared/app-plugins/contributions.js'

interface Props {
  sessionWorking: boolean
  theme?: 'dark' | 'light'
  /** The default working indicator — rendered when no plugin override matches. */
  children: ReactNode
}

export const PluginStatusIndicator = memo(function PluginStatusIndicator({ sessionWorking, theme, children }: Props) {
  const all = useAllContributions()

  const override = useMemo(() => {
    const items: Array<PluginStatusIndicatorContribution & { pluginId: string }> = []
    for (const c of all) {
      for (const ind of c.statusIndicators) {
        items.push({ ...ind, pluginId: c.pluginId })
      }
    }
    const ctx = buildWhenContext({ theme, sessionWorking })
    const filtered = filterContributions(items, ctx)
    return filtered.length > 0 ? filtered[0] : null
  }, [all, sessionWorking, theme])

  if (!override) return <>{children}</>

  const src = `/api/app-plugins/${encodeURIComponent(override.pluginId)}/assets/${override.asset}`
  return <img className="plugin-status-indicator" src={src} alt="" aria-label="working" />
})
