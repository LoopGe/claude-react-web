import { type ReactNode } from 'react'
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

/** happy-dom has no layout, so getBoundingClientRect returns a zero rect
 *  everywhere: the rendered height of a box has to be mocked per element.
 *
 *  "Not being rendered" is NOT mocked this way. It is modelled with an actual
 *  `display: none` wrapper (see renderInPanel) — the real shape, the same one the
 *  keep-alive panel cache imposes — so the component's own hidden-detection runs
 *  against a DOM state instead of against a stub of the very API under test.
 *  happy-dom answers `checkVisibility()` correctly there (verified: false under
 *  a display:none ancestor, true for a rendered zero-height box). */
function mockRectHeight(el: Element, height: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect)
}

/** Render `ui` inside a wrapper that can be taken out of rendering — the
 *  condition a keep-alive-cached panel imposes on everything inside it. The
 *  wrapper is part of every render (including `rerender`), so the hidden state
 *  is React-owned and the component is never remounted by a rerender — a bare
 *  `rerender` would replace the wrapper itself and remount the subtree.
 *
 *  `rerender(ui, hidden)` re-renders inside the same wrapper, with the hidden
 *  state passed explicitly (it is the whole point of these tests — no default
 *  to get wrong). */
function renderInPanel(ui: ReactNode, { hidden = false }: { hidden?: boolean } = {}) {
  function Panel({ hidden: isHidden, child }: { hidden: boolean; child: ReactNode }) {
    return <div style={{ display: isHidden ? 'none' : '' }}>{child}</div>
  }
  const utils = render(<Panel hidden={hidden} child={ui} />)
  return {
    ...utils,
    rerender: (child: ReactNode, nextHidden: boolean) => utils.rerender(<Panel hidden={nextHidden} child={child} />),
  }
}

