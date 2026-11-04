import { describe, expect, it } from 'vitest'
import type { SdkMessage } from '../types'
import {
  bumpGeneration,
  evictSeqs,
  emptyWindow,
  liveAppend,
  pageLoaded,
  windowHole,
} from './seq-window'

function msg(type: string, seq: number): SdkMessage {
  return { type, seq, uuid: `u${seq}` } as unknown as SdkMessage
}

/** Append seqs from..to one by one (contiguous live stream). Starts at seq 0
 *  because a live frame may only anchor an empty window there. */
function stream(w = emptyWindow(0, 0), from = 0, to = 4): typeof w {
  for (let s = from; s <= to; s++) w = liveAppend(w, s, msg('user', s), 0)
  return w
}

/** Seed a window whose on-screen front is `from` the way the client actually
 *  gets one: a page anchors it (a tail page over a transcript whose prefix is
 *  gone, or a recovery page). Live frames can NOT anchor above seq 0. */
function anchored(from: number, to: number): ReturnType<typeof emptyWindow> {
  const messages = []
  for (let s = from; s <= to; s++) messages.push({ seq: s, msg: msg('user', s) })
  return pageLoaded(emptyWindow(0, 0), {
    at: 'tail',
    generation: 0,
    messages,
    hasMore: false,
    headSeq: to + 1,
  })
}

