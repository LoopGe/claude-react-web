import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRevealClass } from '../hooks/useRevealClass'
import { tweenGridTrack } from '../utils/grid-track-tween'

/**
 * One-shot grid-clip entrance wrapper (see `.grid-clip-enter` in
 * utilities.css): renders children inside a 1-row grid clip so the row's
 * real box height glides open instead of snapping the surrounding card
 * taller.
 *
 * The clip's height comes from `tweenGridTrack` (rAF, whole CSS px per frame)
 * rather than the CSS `grid-template-rows` keyframe: a fractional track
 * re-phases every glyph below the row every frame — the shimmer reported for a
 * subagent card's child rows. The `-entering` class still supplies the opacity
 * beat, so `useRevealClass`'s `animationend`/fallback lifecycle (and the
 * clip-only `overflow: hidden`) is unchanged.
 *
 * `entering` must come from a `useEnterOnArrival` gate in the PERSISTENT
 * parent (never from this conditionally-mounted wrapper): it must observe
 * the row's null → non-null transition while the parent is already mounted,
 * so the clip plays only on a GENUINE arrival — never on a Virtuoso
 * scroll-back remount, where the row is already present at mount and would
 * otherwise replay the 0fr→1fr fade every time the transcript scrolls
 * through the card (mirrors ToolResultSection's `entering` prop pattern).
 * The class lifecycle (latch, animationend strip, fallback) lives in
 * useRevealClass.
 */
export function GridClipEnter({ entering, children }: { entering: boolean; children: ReactNode }) {
  const { revealing, handleAnimationEnd } = useRevealClass(entering, 'grid-clip-reveal')
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!revealing) return
    const el = outerRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    // Cancel on unmount: a row recycled mid-reveal must not keep an inline track.
    return tweenGridTrack(el, inner)
  }, [revealing])

  return (
    <div
      ref={outerRef}
      className={`grid-clip-enter${revealing ? ' grid-clip-entering' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div ref={innerRef} className="grid-clip-enter-inner">{children}</div>
    </div>
  )
}