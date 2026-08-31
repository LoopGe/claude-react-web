// Plugin registry context — split from PluginRegistryProvider.tsx so the
// provider file only exports the component (react-refresh/only-export-
// components wants contexts out of component files).

import { createContext } from 'react'
import type { AppPluginClientInfo } from '../../shared/app-plugins/runtime-state.js'

export interface PluginRegistryApi {
  plugins: AppPluginClientInfo[]
  /** Refresh the whole list from REST (e.g. after an install). */
  refresh: () => Promise<void>
  /** Look up a single plugin by id. */
  get: (id: string) => AppPluginClientInfo | undefined
}

export const PluginRegistryContext = createContext<PluginRegistryApi | null>(null)