describe('seq-window: liveAppend', () => {
  it('anchors an empty window at seq 0 (nothing can precede it)', () => {
    const w = liveAppend(emptyWindow(0, 0), 0, msg('user', 0), 0)
    expect(w.newestSeq).toBe(0)
    expect(w.oldestSeq).toBe(0)
    expect(w.window.get(0)).toBeDefined()
    expect(w.pending.size).toBe(0)
    expect(w.hole).toBeNull()
  })

  // The window must never anchor ABOVE seq 0 on an empty, generation-adopted
  // window: the earlier seqs were emitted while no channel was subscribed, and
  // silently starting mid-way is what put the user's prompt at the bottom of
  // its own turn. Parking the frame exposes the prefix as a FRONT hole for the
  // ordinary gap-fill.
  it('parks the first live seq above 0 as a front hole', () => {
    const w = liveAppend(emptyWindow(0, 0), 7, msg('user', 7), 0)
    expect(w.window.size).toBe(0)
    expect(w.newestSeq).toBeNull()
    expect(w.oldestSeq).toBeNull()
    expect(w.pending.get(7)).toBeDefined()
    expect(w.hole).toEqual([0, 6])
  })

  it('anchors normally when the whole prefix is tombstoned', () => {
    // A withdrawal emptied the window and the server declared 0..2 dead —
    // there is no prefix left to fetch, so a live frame must apply at once
    // (a parked `result` here would never clear the turn).
    const w = evictSeqs(emptyWindow(0, 0), [0, 1, 2])
    expect(w.window.size).toBe(0)
    const next = liveAppend(w, 3, msg('user', 3), 0)
    expect(next.window.get(3)).toBeDefined()
    expect(next.newestSeq).toBe(3)
    expect(next.pending.size).toBe(0)
    expect(next.hole).toBeNull()
  })

  it('drains a parked front frame once the prefix page lands', () => {
    const parked = liveAppend(emptyWindow(0, 0), 2, msg('user', 2), 0)
    const w = pageLoaded(parked, {
      at: 'tail',
      messages: [
        { seq: 0, msg: msg('user', 0) },
        { seq: 1, msg: msg('assistant', 1) },
      ],
      hasMore: false,
      generation: 0,
      headSeq: 3,
    })
    expect(w.hole).toBeNull()
    expect(w.pending.size).toBe(0)
    expect(w.newestSeq).toBe(2)
    expect(w.oldestSeq).toBe(0)
    expect([...w.window.keys()]).toEqual([0, 1, 2])
  })

  // A page must not anchor above parked front-hole frames: the front is the
  // seq just below the lowest pending frame, so a page frame beyond it parks
  // too. Anchoring would invert the hole range ([newest+1, minPending-1]) and
  // strand the earlier parked frame forever.
  it('a page cannot anchor above parked front-hole frames', () => {
    const parked = liveAppend(emptyWindow(0, 0), 3, msg('user', 3), 0)
    const w = pageLoaded(parked, {
      at: 'tail',
      messages: [{ seq: 4, msg: msg('assistant', 4) }],
      hasMore: false,
      generation: 0,
      headSeq: 5,
      // No tombstones declared: 0..2 must still be fetched, not skipped.
    })
    expect(w.window.size).toBe(0)
    expect(w.newestSeq).toBeNull()
    expect([...w.pending.keys()].sort((a, b) => a - b)).toEqual([3, 4])
    expect(w.hole).toEqual([0, 2])
  })

  // Front-hole parking makes non-contiguous pending sets reachable. The
  // empty-window drain may only release the contiguous run from the lowest
  // parked frame once its prefix is fully tombstoned; releasing everything
  // would anchor the window across a live, unfetched gap with no hole left to
  // fetch it.
  it('never drains past a live gap when releasing front-hole frames', () => {
    let w = liveAppend(emptyWindow(0, 0), 3, msg('user', 3), 0)
    w = liveAppend(w, 7, msg('assistant', 7), 0)
    w = pageLoaded(w, {
      at: 'tail',
      messages: [],
      hasMore: false,
      generation: 0,
      headSeq: 8,
      tombstones: [0, 1, 2],
    })
    expect([...w.window.keys()]).toEqual([3])
    expect([...w.pending.keys()]).toEqual([7])
    expect(w.newestSeq).toBe(3)
    expect(w.hole).toEqual([4, 6])
  })

  it('tail-appends seq === newestSeq + 1', () => {
    const w = stream()
    expect(w.newestSeq).toBe(4)
    expect(w.oldestSeq).toBe(0)
    expect(w.window.size).toBe(5)
    expect(w.hasOlder).toBe(false)
    expect(w.hasNewer).toBe(false)
  })

  it('buffers a gapped seq into pending and marks the hole range', () => {
    const w = stream(undefined, 0, 2) // newest = 2
    const next = liveAppend(w, 5, msg('assistant', 5), 0)
    expect(next.newestSeq).toBe(2)
    expect(next.window.size).toBe(3)
    expect(next.pending.get(5)).toBeDefined()
    expect(next.hole).toEqual([3, 4])
    expect(windowHole(next)).toEqual([3, 4])
    expect(next.hasNewer).toBe(true)
  })

  it('drops an old frame idempotently (seq <= newestSeq)', () => {
    const w = stream()
    const next = liveAppend(w, 2, msg('user', 2), 0)
    expect(next).toBe(w)
  })

  it('drops a duplicate pending frame idempotently', () => {
    const w = stream(undefined, 0, 2)
    const parked = liveAppend(w, 5, msg('assistant', 5), 0)
    const again = liveAppend(parked, 5, msg('assistant', 5), 0)
    expect(again).toBe(parked)
  })

  it('drains contiguous pending frames on subsequent live appends', () => {
    const w = stream(undefined, 0, 2) // newest = 2
    const parked = liveAppend(liveAppend(w, 4, msg('a', 4), 0), 5, msg('a', 5), 0)
    expect(parked.pending.size).toBe(2)
    // Filling seq 3 cascades 4 and 5 out of pending into the window.
    const filled = liveAppend(parked, 3, msg('a', 3), 0)
    expect(filled.newestSeq).toBe(5)
    expect(filled.pending.size).toBe(0)
    expect(filled.hole).toBeNull()
    expect(filled.window.size).toBe(6)
    expect(filled.window.get(4)).toBeDefined()
    expect(filled.window.get(5)).toBeDefined()
  })

  it('ignores a frame whose generation does not match', () => {
    const w = stream()
    expect(liveAppend(w, 5, msg('a', 5), 9)).toBe(w)
  })

  it('advances headSeq when a live seq reaches it', () => {
    const w = liveAppend(emptyWindow(0, 3), 3, msg('u', 3), 0)
    expect(w.headSeq).toBe(4)
  })
})

