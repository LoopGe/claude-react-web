import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createInputHistoryStore, normalizeEntries } from '../state/inputHistoryStore'
import { useInputHistory } from './useInputHistory'

beforeEach(() => {
  localStorage.clear()
})

describe('useInputHistory (facade)', () => {
  it('add() records entries and prev() returns them', () => {
    const store = createInputHistoryStore('facade-1')
    const { result } = renderHook(() => useInputHistory('s1', null, store))
    act(() => result.current.add('hello'))
    expect(result.current.prev('draft')).toBe('hello')
  })

  it('resets the cursor after add (prev starts at the new most-recent)', () => {
    const store = createInputHistoryStore('facade-2')
    const { result } = renderHook(() => useInputHistory('s1', null, store))
    act(() => result.current.add('first'))
    act(() => result.current.add('second'))
    // After add, cursor is reset — prev() returns the new most-recent entry.
    expect(result.current.prev('draft')).toBe('second')
    expect(result.current.isBrowsing()).toBe(true)
  })

  it('collapses consecutive same-session duplicates', () => {
    const store = createInputHistoryStore('facade-3')
    const { result } = renderHook(() => useInputHistory('s1', null, store))
    act(() => result.current.add('hello'))
    act(() => result.current.add('hello'))
    expect(result.current.prev('draft')).toBe('hello')
    expect(result.current.prev('draft')).toBeNull()
  })

  it('ignores empty/whitespace-only input', () => {
    const store = createInputHistoryStore('facade-4')
    const { result } = renderHook(() => useInputHistory('s1', null, store))
    act(() => result.current.add(''))
    act(() => result.current.add('   '))
    expect(result.current.prev('draft')).toBeNull()
  })

  it('persists via the store (fresh hook on same store sees history)', () => {
    const store = createInputHistoryStore('facade-5')
    const { result } = renderHook(() => useInputHistory('s1', null, store))
    act(() => result.current.add('persistent'))
    const { result: result2 } = renderHook(() => useInputHistory('s1', null, store))
    expect(result2.current.prev('draft')).toBe('persistent')
  })

  it('tags added entries with the current session id', () => {
    const store = createInputHistoryStore('facade-6')
    const { result } = renderHook(() => useInputHistory('s1', null, store))
    act(() => result.current.add('hi'))
    expect(normalizeEntries(JSON.parse(localStorage.getItem('facade-6')!))).toEqual([
      { text: 'hi', sessionId: 's1' },
    ])
  })

  it('navigation is isolated per session', () => {
    const store = createInputHistoryStore('facade-7')
    const a = renderHook(() => useInputHistory('sa', null, store))
    act(() => a.result.current.add('from-a'))
    const b = renderHook(() => useInputHistory('sb', null, store))
    act(() => b.result.current.add('from-b'))
    const a2 = renderHook(() => useInputHistory('sa', null, store))
    expect(a2.result.current.prev('draft')).toBe('from-a')
    expect(a2.result.current.prev('draft')).toBeNull()
    const b2 = renderHook(() => useInputHistory('sb', null, store))
    expect(b2.result.current.prev('draft')).toBe('from-b')
    expect(b2.result.current.prev('draft')).toBeNull()
  })

  it('filter narrows navigation without dropping stored entries', () => {
    const store = createInputHistoryStore('facade-8')
    const seed = renderHook(() => useInputHistory('s1', null, store))
    act(() => seed.result.current.add('hello'))
    act(() => seed.result.current.add('!ls'))
    act(() => seed.result.current.add('how are you'))
    act(() => seed.result.current.add('!pwd'))

    const bash = renderHook(() => useInputHistory('s1', (s) => s.startsWith('!'), store))
    expect(bash.result.current.prev('draft')).toBe('!pwd')
    expect(bash.result.current.prev('!pwd')).toBe('!ls')
    expect(bash.result.current.prev('!ls')).toBeNull()

    // Full ring untouched in the store.
    expect(store.getSession('s1')).toEqual(['!pwd', 'how are you', '!ls', 'hello'])
  })

  it('migrates legacy string[] data to unattributed entries (null session)', () => {
    localStorage.setItem('facade-9', JSON.stringify(['old-a', 'old-b']))
    const store = createInputHistoryStore('facade-9')
    const { result } = renderHook(() => useInputHistory(null, null, store))
    expect(result.current.prev('draft')).toBe('old-a')
    expect(result.current.prev('draft')).toBe('old-b')
  })
})
