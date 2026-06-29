import { describe, it, expect } from 'vitest'
import { closeGroupPanelsState } from './group-panels'

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
