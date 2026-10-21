import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { AnimatedCollapse } from './AnimatedCollapse'
import { setCollapseAnimating } from './collapse-animation'
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

/** happy-dom has no layout, so a box's height has to be mocked per element — on
 *  the metric the component reads, the used height (`offsetHeight`), which the
 *  pin and every comparison go through. (One exception: the mount path's initial
 *  pin reads the content's `scrollHeight`; a test that exercises that pin fakes
 *  it on the prototype.) Deliberately NOT the rect: nothing in the component
 *  reads one, and faking the rect to the same number would hide a rect read
 *  reintroduced later. A test that models an ancestor transform overrides the
 *  rect itself, and there it is meant to disagree.
 *
 *  "Not being rendered" is NOT mocked this way. It is modelled with an actual
 *  `display: none` wrapper (see renderInPanel) — the real shape, the same one the
 *  keep-alive panel cache imposes — so the component's own hidden-detection runs
 *  against a DOM state instead of against a stub of the very API under test.
 *  happy-dom answers `checkVisibility()` correctly there (verified: false under
 *  a display:none ancestor, true for a rendered zero-height box). */
function mockLayoutHeight(el: HTMLElement, height: number) {
  vi.spyOn(el, 'offsetHeight', 'get').mockReturnValue(height)
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
    mockLayoutHeight(body, 40)
    mockLayoutHeight(content, 40)
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
    mockLayoutHeight(body, 60)
    mockLayoutHeight(content, 100)

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
    mockLayoutHeight(body, 60)
    mockLayoutHeight(content, 100)

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
    mockLayoutHeight(body, 60)
    mockLayoutHeight(content, 100)

    // Fire 1 — isolated → the discrete-jump tween starts.
    act(() => fireResize(content))
    expect(body.classList.contains('animating')).toBe(true)

    // Fire 2 one frame later (same tick = well inside the coalesce window) —
    // the continuous sequence takes over: cancel the tween, follow exactly.
    mockLayoutHeight(content, 140)
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
    mockLayoutHeight(content, 100)

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
    mockLayoutHeight(body, 0)
    mockLayoutHeight(content, 100)
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
    mockLayoutHeight(content, 0)
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
    mockLayoutHeight(body, 0)
    mockLayoutHeight(content, 100)
    act(() => fireResize(content))
    expect(body.style.height).toBe('100px')

    // The last row is gone — nothing hidden about it, the box is just empty.
    mockLayoutHeight(content, 0)
    act(() => fireResize(content))
    expect(body.style.height).toBe('0px')
  })

  it('adopts the used height, not a rect scaled by an ancestor transform', () => {
    // The chat panel enters with `scale(0.98)` (layout.css), and every rect read
    // under it reports 98% of the layout height — verified in the browser: a
    // 100px box under scale(0.98) measures rect 98 / offsetHeight 100. A pinned
    // height is a LAYOUT height, so it must not carry that scale: pinned 2%
    // short, the card clips its last row until something re-measures it. (The
    // clamped branch already read offsetHeight for exactly this reason; the
    // other branch quietly did not.)
    const { container } = renderInPanel(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockLayoutHeight(body, 0)
    mockLayoutHeight(content, 100)
    // …but the rect carries the ancestor's scale, as it does in the browser.
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ height: 98 } as DOMRect)

    act(() => fireResize(content))

    expect(body.style.height).toBe('100px')
  })

  it('starts a close fold from the used height, not a scaled rect', () => {
    // The scale reaches the BODY-side reads too (this one and the observer's
    // comparison below), so they need the same treatment as the content's.
    vi.useFakeTimers()
    const { container, rerender } = renderInPanel(
      <AnimatedCollapse open unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockLayoutHeight(body, 100)
    mockLayoutHeight(content, 100)
    body.style.height = '100px' // pinned by an earlier observation
    // Under the entrance's scale(0.98) the body's rect reads 98 while its used
    // height stays 100.
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ height: 98 } as DOMRect)

    rerender(
      <AnimatedCollapse open={false} unmountOnExit={false}>
        {list}
      </AnimatedCollapse>,
      false,
    )

    // The tween starts from the used height, so the fold never jumps…
    expect(body.style.height).toBe('100px')
    act(() => {
      vi.advanceTimersByTime(400)
    })
    // …and settles shut.
    expect(body.style.height).toBe('0px')
  })

  it('does not treat a scaled body rect as a content change', () => {
    // The observer's no-op guard compares the content's used height against the
    // body's. Reading the body's rect under a transform would see it 2% smaller
    // and start a needless tween on every observation.
    const { container } = renderInPanel(
      <AnimatedCollapse open animateResize>
        {list}
      </AnimatedCollapse>,
    )
    const body = container.querySelector('.animated-collapse') as HTMLElement
    const content = container.querySelector('.animated-collapse-content') as HTMLElement
    mockLayoutHeight(body, 100)
    mockLayoutHeight(content, 100)
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ height: 98 } as DOMRect)

    act(() => fireResize(content))

    expect(body.classList.contains('animating')).toBe(false)
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

    // Standing down is not giving up: once the panel renders, the observer
    // re-pins the body from the content box's 0→∞ change — and a fold cycle
    // pins it too (the cycles below are what this case drives).
    mockLayoutHeight(content, 100)
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
    // target — the content's used height, falling back to scrollHeight — reads 0
    // there.
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
    mockLayoutHeight(content, 100)
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
    mockLayoutHeight(body, 100)
    mockLayoutHeight(content, 100)

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
    mockLayoutHeight(body, 0)
    mockLayoutHeight(content, 100)
    act(() => fireResize(content))
    expect(body.style.height).toBe('100px')

    rerender(
      <AnimatedCollapse open remeasureWhileClamped>
        {list}
      </AnimatedCollapse>,
      true,
    )
    mockLayoutHeight(content, 0)
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

