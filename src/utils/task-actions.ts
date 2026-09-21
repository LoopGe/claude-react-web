// Small pure helpers backing Chat's background-task actions (Alt+B / the
// per-card "Background this task" buttons) and its WorkingBubble mount gate.
// Extracted from Chat so the timing-sensitive dedup and the action-offering /
// mount gates are unit-testable.

/** In-flight guard that dedupes a burst of identical actions (e.g. two
 *  clicks on the same "Background this task" button). A key is held for a
 *  grace window AFTER a successful action so a double-click landing before
 *  the server reflects the change can't fire a duplicate POST; on failure
 *  the key is released immediately so a retry isn't swallowed. */
export interface DedupGuard {
  /** Returns true if the key was free (now held), false if already held. */
  tryAcquire(key: string): boolean
  /** Hold the key for `holdMs`, then release it. Replaces any prior hold. */
  releaseAfter(key: string): void
  /** Release the key immediately (no hold). */
  releaseNow(key: string): void
  /** Cancel all pending holds and clear state (component unmount). */
  dispose(): void
  /** Re-arm after a dispose. React StrictMode (dev) runs an effect's cleanup
   *  (which calls dispose) right after its first mount, then re-runs the
   *  effect — reset() is called from the effect body so the spurious
   *  simulated-unmount doesn't leave the guard permanently inert. */
  reset(): void
}

export function createDedupGuard(holdMs: number): DedupGuard {
  const pending = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  return {
    tryAcquire(key) {
      // After dispose (component unmount) the guard is dead — never re-arm.
      // A late in-flight POST resolving post-unmount must not acquire.
      if (disposed) return false
      if (pending.has(key)) return false
      pending.add(key)
      return true
    },
    releaseAfter(key) {
      if (disposed) return
      const existing = timers.get(key)
      if (existing != null) clearTimeout(existing)
      const timer = setTimeout(() => {
        pending.delete(key)
        timers.delete(key)
      }, holdMs)
      timers.set(key, timer)
    },
    releaseNow(key) {
      if (disposed) return
      const existing = timers.get(key)
      if (existing != null) {
        clearTimeout(existing)
        timers.delete(key)
      }
      pending.delete(key)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      pending.clear()
    },
    reset() {
      // Idempotent re-arm: clear any lingering holds/timers and reopen for
      // acquires. Called on every mount; dispose has already cleared state, so
      // the clears here are a no-op in the normal path and a safety net if
      // reset is ever invoked while a hold is still pending.
      disposed = false
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      pending.clear()
    },
  }
}

/** Whether the per-card "background this task" action should be offered.
 *  A live turn always offers it; outside a turn, a synchronous subagent still
 *  mid-flight (an SDK auto-continuation turn — e.g. after a task-notification
 *  lands with includePartialMessages off, where `turnActive` is false) keeps
 *  it available so the user can detach that subagent. Gated on `!terminated`
 *  because a dead session's subagent record would be stale — POSTing against
 *  it surfaces a 410 error banner instead of a toast. */
export function shouldOfferBackgroundAction(args: {
  turnActive: boolean
  terminated: boolean
  hasLiveSyncSubagent: boolean
}): boolean {
  return args.turnActive || (!args.terminated && args.hasLiveSyncSubagent)
}

/** Whether Chat should mount the WorkingBubble at all. A live turn mounts it
 *  unconditionally; outside a turn it stays up while there is anything to
 *  report — any non-terminal task record (`taskCount`, ambient housekeeping
 *  included: the count pill is the TasksPanel entry point), a
 *  pending/background subagent, or a still-running sync subagent during the
 *  SDK's auto-continuation window.
 *
 *  Gated on `!terminated`: a dead session receives no completion signal, so
 *  the bubble would otherwise stay mounted forever.
 *
 *  Deliberately holds NO `computeWaiting` term. `waiting` requires
 *  `!turnActive && !terminated && (indicatorCount > 0 || hasTranscriptBackground)`,
 *  every part of which this clause already covers — `indicatorCount > 0`
 *  implies `taskCount > 0`. That superset relation is asserted where it is
 *  owned (`countTaskActivity` / session-store/normalize.test.ts), and the
 *  implication itself is asserted in task-actions.test.ts against counts
 *  derived from that same rule, so a separate disjunct never decides a mount
 *  and only misleads a reader into treating it as an independent reason. */
export function shouldMountWorkingBubble(args: {
  turnActive: boolean
  terminated: boolean
  taskCount: number
  hasTranscriptBackground: boolean
  hasLiveSyncSubagent: boolean
}): boolean {
  return args.turnActive
    || (!args.terminated
      && (args.taskCount > 0 || args.hasTranscriptBackground || args.hasLiveSyncSubagent))
}
