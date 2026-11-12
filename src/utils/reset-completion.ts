/** How `resetSession`'s POST continuation (/clear and /handoff) completes the
 *  server-side X→Y swap on the client.
 *
 *  Three outcomes, deliberately distinguished — the pre-fix `else` branch
 *  treated "server short-circuit" and "panel closed mid-wait" identically
 *  (both no-ops), which left X as a sidebar ghost and Y hidden forever when
 *  the panel closed during /handoff's long summarize wait:
 *
 *  - `swap`     — server spawned Y (`newId !== oldId`) and X still hosts an
 *                 open panel. `swapSession` places Y in X's slot.
 *  - `teardown` — server spawned Y but the panel is closed (no slot to swap
 *                 into). The clearingIds guard has already swallowed
 *                 session-removed(X) — X is still in `sessions` — and Y sits
 *                 behind an evicting pending marker only `swapSession`
 *                 consumes. `teardownRemovedSession` is the shared path that
 *                 evicts X and lets Y surface.
 *  - `noop`     — server short-circuited (`newId === oldId`: another clear is
 *                 in flight, or the `clearing` flag is stuck). X is still the
 *                 live session; leave it alone. */
export function resetCompletion(args: {
  oldId: string
  newId: string
  panelOpen: boolean
}): 'swap' | 'teardown' | 'noop' {
  if (args.newId === args.oldId) return 'noop'
  return args.panelOpen ? 'swap' : 'teardown'
}

/** A reconnect snapshot cannot guarantee delivery of a later removed(X).
 * Convert an evicting replacement into the explicit replace relationship when
 * X and Y both remain live, preserving its group slot whether removal later
 * succeeds or permanent deletion fails. Missing sides release the marker;
 * non-evicting fork inheritance still waits for group state. */
export function snapshotPendingAction(args: {
  newId: string
  pending: { sourceId: string; evicting: boolean }
  liveIds: ReadonlySet<string>
}): 'release' | 'replace' | 'keep' {
  if (!args.liveIds.has(args.newId) || !args.liveIds.has(args.pending.sourceId)) return 'release'
  return args.pending.evicting ? 'replace' : 'keep'
}

export interface SnapshotPendingReplacement {
  sourceId: string
  evicting: boolean
  replaces?: boolean
}

export function reconcileSnapshotPending(
  previous: Map<string, SnapshotPendingReplacement>,
  liveIds: ReadonlySet<string>,
): Map<string, SnapshotPendingReplacement> {
  let changed = false
  const next = new Map(previous)
  for (const [newId, pending] of next) {
    const action = snapshotPendingAction({ newId, pending, liveIds })
    if (action === 'release') {
      next.delete(newId)
      changed = true
    } else if (action === 'replace') {
      next.set(newId, { ...pending, evicting: false, replaces: true })
      changed = true
    }
  }
  return changed ? next : previous
}

/** A concurrent permanent-clear 409 belongs to another in-flight clear, so its
 * replacement marker must survive. Other errors clear only this call's marker. */
export function shouldClearResetPendingOnError(args: {
  deleteTranscript?: boolean
  status?: number
}): boolean {
  return !(args.deleteTranscript === true && args.status === 409)
}
