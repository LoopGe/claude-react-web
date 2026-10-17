// @vitest-environment jsdom
// (scrollerSnapshotTop 需要 DOM；纯函数部分在 jsdom 下同样可跑)
import { describe, it, expect } from 'vitest'
import {
  PANEL_CACHE_EXTRA,
  mergeOpenIntoCache,
  evictFromCache,
  renderedPanelIds,
  ghostableIds,
  scrollerSnapshotTop,
} from './panel-cache'

describe('mergeOpenIntoCache', () => {
  it('adds newly opened ids at the head, keeps old ids behind (LRU)', () => {
    expect(mergeOpenIntoCache(['a', 'b'], ['c'], 10)).toEqual(['c', 'a', 'b'])
  })

  it('moves a re-opened id to the head', () => {
    expect(mergeOpenIntoCache(['a', 'b', 'c'], ['c'], 10)).toEqual(['c', 'a', 'b'])
  })

  it('trims the LRU tail beyond the cap', () => {
    expect(mergeOpenIntoCache(['a', 'b', 'c'], ['d'], 3)).toEqual(['d', 'a', 'b'])
  })

  it('never trims an open id even when cap < open count', () => {
    // cap=1 是调用方违约（cap 必须 ≥ maxOpen），但 open 头部依然安全
    expect(mergeOpenIntoCache(['a', 'b', 'c'], ['a'], 1)).toEqual(['a'])
  })

  it('returns the same reference when nothing changed (render-phase no-op)', () => {
    const prev = ['a', 'b']
    expect(mergeOpenIntoCache(prev, ['a'], 10)).toBe(prev)
  })

  it('dedupes an open id that is also cached', () => {
    expect(mergeOpenIntoCache(['b', 'a'], ['a', 'c'], 10)).toEqual(['a', 'c', 'b'])
  })
})

describe('evictFromCache', () => {
  it('removes the given ids', () => {
    expect(evictFromCache(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
  })

  it('returns the same reference when nothing matched', () => {
    const prev = ['a']
    expect(evictFromCache(prev, ['z'])).toBe(prev)
  })
})

describe('renderedPanelIds', () => {
  it('open view first in view order, cached ids behind', () => {
    expect(renderedPanelIds(['x', 'y'], ['y', 'a', 'x'])).toEqual(['x', 'y', 'a'])
  })

  it('empty inputs → empty', () => {
    expect(renderedPanelIds([], [])).toEqual([])
  })
})

describe('ghostableIds', () => {
  it('only ids that left BOTH the view and the cache ghost', () => {
    expect(ghostableIds(['a', 'b'], ['b', 'c'])).toEqual(['a'])
  })

  it('no cache → every gone id ghosts (pre-keep-alive behaviour)', () => {
    expect(ghostableIds(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})

describe('scrollerSnapshotTop', () => {
  it('returns scrollTop for a laid-out scroller', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 1234 })
    expect(scrollerSnapshotTop(el)).toBe(1234)
  })

  it('returns null for a collapsed (display:none) scroller', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 0 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0 })
    expect(scrollerSnapshotTop(el)).toBeNull()
  })
})

describe('PANEL_CACHE_EXTRA', () => {
  it('is 3 (desktop peaks at maxOpen 3 + 3 = 6 mounted panels)', () => {
    expect(PANEL_CACHE_EXTRA).toBe(3)
  })
})
