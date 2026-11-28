import type { SessionGroup } from '../types'
import { inheritGroupId } from './session-slot'

/** Pure decision logic for "deactivate a group": remove every group member
 *  from the open-panel set WITHOUT touching group membership (the group and
 *  its member list are preserved, so re-activating the group reopens the
 *  panels). This is distinct from closing a single panel, which is a synced
 *  operation that also ungroups that session (see App.closeSession).
 *
 *  App.closeGroupPanels reads the current `openIds` / `focusedId` from refs,
 *  calls this, and applies the result — keeping the state mutation in App
 *  while the pure, testable transition lives here.
 *
 *  - `openIds` becomes the open ids that are NOT group members (order kept).
 *  - `focusedId` falls back to the last surviving open panel when the focused
 *    panel was a group member, or null when nothing survives; otherwise it is
 *    left unchanged. */
export function closeGroupPanelsState(args: {
  openIds: string[]
  groupSessionIds: string[]
  focusedId: string | null
}): { openIds: string[]; focusedId: string | null } {
  const members = new Set(args.groupSessionIds)
  const nextOpen = args.openIds.filter((id) => !members.has(id))
  const nextFocused =
    args.focusedId && members.has(args.focusedId)
      ? (nextOpen[nextOpen.length - 1] ?? null)
      : args.focusedId
  return { openIds: nextOpen, focusedId: nextFocused }
}

/** Pure group transition for "session `id` takes over `targetId`'s panel
 *  slot" (App.openAtSlot — a sidebar card / resumed session dropped onto a
 *  chat panel).
 *
 *  Deliberately NOT a same-group order sync: swapping the two sessions'
 *  positions in `group.sessionIds` to "mirror the panel swap" (the old
 *  behavior) silently reordered the SIDEBAR, because group sections render in
 *  sessionIds order — dropping a middle card onto the first panel teleported
 *  it to the top of the list. A sidebar-card drop is a sidebar gesture whose
 *  panel is an "open here" target: panel layout (openIds) is transient view
 *  state that may diverge from group order until the next activation
 *  (handleActivateGroup rebuilds openIds from sessionIds), and the sidebar
 *  only ever moves through sidebar gestures. Panel-ORIGINATED swaps
 *  (App.swapPanels) keep mirroring their order into the group — that gesture
 *  IS a workspace rearrangement.
 *
 *  The one membership mutation kept: an UNGROUPED `id` taking a grouped
 *  `targetId`'s slot joins the group at that position while `targetId` leaves
 *  — otherwise the evicted member would linger in the group while the new
 *  occupant sits in the group's panel slot from outside it (the
 *  /resume-into-panel contract). `id` already in ANY group → membership is
 *  nobody's business here (a cross-group panel swap must not yank
 *  membership). */
export function groupsAfterSlotTakeover(args: {
  groups: SessionGroup[]
  id: string
  targetId: string
}): SessionGroup[] {
  const { groups, id, targetId } = args
  if (id === targetId) return groups
  // Any existing membership blocks the transfer: a same-group taker must not
  // move (the bug this helper exists to pin), and a cross-group panel swap
  // must not yank either session out of its group.
  if (groups.some((g) => g.sessionIds.includes(id))) return groups
  // Ungrouped taker → inherit the target's slot. Delegates to the shared
  // position-preserving REPLACE (the /clear swapSession primitive) so the
  // slot arithmetic has one owner; its already-appended idempotency branch
  // is unreachable here (id is in no group) but harmless.
  return inheritGroupId(groups, targetId, id)
}
