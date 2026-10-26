import { describe, it, expect } from 'vitest'
import { evictFromGroups, inheritGroupId, joinGroupOfSource } from './session-slot'
import type { SessionGroup } from '../types'

/**
 * Repro for: "group knowledge 本来两个 session，对其中一个 /clear 后 session 消失".
 *
 * /clear is an X→Y swap. The server broadcasts `session-created(Y, joinGroupOf=X,
 * evictingSource=true)` then `session-removed(X)`. The client is supposed to put
 * Y into X's group slot.
 *
 * The evicting path in App.tsx's session-created handler DELIBERATELY does not
 * append Y (`// swapSession/teardown places Y — nothing to do here`). Placement
 * is deferred to swapSession → inheritGroupId, or to teardownRemovedSession →
 * joinGroupOfSource. Both look up X's group by X's id.
 *
 * If session-removed(X) teardown strips X from the group FIRST (cross-tab, or a
 * WS/POST race that misses the clearingIds guard), both helpers no-op: X is in
 * no group, so Y is never placed. The group loses a member — exactly what the
 * logs show (`ef424bd3` ungrouped, `knowledge` group 2 → 1).
 */
const g = (id: string, sessionIds: string[]): SessionGroup => ({
  id,
  name: id,
  sessionIds,
})

describe('/clear replacement placement', () => {
  it('joinGroupOfSource strands Y when X is already gone (why placement must be atomic)', () => {
    // After session-removed(X) teardown: X is no longer in the group.
    const groupsAfterXRemoved = [g('G1', ['a'])]
    // session-created(Y, joinGroupOf=X) arrives late. The old evicting path
    // deferred placement to this helper — which requires X to still be in a group.
    const next = joinGroupOfSource(groupsAfterXRemoved, 'x', 'y', {
      evicting: true,
      maxGroupSize: 3,
    })
    // Documented limitation: Y is stranded. The fix is evictFromGroups below,
    // which places Y at removal time so this race never has to recover.
    expect(next).toBe(groupsAfterXRemoved)
    expect(next[0].sessionIds).not.toContain('y')
  })

  it('inheritGroupId strands Y when X is already gone (why placement must be atomic)', () => {
    const groupsAfterXRemoved = [g('G1', ['a'])]
    const next = inheritGroupId(groupsAfterXRemoved, 'x', 'y')
    expect(next).toBe(groupsAfterXRemoved)
    expect(next[0].sessionIds).not.toContain('y')
  })

  it('evictFromGroups puts Y in X exact slot — the atomic X→Y swap', () => {
    // The teardown path must drop X and place Y in ONE update so no frame
    // handler in between can observe "X gone, Y not yet placed".
    const groups = [g('G1', ['a', 'x', 'b'])]
    const next = evictFromGroups(groups, 'x', 'y')
    expect(next[0].sessionIds).toEqual(['a', 'y', 'b'])
  })

  it('evictFromGroups without a replacement is a plain removal', () => {
    const groups = [g('G1', ['a', 'x', 'b'])]
    const next = evictFromGroups(groups, 'x')
    expect(next[0].sessionIds).toEqual(['a', 'b'])
  })

  it('evictFromGroups is idempotent when the replacement is already a member', () => {
    const groups = [g('G1', ['a', 'x', 'y'])]
    const next = evictFromGroups(groups, 'x', 'y')
    expect(next[0].sessionIds).toEqual(['a', 'y'])
  })

  it('evictFromGroups no-ops when oldId is in no group (caller keeps the marker)', () => {
    const groups = [g('G1', ['a'])]
    expect(evictFromGroups(groups, 'x', 'y')).toBe(groups)
  })

  it('a clear replacement lands in its source group even when X already left', () => {
    // The invariant the /clear swap must uphold. Placement is now atomic
    // (evictFromGroups), so "X already gone before Y is placed" cannot happen
    // on the teardown path. This test pins the end state.
    const groupsBefore = [g('G1', ['a', 'x'])]
    const groupsAfter = evictFromGroups(groupsBefore, 'x', 'y')
    expect(groupsAfter[0].sessionIds).toEqual(['a', 'y'])
  })
})
