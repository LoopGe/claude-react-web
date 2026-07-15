import { describe, it, expect } from 'vitest'
import { inheritGroupId, inheritSidebarOrderId, joinGroupId, joinGroupOfSource } from './session-slot'
import type { SessionGroup } from '../types'

const g = (id: string, sessionIds: string[]): SessionGroup => ({
  id,
  name: id,
  sessionIds,
})

describe('inheritGroupId', () => {
  it('replaces oldId with newId in its group, preserving position', () => {
    const groups = [g('G1', ['a', 'x', 'b'])]
    expect(inheritGroupId(groups, 'x', 'y')[0].sessionIds).toEqual(['a', 'y', 'b'])
  })

  it('drops oldId (no duplicate) when newId is already a member', () => {
    const groups = [g('G1', ['a', 'x', 'y'])]
    expect(inheritGroupId(groups, 'x', 'y')[0].sessionIds).toEqual(['a', 'y'])
  })

  it('leaves other groups untouched and returns them by reference', () => {
    const other = g('G2', ['p', 'q'])
    const groups = [g('G1', ['a', 'x']), other]
    const next = inheritGroupId(groups, 'x', 'y')
    expect(next[1]).toBe(other)
  })

  it('returns the input array by reference when oldId is in no group', () => {
    const g1 = g('G1', ['a', 'b'])
    const groups = [g1]
    const next = inheritGroupId(groups, 'x', 'y')
    // No group contained oldId → the helper returns the INPUT array by
    // reference (the `map` result is discarded via `changed ? next : groups`),
    // so the caller's reference-equality no-op short-circuit fires (no
    // spurious debounced flush / re-render).
    expect(next).toBe(groups)
    expect(next[0]).toBe(g1)
  })

  it('is a no-op when oldId === newId', () => {
    const groups = [g('G1', ['a', 'x'])]
    expect(inheritGroupId(groups, 'x', 'x')).toBe(groups)
  })

  it('handles a session appearing in multiple groups (defensive)', () => {
    const groups = [g('G1', ['x']), g('G2', ['x', 'z'])]
    const next = inheritGroupId(groups, 'x', 'y')
    expect(next[0].sessionIds).toEqual(['y'])
    expect(next[1].sessionIds).toEqual(['y', 'z'])
  })
})

describe('inheritSidebarOrderId', () => {
  it('replaces oldId with newId preserving position', () => {
    expect(inheritSidebarOrderId(['a', 'x', 'b'], 'x', 'y')).toEqual(['a', 'y', 'b'])
  })

  it('drops oldId when newId is already ordered', () => {
    expect(inheritSidebarOrderId(['a', 'x', 'y'], 'x', 'y')).toEqual(['a', 'y'])
  })

  it('returns the same reference when oldId is absent', () => {
    const order = ['a', 'b']
    expect(inheritSidebarOrderId(order, 'x', 'y')).toBe(order)
  })

  it('is a no-op when oldId === newId', () => {
    const order = ['a', 'x']
    expect(inheritSidebarOrderId(order, 'x', 'x')).toBe(order)
  })
})

describe('joinGroupId', () => {
  it('appends newId to oldIds group (oldId stays)', () => {
    const groups = [g('G1', ['a', 'x'])]
    expect(joinGroupId(groups, 'x', 'y')[0].sessionIds).toEqual(['a', 'x', 'y'])
  })

  it('is a no-op when newId is already a member of oldIds group', () => {
    const groups = [g('G1', ['a', 'x', 'y'])]
    expect(joinGroupId(groups, 'x', 'y')).toBe(groups)
  })

  it('returns the input by reference when oldId is in no group', () => {
    const groups = [g('G1', ['a', 'b'])]
    expect(joinGroupId(groups, 'x', 'y')).toBe(groups)
  })

  it('is a no-op when oldId === newId', () => {
    const groups = [g('G1', ['a', 'x'])]
    expect(joinGroupId(groups, 'x', 'x')).toBe(groups)
  })

  it('leaves other groups untouched by reference', () => {
    const other = g('G2', ['p', 'q'])
    const groups = [g('G1', ['x']), other]
    const next = joinGroupId(groups, 'x', 'y')
    expect(next[1]).toBe(other)
    expect(next[0].sessionIds).toEqual(['x', 'y'])
  })
})

describe('joinGroupOfSource', () => {
  it('appends newId to a non-full group (evicting false, fork)', () => {
    const groups = [g('G1', ['a', 'x'])]
    expect(joinGroupOfSource(groups, 'x', 'y', { evicting: false, maxGroupSize: 3 })[0].sessionIds).toEqual(['a', 'x', 'y'])
  })

  it('skips the append on a FULL group when evicting is false (fork — let handleAddToGroup toast)', () => {
    const groups = [g('G1', ['a', 'b', 'x'])] // full at maxGroupSize=3
    expect(joinGroupOfSource(groups, 'x', 'y', { evicting: false, maxGroupSize: 3 })).toBe(groups)
  })

  it('appends newId to a FULL group when evicting is true (clear/restart — X is leaving)', () => {
    // Regression: this is the /clear-on-a-full-group flash. Without the
    // evicting bypass, Y would stay ungrouped and flash under "Ungrouped".
    const groups = [g('G1', ['a', 'b', 'x'])] // full at maxGroupSize=3
    expect(joinGroupOfSource(groups, 'x', 'y', { evicting: true, maxGroupSize: 3 })[0].sessionIds).toEqual(['a', 'b', 'x', 'y'])
  })

  it('appends to a non-full group regardless of evicting', () => {
    const groups = [g('G1', ['a', 'x'])]
    expect(joinGroupOfSource(groups, 'x', 'y', { evicting: true, maxGroupSize: 3 })[0].sessionIds).toEqual(['a', 'x', 'y'])
  })

  it('returns the input by reference when sourceId is in no group (newId stays ungrouped)', () => {
    const groups = [g('G1', ['a', 'b'])]
    expect(joinGroupOfSource(groups, 'x', 'y', { evicting: true, maxGroupSize: 3 })).toBe(groups)
  })

  it('is a no-op when newId is already a member of sourceIds group', () => {
    const groups = [g('G1', ['a', 'x', 'y'])]
    expect(joinGroupOfSource(groups, 'x', 'y', { evicting: false, maxGroupSize: 3 })).toBe(groups)
  })

  it('is a no-op when sourceId === newId', () => {
    const groups = [g('G1', ['a', 'x'])]
    expect(joinGroupOfSource(groups, 'x', 'x', { evicting: true, maxGroupSize: 3 })).toBe(groups)
  })
})
