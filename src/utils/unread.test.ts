import { describe, it, expect } from 'vitest'
import { computeUnread, bumpLastSeen, pruneLastSeen } from './unread'

describe('computeUnread', () => {
  it('marks sessions with a newer lastTurnAt than seen', () => {
    const unread = computeUnread(
      [{ id: 'a', lastTurnAt: 100 }, { id: 'b', lastTurnAt: 200 }],
      { a: 50, b: 200 },
    )
    expect(unread).toEqual({ a: true })
  })

  it('treats missing lastSeenTurn entry as never-seen (0)', () => {
    // A reload leaves lastSeenTurn empty — sessions that already completed
    // turns would previously all flash as unread (bug 2). With the map
    // persisted we still want new-session behaviour to match: no seen
    // record AND a completed turn → unread.
    const unread = computeUnread([{ id: 'a', lastTurnAt: 100 }], {})
    expect(unread).toEqual({ a: true })
  })

  it('ignores sessions that never completed a turn', () => {
    const unread = computeUnread(
      [{ id: 'a', lastTurnAt: undefined }, { id: 'b' } as { id: 'b' }],
      {},
    )
    expect(unread).toEqual({})
  })

  it('is not affected by whether the session is "open" — the App passes that decision in via lastSeenTurn', () => {
    // computeUnread has no concept of openIds anymore. The App's
    // session-update handler bumps lastSeenTurn[focusedId] when the
    // window is focused, and non-focused open panels legitimately show
    // the dot — that's the whole point of bug 3's fix.
    const unread = computeUnread(
      [{ id: 'focused', lastTurnAt: 100 }, { id: 'sibling', lastTurnAt: 100 }],
      { focused: 100 }, // seen by the focused handler
    )
    expect(unread).toEqual({ sibling: true })
  })

  it('equal timestamps are considered read (no off-by-one)', () => {
    const unread = computeUnread([{ id: 'a', lastTurnAt: 100 }], { a: 100 })
    expect(unread).toEqual({})
  })
})

describe('bumpLastSeen', () => {
  it('returns a new map when advancing', () => {
    const prev = { a: 10 }
    const next = bumpLastSeen(prev, 'a', 20)
    expect(next).toEqual({ a: 20 })
    expect(next).not.toBe(prev)
  })

  it('returns the same reference when the ts is not strictly higher', () => {
    // React bail-out: same reference → no re-render, so this matters.
    const prev = { a: 20 }
    expect(bumpLastSeen(prev, 'a', 20)).toBe(prev)
    expect(bumpLastSeen(prev, 'a', 10)).toBe(prev)
  })

  it('returns the same reference when nextTs is undefined', () => {
    const prev = { a: 20 }
    expect(bumpLastSeen(prev, 'a', undefined)).toBe(prev)
  })

  it('seeds an entry for an unseen id', () => {
    expect(bumpLastSeen({}, 'new', 42)).toEqual({ new: 42 })
  })
})

describe('pruneLastSeen', () => {
  it('drops entries for ids not in the valid set', () => {
    const prev = { a: 1, b: 2, c: 3 }
    const next = pruneLastSeen(prev, new Set(['a', 'c']))
    expect(next).toEqual({ a: 1, c: 3 })
    expect(next).not.toBe(prev)
  })

  it('returns the same reference when nothing would change', () => {
    const prev = { a: 1, b: 2 }
    expect(pruneLastSeen(prev, new Set(['a', 'b']))).toBe(prev)
    expect(pruneLastSeen(prev, new Set(['a', 'b', 'c']))).toBe(prev)
  })

  it('returns an empty object (not the original) when everything prunes', () => {
    const prev = { a: 1 }
    const next = pruneLastSeen(prev, new Set<string>())
    expect(next).toEqual({})
    expect(next).not.toBe(prev)
  })
})
