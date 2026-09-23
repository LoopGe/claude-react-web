import { vi } from 'vitest'

// ResizeObserver isn't available in jsdom. Controllable stub — captures each
// callback by observed element so a test can fire it on demand via fireResize
// (which elements were observed stays per-test-file state, cleared with
// clearResizeObserverStub). Never auto-fires, so tests that don't care about
// content growth behave exactly as they would under a no-op stub. Shared by
// AnimatedCollapse.test.tsx and ToolGroupCard.test.tsx — a behavioral fix to
// the stub must land in ONE place.
const roObserved = new Map<Element, Array<() => void>>()

/** Fire the observation callbacks registered for `el` (what a real
 *  ResizeObserver does after a layout change of the observed box). */
export function fireResize(el: Element) {
  for (const cb of roObserved.get(el) ?? []) cb()
}

/** Register the stub globally — call from beforeEach. */
export function stubResizeObserver() {
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
}

/** Drop the observed-element registry — call from afterEach. */
export function clearResizeObserverStub() {
  roObserved.clear()
}
