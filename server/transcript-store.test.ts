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
})
