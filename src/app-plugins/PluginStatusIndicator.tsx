// PluginStatusIndicator — declarative UI override for the "working..." indicator.
//
// When a plugin contributes a `statusIndicators` entry whose `when` clause
// holds against the current context (session.working, theme), the host
// renders the plugin's image (via /api/app-plugins/:id/assets/<asset>) instead
// of the default dot + "working..." text. If no plugin matches, the default
// indicator (passed as children) renders.
//
// This is a substitutive (vs additive) contribution — the first of its kind.

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAllContributions } from './usePluginRegistry'
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
  // If the <img> fails to load (404, broken asset, etc.), fall back to the
  // default indicator so the working state is never hidden by a broken image.
  const [imgError, setImgError] = useState(false)

  const override = useMemo<PluginStatusIndicatorContribution & { pluginId: string } | null>(() => {
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

  // Reset the error flag when the override changes so a new (valid) plugin
  // image gets a fresh try instead of being permanently hidden.
  useEffect(() => { setImgError(false) }, [override])

  if (!override || imgError) return <>{children}</>

  // URL-encode each path segment so characters like #, ?, spaces don't
  // break the URL.
  const encodedAsset = override.asset.split('/').map(encodeURIComponent).join('/')
  const src = `/api/app-plugins/${encodeURIComponent(override.pluginId)}/assets/${encodedAsset}`
  return <img className="plugin-status-indicator" src={src} alt="" aria-label="working" onError={() => setImgError(true)} />
})
