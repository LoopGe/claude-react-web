import { useSyncExternalStore } from 'react'
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

export function getSessionLastMessageUuid(sessionId: string): string | null {
  return sessionStoreRegistry.getOrCreate(sessionId).getState().lastMessageUuid
}

export function getSessionStore(sessionId: string) {
  return sessionStoreRegistry.getOrCreate(sessionId)
}

export function getSessionState(sessionId: string): SessionState {
  return sessionStoreRegistry.getOrCreate(sessionId).getState()
}

