import { describe, it, expect } from 'vitest'
import { closeGroupPanelsState, groupsAfterSlotTakeover } from './group-panels'
import type { SessionGroup } from '../types'

describe('closeGroupPanelsState', () => {
  it('removes every group member from the open set', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b', 'c'],
      groupSessionIds: ['a', 'c'],
      focusedId: 'a',
    })
    expect(res.openIds).toEqual(['b'])
  })

  it('preserves open panels that are not group members', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b', 'c', 'd'],
      groupSessionIds: ['b'],
      focusedId: 'd',
    })
    expect(res.openIds).toEqual(['a', 'c', 'd'])
  })

  it('does not mutate the input openIds array', () => {
    const openIds = ['a', 'b', 'c']
    closeGroupPanelsState({
      openIds,
      groupSessionIds: ['a'],
      focusedId: 'a',
    })
    expect(openIds).toEqual(['a', 'b', 'c'])
  })

  it('falls back to the last surviving panel when focused is a member', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b', 'c'],
      groupSessionIds: ['a'],
      focusedId: 'a',
    })
    expect(res.focusedId).toBe('c')
  })

  it('falls back to null when no panels survive', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b'],
      groupSessionIds: ['a', 'b'],
      focusedId: 'a',
    })
    expect(res.openIds).toEqual([])
    expect(res.focusedId).toBeNull()
  })

  it('keeps the current focusedId when it is not a group member', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b', 'c'],
      groupSessionIds: ['a'],
      focusedId: 'b',
    })
    expect(res.focusedId).toBe('b')
  })

  it('handles a focusedId of null', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b'],
      groupSessionIds: ['a'],
      focusedId: null,
    })
    expect(res.focusedId).toBeNull()
    expect(res.openIds).toEqual(['b'])
  })

  it('is a no-op when the group owns none of the open panels', () => {
    const res = closeGroupPanelsState({
      openIds: ['a', 'b'],
      groupSessionIds: ['x', 'y'],
      focusedId: 'a',
    })
    expect(res.openIds).toEqual(['a', 'b'])
    expect(res.focusedId).toBe('a')
  })
})

describe('groupsAfterSlotTakeover', () => {
  const g = (id: string, sessionIds: string[]): SessionGroup => ({ id, name: id, sessionIds })

  it('leaves a same-group takeover untouched — the sidebar must not reorder (the jump-to-first bug)', () => {
    const groups = [g('g1', ['a', 'b', 'c'])]
    // Dropping the middle card onto the first member's panel used to swap
    // their sessionIds positions, teleporting the card to the top.
    expect(groupsAfterSlotTakeover({ groups, id: 'b', targetId: 'a' })).toBe(groups)
  })

  it('leaves a cross-group takeover untouched (no membership yanking)', () => {
    const groups = [g('g1', ['a']), g('g2', ['b'])]
    expect(groupsAfterSlotTakeover({ groups, id: 'a', targetId: 'b' })).toBe(groups)
  })

  it('joins an ungrouped taker into the target group at its position', () => {
    const groups = [g('g1', ['a', 'b']), g('g2', ['c'])]
    const next = groupsAfterSlotTakeover({ groups, id: 'x', targetId: 'b' })
    expect(next.find((x) => x.id === 'g1')?.sessionIds).toEqual(['a', 'x'])
    expect(next.find((x) => x.id === 'g2')).toBe(groups[1])
  })

  it('is a no-op when the target is ungrouped or ids match', () => {
    const groups = [g('g1', ['a'])]
    expect(groupsAfterSlotTakeover({ groups, id: 'x', targetId: 'y' })).toBe(groups)
    expect(groupsAfterSlotTakeover({ groups, id: 'a', targetId: 'a' })).toBe(groups)
  })

  it('does not mutate the input groups', () => {
    const groups = [g('g1', ['a', 'b'])]
    groupsAfterSlotTakeover({ groups, id: 'x', targetId: 'b' })
    expect(groups[0].sessionIds).toEqual(['a', 'b'])
  })
})
