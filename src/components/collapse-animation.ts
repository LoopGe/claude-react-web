/**
 * Registry of AnimatedCollapse bodies with a height animation currently in
 * flight. The `.animating` class is styling; this Set is the QUERYABLE signal
 * for consumers outside that component — the transcript scroll machinery needs
 * "is a fold animating in here" without string-matching internal class names
 * (a silent rename would disable the fold-lockstep compensation with no type
 * error) and without scanning the transcript subtree on every ResizeObserver
 * callback.
 *
 * The Set is maintained at the exact statements that add and remove the class
 * inside AnimatedCollapse, so the two cannot drift apart. Animations are
 * bounded (~240ms, one body per fold), so the registry holds at most a
 * handful of elements.
 */

const animatingBodies = new Set<HTMLElement>()

/** Record a body's animation state. Called by AnimatedCollapse immediately
 *  before/after the matching `classList.add/remove('animating')`. */
export function setCollapseAnimating(el: HTMLElement, animating: boolean): void {
  if (animating) animatingBodies.add(el)
  else animatingBodies.delete(el)
}

/** True when any AnimatedCollapse inside `root` is mid-animation (an
 *  open/close fold or a resize tween). O(animated collapses), not O(subtree). */
export function anyCollapseAnimatingInside(root: ParentNode | null): boolean {
  if (!root || animatingBodies.size === 0) return false
  for (const el of animatingBodies) {
    if (root.contains(el)) return true
  }
  return false
}
