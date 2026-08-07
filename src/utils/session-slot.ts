import type { SessionGroup } from '../types'

/** Reassign a session's sidebar group membership from `oldId` to `newId`
 *  (REPLACE semantics: `oldId` leaves, `newId` takes its slot).
 *
 *  Used by `swapSession` — the POST-driven atomic X→Y swap for `/clear` and
 *  restart. The `session-created` handler does NOT use this (it appends via
 *  `joinGroupId` so X stays grouped until swapSession evicts it, avoiding an
 *  "Ungrouped" flash). `swapSession` is idempotent over an already-appended
 *  Y: if `newId` is already a member, `newId` is moved into `oldId`'s slot
 *  (and `oldId` dropped) rather than left at the end where it was appended.
 *
 *  The move matters for `/clear`: `session-created(Y)` lands before the POST
 *  resolves and appends Y to the END of X's group. If `swapSession` then only
 *  dropped X, Y would stay at the end — a non-last session would jump to the
 *  bottom of its group on every clear. Moving Y into X's slot preserves the
 *  original position.
 *
 *  - If `newId` is already a member of a group that also contains `oldId`,
 *    `newId` is moved to `oldId`'s position and `oldId` is dropped.
 *  - Groups without `oldId` are returned by reference (no churn).
 *  - `oldId === newId` is a full no-op (returns input by reference). */
export function inheritGroupId(
  groups: SessionGroup[],
  oldId: string,
  newId: string,
): SessionGroup[] {
  if (oldId === newId) return groups
  let changed = false
  const next = groups.map((g) => {
    const i = g.sessionIds.indexOf(oldId)
    if (i === -1) return g
    changed = true
    const ids = g.sessionIds.slice()
    const j = ids.indexOf(newId)
    if (j === -1) {
      // newId not yet present — take oldId's slot in place.
      ids[i] = newId
    } else {
      // newId was already appended (session-created joinGroupOf frame that
      // landed before swapSession). Move it to oldId's slot so it inherits
      // X's position instead of lingering at the appended end. Removing
      // newId first shifts oldId's index down by one when j < i.
      ids.splice(j, 1)
      ids[j < i ? i - 1 : i] = newId
    }
    return { ...g, sessionIds: ids }
  })
  // Return the input by reference when no group contained oldId, so the
  // caller's no-op short-circuit (e.g. setGroups) fires and we skip a
  // spurious debounced flush / re-render.
  return changed ? next : groups
}

/** Reassign a session's flat sidebar-order slot from `oldId` to `newId`,
 *  preserving position.
 *
 *  Mirrors the sidebarOrder-swap half of `swapSession` (same idempotency
 *  contract as `inheritGroupId`).
 *
 *  - If `newId` is already ordered, `oldId` is dropped instead of dup'd.
 *  - Returns the input by reference when `oldId` isn't present.
 *  - `oldId === newId` is a full no-op. */
export function inheritSidebarOrderId(
  order: string[],
  oldId: string,
  newId: string,
): string[] {
  if (oldId === newId) return order
  if (!order.includes(oldId)) return order
  if (order.includes(newId)) return order.filter((id) => id !== oldId)
  return order.map((id) => (id === oldId ? newId : id))
}

/** Append `newId` to the group containing `sourceId` (the `session-created`
 *  `joinGroupOf` path), with an optional `maxGroupSize` cap bypass for the
 *  evict case.
 *
 *  - Fork (`evicting` false/absent): `sourceId` stays, so the group genuinely
 *    grows by one. Respect `maxGroupSize`: if `sourceId`'s group is already
 *    full, return the input unchanged so the caller's `handleAddToGroup` can
 *    toast on overflow instead of silently exceeding the cap.
 *  - `/clear` + restart (`evicting` true): `sourceId` is being evicted
 *    (same-tab `swapSession` / cross-tab `session-removed`), so appending
 *    `newId` won't grow the group long-term. Bypass the cap — otherwise a
 *    FULL group (e.g. a 3-up workspace at the default `maxGroupSize=3`)
 *    skips the append and `newId` flashes under "Ungrouped" between the
 *    `session-created` frame and the POST-driven `swapSession`.
 *
 *  Delegates the actual append (and its idempotency / source-unguarded
 *  no-ops) to `joinGroupId`, so the caller's reference-equality short-circuit
 *  still fires when nothing changes.
 *
 *  - `sourceId === newId` is a full no-op (returns input by reference).
 *  - `sourceId` in no group → `joinGroupId` returns the input by reference
 *    (`newId` stays ungrouped — matches a fork/clear of an ungrouped source). */
export function joinGroupOfSource(
  groups: SessionGroup[],
  sourceId: string,
  newId: string,
  opts: { evicting?: boolean; maxGroupSize: number },
): SessionGroup[] {
  if (sourceId === newId) return groups
  if (!opts.evicting) {
    const sourceGroup = groups.find((g) => g.sessionIds.includes(sourceId))
    if (sourceGroup && sourceGroup.sessionIds.length >= opts.maxGroupSize) return groups
  }
  return joinGroupId(groups, sourceId, newId)
}

/** Append `newId` to the same group that contains `oldId` (fork semantics:
 *  `oldId` stays, `newId` joins its group). Used by the `session-created`
 *  (`joinGroupOf`) handler so a forked session lands in its source's group
 *  in the same render batch it appears — no "Ungrouped" flash before the
 *  fork POST response runs `handleAddToGroup`.
 *
 *  Precondition: `newId` is a freshly-spawned id not yet in any group (fork
 *  always allocates a new UUID), so cross-group eviction isn't needed.
 *
 *  - If `oldId` is in no group, returns the input by reference (newId stays
 *    ungrouped — matches a fork of an ungrouped source).
 *  - If `newId` is already a member of `oldId`'s group, no-op (idempotent
 *    with the later `handleAddToGroup`, which also dedups).
 *  - `oldId === newId` is a full no-op. */
export function joinGroupId(
  groups: SessionGroup[],
  oldId: string,
  newId: string,
): SessionGroup[] {
  if (oldId === newId) return groups
  let changed = false
  const next = groups.map((g) => {
    if (!g.sessionIds.includes(oldId)) return g
    if (g.sessionIds.includes(newId)) return g
    changed = true
    return { ...g, sessionIds: [...g.sessionIds, newId] }
  })
  return changed ? next : groups
}
