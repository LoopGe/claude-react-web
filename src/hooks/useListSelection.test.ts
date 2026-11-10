import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { useListSelection } from './useListSelection'

/** Fake scrollable rows: one element per row with a spied scrollIntoView. */
function makeRows(count: number) {
  return Array.from({ length: count }, () => {
    const el = document.createElement('div')
    el.scrollIntoView = vi.fn()
    return el
  })
}

interface KeyEventOptions {
  isComposing?: boolean
  keyCode?: number
  target?: Element
}

function keyEvent(key: string, opts: KeyEventOptions = {}) {
  const preventDefault = vi.fn()
  const event = {
    key,
    preventDefault,
    target: opts.target ?? document.createElement('div'),
    nativeEvent: {
      isComposing: opts.isComposing ?? false,
      keyCode: opts.keyCode ?? 0,
    },
  } as unknown as ReactKeyboardEvent<Element>
  return { event, preventDefault }
}

function setup(
  count = 5,
  opts: {
    emptyIndex?: number
    wrap?: boolean
    onActivate?: (index: number) => void
    tabFocusRef?: RefObject<HTMLElement | null>
  } = {},
) {
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

  describe('handleKeyDown', () => {
    it('moves on ArrowDown/ArrowUp and prevents the browser default', () => {
      const { result } = setup()
      const down = keyEvent('ArrowDown')
      act(() => result.current.handleKeyDown(down.event))
      expect(result.current.activeIndex).toBe(1)
      expect(down.preventDefault).toHaveBeenCalled()

      const up = keyEvent('ArrowUp')
      act(() => result.current.handleKeyDown(up.event))
      expect(result.current.activeIndex).toBe(0)
      expect(up.preventDefault).toHaveBeenCalled()
    })

    it('activates the clamped index on Enter', () => {
      const onActivate = vi.fn()
      const { result } = setup(5, { onActivate })

      act(() => result.current.hover(3))
      const enter = keyEvent('Enter')
      act(() => result.current.handleKeyDown(enter.event))

      expect(onActivate).toHaveBeenCalledWith(3)
      expect(enter.preventDefault).toHaveBeenCalled()
    })

    it('activates the clamped index when the row set shrinks', () => {
      const onActivate = vi.fn()
      const { result, rerender } = setup(5, { onActivate })

      act(() => result.current.hover(4))
      rerender({ count: 2 })
      const enter = keyEvent('Enter')
      act(() => result.current.handleKeyDown(enter.event))

      expect(onActivate).toHaveBeenCalledWith(1)
    })

    it('leaves Enter to a focused button', () => {
      const onActivate = vi.fn()
      const { result } = setup(5, { onActivate })
      const enter = keyEvent('Enter', { target: document.createElement('button') })

      act(() => result.current.handleKeyDown(enter.event))

      expect(onActivate).not.toHaveBeenCalled()
      expect(enter.preventDefault).not.toHaveBeenCalled()
    })

    it('ignores Enter when no activation handler is configured', () => {
      const { result } = setup(5)
      const enter = keyEvent('Enter')

      act(() => result.current.handleKeyDown(enter.event))

      expect(enter.preventDefault).not.toHaveBeenCalled()
    })

    it('ignores Enter on an empty list', () => {
      const onActivate = vi.fn()
      const { result } = setup(0, { onActivate })
      const enter = keyEvent('Enter')

      act(() => result.current.handleKeyDown(enter.event))

      expect(onActivate).not.toHaveBeenCalled()
      expect(enter.preventDefault).not.toHaveBeenCalled()
    })

    it('ignores keys while an IME composition is active', () => {
      const onActivate = vi.fn()
      const { result } = setup(5, { onActivate })
      const enter = keyEvent('Enter', { isComposing: true })
      const down = keyEvent('ArrowDown', { isComposing: true })

      act(() => result.current.handleKeyDown(enter.event))
      act(() => result.current.handleKeyDown(down.event))

      expect(onActivate).not.toHaveBeenCalled()
      expect(result.current.activeIndex).toBe(0)
      expect(enter.preventDefault).not.toHaveBeenCalled()
      expect(down.preventDefault).not.toHaveBeenCalled()
    })

    it('treats keyCode 229 as an IME commit even without isComposing', () => {
      const onActivate = vi.fn()
      const { result } = setup(5, { onActivate })
      const enter = keyEvent('Enter', { keyCode: 229 })

      act(() => result.current.handleKeyDown(enter.event))

      expect(onActivate).not.toHaveBeenCalled()
      expect(enter.preventDefault).not.toHaveBeenCalled()
    })

    it('contains Tab on the search input when a focus ref is supplied', () => {
      const input = document.createElement('input')
      document.body.appendChild(input)
      const tabFocusRef: RefObject<HTMLElement | null> = { current: input }
      const { result } = setup(5, { tabFocusRef })
      const tab = keyEvent('Tab')

      act(() => result.current.handleKeyDown(tab.event))

      expect(tab.preventDefault).toHaveBeenCalled()
      expect(document.activeElement).toBe(input)
      input.remove()
    })

    it('contains Tab even while an IME composition is active', () => {
      const input = document.createElement('input')
      document.body.appendChild(input)
      const tabFocusRef: RefObject<HTMLElement | null> = { current: input }
      const { result } = setup(5, { tabFocusRef })
      const tab = keyEvent('Tab', { isComposing: true })

      act(() => result.current.handleKeyDown(tab.event))

      expect(tab.preventDefault).toHaveBeenCalled()
      expect(document.activeElement).toBe(input)
      input.remove()
    })

    it('leaves Tab alone when containment is not requested', () => {
      const { result } = setup()
      const tab = keyEvent('Tab')

      act(() => result.current.handleKeyDown(tab.event))

      expect(tab.preventDefault).not.toHaveBeenCalled()
    })
  })
})