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

/** Subscribe to the running background-task counts for a session, derived
 *  from the `tasks` mirror. Returns a stable `{ all, waiting }` object —
 *  identity only changes when a count actually changes — so consumers
 *  (Chat's WorkingBubble) don't re-render on every task-list mutation that
 *  leaves the counts untouched.
 *
 *  `all` = every non-terminal task (the WorkingBubble pill / TasksPanel entry).
 *  `waiting` = non-terminal AND not skipTranscript — ambient/housekeeping
 *  tasks are SDK-flagged as not belonging in the inline transcript, so they
 *  must not keep the WorkingBubble in a phantom Waiting state. */
export function useSessionTaskCounts(sessionId: string): { all: number; waiting: number } {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const prevRef = useRef<{ all: number; waiting: number } | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  )
  const getSnapshot = useCallback(() => {
    let all = 0
    let waiting = 0
    for (const t of store.getSnapshot().tasks) {
      if (
        t.status === 'completed' || t.status === 'failed' ||
        t.status === 'killed' || t.status === 'stopped'
      ) continue
      all++
      if (!t.skipTranscript) waiting++
    }
    if (prevRef.current && prevRef.current.all === all && prevRef.current.waiting === waiting) {
      return prevRef.current
    }
    prevRef.current = { all, waiting }
    return prevRef.current
  }, [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getSessionLastMessageUuid(sessionId: string): string | null {
  return sessionStoreRegistry.getOrCreate(sessionId).getState().mirror.lastMessageUuid
}

export function getSessionStore(sessionId: string) {
  return sessionStoreRegistry.getOrCreate(sessionId)
}

export function getSessionState(sessionId: string): SessionState {
  return sessionStoreRegistry.getOrCreate(sessionId).getState()
}

