import type { SessionGroup } from '../types'

/** Reassign a session's sidebar group membership from `oldId` to `newId`
 *  (REPLACE semantics: `oldId` leaves, `newId` takes its slot).
 *
 *  Used by `swapSession` — the POST-driven atomic X→Y swap for `/clear` and
 *  restart. The `session-created` handler does NOT use this (it appends via
 *  `joinGroupId` so X stays grouped until swapSession evicts it, avoiding an
 *  "Ungrouped" flash). `swapSession` is idempotent over an already-appended
 *  Y: if `newId` is already a member, `oldId` is simply dropped.
 *
 *  - If `newId` is already a member of a group that also contains `oldId`,
 *    `oldId` is dropped (no duplicate).
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
    if (ids.includes(newId)) ids.splice(i, 1)
    else ids[i] = newId
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
