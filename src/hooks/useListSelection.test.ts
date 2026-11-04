import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useListSelection } from './useListSelection'

/** Fake scrollable rows: one element per row with a spied scrollIntoView. */
function makeRows(count: number) {
  return Array.from({ length: count }, () => {
    const el = document.createElement('div')
    el.scrollIntoView = vi.fn()
    return el
  })
}

function setup(count = 5, opts: { emptyIndex?: number; wrap?: boolean } = {}) {
  // A fixed 10-element pool lets tests grow/shrink `count` without re-creating
  // the element spies.
  const rows = makeRows(10)
  const { result, rerender } = renderHook(
    ({ count: c }: { count: number }) =>
      useListSelection({ count: c, getRow: (i) => rows[i], ...opts }),
    { initialProps: { count } },
  )
  const scrolled = () =>
    rows.flatMap((el, i) => (vi.mocked(el.scrollIntoView).mock.calls.length > 0 ? [i] : []))
  // The mount effect scrolls row 0; only post-mount activity is under test.
  rows.forEach((el) => vi.mocked(el.scrollIntoView).mockClear())
  return { result, scrolled, rerender }
}

describe('useListSelection', () => {
  it('moves the highlight on hover WITHOUT scrolling (the bug this hook prevents)', () => {
    const { result, scrolled } = setup()

    act(() => result.current.hover(2))

    expect(result.current.activeIndex).toBe(2)
    expect(scrolled()).toEqual([])
  })

  it('scrolls the row keyboard movement lands on', () => {
    const { result, scrolled } = setup()

    act(() => result.current.move(1))

    expect(result.current.activeIndex).toBe(1)
    expect(scrolled()).toEqual([1])
  })

  it('does not leak a hover opt-out into the next keyboard step', () => {
    const { result, scrolled } = setup()

    act(() => result.current.hover(2))
    expect(scrolled()).toEqual([])

    act(() => result.current.move(1))
    expect(result.current.activeIndex).toBe(3)
    expect(scrolled()).toEqual([3])
  })

  it('clamps at the ends unless wrap is set', () => {
    const clamped = setup(3)
    act(() => clamped.result.current.move(-1))
    expect(clamped.result.current.activeIndex).toBe(0)
    act(() => clamped.result.current.move(5))
    expect(clamped.result.current.activeIndex).toBe(2)

    const wrapped = setup(3, { wrap: true })
    act(() => wrapped.result.current.move(-1))
    expect(wrapped.result.current.activeIndex).toBe(2)
    act(() => wrapped.result.current.move(1))
    expect(wrapped.result.current.activeIndex).toBe(0)
  })

  it('normalizes wrap for deltas larger than the list', () => {
    const { result } = setup(3, { wrap: true })

    act(() => result.current.move(-4))
    expect(result.current.activeIndex).toBe(2)
    act(() => result.current.move(4))
    expect(result.current.activeIndex).toBe(0)
  })

  it('reports emptyIndex and ignores movement on an empty list', () => {
    const { result } = setup(0, { emptyIndex: -1 })

    expect(result.current.activeIndex).toBe(-1)
    act(() => result.current.move(1))
    expect(result.current.activeIndex).toBe(-1)
  })

  it('reset returns to row 0 and scrolls it into view', () => {
    const { result, scrolled } = setup()

    act(() => result.current.hover(4))
    expect(scrolled()).toEqual([])

    act(() => result.current.reset())
    expect(result.current.activeIndex).toBe(0)
    expect(scrolled()).toEqual([0])
  })

  it('reset scrolls row 0 even when the cursor is already there', () => {
    const { result, scrolled } = setup()

    // activeIndex is 0 from the start, so setState alone would bail out.
    act(() => result.current.reset())

    expect(result.current.activeIndex).toBe(0)
    expect(scrolled()).toEqual([0])
  })
})