import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createInputHistoryStore } from '../state/inputHistoryStore'
import { useHistoryCursor } from './useHistoryCursor'

beforeEach(() => {
  localStorage.clear()
})

describe('useHistoryCursor', () => {
  function makeStore(seed: Array<{ text: string; sessionId: string | null }> = []) {
    const store = createInputHistoryStore('cursor-test')
    for (const e of seed) store.add(e.text, e.sessionId)
    return store
  }

  it('returns null on empty history', () => {
    const store = makeStore()
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    expect(result.current.prev('draft')).toBeNull()
    expect(result.current.next()).toBeNull()
    expect(result.current.isBrowsing()).toBe(false)
  })

  it('prev() walks most-recent → oldest', () => {
    const store = makeStore([
      { text: 'first', sessionId: 's1' },
      { text: 'second', sessionId: 's1' },
    ])
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    expect(result.current.prev('live draft')).toBe('second')
    expect(result.current.isBrowsing()).toBe(true)
    expect(result.current.prev('live draft')).toBe('first')
    expect(result.current.prev('live draft')).toBeNull() // at oldest
  })

  it('next() walks back toward the live draft and restores it', () => {
    const store = makeStore([
      { text: 'first', sessionId: 's1' },
      { text: 'second', sessionId: 's1' },
    ])
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    result.current.prev('live draft') // second
    result.current.prev('live draft') // first
    expect(result.current.next()).toBe('second')
    // next() past the newest restores the stashed draft.
    expect(result.current.next()).toBe('live draft')
    expect(result.current.isBrowsing()).toBe(false)
  })

  it('next() from fresh state returns null', () => {
    const store = makeStore([{ text: 'x', sessionId: 's1' }])
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    expect(result.current.next()).toBeNull()
  })

  it('reset() clears browsing state', () => {
    const store = makeStore([{ text: 'msg', sessionId: 's1' }])
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    result.current.prev('draft')
    expect(result.current.isBrowsing()).toBe(true)
    act(() => result.current.reset())
    expect(result.current.isBrowsing()).toBe(false)
  })

  it('navigation is isolated per session', () => {
    const store = createInputHistoryStore('cursor-iso')
    store.add('from-a', 'sa')
    store.add('from-b', 'sb')
    const a = renderHook(() => useHistoryCursor('sa', null, store))
    const b = renderHook(() => useHistoryCursor('sb', null, store))
    expect(a.result.current.prev('draft')).toBe('from-a')
    expect(a.result.current.prev('draft')).toBeNull()
    expect(b.result.current.prev('draft')).toBe('from-b')
    expect(b.result.current.prev('draft')).toBeNull()
  })

  it('filter narrows navigation without dropping stored entries', () => {
    const store = createInputHistoryStore('cursor-filter')
    store.add('hello', 's1')
    store.add('!ls', 's1')
    store.add('how are you', 's1')
    store.add('!pwd', 's1')

    const bash = renderHook(() => useHistoryCursor('s1', (s) => s.startsWith('!'), store))
    expect(bash.result.current.prev('draft')).toBe('!pwd')
    expect(bash.result.current.prev('!pwd')).toBe('!ls')
    expect(bash.result.current.prev('!ls')).toBeNull()

    // Full ring is untouched in the store.
    expect(store.getSession('s1')).toEqual(['!pwd', 'how are you', '!ls', 'hello'])
  })

  it('reacts to store additions (new entry becomes navigable)', () => {
    const store = makeStore([{ text: 'first', sessionId: 's1' }])
    const { result, rerender } = renderHook(() => useHistoryCursor('s1', null, store))
    expect(result.current.prev('draft')).toBe('first')
    act(() => store.add('second', 's1'))
    rerender()
    // Cursor reset to null because the slice identity changed; prev() now
    // returns the newly added most-recent entry.
    expect(result.current.prev('draft')).toBe('second')
  })
})
