// App-root provider for the resource pane. Owns one registry (providers are
// registered once) and one per-session tab store. Providers are a deployment
// concern, not state: they are read once on mount, which lets tests inject
// fakes without touching the network.

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ResourceRegistry, type InvalidationSource, type ResourceProvider } from './registry'
import { ResourcePaneStore, type OpenOptions } from './tab-store'
import { ResourcePaneContext, type ResourcePaneContextValue } from './context'
import { createFileProvider } from './providers/file'
import { createDiffProvider } from './providers/diff'
import { createSnapshotDiffProvider } from './providers/snapshot-diff'
import { hubInvalidations } from './hub-invalidations'
import { useWsHub } from '../hooks/useWsHub'

interface Props {
  children: ReactNode
  /** Registered viewers; defaults to the built-in file provider. */
  providers?: ResourceProvider[]
  /** WS-backed invalidation source. Omitted in Phase 1: resources fetch once
   *  (a file refetch loop is wired when the hub adapter lands). */
  invalidate?: InvalidationSource
}

export function ResourcePaneProvider({ children, providers, invalidate }: Props) {
  const [registry] = useState(() => {
    const instance = new ResourceRegistry({ invalidate })
    for (const provider of providers ?? [
      createFileProvider(),
      createDiffProvider(),
      createSnapshotDiffProvider(),
    ]) {
      instance.register(provider)
    }
    return instance
  })
  // The store needs to know which kinds have a viewer so an address nothing can
  // open never becomes a tab. `registry` is stable, so the predicate is too.
  const [store] = useState(
    () => new ResourcePaneStore({ canOpen: (kind) => registry.hasProvider(kind) }),
  )

  const openResource = useCallback(
    (sessionId: string, address: string, options?: OpenOptions) =>
      store.open(sessionId, address, options),
    [store],
  )

  const value = useMemo<ResourcePaneContextValue>(
    () => ({ store, registry, openResource }),
    [store, registry, openResource],
  )

  return <ResourcePaneContext.Provider value={value}>{children}</ResourcePaneContext.Provider>
}

/** Production host: wires the app's WS hub into the registry so providers can
 *  refetch on `git-snapshot` frames. Tests render `ResourcePaneProvider`
 *  directly (no hub); `main.tsx` renders this host. */
export function ResourcePaneHost({ children }: { children: ReactNode }) {
  const hub = useWsHub()
  const invalidate = useMemo(() => hubInvalidations(hub), [hub])
  return <ResourcePaneProvider invalidate={invalidate}>{children}</ResourcePaneProvider>
}