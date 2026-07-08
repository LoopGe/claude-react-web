import { describe, it, expect, beforeEach } from 'vitest'
import {
  createInputHistoryStore,
  normalizeEntries,
  INPUT_HISTORY_KEY,
  inputHistoryStore,
} from './inputHistoryStore'

beforeEach(() => {
  localStorage.clear()
  inputHistoryStore.reset()
})

describe('normalizeEntries', () => {
  it('coerces legacy string[] to unattributed entries', () => {
    expect(normalizeEntries(['x'])).toEqual([{ text: 'x', sessionId: null }])
  })
  it('passes through HistoryEntry[] shape', () => {
    expect(normalizeEntries([{ text: 'y', sessionId: 's1' }])).toEqual([
      { text: 'y', sessionId: 's1' },
    ])
  })
  it('defaults missing sessionId to null', () => {
    expect(normalizeEntries([{ text: 'y' }])).toEqual([{ text: 'y', sessionId: null }])
  })
  it('rejects non-array / malformed items', () => {
    expect(normalizeEntries(null)).toEqual([])
    expect(normalizeEntries([{ nope: 1 }])).toEqual([])
    expect(normalizeEntries([42, { text: 'ok' }])).toEqual([{ text: 'ok', sessionId: null }])
  })
})

describe('inputHistoryStore', () => {
  it('starts empty', () => {
    const store = createInputHistoryStore('test-empty')
    expect(store.getAll()).toEqual([])
    expect(store.getSession('s1')).toEqual([])
  })

  it('add() records entries most-recent-first', () => {
    const store = createInputHistoryStore('test-order')
    store.add('first', 's1')
    store.add('second', 's1')
    expect(store.getSession('s1')).toEqual(['second', 'first'])
  })

  it('ignores empty/whitespace-only input', () => {
    const store = createInputHistoryStore('test-empty-input')
    store.add('', 's1')
    store.add('   ', 's1')
    expect(store.getAll()).toEqual([])
  })

  it('collapses consecutive same-session duplicates', () => {
    const store = createInputHistoryStore('test-dedup')
    store.add('hello', 's1')
    store.add('hello', 's1')
    expect(store.getAll()).toEqual([{ text: 'hello', sessionId: 's1' }])
  })

  it('move-to-front an earlier identical same-session entry', () => {
    const store = createInputHistoryStore('test-mtf')
    store.add('dup', 's1')
    store.add('other', 's1')
    store.add('dup', 's1') // should move 'dup' to front, not add a second copy
    expect(store.getSession('s1')).toEqual(['dup', 'other'])
  })

  it('does not collapse duplicates across different sessions', () => {
    const store = createInputHistoryStore('test-cross-session')
    store.add('dup', 'sa')
    store.add('dup', 'sb')
    const all = store.getAll()
    expect(all).toHaveLength(2)
    expect(all.map((e) => e.sessionId).sort()).toEqual(['sa', 'sb'])
  })

  it('tags entries with the session id', () => {
    const store = createInputHistoryStore('test-tag')
    store.add('hi', 's1')
    expect(store.getAll()).toEqual([{ text: 'hi', sessionId: 's1' }])
  })

  it('caps a single session to 20 entries (most recent kept)', () => {
    const store = createInputHistoryStore('test-cap-session')
    for (let i = 0; i < 25; i++) store.add(`m${i}`, 's1')
    const stored = store.getSession('s1')
    expect(stored).toHaveLength(20)
    expect(stored[0]).toBe('m24')
    expect(stored.includes('m4')).toBe(false)
    expect(stored.includes('m5')).toBe(true)
  })

  it('per-session cap does not evict other sessions', () => {
    const store = createInputHistoryStore('test-cap-cross')
    for (let i = 0; i < 20; i++) store.add(`a${i}`, 'sa')
    for (let i = 0; i < 20; i++) store.add(`b${i}`, 'sb')
    const all = store.getAll()
    expect(all.filter((e) => e.sessionId === 'sa')).toHaveLength(20)
    expect(all.filter((e) => e.sessionId === 'sb')).toHaveLength(20)
    expect(all.length).toBeLessThanOrEqual(100)
  })

  it('global cap of 100 holds across sessions', () => {
    const store = createInputHistoryStore('test-cap-global')
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 20; i++) store.add(`s${s}-${i}`, `sess${s}`)
    }
    // 6 sessions × 20 = 120 entries attempted; each session caps at 20, so
    // 120 land, then the global 100 cap trims to 100 (the oldest 20 dropped).
    expect(store.getAll().length).toBeLessThanOrEqual(100)
  })

  it('persists to localStorage and reloads on a fresh store instance', () => {
    const store = createInputHistoryStore('test-persist')
    store.add('persistent', 's1')
    // A new store reading the same key picks up the persisted value.
    const store2 = createInputHistoryStore('test-persist')
    expect(store2.getSession('s1')).toEqual(['persistent'])
  })

  it('migrates legacy string[] data to unattributed entries', () => {
    localStorage.setItem('test-legacy', JSON.stringify(['old-a', 'old-b']))
    const store = createInputHistoryStore('test-legacy')
    expect(store.getSession(null)).toEqual(['old-a', 'old-b'])
  })

  it('notifies subscribers on add', () => {
    const store = createInputHistoryStore('test-subscribe')
    let calls = 0
    const unsub = store.subscribe(() => { calls += 1 })
    store.add('x', 's1')
    expect(calls).toBe(1)
    // No-op add (duplicate) does not notify.
    store.add('x', 's1')
    expect(calls).toBe(1)
    store.add('y', 's1')
    expect(calls).toBe(2)
    unsub()
    store.add('z', 's1')
    expect(calls).toBe(2)
  })

  it('getSnapshot is referentially stable between writes', () => {
    const store = createInputHistoryStore('test-stable')
    const a = store.getSnapshot()
    const b = store.getSnapshot()
    expect(a).toBe(b)
    store.add('x', 's1')
    const c = store.getSnapshot()
    expect(c).not.toBe(a)
  })

  it('reset() re-reads from localStorage', () => {
    const store = createInputHistoryStore('test-reset')
    store.add('in-memory', 's1')
    // Simulate an external write (e.g. another tab) by clearing + reseeding.
    localStorage.setItem('test-reset', JSON.stringify([{ text: 'external', sessionId: 's1' }]))
    store.reset()
    expect(store.getSession('s1')).toEqual(['external'])
  })

  it('clear() wipes entries from memory and localStorage', () => {
    const store = createInputHistoryStore('clear-test')
    store.add('a', 's1')
    store.add('b', 's1')
    expect(store.getAll()).toHaveLength(2)
    store.clear()
    expect(store.getAll()).toEqual([])
    // localStorage also empty
    const raw = JSON.parse(localStorage.getItem('clear-test')!)
    expect(raw).toEqual([])
  })
})

describe('default singleton', () => {
  it('is bound to INPUT_HISTORY_KEY', () => {
    inputHistoryStore.add('singleton-test', 's1')
    const raw = JSON.parse(localStorage.getItem(INPUT_HISTORY_KEY)!)
    expect(raw).toEqual([{ text: 'singleton-test', sessionId: 's1' }])
  })
})