describe('seq-window: pageLoaded', () => {
  it('adopts the page generation when the window is empty', () => {
    const w = pageLoaded(emptyWindow(-1, 0), {
      at: 'tail',
      generation: 2,
      messages: [
        { seq: 3, msg: msg('user', 3) },
        { seq: 4, msg: msg('a', 4) },
      ],
      hasMore: true,
    })
    expect(w.generation).toBe(2)
    expect(w.oldestSeq).toBe(3)
    expect(w.newestSeq).toBe(4)
    expect(w.hasOlder).toBe(true)
    expect(w.hasNewer).toBe(false)
  })

  it('merges a hole-filling tail page and drains pending', () => {
    const w = stream(undefined, 0, 2)
    const parked = liveAppend(w, 5, msg('a', 5), 0)
    const filled = pageLoaded(parked, {
      at: 'tail',
      generation: 0,
      messages: [
        { seq: 3, msg: msg('u', 3) },
        { seq: 4, msg: msg('u', 4) },
      ],
      hasMore: false,
    })
    expect(filled.newestSeq).toBe(5)
    expect(filled.pending.size).toBe(0)
    expect(filled.hole).toBeNull()
    expect(filled.window.size).toBe(6)
    expect(filled.hasNewer).toBe(false)
  })

  it('prepends a head page below oldestSeq and updates hasOlder', () => {
    let w = anchored(10, 12)
    w = { ...w, hasOlder: true }
    const next = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [
        { seq: 8, msg: msg('u', 8) },
        { seq: 9, msg: msg('u', 9) },
      ],
      hasMore: true,
    })
    expect(next.oldestSeq).toBe(8)
    expect(next.newestSeq).toBe(12)
    expect(next.hasOlder).toBe(true)
    expect(next.window.size).toBe(5)
  })

  it('skips seqs already present (idempotent page)', () => {
    const w = stream()
    const again = pageLoaded(w, {
      at: 'tail',
      generation: 0,
      messages: [
        { seq: 3, msg: msg('u', 3) },
        { seq: 4, msg: msg('u', 4) },
      ],
      hasMore: false,
    })
    expect(again.window.size).toBe(5)
    expect(again.hasOlder).toBe(false)
  })

  it('ignores a page whose generation does not match a non-empty window', () => {
    const w = stream()
    const stale = pageLoaded(w, {
      at: 'tail',
      generation: 7,
      messages: [{ seq: 5, msg: msg('u', 5) }],
      hasMore: false,
    })
    expect(stale).toBe(w)
  })

  it('keeps lowering oldestSeq across successive head pages', () => {
    let w = anchored(10, 12)
    w = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [
        { seq: 8, msg: msg('u', 8) },
        { seq: 9, msg: msg('u', 9) },
      ],
      hasMore: true,
    })
    const next = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [
        { seq: 5, msg: msg('u', 5) },
        { seq: 6, msg: msg('u', 6) },
        { seq: 7, msg: msg('u', 7) },
      ],
      hasMore: false,
    })
    expect(next.oldestSeq).toBe(5)
    expect(next.newestSeq).toBe(12)
    expect(next.hasOlder).toBe(false)
  })
})

