/**
 * Pure decision logic for "what should the main grid show when a session is
 * opened". Unified group-centric rule: the grid is always either a single
 * ungrouped session, or the members of one group (capped at `maxOpen`). A
 * session is never stacked next to sessions of a different group.
 *
 * App reads the current groups / sessions / capacity from refs, calls this,
 * and applies the result — keeping the state mutation in App while the pure,
 * testable decision lives here.
 *
 * - Unknown (non-live) ids resolve to `null` so callers can't mint a ghost
 *   panel (the same guard as `handleSelect`).
 * - An ungrouped session opens as a single panel.
 * - A group member opens the whole group (its live members, in group order)
 *   when they fit within `maxOpen`; otherwise — group larger than capacity,
 *   e.g. a single-panel mobile viewport — it degrades to just the requested
 *   session, mirroring `handleSelect`.
 * - `forceGroupId` lets a caller open a session under a group membership that
 *   the store hasn't adopted yet (a freshly forked session inheriting its
 *   source group): the id is appended to that group's live members. Pass
 *   `null` to force single-panel even though the id is currently grouped.
 */
export interface OpenTargetGroup {
  id: string
  sessionIds: string[]
}

export interface OpenTarget {
  /** Ordered ids to show (oldest first), capped at `maxOpen`. */
  openIds: string[]
  /** The session to focus. */
  focusId: string
  /** The group owning the open set, or `null` for a single ungrouped session. */
  groupId: string | null
}

export function openTargetForSession(args: {
  id: string
  groups: OpenTargetGroup[]
  liveSessionIds: Iterable<string>
  maxOpen: number
  forceGroupId?: string | null
}): OpenTarget | null {
  const { id, groups, liveSessionIds, maxOpen } = args
  const live = new Set(liveSessionIds)
  if (!live.has(id)) return null

  const resolved =
    args.forceGroupId === undefined
      ? groups.find((g) => g.sessionIds.includes(id))
      : args.forceGroupId === null
        ? undefined
        : groups.find((g) => g.id === args.forceGroupId)

  // Ungrouped (or forced ungrouped / unknown forced group): single panel.
  if (!resolved) return { openIds: [id], focusId: id, groupId: null }

  // Live members in group order. When membership state hasn't caught up
  // (fork inheriting a group), `id` may not be listed yet — append it last.
  const valid = resolved.sessionIds.filter((gid) => live.has(gid))
  if (!valid.includes(id)) valid.push(id)

  const openIds = valid.length <= maxOpen ? valid : [id]
  return { openIds, focusId: id, groupId: resolved.id }
}
