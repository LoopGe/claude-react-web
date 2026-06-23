import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputHistory, normalizeEntries } from './useInputHistory'

const STORAGE_KEY = 'test-input-history'

beforeEach(() => {
  localStorage.clear()
})

describe('useInputHistory', () => {
  it('starts with empty history', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    expect(result.current.prev('draft')).toBeNull()
    expect(result.current.next()).toBeNull()
    expect(result.current.isBrowsing()).toBe(false)
  })

  it('add() records entries', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    act(() => result.current.add('hello'))
    // After add, prev() should return the entry.
    expect(result.current.prev('draft')).toBe('hello')
  })

  it('collapses consecutive duplicates', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    act(() => result.current.add('hello'))
    act(() => result.current.add('hello'))
    // Should only have one entry — stepping back once hits it, twice returns null.
    expect(result.current.prev('draft')).toBe('hello')
    expect(result.current.prev('draft')).toBeNull()
  })

  it('navigates older/newer entries', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    act(() => result.current.add('first'))
    act(() => result.current.add('second'))

    // prev() steps to most recent.
    expect(result.current.prev('live draft')).toBe('second')
    expect(result.current.isBrowsing()).toBe(true)

    // prev() again steps to older.
    expect(result.current.prev('live draft')).toBe('first')

    // next() steps back to newer.
    expect(result.current.next()).toBe('second')

    // next() past the newest restores the draft.
    expect(result.current.next()).toBe('live draft')
    expect(result.current.isBrowsing()).toBe(false)
  })

  it('next() from fresh state returns null', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    expect(result.current.next()).toBeNull()
  })

  it('reset() clears browsing state', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    act(() => result.current.add('msg'))
    result.current.prev('draft')
    expect(result.current.isBrowsing()).toBe(true)
    act(() => result.current.reset())
    expect(result.current.isBrowsing()).toBe(false)
  })

  it('ignores empty/whitespace-only input', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    act(() => result.current.add(''))
    act(() => result.current.add('   '))
    expect(result.current.prev('draft')).toBeNull()
  })

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY))
    act(() => result.current.add('persistent'))

    // Re-render with a fresh hook — should pick up stored value.
    const { result: result2 } = renderHook(() => useInputHistory(STORAGE_KEY))
    expect(result2.current.prev('draft')).toBe('persistent')
  })

  it('migrates legacy string[] data to unattributed entries', () => {
    // Seed the old plain-string format directly.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['old-a', 'old-b']))
    // A null-session hook walks the unattributed entries.
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY, null))
    expect(result.current.prev('draft')).toBe('old-a')
    expect(result.current.prev('draft')).toBe('old-b')
  })

  it('normalizeEntries coerces both shapes', () => {
    expect(normalizeEntries(['x'])).toEqual([{ text: 'x', sessionId: null }])
    expect(normalizeEntries([{ text: 'y', sessionId: 's1' }])).toEqual([
      { text: 'y', sessionId: 's1' },
    ])
    expect(normalizeEntries(null)).toEqual([])
    expect(normalizeEntries([{ nope: 1 }])).toEqual([])
  })

  it('navigation is isolated per session', () => {
    const a = renderHook(() => useInputHistory(STORAGE_KEY, 'sa'))
    act(() => a.result.current.add('from-a'))
    const b = renderHook(() => useInputHistory(STORAGE_KEY, 'sb'))
    act(() => b.result.current.add('from-b'))

    // Each session only sees its own entry.
    const a2 = renderHook(() => useInputHistory(STORAGE_KEY, 'sa'))
    expect(a2.result.current.prev('draft')).toBe('from-a')
    expect(a2.result.current.prev('draft')).toBeNull()

    const b2 = renderHook(() => useInputHistory(STORAGE_KEY, 'sb'))
    expect(b2.result.current.prev('draft')).toBe('from-b')
    expect(b2.result.current.prev('draft')).toBeNull()
  })

  it('tags added entries with the current session id', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY, 's1'))
    act(() => result.current.add('hi'))
    const stored = normalizeEntries(JSON.parse(localStorage.getItem(STORAGE_KEY)!))
    expect(stored).toEqual([{ text: 'hi', sessionId: 's1' }])
  })

  it('caps a single session to 20 entries', () => {
    const { result } = renderHook(() => useInputHistory(STORAGE_KEY, 's1'))
    for (let i = 0; i < 25; i++) act(() => result.current.add(`m${i}`))
    const stored = normalizeEntries(JSON.parse(localStorage.getItem(STORAGE_KEY)!))
    expect(stored).toHaveLength(20)
    // Keeps the 20 most recent (m24..m5); m4 and older are evicted.
    expect(stored[0]).toEqual({ text: 'm24', sessionId: 's1' })
    expect(stored.some((e) => e.text === 'm4')).toBe(false)
    expect(stored.some((e) => e.text === 'm5')).toBe(true)
  })

  it('per-session cap does not evict other sessions; global cap of 100 holds', () => {
    // Fill session A up to its cap.
    const a = renderHook(() => useInputHistory(STORAGE_KEY, 'sa'))
    for (let i = 0; i < 20; i++) act(() => a.result.current.add(`a${i}`))
    // Session B adds entries — A's 20 must survive.
    const b = renderHook(() => useInputHistory(STORAGE_KEY, 'sb'))
    for (let i = 0; i < 20; i++) act(() => b.result.current.add(`b${i}`))
    const stored = normalizeEntries(JSON.parse(localStorage.getItem(STORAGE_KEY)!))
    expect(stored.filter((e) => e.sessionId === 'sa')).toHaveLength(20)
    expect(stored.filter((e) => e.sessionId === 'sb')).toHaveLength(20)
    expect(stored.length).toBeLessThanOrEqual(100)
  })

  it('collapse only applies within the same session', () => {
    const a = renderHook(() => useInputHistory(STORAGE_KEY, 'sa'))
    act(() => a.result.current.add('dup'))
    const b = renderHook(() => useInputHistory(STORAGE_KEY, 'sb'))
    act(() => b.result.current.add('dup'))
    // Both sessions keep their own 'dup' — not collapsed across sessions.
    const stored = normalizeEntries(JSON.parse(localStorage.getItem(STORAGE_KEY)!))
    expect(stored).toHaveLength(2)
    expect(stored.map((e) => e.sessionId).sort()).toEqual(['sa', 'sb'])
  })

  it('filter narrows navigation without dropping stored entries', () => {
    // Seed mixed chat + shell (`!`) history for one session.
    const seed = renderHook(() => useInputHistory(STORAGE_KEY, 's1'))
    act(() => seed.result.current.add('hello'))
    act(() => seed.result.current.add('!ls'))
    act(() => seed.result.current.add('how are you'))
    act(() => seed.result.current.add('!pwd'))

    // Bash-mode filter: only `!` entries are navigable.
    const bash = renderHook(() =>
      useInputHistory(STORAGE_KEY, 's1', (s) => s.startsWith('!')),
    )
    expect(bash.result.current.prev('draft')).toBe('!pwd')
    expect(bash.result.current.prev('!pwd')).toBe('!ls')
    expect(bash.result.current.prev('!ls')).toBeNull()

    // Chat-mode filter: `!` entries are skipped.
    const chat = renderHook(() =>
      useInputHistory(STORAGE_KEY, 's1', (s) => !s.startsWith('!')),
    )
    expect(chat.result.current.prev('draft')).toBe('how are you')
    expect(chat.result.current.prev('how are you')).toBe('hello')
    expect(chat.result.current.prev('hello')).toBeNull()

    // The full ring is untouched — both kinds are still stored.
    const stored = normalizeEntries(JSON.parse(localStorage.getItem(STORAGE_KEY)!))
    expect(stored.map((e) => e.text)).toEqual(['!pwd', 'how are you', '!ls', 'hello'])
  })
})
