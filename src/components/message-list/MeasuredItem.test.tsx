// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MeasuredItem } from './MeasuredItem'
import {
  lookupRowHeight,
  ROW_HEIGHT_FALLBACK_PX,
  clearRowHeightCache,
  rowHeightCacheSize,
} from '../../utils/row-height-cache'

// Controllable ResizeObserver stub (same pattern as FoldableBody.test.tsx):
// captures callbacks by observed element so a test drives a re-measure
// deterministically via fireResize(el). Never auto-fires.
const roObserved = new Map<Element, Array<(entries: ResizeObserverEntry[]) => void>>()
function fireResize(el: Element) {
  // ResizeObserver passes one entry per observed element change; only
  // `target` is read by the production callback, so the rest is cast away.
  for (const cb of roObserved.get(el) ?? []) cb([{ target: el } as ResizeObserverEntry])
}
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(private cb: (entries: ResizeObserverEntry[]) => void) {}
    observe(el: Element) {
      const list = roObserved.get(el) ?? []
      list.push(this.cb)
      roObserved.set(el, list)
    }
    unobserve(el: Element) {
      const list = roObserved.get(el)
      if (!list) return
      const i = list.indexOf(this.cb)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) roObserved.delete(el)
    }
    disconnect() {
      for (const [el, list] of Array.from(roObserved)) {
        const i = list.indexOf(this.cb)
        if (i >= 0) list.splice(i, 1)
        if (list.length === 0) roObserved.delete(el)
      }
    }
  },
)

// happy-dom has no layout engine — offsetHeight is always 0. Drive it with a
// mutable module value so tests control what a "measured" height is.
let fakeOffsetHeight = 0
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => fakeOffsetHeight,
})

/** Minimal ItemProps stand-in: only `item` (cache keying) and the spread
 *  contract matter here; the rest are Virtuoso internals this wrapper must
 *  pass through untouched. */
function itemProps(
  item: { id?: string; kind?: 'streaming'; content?: string },
  children: React.ReactNode = 'row',
) {
  return {
    item,
    context: { someContext: true },
    'data-index': 0,
    'data-item-index': 0,
    'data-known-size': 0,
    style: { overflowAnchor: 'none' } as React.CSSProperties,
    children,
  }
}

describe('MeasuredItem', () => {
  beforeEach(() => {
    clearRowHeightCache()
    fakeOffsetHeight = 0
  })
  afterEach(() => {
    cleanup()
    roObserved.clear()
  })

  it('records the row height via the initial ResizeObserver observation', () => {
    fakeOffsetHeight = 123
    const { container } = render(<MeasuredItem {...itemProps({ id: 'm1' })} />)
    // No mount-time record: the immediate read was dropped (it forced a
    // layout per mounting row for a value the RO delivers in the same pass).
    expect(lookupRowHeight('m1')).toBeUndefined()
    fireResize(container.firstElementChild as HTMLElement)
    expect(lookupRowHeight('m1')).toBe(123)
  })

  it('rounds fractional measured heights', () => {
    fakeOffsetHeight = 122.6
    const { container } = render(<MeasuredItem {...itemProps({ id: 'm1' })} />)
    fireResize(container.firstElementChild as HTMLElement)
    expect(lookupRowHeight('m1')).toBe(123)
  })

  it('skips the streaming tail row (no stable id)', () => {
    fakeOffsetHeight = 123
    const { container } = render(
      <MeasuredItem {...itemProps({ kind: 'streaming', content: 'x' })} />,
    )
    fireResize(container.firstElementChild as HTMLElement)
    expect(rowHeightCacheSize()).toBe(0)
  })

  it('keeps the cache entry fresh via ResizeObserver while mounted', () => {
    fakeOffsetHeight = 100
    const { container } = render(<MeasuredItem {...itemProps({ id: 'm1' })} />)
    fireResize(container.firstElementChild as HTMLElement)
    expect(lookupRowHeight('m1')).toBe(100)
    // The wrapper element must be the RO-observed node (Virtuoso measures the
    // same element, so its data attrs must sit on it too).
    const el = container.firstElementChild as HTMLElement
    expect(el.dataset.crwRowId).toBe('m1')
    fakeOffsetHeight = 340
    fireResize(el)
    expect(lookupRowHeight('m1')).toBe(340)
  })

  it('unobserves on unmount but keeps the last recorded height', () => {
    fakeOffsetHeight = 100
    const { container, unmount } = render(<MeasuredItem {...itemProps({ id: 'm1' })} />)
    const el = container.firstElementChild as HTMLElement
    expect(roObserved.has(el)).toBe(true)
    fireResize(el)
    unmount()
    expect(roObserved.has(el)).toBe(false)
    // The recorded value survives — it IS the next mount's estimate.
    expect(lookupRowHeight('m1')).toBe(100)
  })

  it('passes Virtuoso contract props through to the DOM element', () => {
    fakeOffsetHeight = 100
    const { container } = render(<MeasuredItem {...itemProps({ id: 'm1' })} />)
    const el = container.firstElementChild as HTMLElement
    // data attrs + style are Virtuoso's positioning/measurement contract.
    expect(el.dataset.itemIndex).toBe('0')
    expect(el.dataset.knownSize).toBe('0')
    expect(el.style.overflowAnchor).toBe('none')
    expect(el.textContent).toBe('row')
    // `item` and `context` must NOT reach the DOM (unknown-prop warning).
    expect(el.hasAttribute('item')).toBe(false)
    expect(el.hasAttribute('context')).toBe(false)
  })

  it('exports a fallback distinct from the old probe default', () => {
    // Documentation guard: the fallback replaced the 62px probe default with
    // the measured median; if someone retunes it, this is the place to
    // reconsider the comment in MeasuredItem.tsx too.
    expect(ROW_HEIGHT_FALLBACK_PX).toBeGreaterThan(62)
    expect(ROW_HEIGHT_FALLBACK_PX).toBeLessThan(150)
  })
})
