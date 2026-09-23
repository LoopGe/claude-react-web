import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { AnimatedCollapse } from './AnimatedCollapse'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  stubResizeObserver()
})

afterEach(() => {
  clearResizeObserverStub()
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

  it('follows continuous growth exactly instead of tweening to a stale target', () => {
    // Regression: an inner animation (a nested collapse, a grid-rows reveal)
    // feeds the ResizeObserver EVERY FRAME. The second observation used to be
    // swallowed by the in-flight guard, so the body kept tweening toward the
    // first frame's (stale) height and only snapped to the truth when
    // finishOpen re-measured at the end — "frozen while the inner card
    // shrinks, then jumps". Continuous observations must follow exactly.
    vi.useFakeTimers()
    const { container } = render(
      <AnimatedCollapse open animateResize>
        <ul>
          <li>A</li>
        </ul>
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(body, 60)
    mockRectHeight(content, 100)
    // jsdom reports offsetHeight 0, which reads as "ancestor clamped the body"
    // once a nonzero height is pinned — give the body its mocked rendered
    // height for the clamp probe (real browsers report the laid-out box).
    vi.spyOn(body, 'offsetHeight', 'get').mockReturnValue(60)

    // Fire 1 — isolated → the discrete-jump tween starts.
    act(() => fireResize(content))
    expect(body.classList.contains('animating')).toBe(true)

    // Fire 2 one frame later (same tick = well inside the coalesce window) —
    // the continuous sequence takes over: cancel the tween, follow exactly.
    mockRectHeight(content, 140)
    act(() => fireResize(content))
    expect(body.style.height).toBe('140px')
    expect(body.classList.contains('animating')).toBe(false)
    expect(body.style.transition).toBe('none')

    // Nothing pending — no delayed re-measure snap on top.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(body.style.height).toBe('140px')
  })

  it('never tears down an in-flight open/close fold for a resize observation', () => {
    // The fold must keep playing even with animateResize on — the guard now
    // distinguishes fold (protected) from resize tween (replaceable).
    vi.useFakeTimers()
    const { container, rerender } = render(
      <AnimatedCollapse open={false} animateResize unmountOnExit={false}>
        <ul>
          <li>A</li>
        </ul>
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(content, 100)

    rerender(
      <AnimatedCollapse open animateResize unmountOnExit={false}>
        <ul>
          <li>A</li>
        </ul>
      </AnimatedCollapse>,
    )
    expect(body.classList.contains('animating')).toBe(true)
    expect(body.style.height).toBe('0px')

    act(() => fireResize(content))
    // Still folding — the observation must not snap or retarget it.
    expect(body.classList.contains('animating')).toBe(true)
    expect(body.style.height).toBe('0px')

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(body.style.height).toBe('100px')
    expect(body.classList.contains('animating')).toBe(false)
  })
})