describe('seq-window: evictSeqs', () => {
  it('removes seqs and recomputes the boundaries', () => {
    const w = stream()
    const next = evictSeqs(w, [0, 2])
    expect(next.window.has(0)).toBe(false)
    expect(next.window.has(2)).toBe(false)
    expect(next.oldestSeq).toBe(1)
    expect(next.newestSeq).toBe(4)
    expect(next.window.size).toBe(3)
  })

  it('evicts from pending too', () => {
    const w = stream(undefined, 0, 2)
    const parked = liveAppend(w, 5, msg('a', 5), 0)
    const next = evictSeqs(parked, [5])
    expect(next.pending.size).toBe(0)
    expect(next.hole).toBeNull()
    expect(next.newestSeq).toBe(2)
  })

  it('empties the window cleanly when everything is evicted', () => {
    const w = stream(undefined, 0, 2)
    const next = evictSeqs(w, [0, 1, 2])
    expect(next.oldestSeq).toBeNull()
    expect(next.newestSeq).toBeNull()
    expect(next.window.size).toBe(0)
  })

  it('is identity-stable on a REPEAT evict of already-recorded seqs', () => {
    const w = stream()
    const once = evictSeqs(w, [99, 100]) // first evict records the tombstones
    expect(once).not.toBe(w)
    expect(once.tombstones.has(99)).toBe(true)
    expect(evictSeqs(once, [99, 100])).toBe(once) // nothing new → same reference
  })

  it('records unknown seqs as tombstones even when nothing was held', () => {
    const w = stream()
    const next = evictSeqs(w, [99])
    expect(next.tombstones.has(99)).toBe(true)
    expect(next.window.size).toBe(w.window.size) // nothing deleted
    expect(next).not.toBe(w)
  })

  it('opts.tombstone=false deletes without recording (client-side trims)', () => {
    const w = stream()
    const next = evictSeqs(w, [0], { tombstone: false })
    expect(next.window.has(0)).toBe(false)
    expect(next.tombstones.size).toBe(0)
  })
})

