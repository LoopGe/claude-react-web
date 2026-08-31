// usePluginRegistry / useAllContributions — consumer hooks for the plugin
// registry context.
//
// Kept in a separate file from PluginRegistryProvider so react-refresh can
// fast-refresh the provider component without the hook exports forcing a full
// module reload (react-refresh/only-export-components).

import { useContext, useMemo } from 'react'
import type { ResolvedPluginContributions } from '../../shared/app-plugins/contributions.js'
import { PluginRegistryContext, type PluginRegistryApi } from './plugin-registry-context'

const EMPTY_REGISTRY: PluginRegistryApi = {
  plugins: [],
  refresh: () => Promise.resolve(),
  get: () => undefined,
}

export function usePluginRegistry(): PluginRegistryApi {
  const ctx = useContext(PluginRegistryContext)
  // Gracefully degrade when no provider is mounted (e.g. in tests, or any
  // surface that doesn't opt into plugins) — the subsystem is optional, so a
  // missing provider means "no plugins" rather than a crash. Production mounts
  // the provider in main.tsx, so real usage gets the live registry.
  return ctx ?? EMPTY_REGISTRY
}

/** Convenience: every enabled plugin's contributions flattened + tagged. */
export function useAllContributions(): Array<ResolvedPluginContributions & { pluginId: string }> {
  const { plugins } = usePluginRegistry()
  return useMemo(
    () =>
      plugins
        .filter((p) => p.enabled && p.compatible)
        .map((p) => ({ ...p.contributions, pluginId: p.id })),
    [plugins],
  )
}