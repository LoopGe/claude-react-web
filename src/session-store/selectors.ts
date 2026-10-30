import { useCallback, useRef, useSyncExternalStore } from 'react'
import { sessionStoreRegistry } from './registry'
import type { SessionSnapshot } from './types'
import { countTaskActivity, type ActiveWorktree } from './normalize'

// ── Module-level (referentially stable) selectors ──────────────────
//
// The brief's Task 5 asks for three primitive boolean selectors that the
// session-bound adapters and turn-status consumers feed into
// `useSessionSelector` — the wrapper that re-renders only when the
// derived primitive changes (Object.is), not on every snapshot dispatch.
//
// Defining them at module scope (rather than inline arrows at the call
// site) is the contract `useSessionSelector` documents: a stable
// `select` reference keeps `getSnapshot`'s `useCallback` deps stable,
// otherwise the hook re-binds on every render and the Object.is guard
// never gets a chance to dedup. They live here (next to the other
// reactive readers) as the canonical selectors that Chat and the
// turn-status components import via `useSessionSelector`.

/** True when any live-turn phase is active (thinking / writing / tool_use).
 *  Drives the turn-active gate the WorkingBubble mount condition and the
 *  per-card background-action availability read off; a primitive so a
 *  transition (null → phase or phase → null) re-renders exactly once. */
export const selectHasActivePhase = (snapshot: SessionSnapshot): boolean =>
  snapshot.activePhase != null

/** True when the transcript mirror lists at least one `pending` or
 *  `background` subagent — the post-turn-end forms that keep the
 *  WorkingBubble mounted in its `Waiting` state. Mirrors the
 *  `hasTranscriptBackground` predicate in `normalize.ts` so the main
 *  panel and the side drawer cannot disagree about which statuses count;
 *  read here as a primitive over `activeSubagents`, so a change in any
 *  OTHER subagent field (lastToolName, progressSummary, …) does not
 *  re-render the gate consumer. */
export const selectHasTranscriptBackground = (snapshot: SessionSnapshot): boolean =>
  snapshot.activeSubagents.some(
    (a) => a.status === 'pending' || a.status === 'background',
  )

/** True when at least one synchronous subagent (`!isAsync`) is currently
 *  `running`. Drives the SDK-auto-continuation carve-out of the per-card
 *  background-action gate: a sync subagent can still be mid-flight when
 *  `turnActive` (driven by `activePhase`) reads false, so the action
 *  stays available for that window. Read as a primitive over
 *  `activeSubagents` for the same re-render reason as above. */
export const selectHasLiveSyncSubagent = (snapshot: SessionSnapshot): boolean =>
  snapshot.activeSubagents.some((a) => a.status === 'running' && !a.isAsync)


/** Subscribe to a single field of the session snapshot. Only triggers a
 *  re-render when the field's reference identity changes (via Object.is),
 *  unlike a whole-snapshot subscription which re-renders on every dispatch. */
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

/** Subscribe to a value DERIVED from the session snapshot. Re-renders only
 *  when the derived value changes (Object.is), so derive a primitive — e.g.
 *  `snap => snap.activePhase != null` lets a component react to a turn
 *  starting/ending without re-rendering on every phase transition.
 *  `select` must be referentially stable (a module-level function); an inline
 *  arrow would re-bind getSnapshot on every render. */
export function useSessionSelector<T>(
  sessionId: string,
  select: (snapshot: SessionSnapshot) => T,
): T {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  )
  const getSnapshot = useCallback(() => select(store.getSnapshot()), [store, select])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** `useSessionField` for call sites that may not have a session id (tests,
 *  static transcripts): without one the subscription is inert and returns
 *  null. Same re-render contract as useSessionField when a id IS provided.
 *  The hook pair must stay unconditional (rules of hooks) — hence the
 *  nullable store rather than an early return. */
export function useOptionalSessionField<K extends keyof SessionSnapshot>(
  sessionId: string | undefined,
  field: K,
): SessionSnapshot[K] | null {
  const store = sessionId ? sessionStoreRegistry.getOrCreate(sessionId) : null
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : () => {}),
    [store],
  )
  const getSnapshot = useCallback(
    () => (store ? store.getSnapshot()[field] : null),
    [store, field],
  )
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
 *  keeps the panel reachable while ambient housekeeping runs.
 *
 *  `indicator <= all` always, and structurally so — both are produced by
 *  `countTaskActivity`'s single pass (normalize.ts), with `indicator++` gated
 *  on a subset of the iterations (`!skipTranscript && !ambient`). So
 *  `indicator > 0` implies `all > 0`, and the WorkingBubble's mount gate
 *  relies on exactly that implication (see Chat.tsx / shouldMountWorkingBubble).
 *  normalize.test.ts asserts the relation directly, so a change that let
 *  `indicator` count something the `all` pass skips fails there rather than
 *  silently unmounting the bubble. */
export function useSessionTaskCounts(sessionId: string): { all: number; indicator: number } {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const prevRef = useRef<{ all: number; indicator: number } | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  )
  const getSnapshot = useCallback(() => {
    const { all, indicator } = countTaskActivity(store.getSnapshot().tasks)
    if (prevRef.current && prevRef.current.all === all && prevRef.current.indicator === indicator) {
      return prevRef.current
    }
    prevRef.current = { all, indicator }
    return prevRef.current
  }, [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Reactive subscription to the session's current "isolated in a
 *  worktree" state, folded from EnterWorktree/ExitWorktree in the
 *  mirrored transcript. Reference-stable when the derived value is
 *  unchanged, so appending unrelated messages doesn't re-render chips
 *  that merely show this.
 *
 *  O(1) per store emit: it reads `ServerMirror.activeWorktree`, which the
 *  reducer maintains incrementally (see that field's doc). It used to run
 *  `getActiveWorktree` over the whole transcript inside getSnapshot — once
 *  per emit, i.e. per stream_event delta, per open panel. */
export function useSessionActiveWorktree(sessionId: string): ActiveWorktree | null {
  const store = sessionStoreRegistry.getOrCreate(sessionId)
  const prevRef = useRef<ActiveWorktree | null>(null)
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => {
    const active = store.getState().mirror.activeWorktree
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

