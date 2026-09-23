import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { FoldableBody } from './FoldableBody'
import { FOLD_MAX_PX, userBodyFoldKey } from './fold-key'
import type { SdkMessage } from '../../types'

// Controllable ResizeObserver stub (same pattern as MessageList.test.tsx):
// captures callbacks by observed element so a test drives a re-measure
// deterministically via fireResize(el). Never auto-fires.
const roObserved = new Map<Element, Array<() => void>>()
function fireResize(el: Element) {
  for (const cb of roObserved.get(el) ?? []) cb()
}
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

// happy-dom has no layout engine, so scrollHeight is always 0. Mutable
// prototype stub: the element under measurement is created by the component
// itself, before any test code can reach it, so per-element defineProperty
// (the Composer.test approach) is impossible — the measurement must see a
// scripted height from the very first useLayoutEffect. Scoped to this file
// (process-per-file isolation) and restored in afterEach.
let mockScrollHeight = 0
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  mockScrollHeight = 0
  roObserved.clear()
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => mockScrollHeight,
  })
})

afterEach(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight
})

describe('FoldableBody', () => {
  it('renders children bare when content fits under the threshold', () => {
    mockScrollHeight = FOLD_MAX_PX - 40
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>short</p>
      </FoldableBody>,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(screen.getByText('short')).toBeTruthy()
  })

  it('clamps over-threshold content and offers Show more', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    const content = container.querySelector('.fold-content') as HTMLElement
    expect(content.classList.contains('fold-clamped')).toBe(true)
    // Clamp height comes from the same constant the measurement compared
    // against — inline, so threshold and max-height cannot drift apart.
    expect(content.style.maxHeight).toBe(`${FOLD_MAX_PX}px`)
    const btn = screen.getByRole('button', { name: /show more/i })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('invokes onToggle and reflects the parent-controlled expanded state', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const onToggle = vi.fn()
    const { container, rerender } = render(
      <FoldableBody expanded={false} onToggle={onToggle}>
        <p>tall</p>
      </FoldableBody>,
    )
    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)

    // The lifted state lives in the parent; the prop flip is what re-renders.
    rerender(
      <FoldableBody expanded onToggle={onToggle}>
        <p>tall</p>
      </FoldableBody>,
    )
    const btn = screen.getByRole('button', { name: /show less/i })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect((container.querySelector('.fold-content') as HTMLElement).style.maxHeight).toBe('')
  })

  it('never clamps and hides the toggle while force-opened (search hit)', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container } = render(
      <FoldableBody expanded={false} forceOpen onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('tall')).toBeTruthy()
  })

  it('re-measures when ResizeObserver reports a content resize', () => {
    mockScrollHeight = FOLD_MAX_PX - 40
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>grows</p>
      </FoldableBody>,
    )
    expect(screen.queryByRole('button')).toBeNull()

    // e.g. an image finished loading and pushed the body past the threshold.
    // RO observes the INNER measurement element (see FoldableBody — the
    // outer box owns clipping, the inner owns measurement, so an
    // overflow:clip parent can never skew the scrollHeight read).
    mockScrollHeight = FOLD_MAX_PX + 100
    act(() => {
      fireResize(container.querySelector('.fold-measure')!)
    })
    expect(screen.getByRole('button', { name: /show more/i })).toBeTruthy()
    expect(container.querySelector('.fold-clamped')).toBeTruthy()
  })

  it('links the toggle to the clipped region via aria-controls', () => {
    // Mirrors ToolGroupCard's useId + aria-controls pattern: aria-expanded
    // alone tells an AT the state but not WHICH region it mutates.
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    const btn = screen.getByRole('button', { name: /show more/i })
    const controls = btn.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    // useId emits ":r0:"-style ids — invalid in a #selector, so match via
    // the attribute form instead (CSS.escape isn't guaranteed in happy-dom).
    const region = container.querySelector(`[id="${controls}"]`)
    expect(region).toBeTruthy()
    expect(region).toBe(container.querySelector('.fold-clamped'))
  })
})

