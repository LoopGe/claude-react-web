import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createInputHistoryStore } from '../state/inputHistoryStore'
import { getImages } from '../state/inputHistoryImages'
import { useHistoryCursor } from './useHistoryCursor'
import 'fake-indexeddb/auto'
import { resetInputHistoryIdb, untilIdb, makeImg as img } from '../test-utils/inputHistoryIdb'

beforeEach(() => {
  localStorage.clear()
  resetInputHistoryIdb()
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
    expect(result.current.prev('live draft')).toEqual({ text: 'second', id: null, isDraft: false })
    expect(result.current.isBrowsing()).toBe(true)
    expect(result.current.prev('live draft')).toEqual({ text: 'first', id: null, isDraft: false })
    expect(result.current.prev('live draft')).toBeNull() // at oldest
  })

  it('prev() carries the entry id for image-bearing entries', () => {
    const store = createInputHistoryStore('cursor-img')
    store.add('plain', 's1')
    store.add('with picture', 's1', [img()])
    const entryId = store.getAll()[0].id
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    expect(result.current.prev('draft')).toEqual({ text: 'with picture', id: entryId, isDraft: false })
    expect(result.current.prev('draft')).toEqual({ text: 'plain', id: null, isDraft: false })
  })

  it('next() walks back toward the live draft and restores it (id null)', () => {
    const store = makeStore([
      { text: 'first', sessionId: 's1' },
      { text: 'second', sessionId: 's1' },
    ])
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    result.current.prev('live draft') // second
    result.current.prev('live draft') // first
    expect(result.current.next()).toEqual({ text: 'second', id: null, isDraft: false })
    // next() past the newest restores the stashed draft — isDraft is true so
    // the caller knows to restore the stashed images rather than load an
    // entry's from IDB.
    expect(result.current.next()).toEqual({ text: 'live draft', id: null, isDraft: true })
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
    expect(a.result.current.prev('draft')).toEqual({ text: 'from-a', id: null, isDraft: false })
    expect(a.result.current.prev('draft')).toBeNull()
    expect(b.result.current.prev('draft')).toEqual({ text: 'from-b', id: null, isDraft: false })
    expect(b.result.current.prev('draft')).toBeNull()
  })

  it('filter narrows navigation without dropping stored entries', () => {
    const store = createInputHistoryStore('cursor-filter')
    store.add('hello', 's1')
    store.add('!ls', 's1')
    store.add('how are you', 's1')
    store.add('!pwd', 's1')

    const bash = renderHook(() => useHistoryCursor('s1', (s) => s.startsWith('!'), store))
    expect(bash.result.current.prev('draft')).toEqual({ text: '!pwd', id: null, isDraft: false })
    expect(bash.result.current.prev('!pwd')).toEqual({ text: '!ls', id: null, isDraft: false })
    expect(bash.result.current.prev('!ls')).toBeNull()

    // Full ring is untouched in the store.
    expect(store.getSession('s1')).toEqual(['!pwd', 'how are you', '!ls', 'hello'])
  })

  it('reacts to store additions (new entry becomes navigable)', () => {
    const store = makeStore([{ text: 'first', sessionId: 's1' }])
    const { result, rerender } = renderHook(() => useHistoryCursor('s1', null, store))
    expect(result.current.prev('draft')).toEqual({ text: 'first', id: null, isDraft: false })
    act(() => store.add('second', 's1'))
    rerender()
    // Cursor reset to null because the slice identity changed; prev() now
    // returns the newly added most-recent entry.
    expect(result.current.prev('draft')).toEqual({ text: 'second', id: null, isDraft: false })
  })

  it('an image entry id resolves to the persisted IDB record', async () => {
    const store = createInputHistoryStore('cursor-img-idb')
    store.add('with picture', 's1', [img()])
    const entryId = store.getAll()[0].id!
    const { result } = renderHook(() => useHistoryCursor('s1', null, store))
    const recall = result.current.prev('draft')
    expect(recall?.id).toBe(entryId)
    // The id is the key the caller loads images from.
    await untilIdb(async () => (await getImages(entryId)).length === 1)
  })
})
