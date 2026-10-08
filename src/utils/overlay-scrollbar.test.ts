// @vitest-environment happy-dom
// overlay-scrollbar.ts touches the real DOM (appendChild, MutationObserver,
// getComputedStyle), so it needs a DOM even though src/utils defaults to node.
import { describe, it, expect } from 'vitest'
import { attachOverlayScrollbar } from './overlay-scrollbar'

/** Stub the geometry reads syncTrackBox/updateAxis rely on. happy-dom does no
 *  real layout, so every rect/layout number is an instance override. `elTop`
 *  stands in for el's border-box top within the parent — the value a running
 *  CSS transform (entrance animation) temporarily inflates. */
function stubGeometry(parent: HTMLElement, el: HTMLElement, elTop: () => number) {
  const rect = (top: number, height: number) => ({
    x: 0, y: top, left: 0, top, width: 300, height, right: 300, bottom: top + height, toJSON() {},
  })
  parent.getBoundingClientRect = () => rect(0, 200)
  el.getBoundingClientRect = () => rect(elTop(), 150)
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
