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
