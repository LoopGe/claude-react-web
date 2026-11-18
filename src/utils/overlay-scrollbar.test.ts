// @vitest-environment happy-dom
// overlay-scrollbar.ts touches the real DOM (appendChild, MutationObserver,
// getComputedStyle), so it needs a DOM even though src/utils defaults to node.
import { describe, it, expect } from 'vitest'
import { attachOverlayScrollbar } from './overlay-scrollbar'

/** The file's single DOMRect-shaped stub factory. happy-dom does no real
 *  layout, so every rect is an instance override. The drag tests deliberately
 *  pass left ≠ top — the discriminating fact for the drag formula reading the
 *  track origin on the pointer's own axis. */
const dragRect = (left: number, top: number, width: number, height: number) => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {},
})

/** Stub the geometry reads syncTrackBox/updateAxis rely on. `elTop` stands in
 *  for el's border-box top within the parent — the value a running CSS
 *  transform (entrance animation) temporarily inflates. */
function stubGeometry(parent: HTMLElement, el: HTMLElement, elTop: () => number) {
  parent.getBoundingClientRect = () => dragRect(0, 0, 300, 200)
  el.getBoundingClientRect = () => dragRect(0, elTop(), 300, 150)
  Object.defineProperty(parent, 'clientTop', { value: 0 })
  Object.defineProperty(parent, 'clientLeft', { value: 0 })
  Object.defineProperty(parent, 'clientHeight', { value: 200 })
  Object.defineProperty(parent, 'clientWidth', { value: 300 })
  Object.defineProperty(el, 'clientTop', { value: 1 })
  Object.defineProperty(el, 'clientLeft', { value: 0 })
  Object.defineProperty(el, 'clientHeight', { value: 150 })
  Object.defineProperty(el, 'clientWidth', { value: 300 })
  Object.defineProperty(el, 'scrollHeight', { value: 400 })
  Object.defineProperty(el, 'scrollTop', { value: 0, writable: true })
}

const flushFrame = async () => {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  await new Promise<void>((r) => setTimeout(r, 0))
}

/** Shared scaffolding for the thumb-drag tests: a 300×150 scroller with
 *  300px of overflow on each enabled axis, a track rect whose left ≠ top
 *  (the discriminating fact for the axis-correct origin), and a thumb rect
 *  stubbed at its rendered position for the initial scroll — the drag reads
 *  that rendered leading edge for the grab offset. `initialScroll` applies
 *  to the drag axis ('both' drags horizontal). */
async function setupDrag(orientation: 'vertical' | 'horizontal' | 'both', initialScroll = 0) {
  const axis = orientation === 'vertical' ? 'vertical' : 'horizontal'
  const horizontal = axis === 'horizontal'
  const parent = document.createElement('div')
  const el = document.createElement('div')
  parent.appendChild(el)
  parent.getBoundingClientRect = () => dragRect(0, 0, 300, 200)
  el.getBoundingClientRect = () => dragRect(0, 0, 300, 150)
  Object.defineProperty(el, 'clientWidth', { value: 300 })
  Object.defineProperty(el, 'clientHeight', { value: 150 })
  Object.defineProperty(el, 'scrollWidth', { value: orientation === 'vertical' ? 300 : 600, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { value: orientation === 'horizontal' ? 150 : 450, configurable: true })
  Object.defineProperty(el, horizontal ? 'scrollLeft' : 'scrollTop', { value: initialScroll, writable: true })

  const controller = attachOverlayScrollbar(el, { orientation, autoHide: 'never' })
  const track = parent.querySelector<HTMLElement>(`.os-track-${axis}`)!
  const thumb = track.querySelector<HTMLElement>('.os-thumb')!
  track.getBoundingClientRect = () => horizontal ? dragRect(100, 500, 300, 6) : dragRect(100, 500, 6, 150)
  // Thumb 150 = 300/600 × 300 (horizontal), 50 = 150/450 × 150 (vertical);
  // travel 150 / 100, maxScroll 300 on the drag axis.
  const thumbSize = horizontal ? 150 : 50
  Object.defineProperty(thumb, horizontal ? 'offsetWidth' : 'offsetHeight', { value: thumbSize })
  const travel = (horizontal ? 300 : 150) - thumbSize
  const thumbPos = (initialScroll / 300) * travel
  thumb.getBoundingClientRect = () => horizontal
    ? dragRect(100 + thumbPos, 500, thumbSize, 6)
    : dragRect(100, 500 + thumbPos, 6, thumbSize)
  await flushFrame()

  const ev = (type: string, pos: number) => new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, button: 0,
    clientX: horizontal ? pos : 103,
    clientY: horizontal ? 503 : pos,
  })
  return { el, parent, thumb, ev, controller }
}

