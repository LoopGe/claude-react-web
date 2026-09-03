import { describe, it, expect } from 'vitest'
import { openTargetForSession } from './open-target'

const G = { id: 'g', sessionIds: ['a', 'b'] }

describe('openTargetForSession', () => {
  it('returns null for a session id that is not live', () => {
    const res = openTargetForSession({
      id: 'ghost',
      groups: [G],
      liveSessionIds: ['a', 'b'],
      maxOpen: 3,
    })
    expect(res).toBeNull()
  })

  it('opens a single panel for an ungrouped session', () => {
    const res = openTargetForSession({
      id: 'x',
      groups: [G],
      liveSessionIds: ['a', 'b', 'x'],
      maxOpen: 3,
    })
    expect(res).toEqual({ openIds: ['x'], focusId: 'x', groupId: null })
  })

  it('opens the whole group (in group order) when it fits maxOpen', () => {
    const res = openTargetForSession({
      id: 'a',
      groups: [{ id: 'g', sessionIds: ['a', 'b'] }],
      liveSessionIds: ['a', 'b'],
      maxOpen: 3,
    })
    expect(res).toEqual({ openIds: ['a', 'b'], focusId: 'a', groupId: 'g' })
  })

  it('focuses the requested member no matter where it sits in group order', () => {
    const res = openTargetForSession({
      id: 'z',
      groups: [{ id: 'g', sessionIds: ['a', 'z', 'b'] }],
      liveSessionIds: ['a', 'z', 'b'],
      maxOpen: 5,
    })
    expect(res).toEqual({ openIds: ['a', 'z', 'b'], focusId: 'z', groupId: 'g' })
  })

  it('degrades to just the requested session when the group exceeds maxOpen', () => {
    const res = openTargetForSession({
      id: 'b',
      groups: [{ id: 'g', sessionIds: ['a', 'b', 'c'] }],
      liveSessionIds: ['a', 'b', 'c'],
      maxOpen: 2,
    })
    expect(res).toEqual({ openIds: ['b'], focusId: 'b', groupId: 'g' })
  })

  it('drops stale (non-live) group members before sizing against maxOpen', () => {
    const res = openTargetForSession({
      id: 'a',
      groups: [{ id: 'g', sessionIds: ['a', 'b', 'gone'] }],
      liveSessionIds: ['a', 'b'],
      maxOpen: 2,
    })
    // 'gone' no longer exists, so the live group is just [a, b] → fits.
    expect(res).toEqual({ openIds: ['a', 'b'], focusId: 'a', groupId: 'g' })
  })

  it('treats a forced group as membership even when the id is not listed yet', () => {
    // A freshly forked session inherits a group before membership state catches up.
    const res = openTargetForSession({
      id: 'new',
      groups: [{ id: 'g', sessionIds: ['a'] }],
      liveSessionIds: ['a', 'new'],
      maxOpen: 3,
      forceGroupId: 'g',
    })
    expect(res).toEqual({ openIds: ['a', 'new'], focusId: 'new', groupId: 'g' })
  })

  it('forceGroupId null opens a single panel even when the id is listed in a group', () => {
    // The fork could not inherit its source group (group full) → stays ungrouped.
    const res = openTargetForSession({
      id: 'a',
      groups: [G],
      liveSessionIds: ['a', 'b'],
      maxOpen: 3,
      forceGroupId: null,
    })
    expect(res).toEqual({ openIds: ['a'], focusId: 'a', groupId: null })
  })

  it('forceGroupId referencing an unknown group falls back to single-panel open', () => {
    const res = openTargetForSession({
      id: 'a',
      groups: [G],
      liveSessionIds: ['a', 'b'],
      maxOpen: 3,
      forceGroupId: 'nope',
    })
    expect(res).toEqual({ openIds: ['a'], focusId: 'a', groupId: null })
  })

  it('does not mutate the input group sessionIds array', () => {
    const group = { id: 'g', sessionIds: ['a', 'b'] }
    openTargetForSession({
      id: 'a',
      groups: [group],
      liveSessionIds: ['a', 'b'],
      maxOpen: 3,
    })
    expect(group.sessionIds).toEqual(['a', 'b'])
  })
})
