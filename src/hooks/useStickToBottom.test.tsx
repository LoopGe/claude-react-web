// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { useRef } from 'react'
import { act, render } from '@testing-library/react'
import { isScrolledToBottom, useStickToBottom } from './useStickToBottom'

function Probe({ text, active }: { text: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useStickToBottom(ref, text, active)
  return <div data-testid="scroller" ref={ref} />
}

/** jsdom gives every element a 0×0 scroll box; the hook only needs geometry,
 *  so install it directly. `scrollTop` is modeled on the browser: writes clamp
 *  to [0, scrollHeight - clientHeight], so the follow path exercises the same
 *  clamped read-back it will see in production (never the raw scrollHeight). */
function prepare(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  const max = Math.max(0, scrollHeight - clientHeight)
  let top = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.min(Math.max(v, 0), max) },
  })
}

describe('isScrolledToBottom', () => {
  it('counts the tolerance band as bottom; anything further up is scrolled', () => {
    expect(isScrolledToBottom({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 })).toBe(true)
    expect(isScrolledToBottom({ scrollTop: 397, scrollHeight: 500, clientHeight: 100 })).toBe(false)
    // Shorter than the viewport: nothing to scroll, so always "at bottom".
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true)
  })
})

describe('useStickToBottom', () => {
  it('pins the viewport to the bottom on every growth while active', () => {
    const { getByTestId, rerender } = render(<Probe text="a" active />)
    const el = getByTestId('scroller')
    prepare(el, 500, 100)
    rerender(<Probe text="ab" active />)
    // Browser clamp: writing scrollHeight lands at scrollHeight - clientHeight.
    expect(el.scrollTop).toBe(400)
    expect(el.dataset.scrolled).toBe('true')
    expect(el.dataset.atBottom).toBe('true')
    rerender(<Probe text="abc" active />)
    expect(el.scrollTop).toBe(400)
  })

  it('pauses follow when the user scrolls up and resumes once back at the bottom', () => {
    const { getByTestId, rerender } = render(<Probe text="a" active />)
    const el = getByTestId('scroller')
    prepare(el, 500, 100)
    rerender(<Probe text="ab" active />)
    expect(el.scrollTop).toBe(400)

    act(() => {
      el.scrollTop = 120
      el.dispatchEvent(new Event('scroll'))
    })
    rerender(<Probe text="abc" active />)
    // Follow is paused: the flush did not yank the reader back down.
    expect(el.scrollTop).toBe(120)
    expect(el.dataset.scrolled).toBe('true')
    expect(el.dataset.atBottom).toBe('false')

    act(() => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    expect(el.dataset.scrolled).toBe('false')
    expect(el.dataset.atBottom).toBe('false')

    act(() => {
      el.scrollTop = 500
      el.dispatchEvent(new Event('scroll'))
    })
    expect(el.scrollTop).toBe(400) // clamped to the real bottom
    expect(el.dataset.atBottom).toBe('true')
    rerender(<Probe text="abcd" active />)
    expect(el.scrollTop).toBe(400)
  })

  it('does not move the viewport while inactive (settled blocks read statically)', () => {
    const { getByTestId, rerender } = render(<Probe text="a" active={false} />)
    const el = getByTestId('scroller')
    prepare(el, 500, 100)
    el.scrollTop = 90
    rerender(<Probe text="ab" active={false} />)
    expect(el.scrollTop).toBe(90)
  })
})