describe('attachOverlayScrollbar', () => {
  it('keeps the native-scrollbar hide across a React className rewrite and cleans up on destroy', () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)

    const controller = attachOverlayScrollbar(el, { autoHide: 'never' })
    expect(el.hasAttribute('data-os-native-hidden')).toBe(true)

    // Simulate React rewriting className from its own template (e.g. the
    // sidebar's entrance class dropping after the stagger window). React
    // wholesale-replaces className on the element it owns, but never touches
    // data-* attributes it does not manage — so the hide survives without an
    // observer to re-assert it. (A class-based hide would be clobbered here,
    // which is the double-scrollbar bug this guards against.)
    el.className = 'session-list'
    expect(el.hasAttribute('data-os-native-hidden')).toBe(true)

    controller.destroy()
    expect(el.hasAttribute('data-os-native-hidden')).toBe(false)

    // No observer lingers to resurrect the hide after teardown.
    el.className = 'session-list'
    expect(el.hasAttribute('data-os-native-hidden')).toBe(false)
  })

  it('resyncs track geometry when a CSS animation on el settles (animationend)', async () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)

    // Mid-entrance-transform: el sits 20px down instead of its settled 16px
    // (overlay-panel-in displaces the rect without resizing the box, so the
    // attach-time sync — and its rAF — sample the transform mid-flight).
    let elTop = 20
    stubGeometry(parent, el, () => elTop)

    const controller = attachOverlayScrollbar(el, { autoHide: 'never' })
    const track = parent.querySelector<HTMLElement>('.os-track-vertical')!
    expect(track).not.toBeNull()
    // Drain the attach-time update and its rAF so the assertions below measure
    // only event-driven behavior, not the initial sync racing the test.
    await flushFrame()
    // Attach-time sample reflects the displaced rect (top = elTop + border 1).
    expect(track.style.top).toBe('21px')

    // The transform settles (animation end), then the event fires. Nothing
    // resized el, so without an explicit resync the frozen sample would stand
    // forever — and a frozen top past the parent's scroll edge materialises a
    // native scrollbar on an overflow-y: auto parent (the tasks-overlay bug).
    elTop = 16
    el.dispatchEvent(new Event('animationend', { bubbles: true }))
    await flushFrame()
    expect(track.style.top).toBe('17px')

    // Same for a transform TRANSITION settling: rect moves, box doesn't.
    elTop = 24
    const te = new Event('transitionend', { bubbles: true }) as TransitionEvent
    Object.defineProperty(te, 'propertyName', { value: 'transform' })
    el.dispatchEvent(te)
    await flushFrame()
    expect(track.style.top).toBe('25px')

    // EVERY transitionend settles into a resync — no property allowlist. The
    // individual translate/rotate/scale properties, inset, and margin all move
    // a rect without resizing the box, and an allowlist silently misses future
    // ones. The cost of unfiltered events is one rAF-coalesced update per
    // settle (the same price as a scroll tick); the module's own writes cannot
    // feed back into a loop because update() never writes a transitioned
    // property — the thumb's opacity fade terminates on its own.
    elTop = 40
    const st = new Event('transitionend', { bubbles: true }) as TransitionEvent
    Object.defineProperty(st, 'propertyName', { value: 'scale' })
    el.dispatchEvent(st)
    await flushFrame()
    expect(track.style.top).toBe('41px')

    elTop = 50
    const ct = new Event('transitionend', { bubbles: true }) as TransitionEvent
    Object.defineProperty(ct, 'propertyName', { value: 'background-color' })
    el.dispatchEvent(ct)
    await flushFrame()
    expect(track.style.top).toBe('51px')

    controller.destroy()
  })

  it('resyncs when the animation is on the PARENT (the animated overlay card around a nested scroller)', async () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)
    let elTop = 20
    stubGeometry(parent, el, () => elTop)

    // GitPanel-shaped: overlay-panel-in runs on the CARD (parent); el is a
    // nested .git-panel-scroll. The card's animationend bubbles UPWARD, so it
    // can never pass through a listener mounted on the descendant.
    const controller = attachOverlayScrollbar(el, { autoHide: 'never' })
    const track = parent.querySelector<HTMLElement>('.os-track-vertical')!
    await flushFrame()
    expect(track.style.top).toBe('21px')

    elTop = 16
    parent.dispatchEvent(new Event('animationend', { bubbles: true }))
    await flushFrame()
    expect(track.style.top).toBe('17px')

    controller.destroy()
  })

  it('resyncs when the entrance animation is cancelled mid-flight (animationcancel)', async () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)
    let elTop = 20
    stubGeometry(parent, el, () => elTop)

    // A class rewrite or data-state flip can cancel the running entrance
    // before it ends — no animationend will ever fire for it, so the cancel
    // itself must trigger the resync or the mid-flight sample stands forever.
    const controller = attachOverlayScrollbar(el, { autoHide: 'never' })
    const track = parent.querySelector<HTMLElement>('.os-track-vertical')!
    await flushFrame()
    expect(track.style.top).toBe('21px')

    elTop = 16
    el.dispatchEvent(new Event('animationcancel', { bubbles: true }))
    await flushFrame()
    expect(track.style.top).toBe('17px')

    // Same for a cancelled TRANSITION on the parent — transitioncancel, the
    // event a browser fires instead of transitionend when an interrupted
    // transition never reaches its end value.
    elTop = 24
    parent.dispatchEvent(new Event('transitioncancel', { bubbles: true }))
    await flushFrame()
    expect(track.style.top).toBe('25px')

    controller.destroy()
  })

  // Regression: the shared thumb-drag handler subtracted trackRect.top on
  // BOTH axes. A horizontal drag's pointer coordinate is clientX, so the
  // track's viewport Y (hundreds of px down in any real panel) entered the X
  // math: rel went negative everywhere inside the track, clamped to 0, and
  // the horizontal thumb could never be dragged off the left edge (measured
  // live in the GitPanel diff preview: a 300px drag left scrollLeft at 0).
  // left ≠ top in the stubbed track rect is the discriminating fact — the
  // buggy formula subtracts top. Reverting the fix fails this test.
  it('dragging the horizontal thumb maps pointer X through the track LEFT edge to scrollLeft', async () => {
    const { el, thumb, ev, controller } = await setupDrag('horizontal')
    // Grab the thumb center (rendered 100..250, center 175 → grabOffset 75),
    // drag to 250: thumbPos = 250 − 100 − 75 = 75 → scrollLeft 150 of 300.
    thumb.dispatchEvent(ev('pointerdown', 175))
    thumb.dispatchEvent(ev('pointermove', 250))
    expect(el.scrollLeft).toBe(150)
    // Past the right edge clamps to the full range, not past it.
    thumb.dispatchEvent(ev('pointermove', 400))
    expect(el.scrollLeft).toBe(300)
    // Left of the track clamps back to 0 — the negative regime the original
    // axis bug lived in.
    thumb.dispatchEvent(ev('pointermove', 50))
    expect(el.scrollLeft).toBe(0)
    thumb.dispatchEvent(ev('pointerup', 50))
    controller.destroy()
  })

  // Regression: the drag formula centered the thumb under the pointer
  // (subtracting thumbSize/2) instead of preserving the grab offset. For a
  // wide thumb — a diff preview's thumb is most of the track, half-width
  // larger than the whole travel — a LEFT-edge grab dead-zoned until the
  // pointer moved thumbSize/2, and a RIGHT-edge grab teleported to the far
  // end on the first move. The thumb must follow the pointer by the offset
  // recorded at pointerdown.
  it('grabbing the horizontal thumb at its LEFT edge scrolls from the first pixel', async () => {
    const { el, thumb, ev, controller } = await setupDrag('horizontal')
    // Thumb spans track 100..250 at scrollLeft 0. Grab its LEFT edge (100):
    // a 10px move is 10/150 of the travel → scrollLeft 20 of 300, not 0.
    thumb.dispatchEvent(ev('pointerdown', 100))
    thumb.dispatchEvent(ev('pointermove', 110))
    expect(el.scrollLeft).toBe(20)
    // The full range stays reachable from a left-edge grab.
    thumb.dispatchEvent(ev('pointermove', 175))
    expect(el.scrollLeft).toBe(150)
    thumb.dispatchEvent(ev('pointerup', 175))
    controller.destroy()
  })

  it('grabbing the horizontal thumb at its RIGHT edge does not jump on the first move', async () => {
    const { el, thumb, ev, controller } = await setupDrag('horizontal')
    // Grab the RIGHT edge (250) and hold still: the scroll must not move.
    thumb.dispatchEvent(ev('pointerdown', 250))
    thumb.dispatchEvent(ev('pointermove', 250))
    expect(el.scrollLeft).toBe(0)
    // Dragging to the track's right end (400) reaches the full range.
    thumb.dispatchEvent(ev('pointermove', 400))
    expect(el.scrollLeft).toBe(300)
    thumb.dispatchEvent(ev('pointerup', 400))
    controller.destroy()
  })

  it('measures the grab offset from the thumb RENDERED position when the drag starts mid-scroll', async () => {
    // initialScroll 150 → rendered thumbPos 75: the thumb spans 175..325.
    const { el, thumb, ev, controller } = await setupDrag('horizontal', 150)
    // Grab at 200 = 25px into the thumb. A 10px move → thumbPos 85 →
    // scrollLeft 85/150 × 300 = 170.
    thumb.dispatchEvent(ev('pointerdown', 200))
    thumb.dispatchEvent(ev('pointermove', 210))
    expect(el.scrollLeft).toBe(170)
    thumb.dispatchEvent(ev('pointerup', 210))
    controller.destroy()
  })

  // Control for the other axis of the same shared drag formula: vertical
  // pointer Y goes through trackRect.top. Pins the fix from over-correcting.
  it('dragging the vertical thumb maps pointer Y through the track top edge to scrollTop', async () => {
    const { el, thumb, ev, controller } = await setupDrag('vertical')
    // Grab the thumb center (track top 500 + thumb 50/2 → grabOffset 25),
    // drag 50px down: thumbPos = 575 − 500 − 25 = 50 → scrollTop 150 of 300.
    thumb.dispatchEvent(ev('pointerdown', 525))
    thumb.dispatchEvent(ev('pointermove', 575))
    expect(el.scrollTop).toBe(150)
    thumb.dispatchEvent(ev('pointerup', 575))
    controller.destroy()
  })

  it('recomputes the scroll range mid-drag when content grows (streaming)', async () => {
    const { el, thumb, ev, controller } = await setupDrag('horizontal')
    thumb.dispatchEvent(ev('pointerdown', 175)) // grabOffset 75
    // Content grows while held: maxScroll 300 → 600. The drag maps through
    // the pointerdown travel (150) but the RANGE is fresh: thumbPos 75 →
    // 75/150 × 600 = 300, not the frozen-range 150. (happy-dom fires no
    // scroll events, so updateAxis does not re-render mid-drag here; the
    // rendered-thumb consistency of a real streaming drag is untested.)
    Object.defineProperty(el, 'scrollWidth', { value: 900 })
    thumb.dispatchEvent(ev('pointermove', 250))
    expect(el.scrollLeft).toBe(300)
    thumb.dispatchEvent(ev('pointerup', 250))
    controller.destroy()
  })

  it("orientation 'both' renders both tracks and a horizontal drag leaves the vertical axis alone", async () => {
    const { el, parent, thumb, ev, controller } = await setupDrag('both')
    expect(parent.querySelector('.os-track-vertical')).not.toBeNull()
    expect(parent.querySelector('.os-track-horizontal')).not.toBeNull()
    thumb.dispatchEvent(ev('pointerdown', 175))
    thumb.dispatchEvent(ev('pointermove', 250))
    expect(el.scrollLeft).toBe(150)
    expect(el.scrollTop).toBe(0)
    thumb.dispatchEvent(ev('pointerup', 250))
    controller.destroy()
  })

  it('stops resyncing after destroy (animationend listener removed)', async () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)
    let elTop = 20
    stubGeometry(parent, el, () => elTop)

    const controller = attachOverlayScrollbar(el, { autoHide: 'never' })
    const track = parent.querySelector<HTMLElement>('.os-track-vertical')!
    await flushFrame() // drain the attach-time update + rAF
    controller.destroy()

    elTop = 16
    el.dispatchEvent(new Event('animationend', { bubbles: true }))
    parent.dispatchEvent(new Event('animationend', { bubbles: true }))
    el.dispatchEvent(new Event('animationcancel', { bubbles: true }))
    parent.dispatchEvent(new Event('animationcancel', { bubbles: true }))
    el.dispatchEvent(new Event('transitioncancel', { bubbles: true }))
    parent.dispatchEvent(new Event('transitioncancel', { bubbles: true }))
    await flushFrame()
    expect(track.style.top).toBe('21px') // frozen at the destroy-time sample
  })
})
