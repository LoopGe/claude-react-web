import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createInputHistoryStore } from '../state/inputHistoryStore'
import { useInputHistoryPanel } from './useInputHistoryPanel'

beforeEach(() => {
  localStorage.clear()
})

function storeWith(entries: Array<{ text: string; sessionId: string | null }>) {
  const store = createInputHistoryStore('panel-test')
  for (const e of entries) store.add(e.text, e.sessionId)
  return store
}

describe('useInputHistoryPanel', () => {
  it('promotes the focused session to "This session"', () => {
    const store = storeWith([
      { text: 'a1', sessionId: 'sa' },
      { text: 'b1', sessionId: 'sb' },
      { text: 'a2', sessionId: 'sa' },
    ])
    const { result } = renderHook(() => useInputHistoryPanel('sa', '', store))
    expect(result.current.sessionItems).toEqual(['a2', 'a1'])
    expect(result.current.otherItems).toEqual(['b1'])
    expect(result.current.flat).toEqual(['a2', 'a1', 'b1'])
  })

  it('with no focused session, everything lands in otherItems', () => {
    const store = storeWith([
      { text: 'a1', sessionId: 'sa' },
      { text: 'legacy', sessionId: null },
    ])
    const { result } = renderHook(() => useInputHistoryPanel(null, '', store))
    expect(result.current.sessionItems).toEqual([])
    // Store is most-recent-first: 'legacy' (added second) sorts ahead of 'a1'.
    expect(result.current.otherItems).toEqual(['legacy', 'a1'])
    expect(result.current.flat).toEqual(['legacy', 'a1'])
  })

  it('dedups identical texts preserving first-seen order', () => {
    const store = storeWith([
      { text: 'dup', sessionId: 'sa' },
      { text: 'dup', sessionId: 'sb' },
      { text: 'dup', sessionId: 'sc' },
    ])
    const { result } = renderHook(() => useInputHistoryPanel('sa', '', store))
    // 'dup' from sa promoted to sessionItems; the other two collapse to one
    // in otherItems.
    expect(result.current.sessionItems).toEqual(['dup'])
    expect(result.current.otherItems).toEqual(['dup'])
  })

  it('filters by case-insensitive query across both sections', () => {
    const store = storeWith([
      { text: 'Find Me', sessionId: 'sa' },
      { text: 'other', sessionId: 'sa' },
      { text: 'also find me here', sessionId: 'sb' },
    ])
    const { result } = renderHook(() => useInputHistoryPanel('sa', 'find', store))
    expect(result.current.sessionItems).toEqual(['Find Me'])
    expect(result.current.otherItems).toEqual(['also find me here'])
  })

  it('totalCount ignores the search filter', () => {
    const store = storeWith([
      { text: 'a', sessionId: 'sa' },
      { text: 'b', sessionId: 'sa' },
    ])
    const { result } = renderHook(() => useInputHistoryPanel('sa', 'nomatch', store))
    expect(result.current.flat).toEqual([])
    expect(result.current.totalCount).toBe(2)
  })

  it('reacts to store additions', () => {
    const store = storeWith([{ text: 'a', sessionId: 'sa' }])
    const { result, rerender } = renderHook(() => useInputHistoryPanel('sa', '', store))
    expect(result.current.sessionItems).toEqual(['a'])
    store.add('b', 'sa')
    rerender()
    expect(result.current.sessionItems).toEqual(['b', 'a'])
  })
})
