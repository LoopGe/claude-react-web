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

export function prepareFlip(selector: string, keyAttr: string): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}
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

/** Group reorder FLIP — animates both the sidebar's top pill row (horizontal
 *  slide) and the grouped section list (vertical slide) in one pass. Same
 *  contract as `prepareFlip`: call before mutating `groups`, run the returned
 *  function right after. */
export function prepareGroupFlip(): () => void {
  const animatePills = prepareFlip('[data-group-pill-id]', 'data-group-pill-id')
  const animateSections = prepareFlip('[data-group-section-id]', 'data-group-section-id')
  return () => {
    animatePills()
    animateSections()
  }
}