describe('seq-window: tombstone-aware contiguity', () => {
  it('THE interrupt/withdraw race: evict of the top seq lets the next seq append', () => {
    // Steer message applied at seq 4; server tombstones 4; the turn's result
    // registers at 5. Without tombstone awareness 5 parks behind an
    // unfillable hole and the WorkingBubble never clears.
    const w = stream(undefined, 0, 4) // newest = 4
    const evicted = evictSeqs(w, [4])
    expect(evicted.newestSeq).toBe(3)
    const result = liveAppend(evicted, 5, msg('result', 5), 0)
    expect(result.window.has(5)).toBe(true)
    expect(result.newestSeq).toBe(5)
    expect(result.pending.size).toBe(0)
    expect(result.hole).toBeNull()
  })

  it('reverse order: a frame parked behind a tombstoned hole drains on evict', () => {
    const w = stream(undefined, 0, 3) // newest = 3
    const parked = liveAppend(w, 5, msg('result', 5), 0)
    expect(parked.pending.size).toBe(1)
    const evicted = evictSeqs(parked, [4]) // tombstone lands AFTER the park
    expect(evicted.window.has(5)).toBe(true)
    expect(evicted.pending.size).toBe(0)
    expect(evicted.newestSeq).toBe(5)
    expect(evicted.hole).toBeNull()
  })

  it('drains a pending run across a tombstone run', () => {
    const w = stream(undefined, 0, 5) // newest = 5
    const parked = liveAppend(liveAppend(w, 8, msg('a', 8), 0), 9, msg('a', 9), 0)
    const evicted = evictSeqs(parked, [6, 7])
    expect(evicted.window.has(8)).toBe(true)
    expect(evicted.window.has(9)).toBe(true)
    expect(evicted.pending.size).toBe(0)
    expect(evicted.newestSeq).toBe(9)
  })

  it('a live frame at an already-tombstoned seq is dropped, the next seq skips past', () => {
    const w = stream(undefined, 0, 2) // newest = 2
    const recorded = evictSeqs(w, [3]) // seq 3 will never arrive
    const resurrect = liveAppend(recorded, 3, msg('user', 3), 0)
    expect(resurrect.window.has(3)).toBe(false)
    expect(resurrect.pending.has(3)).toBe(false)
    const next = liveAppend(resurrect, 4, msg('result', 4), 0)
    expect(next.window.has(4)).toBe(true)
    expect(next.newestSeq).toBe(4)
    expect(next.window.has(3)).toBe(false)
  })

  it('pageLoaded records tombstones before inserting and drains pending behind them', () => {
    const w = stream(undefined, 0, 2) // newest = 2
    const parked = liveAppend(w, 5, msg('result', 5), 0) // hole [3, 4]
    const filled = pageLoaded(parked, {
      at: 'tail',
      generation: 0,
      messages: [{ seq: 3, msg: msg('user', 3) }],
      tombstones: [4],
      hasMore: false,
    })
    expect(filled.newestSeq).toBe(5)
    expect(filled.pending.size).toBe(0)
    expect(filled.hole).toBeNull()
    expect(filled.window.has(4)).toBe(false)
    expect(filled.tombstones.has(4)).toBe(true)
  })

  it('a fresh tail page spanning a tombstone bootstraps without parking', () => {
    const w = pageLoaded(emptyWindow(-1, 0), {
      at: 'tail',
      generation: 0,
      messages: [
        { seq: 0, msg: msg('user', 0) },
        { seq: 1, msg: msg('user', 1) },
        { seq: 2, msg: msg('user', 2) },
        { seq: 4, msg: msg('result', 4) },
      ],
      tombstones: [3],
      hasMore: false,
    })
    expect(w.newestSeq).toBe(4)
    expect(w.pending.size).toBe(0)
    expect(w.hole).toBeNull()
    expect(w.oldestSeq).toBe(0)
  })

  it('bumpGeneration discards recorded tombstones', () => {
    const w = evictSeqs(stream(), [2])
    expect(w.tombstones.size).toBe(1)
    const bumped = bumpGeneration(w, 1, 0)
    expect(bumped.tombstones.size).toBe(0)
  })

  it('a live frame at an already-tombstoned seq is identity-stable (no clone churn)', () => {
    const w = evictSeqs(stream(undefined, 0, 4), [5]) // tombstone above newest
    const again = liveAppend(w, 5, msg('user', 5), 0)
    expect(again).toBe(w)
  })

  it('an emptied window still drains parked frames when a later tombstone closes the hole', () => {
    // Withdrawal evicts ALL applied rows (newestSeq → null), stranding a
    // parked frame behind a real hole; the LATE tombstone for that hole must
    // still drain it — an empty window has no contiguity anchor, so every
    // pending seq is appendable (same semantics as insertMessage on empty).
    let w = stream(undefined, 0, 2) // applied 0..2
    w = liveAppend(w, 4, msg('result', 4), 0) // parks behind hole [3, 3]
    w = evictSeqs(w, [0, 1, 2]) // withdrawal empties the window
    expect(w.newestSeq).toBeNull()
    expect(w.pending.size).toBe(1)
    w = evictSeqs(w, [3]) // the server tombstones the hole seq
    expect(w.pending.size).toBe(0)
    expect(w.window.has(4)).toBe(true)
    expect(w.newestSeq).toBe(4)
    expect(w.hole).toBeNull()
  })
})

describe('seq-window: bumpGeneration', () => {
  it('discards the whole window and adopts the new cursor', () => {
    const w = stream()
    const next = bumpGeneration(w, 3, 0)
    expect(next.generation).toBe(3)
    expect(next.headSeq).toBe(0)
    expect(next.window.size).toBe(0)
    expect(next.pending.size).toBe(0)
    expect(next.oldestSeq).toBeNull()
    expect(next.newestSeq).toBeNull()
    expect(next.hasOlder).toBe(false)
    expect(next.hasNewer).toBe(false)
    expect(next.hole).toBeNull()
  })
})

