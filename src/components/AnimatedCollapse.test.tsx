import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { AnimatedCollapse } from './AnimatedCollapse'

// ResizeObserver isn't available in jsdom. Controllable stub — captures each
// callback by observed element so a test can fire it on demand via
// fireResize(el). Never auto-fires, so the open/close fold tests behave
// exactly as they would under a no-op stub.
const roObserved = new Map<Element, Array<() => void>>()
function fireResize(el: Element) {
  for (const cb of roObserved.get(el) ?? []) cb()
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {}
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
})

afterEach(() => {
  roObserved.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** jsdom has no layout, so getBoundingClientRect returns 0 everywhere. Mock the
 *  rendered height of a single element to simulate a laid-out box. */
function mockRectHeight(el: Element, height: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect)
}

describe('AnimatedCollapse — exit keeps the last visible content', () => {
  /** The body must be tall enough to tween (jsdom has no layout). */
  function armTween(body: HTMLElement, content: HTMLElement) {
    mockRectHeight(body, 40)
    mockRectHeight(content, 40)
  }

  it('renders the last OPEN children while the exit tween runs (not an empty box)', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <AnimatedCollapse open>
        <span>attachment chip</span>
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    armTween(body, content)

    // The row is dropped in the SAME commit that flips open=false — exactly
    // what the composer does when the last attachment is removed.
    rerender(<AnimatedCollapse open={false}>{null}</AnimatedCollapse>)

    // Mid-tween the body is still mounted and must still paint the chip.
    expect(container.querySelector('.animated-collapse-content')?.textContent).toBe('attachment chip')

    act(() => { vi.advanceTimersByTime(400) })
    // Settled: unmountOnExit drops the body entirely.
    expect(container.querySelector('.animated-collapse')).toBeNull()
  })

  it('does not apply aria-hidden until the exit settles, and never over focus', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <AnimatedCollapse open unmountOnExit={false}>
        <button type="button">remove</button>
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    const button = container.querySelector('button') as HTMLElement
    armTween(body, content)
    act(() => { button.focus() })
    expect(document.activeElement).toBe(button)

    rerender(
      <AnimatedCollapse open={false} unmountOnExit={false}>
        <button type="button">remove</button>
      </AnimatedCollapse>,
    )

    // During the tween the focused control is still in the subtree, so hiding
    // it would make Chrome refuse the aria-hidden write and warn.
    expect(body.getAttribute('aria-hidden')).toBeNull()
    expect(document.activeElement).toBe(button)

    act(() => { vi.advanceTimersByTime(400) })
    // Settled shut: focus is released first, then the body is hidden.
    expect(body.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).not.toBe(button)
  })
})

describe('AnimatedCollapse — intrinsic content growth while open', () => {
  it('snaps the body height by default (animateResize off)', () => {
    const { container } = render(
      <AnimatedCollapse open>
        <ul>
          <li>A</li>
        </ul>
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(body, 60)
    mockRectHeight(content, 100)

    act(() => fireResize(content))

    // Snap: height jumps straight to the content's new natural height.
    expect(body.style.height).toBe('100px')
    expect(body.classList.contains('animating')).toBe(false)
  })

  it('tweens the body height on content growth when animateResize is set', () => {
    vi.useFakeTimers()
    const { container } = render(
      <AnimatedCollapse open animateResize>
        <ul>
          <li>A</li>
          <li>B</li>
        </ul>
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(body, 60)
    mockRectHeight(content, 100)

    act(() => fireResize(content))

    // Starts a height tween from the current rendered height (60px)…
    expect(body.style.height).toBe('60px')
    expect(body.classList.contains('animating')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(400)
    })

    // …and settles on the content's natural height with animation state cleared.
    expect(body.style.height).toBe('100px')
    expect(body.classList.contains('animating')).toBe(false)
    expect(body.style.transition).toBe('')
  })
})
