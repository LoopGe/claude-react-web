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
 *
 * Starting a fold ALSO releases the pinned heights of that body's ancestors —
 * AnimatedCollapse does that from its own animateHeight, before every height it
 * writes (see releaseAncestorCollapsePins for why a pinned ancestor turns a
 * nested fold into a one-frame dip of the content below it).
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

/** Drop the pinned height of every collapse body ABOVE `el`.
 *
 *  A pinned ancestor body is a COPY of its content's height, written by that
 *  ancestor's own ResizeObserver — i.e. one RO broadcast AFTER this fold wrote
 *  its per-frame height. Anything that compensates from box observations reads
 *  those boxes in the same broadcast, so it can only ever compensate the
 *  PREVIOUS frame's geometry: every frame of a fold nested inside a pinned body
 *  paints the content below it one growth-step low, then snaps back on the next
 *  frame. Measured live on a ToolGroupCard's result row (a nested collapse
 *  inside the group's pinned body): the assistant card below the group was
 *  painted 115-132px lower on the fold's steep frames and 15/7/4/2px on its
 *  tail. Released, the ancestor's box tracks its content in the SAME layout pass
 *  as the fold's height write — the phase the compensation needs.
 *
 *  Two ancestors are deliberately left alone:
 *  - one that is itself animating: its tween owns that pin and rewrites it
 *    every frame anyway;
 *  - one that is folded (`0px`): that pin is the fold, not a copy of its
 *    content, and a search-forced result row can open inside a folded group —
 *    releasing it there would spill the folded card open. Nothing needs
 *    relaying while it is shut.
 *
 *  The released body stays unpinned: the same resting state `standDown` leaves
 *  (an unpinned body's own box already equals its content, so the observer has
 *  nothing to detect), and the next fold cycle pins it again. */
export function releaseAncestorCollapsePins(el: HTMLElement): void {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (!node.classList.contains('animated-collapse')) continue
    if (animatingBodies.has(node)) continue
    if (node.style.height === '') continue
    // A folded (0px) body clips everything inside it, so nothing above this
    // point can move and there is nothing to relay: STOP here rather than
    // un-pinning unrelated bodies further up the chain (a group body above a
    // folded subagent details, say) — their content cannot change while the
    // inner fold is clipped to zero.
    if (node.style.height === '0px') break
    node.style.height = ''
  }
}
