import { describe, expect, it } from 'vitest'
import { TranscriptStore } from './transcript-store'

describe('TranscriptStore', () => {
  it('assigns dense ascending seqs and dedups by uuid', () => {
    const s = new TranscriptStore('sid')
    expect(s.record('u1')).toBe(0)
    expect(s.record('u2')).toBe(1)
    expect(s.record('u1')).toBe(0) // SDK echo / 重复登记不产生新 seq
    expect(s.record(null)).toBe(2)
  })
  it('window() returns the newest page by default, oldest-first', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 10; i++) s.record(`u${i}`)
    const w = s.window(undefined, 4)
    expect(w.messages.map((m) => m.seq)).toEqual([6, 7, 8, 9])
    expect(w.hasMore).toBe(true)
  })
  it('window(before) pages strictly below the bound', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 10; i++) s.record(`u${i}`)
    const w = s.window(4, 3)
    expect(w.messages.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(w.hasMore).toBe(true)
  })
  it('hasMore is false at the beginning of the seq space', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 5; i++) s.record(`u${i}`)
    expect(s.window(2, 10).hasMore).toBe(false)
  })
  it('window with limit 0 returns an empty cursor-only page without throwing', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 3; i++) s.record(`u${i}`)
    const w = s.window(undefined, 0)
    expect(w.messages).toEqual([])
    expect(w.hasMore).toBe(false)
    expect(w.startIndex).toBe(3)
    expect(w.headSeq).toBe(3)
    // before-bound variant too (the picked[0].seq deref crashed here first)
    expect(() => s.window(2, 0)).not.toThrow()
    expect(s.window(2, 0).messages).toEqual([])
  })
  it('evict tombstones without recycling seqs; window skips them', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 5; i++) s.record(`u${i}`)
    expect(s.evict(['u1', 'u3', 'missing'])).toEqual([1, 3])
    expect(s.window(undefined, 10).messages.map((m) => m.seq)).toEqual([0, 2, 4])
    expect(s.record('u5')).toBe(5) // seq 不回 收
  })
  it('reset bumps generation and zeroes seqs', () => {
    const s = new TranscriptStore('sid')
    s.record('u1')
    s.reset()
    expect(s.generation).toBe(1)
    expect(s.record('u2')).toBe(0)
    expect(s.seqOf('u1')).toBeUndefined()
  })
  it('hydrate restores indexes and tombstones', () => {
    const s = new TranscriptStore('sid')
    s.hydrate([
      { seq: 0, uuid: 'a', msg: { type: 'user' } },
      { seq: 1, uuid: 'b', evicted: true },
      { seq: 2, uuid: 'c', msg: { type: 'assistant' } },
    ])
    expect(s.headSeq).toBe(3)
    expect(s.seqOf('b')).toBe(1)
    expect(s.isEvicted(1)).toBe(true)
    expect(s.window(undefined, 10).messages.map((m) => m.seq)).toEqual([0, 2])
  })

  describe('window() tombstone reporting', () => {
    it('reports no tombstones when nothing was evicted', () => {
      const s = new TranscriptStore('sid')
      for (let i = 0; i < 4; i++) s.record(`u${i}`)
      expect(s.window(undefined, 10).tombstones).toEqual([])
    })
    it('reports evicted seqs across the page span, even below a visible newer message', () => {
      // The interrupt/withdraw race shape: tombstoned seq 3 sits BELOW visible
      // seq 5 — a top-run-only scan would stop at 5 and miss it.
      const s = new TranscriptStore('sid')
      for (let i = 0; i < 5; i++) s.record(`u${i}`)
      s.evict(['u3'])
      s.record('u5')
      const w = s.window(undefined, 10)
      expect(w.messages.map((m) => m.seq)).toEqual([0, 1, 2, 4, 5])
      expect(w.tombstones).toEqual([3])
    })
    it('reports only tombstones within the span [picked[0].seq, before)', () => {
      const s = new TranscriptStore('sid')
      for (let i = 0; i < 6; i++) s.record(`u${i}`)
      s.evict(['u1', 'u3', 'u4'])
      const w = s.window(6, 2)
      expect(w.messages.map((m) => m.seq)).toEqual([2, 5])
      expect(w.tombstones).toEqual([3, 4]) // seq 1 is below the span — not reported
    })
    it('empty page reports no tombstones', () => {
      const s = new TranscriptStore('sid')
      for (let i = 0; i < 3; i++) s.record(`u${i}`)
      s.evict(['u1'])
      expect(s.window(2, 0).tombstones).toEqual([])
    })
    it('a page whose ENTIRE span is evicted still declares them (missed-evict reconnect)', () => {
      // The client holds nothing below the bound; the hole-fill page picks
      // nothing, but every seq below `before` is evicted and must be declared
      // or the parked frame above them strands behind an undeclared hole.
      const s = new TranscriptStore('sid')
      for (let i = 0; i < 5; i++) s.record(`u${i}`)
      s.evict(['u0', 'u1', 'u2', 'u3', 'u4'])
      s.record('u5')
      const w = s.window(5, 200)
      expect(w.messages).toEqual([])
      expect(w.tombstones).toEqual([0, 1, 2, 3, 4])
    })
    it('reports hydrate-carried evictions', () => {
      const s = new TranscriptStore('sid')
      s.hydrate([
        { seq: 0, uuid: 'a', msg: { type: 'user' } },
        { seq: 1, uuid: 'b', evicted: true },
        { seq: 2, uuid: 'c', msg: { type: 'assistant' } },
      ])
      expect(s.window(undefined, 10).tombstones).toEqual([1])
    })
  })
})
