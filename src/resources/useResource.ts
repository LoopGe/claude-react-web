// Subscribe to one resource address. The registry's holder count means the
// stream starts on first use and aborts when the last subscriber (or pin)
// releases — switching addresses resubscribes and releases the old one.

import { useCallback, useSyncExternalStore } from 'react'
import { useResourceRegistry } from './context'
import type { ResourceSnapshot } from './registry'

export function useResource<T = unknown>(address: string): ResourceSnapshot<T> {
  const registry = useResourceRegistry()
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.subscribe(address, onStoreChange),
    [registry, address],
  )
  const getSnapshot = useCallback(
    () => registry.getSnapshot(address) as ResourceSnapshot<T>,
    [registry, address],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}