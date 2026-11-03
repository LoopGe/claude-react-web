// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  PANEL_CACHE_EXTRA,
  mergeOpenIntoCache,
  evictFromCache,
  renderedPanelIds,
  ghostableIds,
  scrollerSnapshot,
  scrollSnapshotTop,
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

describe('anchored scroll snapshots', () => {
  function scrollerWithRow(scale = 1) {
    const el = document.createElement('div')
    Object.defineProperties(el, {
      clientHeight: { configurable: true, value: 600 },
      offsetHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1600, writable: true },
      scrollTop: { configurable: true, value: 1100, writable: true },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 600 * scale }),
      },
    })
    const row = document.createElement('div')
    row.dataset.crwRowId = 'message-a'
    row.dataset.itemIndex = '100'
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: -100 * scale, bottom: 1 }),
    })
    el.appendChild(row)
    return { el, row }
  }

  it('restores the same message offset after older history prepends', () => {
    const { el, row } = scrollerWithRow()
    const snapshot = scrollerSnapshot(el)
    expect(snapshot).toEqual({ top: 1100, anchorId: 'message-a', anchorOffset: 100 })

    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 900, bottom: 1000 }),
    })
    expect(scrollSnapshotTop(el, snapshot!)).toBe(2100)
    row.dataset.crwRowId = 'server-uuid-1'
    row.dataset.crwOptimisticSource = 'message-a'
    expect(scrollSnapshotTop(el, snapshot!)).toBe(2100)

    row.remove()
    // A virtualized anchor must be revealed by its owner by id, never guessed
    // from scrollHeight (which also includes tail growth and rewrap).
    expect(scrollSnapshotTop(el, snapshot!)).toBeNull()
    el.dataset.crwAnchorMissing = 'message-a'
    expect(scrollSnapshotTop(el, snapshot!)).toBe(1100)
    scrollerSnapshot(el)
    expect(el.dataset.crwAnchorMissing).toBeUndefined()
  })

  it('normalizes viewport rects when the panel is scaled during entrance', () => {
    const { el, row } = scrollerWithRow(0.5)
    const snapshot = scrollerSnapshot(el)
    expect(snapshot).toEqual({ top: 1100, anchorId: 'message-a', anchorOffset: 100 })
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 450, bottom: 550 }),
    })
    expect(scrollSnapshotTop(el, snapshot!)).toBe(2100)
  })
  it('does not anchor on an overscan row below the viewport', () => {
    const { el, row } = scrollerWithRow()
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 700, bottom: 800 }),
    })
    expect(scrollerSnapshot(el)).toEqual({ top: 1100, anchorId: null, anchorOffset: 0 })
  })
})

describe('PANEL_CACHE_EXTRA', () => {
  it('is 3 (desktop peaks at maxOpen 3 + 3 = 6 mounted panels)', () => {
    expect(PANEL_CACHE_EXTRA).toBe(3)
  })
})