describe('FoldableBody height tween', () => {
  // The tween is driven imperatively (explicit height pin + inline
  // transition, landing on the rest state via transitionend or the fallback
  // timer). happy-dom fires no transition events, so every test below
  // exercises the FALLBACK-timer landing path — deterministic under fake
  // timers.
  it('pins an explicit height tween on expand and lands on the open rest state', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      // Mid-tween: the target height is pinned, the transition is live, the
      // clamp is neutralized (it would cap the animation), and the tween
      // mask class is on (it carries the fade for the inline mask-size
      // endpoints — the open rest state itself is deliberately unmasked).
      expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
      expect(content.style.transition).toContain('height')
      expect(content.style.maxHeight).toBe('')
      expect(content.classList.contains('fold-tweening')).toBe(true)
      // The inline mask-size END is committed at arm: expand ends with the
      // band fully below the box edge (the offset = the stylesheet's fade
      // ramp via --fold-fade-height). A swapped start/end pair lands the
      // band on the wrong end of the box in a real browser.
      expect(content.style.maskSize).toBe('100% calc(100% + var(--fold-fade-height))')
      // Fallback timer lands the open rest state: auto height, no clamp, no
      // tween mask.
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe('')
      expect(content.style.transition).toBe('')
      expect(content.style.maskSize).toBe('')
      expect(content.classList.contains('fold-tweening')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tweens collapse back to the clamp and restores the clamped rest state', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      // Mount at expanded: no tween runs (the fold starts settled open).
      expect(content.style.height).toBe('')
      rerender(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      // Mid-tween: target is the clamp, maxHeight is neutralized so it
      // cannot cap the animation, and the tween mask class is on with the
      // collapse end value (band on the edge, riding the shrinking box).
      expect(content.style.height).toBe(`${FOLD_MAX_PX}px`)
      expect(content.style.maxHeight).toBe('')
      expect(content.classList.contains('fold-tweening')).toBe(true)
      expect(content.style.maskSize).toBe('100% 100%')
      // Fallback timer restores the clamped rest state.
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe(`${FOLD_MAX_PX}px`)
      expect(content.style.transition).toBe('')
      expect(content.style.maskSize).toBe('')
      expect(content.classList.contains('fold-tweening')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retargets a running tween when re-toggled mid-flight', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      // Reverse mid-expand: the collapse takes over the box (no stacked
      // timers fighting over it) and lands the clamped rest state.
      rerender(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      expect(content.style.height).toBe(`${FOLD_MAX_PX}px`)
      // The handover RE-ARMED (this delta is tweenable): exactly one
      // fallback timer alive — the old tween's was cleared by the handover.
      // A stacked timer would prematurely land a live retarget mid-flight in
      // a real browser, where the two deadlines differ; both lands writing
      // the same final DOM state inside one advanceTimersByTime call would
      // otherwise hide it.
      expect(vi.getTimerCount()).toBe(1)
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe(`${FOLD_MAX_PX}px`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues a mid-flight retarget from the live interpolated height', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      // Collapse tween starts (target: the clamp).
      rerender(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      expect(content.style.height).toBe(`${FOLD_MAX_PX}px`)
      // Reverse mid-collapse with the box at 339px — within 2px of the expand
      // target (340). Only a LIVE-height handover can produce that degenerate
      // delta and bail straight to the rest state; a constant-from handover
      // (the clamped 240) would read |340-240| ≥ 2 and tween instead. This is
      // the regression guard for the handover path happy-dom's zero rects
      // otherwise never exercise. (offsetHeight, not a rect: the tween reads
      // the transform-free used height — see FoldableBody.)
      Object.defineProperty(content, 'offsetHeight', { configurable: true, value: FOLD_MAX_PX + 99 })
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      expect(content.style.height).toBe('')
      expect(content.style.transition).toBe('')
      expect(content.style.maxHeight).toBe('')
      delete (content as { offsetHeight?: unknown }).offsetHeight
      // The degenerate delta BAILS (no re-arm) — so ZERO timers remain: this
      // proves the handover cleared the old tween's fallback timer (a stacked
      // timer would prematurely land a live retarget mid-flight in a real
      // browser, where the two deadlines differ; both lands writing the same
      // final DOM state inside one advanceTimersByTime call hides it).
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lands open instantly when a search hit interrupts a collapse tween', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      expect(content.style.height).toBe(`${FOLD_MAX_PX}px`)
      // forceOpen is a hard override, never tweened: the navigated <mark>
      // must be visible now, not after the collapse lands.
      rerender(
        <FoldableBody expanded={false} forceOpen onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe('')
      expect(content.style.transition).toBe('')
      expect(container.querySelector('.fold-clamped')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lands on a height transitionend and ignores every other transition event', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container, rerender } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    rerender(
      <FoldableBody expanded onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    const content = container.querySelector('.fold-content') as HTMLElement
    expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
    // happy-dom + RTL expose no fireEvent.transitionend — dispatch synthetic
    // events directly (target/propertyName are exactly what the filter reads).
    const fireTransitionEnd = (el: Element, propertyName: string, bubbles = false) => {
      const event = new Event('transitionend', { bubbles })
      Object.defineProperty(event, 'propertyName', { value: propertyName })
      el.dispatchEvent(event)
    }
    // A transitionend for a DIFFERENT property (the mask-size tween also
    // fires one) must not land the fold.
    fireTransitionEnd(content, 'opacity')
    expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
    // Neither may one BUBBLING up from a descendant — the target filter keeps
    // inner transitions (markdown images, code blocks) from landing early.
    fireTransitionEnd(container.querySelector('.fold-measure')!, 'height', true)
    expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
    // The real signal: height transitionend on the box itself → rest state.
    fireTransitionEnd(content, 'height')
    expect(content.style.height).toBe('')
    expect(content.style.maxHeight).toBe('')
    expect(content.style.transition).toBe('')
  })

  it('reconciles content that grows mid-tween instead of snapping at the land', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
      // An image finishes loading mid-tween: the natural height grows past
      // the target the tween was armed with.
      mockScrollHeight = FOLD_MAX_PX + 260
      act(() => {
        vi.advanceTimersByTime(400)
      })
      // First land reconciles — the tween re-arms toward the new natural
      // rather than snapping the box when the pin clears.
      expect(content.style.height).toBe(`${FOLD_MAX_PX + 260}px`)
      act(() => {
        vi.advanceTimersByTime(400)
      })
      // Stable content → the open rest state.
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe('')
      expect(content.style.transition).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('interrupts a running expand tween when a search hit arrives without changing open', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
      // The search hit flips forceOpen while `open` (expanded || forceOpen)
      // stays true — the hard override must still interrupt the in-flight
      // tween: the navigated <mark> below the pin is visible NOW.
      rerender(
        <FoldableBody expanded forceOpen onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe('')
      expect(content.style.transition).toBe('')
      expect(container.querySelector('.fold-clamped')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lands immediately when content shrinks below the threshold mid-tween', () => {
    vi.useFakeTimers()
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      expect(content.style.height).toBe(`${FOLD_MAX_PX + 100}px`)
      // The body reflows short mid-expand (panel widened, image unloaded):
      // the fold is moot — the tween must land instead of pinning toward a
      // clamp that no longer applies.
      mockScrollHeight = FOLD_MAX_PX - 40
      act(() => {
        fireResize(container.querySelector('.fold-measure')!)
      })
      expect(content.style.height).toBe('')
      expect(content.style.maxHeight).toBe('')
      expect(content.style.transition).toBe('')
      expect(content.style.maskSize).toBe('')
      expect(content.classList.contains('fold-tweening')).toBe(false)
      expect(screen.queryByRole('button')).toBeNull()
      // The tween's fallback timer was canceled with it.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the tween under prefers-reduced-motion', () => {
    const mqlSpy = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList)
    try {
      mockScrollHeight = FOLD_MAX_PX + 100
      const { container, rerender } = render(
        <FoldableBody expanded={false} onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      rerender(
        <FoldableBody expanded onToggle={() => {}}>
          <p>tall</p>
        </FoldableBody>,
      )
      const content = container.querySelector('.fold-content') as HTMLElement
      // Instant flip: no pin, no transition — the class change alone does
      // the work, and the clamp is already lifted.
      expect(content.style.height).toBe('')
      expect(content.style.transition).toBe('')
      expect(content.style.maxHeight).toBe('')
    } finally {
      mqlSpy.mockRestore()
    }
  })
})

describe('userBodyFoldKey', () => {
  function userMsg(uuid: string, text: string, images: string[] = []): SdkMessage {
    return {
      type: 'user',
      uuid,
      message: {
        content: [
          { type: 'text', text },
          ...images.map((data) => ({ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } })),
        ],
      },
    } as unknown as SdkMessage
  }

  it('is stable across the ack uuid re-key (pendingId → server uuid)', () => {
    // ackUserMessage rebuilds the row with a new uuid but verbatim content;
    // a uuid-keyed expansion would snap shut mid-send.
    expect(userBodyFoldKey(userMsg('pending-1', 'long paste'))).toBe(
      userBodyFoldKey(userMsg('server-uuid', 'long paste')),
    )
  })

  it('distinguishes different content', () => {
    expect(userBodyFoldKey(userMsg('x', 'aaaa'))).not.toBe(userBodyFoldKey(userMsg('x', 'bbbb')))
  })

  it('lets image payloads participate so image-only messages get distinct keys', () => {
    expect(userBodyFoldKey(userMsg('x', '', ['abc']))).not.toBe(
      userBodyFoldKey(userMsg('x', '', ['abcd'])),
    )
    expect(userBodyFoldKey(userMsg('x', '', ['abc']))).toBe(
      userBodyFoldKey(userMsg('y', '', ['abc'])),
    )
  })
})
