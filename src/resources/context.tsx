// Resource pane context: one store + registry shared by every Chat panel.
// Mounted at the App root so an LRU-evicted panel loses its DOM (and its
// stream pins) but not its tab state, which restores from localStorage.

import { createContext, useContext } from 'react'
import type { OpenOptions, OpenResult, ResourcePaneStore } from './tab-store'
import type { ResourceRegistry } from './registry'

export interface ResourcePaneContextValue {
  store: ResourcePaneStore
  registry: ResourceRegistry
  openResource(sessionId: string, address: string, options?: OpenOptions): OpenResult
}

export const ResourcePaneContext = createContext<ResourcePaneContextValue | null>(null)

function useResourcePaneContext(): ResourcePaneContextValue {
  const context = useContext(ResourcePaneContext)
  if (!context) throw new Error('resource pane used outside <ResourcePaneProvider>')
  return context
}

export function useResourcePaneStore(): ResourcePaneStore {
  return useResourcePaneContext().store
}

export function useResourceRegistry(): ResourceRegistry {
  return useResourcePaneContext().registry
}

/** Entry point for every resource opener (tool rows, git rows, links). */
export function useOpenResource(): ResourcePaneContextValue['openResource'] {
  return useResourcePaneContext().openResource
}