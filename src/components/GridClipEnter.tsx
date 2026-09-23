import type { ReactNode } from 'react'
import { useRevealClass } from '../hooks/useRevealClass'

/**
 * One-shot grid-clip entrance wrapper (see `.grid-clip-enter` in
 * utilities.css): renders children inside a 1-row grid clip so the row's
 * real box height glides open instead of snapping the surrounding card
 * taller.
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

  return (
    <div
      className={`grid-clip-enter${revealing ? ' grid-clip-entering' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="grid-clip-enter-inner">{children}</div>
    </div>
  )
}