// ─── Task 9: oldestSeq skips slot-routed frames ─────────────────────────
//
// The server seq-assigns every isRenderableSdkMessage frame — a set WIDER
// than the client's ordered log. `system/api_retry` renders from its
// transient slot and an empty `result` frame is suppressed outright; both
// enter the window map (dedup/idempotence needs the membership) but never
// become transcript rows. oldestSeq is the RENDER ANCHOR (firstItemIndex),
// so it must be the seq of the first message that actually reached the
// ordered log: a slot-routed seq at the window top would offset the whole
// row grid relative to the seq space. newestSeq stays the numeric max —
// the tail-contiguity/hole logic is seq arithmetic.
describe('seq-window: oldestSeq skips slot-routed frames', () => {
  const apiRetry = (seq: number): SdkMessage =>
    ({ type: 'system', subtype: 'api_retry', seq, uuid: `r${seq}` }) as unknown as SdkMessage
  const emptyResult = (seq: number): SdkMessage =>
    ({ type: 'result', subtype: 'success', num_turns: 0, result: '', seq, uuid: `e${seq}` }) as unknown as SdkMessage

  it('a head page whose oldest entry is api_retry anchors on the first log row below it', () => {
    let w = anchored(10, 12)
    w = { ...w, hasOlder: true }
    const next = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [
        { seq: 8, msg: apiRetry(8) },
        { seq: 9, msg: msg('u', 9) },
      ],
      hasMore: true,
    })
    // seq 8 stays a window member (dedup), but the anchor is 9.
    expect(next.window.has(8)).toBe(true)
    expect(next.oldestSeq).toBe(9)
    expect(next.newestSeq).toBe(12)
  })

  it('an empty result frame at the window top is skipped the same way', () => {
    const w = anchored(10, 12)
    const next = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [{ seq: 9, msg: emptyResult(9) }],
      hasMore: true,
    })
    expect(next.window.has(9)).toBe(true)
    expect(next.oldestSeq).toBe(10)
  })

  it('a real result frame (non-empty) is NOT skipped', () => {
    const realResult = (seq: number): SdkMessage =>
      ({ type: 'result', subtype: 'success', num_turns: 1, result: 'done', seq, uuid: `e${seq}` }) as unknown as SdkMessage
    const w = anchored(10, 12)
    const next = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [{ seq: 9, msg: realResult(9) }],
      hasMore: true,
    })
    expect(next.oldestSeq).toBe(9)
  })

  it('live api_retry appends advance newestSeq but not the log-row anchor', () => {
    let w = stream(emptyWindow(0, 0), 0, 2)
    w = liveAppend(w, 3, apiRetry(3), 0)
    w = liveAppend(w, 4, msg('u', 4), 0)
    expect(w.newestSeq).toBe(4)
    expect(w.oldestSeq).toBe(0)
  })

  it('falls back to the true min when EVERY window entry is slot-routed (anchor stays non-null)', () => {
    // Pathological page of nothing but retries. `oldestSeq !== null` must
    // keep meaning "window non-empty" — loadOlder and the empty-window
    // bootstrap both gate on it.
    const w = liveAppend(emptyWindow(0, 0), 0, apiRetry(0), 0)
    expect(w.window.size).toBe(1)
    expect(w.oldestSeq).toBe(0)
  })

  it('recomputes the skip after evicting the log row under a slot-routed top', () => {
    let w = anchored(10, 12)
    w = pageLoaded(w, {
      at: 'head',
      generation: 0,
      messages: [
        { seq: 8, msg: apiRetry(8) },
        { seq: 9, msg: msg('u', 9) },
      ],
      hasMore: true,
    })
    expect(w.oldestSeq).toBe(9)
    // The first log row is tombstoned: the anchor moves past it, and the
    // slot-routed seq 8 is still skipped.
    const next = evictSeqs(w, [9])
    expect(next.window.has(9)).toBe(false)
    expect(next.oldestSeq).toBe(10)
  })
})