describe('AnimatedCollapse — exit keeps the last visible content', () => {
  /** The body must be tall enough to tween (happy-dom has no layout). */
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
    // happy-dom reports offsetHeight 0, which reads as "ancestor clamped the
    // body" once a nonzero height is pinned — give the body its mocked rendered
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

describe('AnimatedCollapse — a box that is not being rendered is not a measurement', () => {
  const list = (
    <ul>
      <li>A</li>
    </ul>
  )

  it('keeps the pinned height when the observed subtree stops being rendered', () => {
    // A keep-alive-cached panel is display:none, so its whole subtree reports
    // 0×0 to the ResizeObserver. Adopting that 0 pins the body to 0px, and the
    // bottom cards then come back header-only on the next show and tween up from
    // there — the TaskList's "height changes on a group switch". The opt-in
    // remeasureWhileClamped is what made the zero adoptable: it exists to keep
    // the pin in step under a flex clamp, and a not-rendered box reads the same
    // way (a box shorter than the pin).
    const { container, rerender } = renderInPanel(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(body, 0)
    mockRectHeight(content, 100)
    act(() => fireResize(content))
    expect(body.style.height).toBe('100px')

    // The panel goes into the keep-alive cache — nothing in the subtree renders,
    // and every metric of it now reads 0 (a browser reports exactly that: no
    // box, no metrics), so the faked rect goes to 0 with it.
    rerender(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
      true,
    )
    mockRectHeight(content, 0)
    act(() => fireResize(content))

    // The pin has to survive the hidden period, or the card is header-only the
    // moment it is shown again.
    expect(body.style.height).toBe('100px')
  })

  it('still adopts a zero reading from a box that IS rendered', () => {
    // The counterpart to the test above, and the reason the probe asks "is it
    // rendered" rather than "is its height non-zero": a list that empties really
    // does collapse the body to 0, and that reading has to be adopted.
    const { container } = renderInPanel(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(body, 0)
    mockRectHeight(content, 100)
    act(() => fireResize(content))
    expect(body.style.height).toBe('100px')

    // The last row is gone — nothing hidden about it, the box is just empty.
    mockRectHeight(content, 0)
    act(() => fireResize(content))
    expect(body.style.height).toBe('0px')
  })

  it('does not pin a zero height when it mounts inside a subtree that is not rendered', () => {
    // A cached panel keeps receiving live data, so a card can mount while
    // display:none. Both of the initial pin's sources read 0 there — the
    // content's scrollHeight and its rect — and neither of them is a height.
    vi.useFakeTimers()
    const { container, rerender } = renderInPanel(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      { hidden: true },
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    expect(body.style.height).toBe('')

    // Standing down is not giving up: once the panel renders, a fold cycle pins
    // the body again. (The observer cannot — an unpinned body's own box already
    // equals its content's height, so it has nothing to detect.)
    mockRectHeight(content, 100)
    rerender(
      <AnimatedCollapse open={false} unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      false,
    )
    act(() => {
      vi.advanceTimersByTime(400)
    })
    rerender(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      false,
    )
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(body.style.height).toBe('100px')
  })

  it('does not pin a zero height when it is opened inside a subtree that is not rendered', () => {
    // The collapse flag is per-session localStorage that syncs across tabs
    // (useLocalStorage's 'storage' listener), so a card sitting in a
    // keep-alive-cached panel can be opened while it is hidden. The fold's
    // target — content rect, falling back to scrollHeight — reads 0 there.
    const { container, rerender } = renderInPanel(
      <AnimatedCollapse open={false} unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    expect(body.style.height).toBe('0px')

    rerender(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      true,
    )

    // Open again — the body belongs at its natural height, not at 0px.
    expect(body.style.height).toBe('')

    // …and it recovers the same way the mount case does: once the panel renders,
    // a fold cycle pins it again. Nothing re-pins an auto-height body on its own.
    vi.useFakeTimers()
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(content, 100)
    rerender(
      <AnimatedCollapse open={false} unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      false,
    )
    act(() => {
      vi.advanceTimersByTime(400)
    })
    rerender(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      false,
    )
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(body.style.height).toBe('100px')
  })

  it('cancels a fold that is still running when the subtree stops rendering', () => {
    // The same cross-tab flag can flip the card back OPEN while it is hidden —
    // and while the close fold it just started is still in flight. Without the
    // stand-down's cancel, that fold runs on and settles finishClosed() onto a
    // body that is open again (height 0, opacity 0, aria-hidden) — an open card
    // at full height and fully transparent. (Before this guard the same sequence
    // failed differently: the open fold's target read 0, so finishOpen pinned
    // 0px — the header-only card the first test in this block covers.)
    vi.useFakeTimers()
    const { container, rerender } = renderInPanel(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockRectHeight(body, 100)
    mockRectHeight(content, 100)

    // Collapse it — the close fold is in flight.
    rerender(
      <AnimatedCollapse open={false} unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      false,
    )
    expect(body.classList.contains('animating')).toBe(true)

    // Hidden panel: the card flips back open before the fold can settle.
    rerender(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      true,
    )
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(body.style.height).toBe('')
    expect(body.style.opacity).toBe('')
    expect(body.getAttribute('aria-hidden')).toBeNull()
    // The cancelled fold had already written the tween's transition onto the
    // element; standing down has to leave it settled, or those pin writes play
    // as animated changes and the stranded transition outlives the fold.
    expect(body.style.transition).toBe('')
  })

  it('pins the body from the content when it mounts in a rendered subtree', () => {
    // The boundary of the stand-down above: a mount that IS rendered pins
    // exactly as it always did. (scrollHeight is faked on the prototype — it has
    // to be in place before the mount's initial pin, and happy-dom reports 0 for
    // every box, which would pin 0px for an unrelated reason.)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100)
    const { container } = renderInPanel(
      <AnimatedCollapse open>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    expect(body.style.height).toBe('100px')
  })

  it('asks the same question through the display-chain fallback', () => {
    // The fallback (engines without checkVisibility) is a real code path, but
    // nothing in this suite runs on such an engine — happy-dom has the API — so
    // force it here: the guard has to reach the same verdict through the walk.
    const { container, rerender } = renderInPanel(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    Object.defineProperty(content, 'checkVisibility', { value: undefined })
    mockRectHeight(body, 0)
    mockRectHeight(content, 100)
    act(() => fireResize(content))
    expect(body.style.height).toBe('100px')

    rerender(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
      true,
    )
    mockRectHeight(content, 0)
    act(() => fireResize(content))
    expect(body.style.height).toBe('100px')
  })

  it('still pins when the box is only invisible, not unrendered', () => {
    // `visibility: hidden` is not "not rendered": the box exists and its metrics
    // are real, so the card keeps its pin. This pins the size- and
    // visibility-agnostic reading the probe has to give (verified against the
    // browser) — it must not drift into asking "is it visible".
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100)
    const { container } = render(
      <div style={{ visibility: 'hidden' }}>
        <AnimatedCollapse open>{list}</AnimatedCollapse>
      </div>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    expect(body.style.height).toBe('100px')
  })
})