describe('AnimatedCollapse — a nested fold is never relayed through an ancestor pin', () => {
  /** An open outer collapse with a pin, wrapping an inner collapse. */
  function Nested({
    innerOpen,
    outerAnimateResize = true,
    outerRemeasureWhileClamped = false,
  }: {
    innerOpen: boolean
    outerAnimateResize?: boolean
    outerRemeasureWhileClamped?: boolean
  }) {
    return (
      <AnimatedCollapse
        open
        unmountOnExit={false}
        animateResize={outerAnimateResize}
        remeasureWhileClamped={outerRemeasureWhileClamped}
      >
        <AnimatedCollapse open={innerOpen} unmountOnExit={false}>
          <ul>
            <li>A</li>
          </ul>
        </AnimatedCollapse>
      </AnimatedCollapse>
    )
  }

  function parts(container: HTMLElement) {
    const bodies = container.querySelectorAll<HTMLElement>('.animated-collapse')
    const contents = container.querySelectorAll<HTMLElement>('.animated-collapse-content')
    return { outer: bodies[0], inner: bodies[1], outerContent: contents[0], innerContent: contents[1] }
  }

  it('drops the ancestor pin when a nested fold starts animating', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<Nested innerOpen={false} />)
    const { outer, inner, innerContent } = parts(container)
    outer.style.height = '100px' // a settled open body, as in the browser
    mockLayoutHeight(innerContent, 400)

    rerender(<Nested innerOpen />)

    // The nested fold owns the height now: the ancestor must not clip it, or
    // its own observer would relay the growth one broadcast late. The release
    // lives in animateHeight, so this pins the ANIMATED fold path — the
    // reduced-motion case below pins the instant one, and Task 3's group test
    // pins the same wiring through a real ToolGroupCard.
    expect(outer.style.height).toBe('')
    expect(inner.classList.contains('animating')).toBe(true)
  })

  it('drops the ancestor pin even when the fold settles instantly (reduced motion)', () => {
    // Reduced motion (and any <2px delta) settles synchronously, so
    // animateHeight never registers — the layout-effect release is the only
    // path. Without it the ancestor relays the whole growth one broadcast late:
    // the content below flashes a full body-height lower for one frame.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { container, rerender } = render(<Nested innerOpen={false} />)
    const { outer, innerContent } = parts(container)
    outer.style.height = '100px'
    mockLayoutHeight(innerContent, 400)

    rerender(<Nested innerOpen />)

    expect(outer.style.height).toBe('')
  })

  it('does not re-pin the ancestor while a nested collapse animates', () => {
    // `outerAnimateResize={false}` so the contrast below is a plain snap rather
    // than a tween whose first frame is the OLD height (the tween's own
    // start-value write would make the assertion read the wrong number).
    const { container } = render(<Nested innerOpen={false} outerAnimateResize={false} />)
    const { outer, inner, outerContent } = parts(container)
    outer.style.height = '100px'
    mockLayoutHeight(outer, 100)
    mockLayoutHeight(outerContent, 400)
    // The registry is the signal — the observer consults it, not the DOM class.
    setCollapseAnimating(inner, true)

    act(() => fireResize(outerContent))

    expect(outer.style.height).toBe('')

    // …and the very same observation pins it once the nested fold is over
    // (this is the contrast that keeps the guard from silently disabling the
    // body's normal resize handling).
    setCollapseAnimating(inner, false)
    act(() => fireResize(outerContent))
    expect(outer.style.height).toBe('400px')
  })

  it('still adopts a clamped reading while a nested collapse animates', () => {
    // This pins the ORDER of the two guards: the nested check must sit BELOW
    // the clamped branch, so a flex-clamped body (the TaskList card under
    // .chat-bottom-stack's cap) keeps healing its pin from the content. It
    // passes both before and after this change by design — it reddens only if
    // the nested check is hoisted above the clamped branch. `remeasureWhileClamped`
    // is what makes a clamped reading adoptable at all (without it
    // measureAdoptableHeight returns null and nothing is written) — the same
    // opt-in the TaskList card carries.
    const { container } = render(<Nested innerOpen={false} outerRemeasureWhileClamped />)
    const { outer, inner, outerContent } = parts(container)
    outer.style.height = '100px'
    mockLayoutHeight(outer, 40) // clamped: the used height is shorter than the pin
    mockLayoutHeight(outerContent, 400)
    setCollapseAnimating(inner, true)

    act(() => fireResize(outerContent))

    expect(outer.style.height).toBe('400px')
  })

  it('leaves a stand-down body alone', () => {
    // The inner card's open lands while its subtree is not rendered (a
    // keep-alive panel; the cross-tab collapse flag can open a card while it is
    // hidden). The component stands down instead of animating, so nothing
    // releases the ancestor pin that keeps a shown-again card from coming back
    // header-only.
    const { container, rerender } = renderInPanel(<Nested innerOpen={false} />)
    const { outer, inner } = parts(container)
    outer.style.height = '300px' // a settled open body with a pin

    rerender(<Nested innerOpen />, true) // the open lands while the panel is hidden

    expect(inner.classList.contains('animating')).toBe(false)
    expect(outer.style.height).toBe('300px')
  })

  it('drops the ancestor pin when a nested fold CLOSES instantly (reduced motion)', () => {
    // The close direction has no animateHeight registration of its own under
    // reduced motion — the release has to be reached before that early return,
    // or a pinned ancestor relays the whole shrink one broadcast late: the
    // content below flashes a full body-height low for one frame.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { container, rerender } = render(<Nested innerOpen />)
    const { outer, inner, innerContent } = parts(container)
    mockLayoutHeight(innerContent, 400)
    outer.style.height = '100px' // the ancestor is pinned while the nested card is open

    rerender(<Nested innerOpen={false} />)

    expect(inner.classList.contains('animating')).toBe(false)
    expect(outer.style.height).toBe('')
  })

  it('does not un-pin a body whose own resize tween is in flight', () => {
    // A resize tween's pin IS its animation (releaseAncestorCollapsePins skips
    // exactly that body for this reason) — so the nested check must not clear it
    // either, or one observation snaps the glide to an auto box mid-tween.
    vi.useFakeTimers()
    const { container } = render(<Nested innerOpen={false} />)
    const { outer, inner, outerContent } = parts(container)
    // The used height tracks the pin, as a real box does — a frozen mock reads
    // as "clamped" against the tween's own per-frame writes.
    vi.spyOn(outer, 'offsetHeight', 'get').mockImplementation(() => Number.parseFloat(outer.style.height || '0'))
    outer.style.height = '100px'
    mockLayoutHeight(outerContent, 400)
    act(() => fireResize(outerContent)) // discrete → a resize tween owns the pin
    expect(outer.classList.contains('animating')).toBe(true)

    setCollapseAnimating(inner, true) // a nested collapse starts mid-tween
    mockLayoutHeight(outerContent, 500)
    act(() => fireResize(outerContent))

    // The discriminator: the bug wrote '' (auto) here, losing the glide. Both
    // admissible paths instead leave a real height — cancel-and-replace starts
    // a new tween from the rendered height, the continuous branch snaps to the
    // content — so only "not auto, and not below the height it started at" is
    // asserted.
    expect(outer.style.height).not.toBe('')
    expect(Number.parseFloat(outer.style.height)).toBeGreaterThanOrEqual(100)
  })

  it('re-pins an auto-height body so a later growth can still tween', () => {
    // A body released by a nested fold (or stood down) carries no pin, and an
    // auto box equals its content — so its own observer reads no difference on
    // the next growth and the animateResize glide would be gone for good (the
    // ToolGroupCard's member-append glide). The observer restores the pin.
    const { container } = render(<Nested innerOpen={false} />)
    const { outer, outerContent } = parts(container)
    outer.style.height = '' // released / stood down
    mockLayoutHeight(outer, 100)
    mockLayoutHeight(outerContent, 100)

    act(() => fireResize(outerContent)) // no difference to detect

    expect(outer.style.height).toBe('100px')
  })
})
