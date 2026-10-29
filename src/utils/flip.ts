// Shared FLIP (First-Last-Invert-Play) helper for reorder animations.
//
// Both the session-card reorder and the session-group reorder animate the
// settle after a drag / context-menu Move up-down: capture every element's
// position BEFORE the state change, then — once React commits the new layout
// — translate each element from its old position to its new one. A single
// translate(deltaX, deltaY) covers vertical moves (session cards, grouped
// section wrappers) and horizontal moves (group pills) alike.
//
// Elements are matched by `selector` and keyed by the `keyAttr` attribute;
// keys must be unique per element so a moved element can be matched to its
// old rect even though its DOM order changed. The caller snapshots, mutates
// state, then runs the returned function:
//
//   const animateMove = prepareFlip('[data-foo]', 'data-foo')
//   setState(next)          // React re-renders
//   animateMove()           // rAF → translate old→new
//
// Mirrors the reduced-motion gate and the 180ms / cubic-bezier(.2,.8,.2,1)
// curve used by the session-card FLIP so the motion language stays uniform.

import { prefersReducedMotion } from './reduced-motion'

export function prepareFlip(selector: string, keyAttr: string): () => void {
  if (prefersReducedMotion()) return () => {}
  const before = new Map<string, DOMRect>()
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const id = el.getAttribute(keyAttr)
    if (id) before.set(id, el.getBoundingClientRect())
  }
  return () => {
    window.requestAnimationFrame(() => {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const prev = before.get(el.getAttribute(keyAttr) ?? '')
        if (!prev) continue
        const next = el.getBoundingClientRect()
        const deltaX = prev.left - next.left
        const deltaY = prev.top - next.top
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue
        el.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
        )
      }
    })
  }
}

/** DOM marker on every reorderable nav-strip slot (SortableNode nodeAttrs).
 *  The single spelling shared by the producer (SessionNavStrip) and the
 *  consumers (prepareStripFlip below, and the strip's first-sight mount
 *  pop) — a rename here can't silently orphan the selector. */
export const NAV_ITEM_ID_ATTR = 'data-nav-item-id'

/** Collapsed-sidebar nav strip FLIP — the strip's tab/chip slots
 *  (NAV_ITEM_ID_ATTR on the SortableNode wrapper), the horizontal row. Same
 *  contract as `prepareFlip`. No-op while the strip is unmounted (the
 *  selector matches nothing). */
export function prepareStripFlip(): () => void {
  // Cancel any in-flight focus-pull glide first: prepareFlip reads the
  // before/after rects a frame apart, and a gliding scroller would smear
  // every slot's settle delta with scroll drift. The no-op scrollTo (with
  // no CSS smooth on the scroller) is an instant scroll — it aborts the
  // smooth scrollIntoView mid-flight.
  const scroller = document.querySelector('.session-nav-scroll')
  scroller?.scrollTo(scroller.scrollLeft, scroller.scrollTop)
  return prepareFlip(`[${NAV_ITEM_ID_ATTR}]`, NAV_ITEM_ID_ATTR)
}

/** Group reorder FLIP — animates the sidebar's top pill row (horizontal
 *  slide), the grouped section list (vertical slide), and the collapsed-
 *  sidebar nav strip's chips+tabs (a group move transposes its whole section
 *  across the strip row) in one pass. Same contract as `prepareFlip`: call
 *  before mutating `groups`, run the returned function right after. */
export function prepareGroupFlip(): () => void {
  const animatePills = prepareFlip('[data-group-pill-id]', 'data-group-pill-id')
  const animateSections = prepareFlip('[data-group-section-id]', 'data-group-section-id')
  const animateStrip = prepareStripFlip()
  return () => {
    animatePills()
    animateSections()
    animateStrip()
  }
}
