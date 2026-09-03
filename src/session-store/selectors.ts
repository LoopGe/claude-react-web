import { useCallback, useRef, useSyncExternalStore } from 'react'
import { sessionStoreRegistry } from './registry'
import type { SessionSnapshot, SessionState } from './types'
import { getActiveWorktree, type ActiveWorktree } from './normalize'

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
 *  `waiting` = non-terminal AND not (skipTranscript || ambient) — housekeeping
 *  tasks are SDK-flagged as not belonging in the inline transcript, and
 *  `ambient` (0.3.247) additionally covers auto-started live-update watchers;
 *  neither may keep the WorkingBubble in a phantom Waiting state. */
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
      if (!t.skipTranscript && !t.ambient) waiting++
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

/** Reactive subscription to the session's current "isolated in a
 *  worktree" state, folded from EnterWorktree/ExitWorktree in the
 *  mirrored transcript. Reference-stable when the derived value is
 *  unchanged, so appending unrelated messages doesn't re-render chips
 *  that merely show this. */
export function useSessionActiveWorktree(sessionId: string): ActiveWorktree | null {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const prevRef = useRef<ActiveWorktree | null>(null)
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => {
    const active = getActiveWorktree(store.getState().mirror.messages)
    if (
      prevRef.current &&
      prevRef.current.name === active?.name &&
      prevRef.current.enterMsgId === active?.enterMsgId
    ) {
      return prevRef.current
    }
    prevRef.current = active
    return prevRef.current
  }, [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getSessionStore(sessionId: string) {
  return sessionStoreRegistry.getOrCreate(sessionId)
}

export function getSessionState(sessionId: string): SessionState {
  return sessionStoreRegistry.getOrCreate(sessionId).getState()
}

