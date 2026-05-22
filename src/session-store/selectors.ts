import { useCallback, useRef, useSyncExternalStore } from 'react'
import { sessionStoreRegistry } from './registry'
import type { SessionSnapshot, SessionState } from './types'

export function useSessionSnapshot(sessionId: string): SessionSnapshot {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}

/** Subscribe to a single field of the session snapshot. Only triggers a
 *  re-render when the field's reference identity changes (via Object.is),
 *  unlike useSessionSnapshot which re-renders on every dispatch. */
export function useSessionField<K extends keyof SessionSnapshot>(
  sessionId: string,
  field: K,
): SessionSnapshot[K] {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const prevRef = useRef<SessionSnapshot[K]>(store.getSnapshot()[field])
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  )
  const getSnapshot = useCallback(() => {
    const val = store.getSnapshot()[field]
    // Reuse previous reference if unchanged to prevent re-renders.
    if (Object.is(val, prevRef.current)) return prevRef.current
    prevRef.current = val
    return val
  }, [store, field])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getSessionLastMessageUuid(sessionId: string): string | null {
  return sessionStoreRegistry.getOrCreate(sessionId).getState().lastMessageUuid
}

export function getSessionStore(sessionId: string) {
  return sessionStoreRegistry.getOrCreate(sessionId)
}

export function getSessionState(sessionId: string): SessionState {
  return sessionStoreRegistry.getOrCreate(sessionId).getState()
}

