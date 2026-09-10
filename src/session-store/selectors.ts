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

/** Subscribe to the background-task counts for a session, derived from the
 *  `tasks` mirror. Returns a stable `{ all, indicator }` object — identity
 *  only changes when a count actually changes — so consumers don't re-render
 *  on every task-list mutation that leaves the counts untouched.
 *
 *  `indicator` is the ONE number every activity surface must show: non-terminal
 *  AND not (skipTranscript || ambient). This is the SDK's own rule — it
 *  documents `ambient` as housekeeping the CLI "does not surface as user work"
 *  (every skip_transcript task plus auto-started live-update watchers) and says
 *  hosts should exclude them from activity indicators. Every consumer reads it
 *  from here rather than re-deriving: the WorkingBubble count pill, its
 *  Waiting-state gate, and the TasksPanel header. Two surfaces counting the
 *  same tasks under different rules is exactly the "the panel says 3, the
 *  bubble says 1" mismatch this selector exists to prevent.
 *
 *  `all` = every non-terminal task, ambient included. NOT an indicator count:
 *  it only answers "is there anything in the TasksPanel worth opening", which
 *  keeps the panel reachable while ambient housekeeping runs. */
export function useSessionTaskCounts(sessionId: string): { all: number; indicator: number } {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const prevRef = useRef<{ all: number; indicator: number } | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  )
  const getSnapshot = useCallback(() => {
    let all = 0
    let indicator = 0
    for (const t of store.getSnapshot().tasks) {
      if (
        t.status === 'completed' || t.status === 'failed' ||
        t.status === 'killed' || t.status === 'stopped'
      ) continue
      all++
      if (!t.skipTranscript && !t.ambient) indicator++
    }
    if (prevRef.current && prevRef.current.all === all && prevRef.current.indicator === indicator) {
      return prevRef.current
    }
    prevRef.current = { all, indicator }
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

