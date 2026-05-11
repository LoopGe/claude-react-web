import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputHistory } from './useInputHistory'

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
})
