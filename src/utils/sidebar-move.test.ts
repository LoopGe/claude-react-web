import { describe, it, expect } from 'vitest'
import { sidebarMoveTarget } from './sidebar-move'
import type { SidebarSection, SessionInfo } from '../types'

function session(id: string): SessionInfo {
  // SessionNavStrip and the sidebar render off a handful of fields; the move
  // math itself only reads `id`. Fill the rest with inert placeholders.
  return { id } as SessionInfo
}

const sections: SidebarSection[] = [
  {
    kind: 'group',
    group: { id: 'g1', name: 'Group 1', sessionIds: ['a', 'b', 'c'] },
    sessions: [session('a'), session('b'), session('c')],
  },
  { kind: 'ungrouped', sessions: [session('d'), session('e')] },
]

describe('sidebarMoveTarget', () => {
  it('returns the previous sibling within a group section for "up"', () => {
    expect(sidebarMoveTarget(sections, 'b', 'up')).toEqual({
      targetId: 'a',
      groupId: 'g1',
    })
  })

  it('returns the next sibling within a group section for "down"', () => {
    expect(sidebarMoveTarget(sections, 'b', 'down')).toEqual({
      targetId: 'c',
      groupId: 'g1',
    })
  })

  it('returns null at the top edge of a section', () => {
    expect(sidebarMoveTarget(sections, 'a', 'up')).toBeNull()
  })

  it('returns null at the bottom edge of a section', () => {
    expect(sidebarMoveTarget(sections, 'e', 'down')).toBeNull()
  })

  it('omits groupId in the ungrouped section', () => {
    expect(sidebarMoveTarget(sections, 'd', 'down')).toEqual({ targetId: 'e' })
    expect(sidebarMoveTarget(sections, 'e', 'up')).toEqual({ targetId: 'd' })
  })

  it('does not cross section boundaries', () => {
    // "up" from the first member of the ungrouped section must not reach
    // into the group section above — sections are independent containers.
    expect(sidebarMoveTarget(sections, 'd', 'up')).toBeNull()
    expect(sidebarMoveTarget(sections, 'c', 'down')).toBeNull()
  })

  it('returns null for an unknown session id', () => {
    expect(sidebarMoveTarget(sections, 'zzz', 'up')).toBeNull()
  })

  it('returns null when the id is not in the group snapshot but in sessionIds', () => {
    // group.sessionIds and sec.sessions can drift during a deletion; the
    // move math must trust the rendered section list only.
    const drifted: SidebarSection[] = [
      {
        kind: 'group',
        group: { id: 'g1', name: 'G', sessionIds: ['a', 'ghost'] },
        sessions: [session('a')],
      },
    ]
    expect(sidebarMoveTarget(drifted, 'ghost', 'up')).toBeNull()
  })

  it('returns null for empty sections', () => {
    expect(sidebarMoveTarget([], 'a', 'up')).toBeNull()
  })
})
