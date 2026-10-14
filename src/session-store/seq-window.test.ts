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

/** Append seqs from..to one by one (contiguous live stream). */
function stream(w = emptyWindow(0, 0), from = 0, to = 4): typeof w {
  for (let s = from; s <= to; s++) w = liveAppend(w, s, msg('user', s), 0)
  return w
}

describe('seq-window: liveAppend', () => {
  it('appends the first seq into an empty window (oldest = newest = seq)', () => {
    const w = liveAppend(emptyWindow(0, 0), 7, msg('user', 7), 0)
    expect(w.newestSeq).toBe(7)
    expect(w.oldestSeq).toBe(7)
    expect(w.window.get(7)).toBeDefined()
    expect(w.hole).toBeNull()
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
    let w = stream(emptyWindow(0, 0), 10, 12)
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
    let w = stream(emptyWindow(0, 0), 10, 12)
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

  it('is identity-stable when nothing named exists', () => {
    const w = stream()
    expect(evictSeqs(w, [99, 100])).toBe(w)
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
