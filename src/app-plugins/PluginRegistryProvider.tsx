// Plugin registry context + provider.
//
// One <PluginRegistryProvider> at the App root (inside WsHubProvider).
// Hydrates the plugin list via REST on mount, then keeps it in sync with the
// three app-plugin WS frames (snapshot / state-changed / contributions-
// changed). Exposes the list + a filtered view of contributions to consumers.
//
// The provider is the single source of truth for "which plugins are enabled
// and what do they contribute" on the client. Slots, the context menu, and
// the Command Palette all read from usePluginRegistry().

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../hooks/useApi'
import { useWsHub } from '../hooks/useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { AppPluginClientInfo } from '../../shared/app-plugins/runtime-state.js'
import { PluginRegistryContext, type PluginRegistryApi } from './plugin-registry-context'

export function PluginRegistryProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<AppPluginClientInfo[]>([])
  const hub = useWsHub()
  // Latest list kept in a ref (updated in an effect, NOT during render) so
  // the stable `get` callback can read current state without re-creating.
  const pluginsRef = useRef<AppPluginClientInfo[]>([])
  // Set true the moment a WS snapshot/state frame arrives. WS is
  // authoritative; once it has spoken, a late REST response (mount hydrate or
  // a post-mutation refresh) must NOT clobber the fresher WS state.
  const wsHydratedRef = useRef(false)

  const refresh = useCallback(async () => {
    // If WS already hydrated, skip the REST fetch — it can only be stale
    // relative to the WS stream (e.g. a concurrent cross-tab mutation).
    if (wsHydratedRef.current) return
    try {
      const res = await api.get<{ plugins: AppPluginClientInfo[] }>('/app-plugins')
      // Re-check after the await: a WS frame may have landed during the fetch.
      if (wsHydratedRef.current) return
      setPlugins(res.plugins ?? [])
    } catch {
      // Subsystem disabled or unreachable — leave the list empty.
    }
  }, [])

  // Hydrate on mount.
  useEffect(() => {
    // One-time REST fetch on mount to populate the list before the first WS
    // snapshot arrives. setState-in-effect is intentional here.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount hydration
    void refresh()
  }, [refresh])

  // Keep the ref in sync with state (in an effect, not during render).
  useEffect(() => {
    pluginsRef.current = plugins
  }, [plugins])

  // Sync with WS frames. Registered once (stable hub). Uses the updater form
  // so it doesn't need to read current state from a ref.
  useEffect(() => {
    const off = hub.addListener((frame: WsServerFrame) => {
      if (frame.kind === 'app-plugins-snapshot') {
        wsHydratedRef.current = true
        setPlugins(frame.plugins)
        return
      }
      if (frame.kind === 'app-plugin-state-changed') {
        wsHydratedRef.current = true
        const next = frame.plugin
        setPlugins((prev) => {
          const idx = prev.findIndex((p) => p.id === next.id)
          if (idx === -1) return [...prev, next]
          const copy = prev.slice()
          copy[idx] = next
          return copy
        })
        return
      }
      if (frame.kind === 'app-plugin-contributions-changed') {
        wsHydratedRef.current = true
        const { pluginId, contributions } = frame
        setPlugins((prev) =>
          prev.map((p) => (p.id === pluginId ? { ...p, contributions } : p)),
        )
        return
      }
    })
    return off
  }, [hub])

  const get = useCallback((id: string) => pluginsRef.current.find((p) => p.id === id), [])

  const value = useMemo<PluginRegistryApi>(() => ({ plugins, refresh, get }), [plugins, refresh, get])
  return <PluginRegistryContext.Provider value={value}>{children}</PluginRegistryContext.Provider>
}
