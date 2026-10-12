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
    expect(result.current.sessionItems).toEqual([
      { text: 'a2', id: null },
      { text: 'a1', id: null },
    ])
    expect(result.current.otherItems).toEqual([{ text: 'b1', id: null }])
    expect(result.current.flat).toEqual([
      { text: 'a2', id: null },
      { text: 'a1', id: null },
      { text: 'b1', id: null },
    ])
  })

  it('with no focused session, everything lands in otherItems', () => {
    const store = storeWith([
      { text: 'a1', sessionId: 'sa' },
      { text: 'legacy', sessionId: null },
    ])
    const { result } = renderHook(() => useInputHistoryPanel(null, '', store))
    expect(result.current.sessionItems).toEqual([])
    // Store is most-recent-first: 'legacy' (added second) sorts ahead of 'a1'.
    expect(result.current.otherItems).toEqual([
      { text: 'legacy', id: null },
      { text: 'a1', id: null },
    ])
    expect(result.current.flat).toEqual([
      { text: 'legacy', id: null },
      { text: 'a1', id: null },
    ])
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
    expect(result.current.sessionItems).toEqual([{ text: 'dup', id: null }])
    expect(result.current.otherItems).toEqual([{ text: 'dup', id: null }])
  })

  it('carries the image-record id of the newest entry with that text', () => {
    const store = createInputHistoryStore('panel-img')
    store.add('dup', 'sa')
    store.add('other', 'sa')
    // Re-send 'dup' WITH images — move-to-front, fresh id; the panel entry
    // must resolve to the newest id (the one whose IDB record exists).
    store.add('dup', 'sa', [
      { data: 'AAAA', mediaType: 'image/png', width: 1, height: 2, size: 3 },
    ])
    const newestId = store.getAll().find((e) => e.text === 'dup')!.id!
    const { result } = renderHook(() => useInputHistoryPanel('sa', '', store))
    expect(result.current.sessionItems).toEqual([
      { text: 'dup', id: newestId },
      { text: 'other', id: null },
    ])
  })

  it('filters by case-insensitive query across both sections', () => {
    const store = storeWith([
      { text: 'Find Me', sessionId: 'sa' },
      { text: 'other', sessionId: 'sa' },
      { text: 'also find me here', sessionId: 'sb' },
    ])
    const { result } = renderHook(() => useInputHistoryPanel('sa', 'find', store))
    expect(result.current.sessionItems).toEqual([{ text: 'Find Me', id: null }])
    expect(result.current.otherItems).toEqual([{ text: 'also find me here', id: null }])
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
    expect(result.current.sessionItems).toEqual([{ text: 'a', id: null }])
    store.add('b', 'sa')
    rerender()
    expect(result.current.sessionItems).toEqual([
      { text: 'b', id: null },
      { text: 'a', id: null },
    ])
  })
})
