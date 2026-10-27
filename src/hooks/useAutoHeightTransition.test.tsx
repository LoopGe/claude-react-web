import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setCollapseAnimating } from '../components/collapse-animation'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { useAutoHeightTransition } from './useAutoHeightTransition'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  stubResizeObserver()
})

afterEach(() => {
  clearResizeObserverStub()
  vi.restoreAllMocks()
})

/** Minimal consumer: the hook needs a ref to a real element. */
function Harness({ onReady }: { onReady: (captureHeight: () => void, el: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { captureHeight } = useAutoHeightTransition(ref, 'key')
  useEffect(() => {
    if (ref.current) onReady(captureHeight, ref.current)
  }, [captureHeight, onReady])
  return <div data-testid="target" ref={ref} />
}

it('captures the used height, not a rect scaled by an ancestor transform', () => {
  // captureHeight pins the element's current height as a tween's start point,
  // and its callers (a settings panel body, a folder picker list) live inside
  // `.chat-panel`, which enters with `scale(0.98)` (layout.css). A rect read
  // there is 2% short, so the tween starts smaller than the box it is animating
  // and jumps on the first frame. Same hazard the fold components document.
  let capture: (() => void) | null = null
  let el: HTMLElement | null = null
  render(
    <Harness
      onReady={(c, e) => {
        capture = c
        el = e
      }}
    />,
  )
  expect(capture).not.toBeNull()
  // A 100px box under scale(0.98): the rect reads 98, the used height is 100.
  vi.spyOn(el!, 'offsetHeight', 'get').mockReturnValue(100)
  vi.spyOn(el!, 'getBoundingClientRect').mockReturnValue({ height: 98 } as DOMRect)

  act(() => capture!())

  expect(el!.style.height).toBe('100px')
})

/** Consumer mirroring the settings panel: a body ref driven by a measured
 *  target, watching an inner content element for size changes. */
function ObservedHarness({
  targetRef,
  animKey = 'key',
  durationMs,
  onReady,
}: {
  targetRef: { current: number }
  animKey?: string
  durationMs?: number
  onReady: (el: HTMLElement, contentEl: HTMLElement) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const measureTargetHeight = () => targetRef.current
  useAutoHeightTransition(ref, animKey, { measureTargetHeight, observe: contentRef, durationMs })
  useEffect(() => {
    if (ref.current && contentRef.current) onReady(ref.current, contentRef.current)
  }, [onReady])
  return (
    <div ref={ref} data-testid="target">
      <div ref={contentRef} data-testid="content" />
    </div>
  )
}

it('does not pin the body while a nested collapse is animating inside the observed content', () => {
  // The session settings panel has exactly this shape: expanding an
  // AnimatedDetails ("Loaded skills") grows the observed content every frame,
  // and the hook used to answer with its own height tween — pinning the panel
  // body mid-fold and snapping it back when the tween chain ended (the
  // scrollbar suddenly shortened at fold completion). A fold animating inside
  // the observed content IS the height motion to follow natively; the hook
  // must stand down (same rule AnimatedCollapse's own observer applies).
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  try {
    targetRef.current = 800
    act(() => fireResize(contentEl!))

    expect(el!.style.height).toBe('')
    expect(el!.classList.contains('auto-height-animating')).toBe(false)
  } finally {
    setCollapseAnimating(folding, false)
  }
})

it('tracks the target during the collapse so the next discrete change animates from the right start', () => {
  // Standing down must still keep the bookkeeping: when the fold settles and
  // a genuinely discrete change lands, the tween starts from the height the
  // body reached natively during the fold — not from a stale pre-fold value.
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  // Mid-fold: the target grows to 800 across frames — tracked, not animated.
  targetRef.current = 800
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  now.mockReturnValue(1100)
  setCollapseAnimating(folding, false)
  // Fold settled, target unchanged: nothing to animate (Δ < 2).
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  // A real discrete change past the settle window tweens from the tracked 800
  // (within the window, an observation is the fold's tail and is swallowed —
  // covered by the settle-frame tests).
  now.mockReturnValue(1300)
  targetRef.current = 900
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('800px')
  expect(el!.classList.contains('auto-height-animating')).toBe(true)
})

it('still animates discrete content changes when no collapse is animating', () => {
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  targetRef.current = 800
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('500px')
  expect(el!.classList.contains('auto-height-animating')).toBe(true)
})

it('does not adopt an unrendered box\'s measurements (zero or padding-derived)', () => {
  // The settings panel stays mounted under `.hidden` (display:none) — its box
  // reads 0 everywhere, and none of those zeros is a measurement (the rule
  // AnimatedCollapse pins via isRendered). Worse, a measure can return a
  // NONZERO off a hidden box: GlobalSettingsModal's adds the body's CSS
  // padding to the zero scrollHeight (~32px), so a `target === 0` conjunct
  // would adopt that as a real target. The key-driven path reads the measure
  // on WS-driven key changes WHILE hidden (no ResizeObserver needed). NO read
  // off an unrendered box is a measurement.
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  el!.style.display = 'none'
  for (const hiddenRead of [0, 32]) {
    targetRef.current = hiddenRead
    act(() => fireResize(contentEl!))
    expect(el!.style.height).toBe('')
    expect(el!.classList.contains('auto-height-animating')).toBe(false)
  }
})

it('rebases the baseline on a hidden-window read so the reveal does not glide', () => {
  // A refused (unrendered) read must drop the tracking baseline, not leave it
  // stale: if content changed while the panel was hidden (a WS-driven key
  // change), the reveal's first observation would otherwise animate from the
  // PRE-HIDE target — gliding the body through wrong heights right after
  // every reopen. Rebase: the reveal records the real height without a tween.
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  const { rerender } = render(
    <ObservedHarness
      targetRef={targetRef}
      animKey="a"
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  el!.style.display = 'none'
  targetRef.current = 800
  rerender(
    <ObservedHarness
      targetRef={targetRef}
      animKey="b"
      onReady={() => {}}
    />,
  )
  expect(el!.style.height).toBe('')
  el!.style.display = ''
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  expect(el!.classList.contains('auto-height-animating')).toBe(false)
})

it('stands down for a key-driven change while a collapse is animating inside', () => {
  // The same fold-owns-the-motion rule applies to the key path: a WS-driven
  // key change (busy / usage totals) landing mid-fold must not pin the body
  // back to the pre-fold height and re-grow it. (The captureHeight branch is
  // different — it has already pinned the box and MUST animate to release it —
  // but a fold there is unreachable: that branch runs after a content swap,
  // which unmounts any fold.)
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  const { rerender } = render(
    <ObservedHarness
      targetRef={targetRef}
      animKey="a"
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  try {
    targetRef.current = 800
    rerender(
      <ObservedHarness
        targetRef={targetRef}
        animKey="b"
        onReady={() => {}}
      />,
    )
    expect(el!.style.height).toBe('')
    expect(el!.classList.contains('auto-height-animating')).toBe(false)
  } finally {
    setCollapseAnimating(folding, false)
  }
})

it('a tween finishing mid-fold releases the pin instead of chaining a catch-up', async () => {
  // A tween that started before the fold (content grew, then the user opened a
  // fold within its 240ms) must not chain a catch-up tween at finish: that
  // re-pins the body below its natural height mid-fold and re-targets every
  // durationMs until the fold settles. finish releases the pin and tracks.
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      durationMs={30}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  targetRef.current = 800
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('500px')
  // A second observation lands during the tween: deferred as the pending
  // retarget the finish will try to chain to.
  targetRef.current = 1000
  act(() => fireResize(contentEl!))
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  // durationMs 30 + the 120ms safety timer is the finish at most 150ms out.
  await new Promise((r) => setTimeout(r, 250))
  expect(el!.style.height).toBe('')
  expect(el!.classList.contains('auto-height-animating')).toBe(false)
  setCollapseAnimating(folding, false)
})

it('swallows the fold\'s settle-frame observation but animates later changes', () => {
  // AnimatedCollapse clears its animating registry at the fold's settle, in the
  // same task as its final height write — but that final size's
  // ResizeObserver delivery lands in a LATER rendering step, so the fold guard
  // sees "no fold" exactly once: the tail of the fold. Answering it with a
  // tween pins the body a frame low and re-grows the tail. That one delivery
  // is swallowed (tracked only); a genuine discrete change arriving after the
  // settle window animates normally. Clock is mocked (the window is real-time
  // in the hook) so the window cannot flake open under a stalled runner.
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  targetRef.current = 700
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  now.mockReturnValue(1005)
  setCollapseAnimating(folding, false)
  // The settle-frame delivery: remaining growth, no fold in the registry.
  now.mockReturnValue(1010)
  targetRef.current = 720
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  expect(el!.classList.contains('auto-height-animating')).toBe(false)
  // Past the settle window a discrete change animates from the tracked 720.
  now.mockReturnValue(1300)
  targetRef.current = 800
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('720px')
  expect(el!.classList.contains('auto-height-animating')).toBe(true)
})

it('swallows the settle tail even when the fold\'s last frames were sub-2px', () => {
  // A fold's eased tail grows the body in <2px steps, which the delta
  // early-return absorbs WITHOUT touching any fold bookkeeping — so if the
  // settle window is clocked from the last guard-fired observation (rather
  // than from the settle itself) it expires mid-tail, and the settle-frame
  // delivery (several tail frames coalesced, ≥2px) slips through as a
  // catch-up tween. The window must be anchored on the settle moment.
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  targetRef.current = 700
  act(() => fireResize(contentEl!))
  // Sub-2px tail frames: absorbed by the delta early-return.
  now.mockReturnValue(1100)
  targetRef.current = 701
  act(() => fireResize(contentEl!))
  now.mockReturnValue(1150)
  targetRef.current = 702
  act(() => fireResize(contentEl!))
  setCollapseAnimating(folding, false)
  // The settle tail (coalesced frames): ≥2px vs tracked, 10ms after settle.
  now.mockReturnValue(1160)
  targetRef.current = 720
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  expect(el!.classList.contains('auto-height-animating')).toBe(false)
  now.mockReturnValue(1400)
  targetRef.current = 800
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('720px')
  expect(el!.classList.contains('auto-height-animating')).toBe(true)
})

it('swallows the settle tail however late its delivery lands', () => {
  // The tail's ResizeObserver delivery is one rendering step behind the
  // settle — and under a long task (a large transcript render) that step can
  // land far behind. A wall-clock window expires and the tail slips through
  // as the exact catch-up tween this hook must never run; the stand-down is
  // a one-shot latch per settle, consumed by whenever the observation comes.
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const targetRef = { current: 500 }
  let el: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  render(
    <ObservedHarness
      targetRef={targetRef}
      onReady={(e, c) => {
        el = e
        contentEl = c
      }}
    />,
  )
  const folding = document.createElement('div')
  contentEl!.appendChild(folding)
  setCollapseAnimating(folding, true)
  targetRef.current = 700
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  now.mockReturnValue(1050)
  setCollapseAnimating(folding, false)
  // The tail arrives seconds later (long task in between).
  now.mockReturnValue(5000)
  targetRef.current = 720
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('')
  expect(el!.classList.contains('auto-height-animating')).toBe(false)
  // The latch is spent: the next discrete change animates from the tracked 720.
  now.mockReturnValue(5200)
  targetRef.current = 800
  act(() => fireResize(contentEl!))
  expect(el!.style.height).toBe('720px')
  expect(el!.classList.contains('auto-height-animating')).toBe(true)
})