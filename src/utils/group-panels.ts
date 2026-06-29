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
