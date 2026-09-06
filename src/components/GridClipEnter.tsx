import {
  type AnimationEvent as ReactAnimationEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/** How long past the CSS reveal before the `-entering` class is force-cleared
 *  as a fallback. Slight buffer so the precise `animationend` path normally
 *  wins; the fallback only fires when the animation is suppressed (e.g.
 *  prefers-reduced-motion) or never delivers its end event. */
const FALLBACK_MS = 160

/** Read `--motion-duration-moderate` (the reveal's duration) from the theme
 *  so the fallback cleanup tracks CSS edits instead of hardcoding 240ms. */
const revealDurationMs = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-moderate')
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 240
}

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
 *
 * The `-entering` class is stripped on `animationend` (precise, no timer to
 * desynchronize from `--motion-duration-moderate`), with a timeout fallback
 * that clears it even when the animation never runs — e.g. `prefers-reduced-
 * motion` sets `animation: none`, so `animationend` never fires and the
 * class (and its reveal-only `overflow:hidden`) would otherwise persist,
 * permanently clipping the contained button's focus ring.
 */
export function GridClipEnter({ entering, children }: { entering: boolean; children: ReactNode }) {
  // Seed from `entering` (like ToolResultSection) so a row that mounts AFTER
  // the parent's arrival gate already armed — entering true at first render —
  // shows the reveal from its very first frame instead of missing it. The
  // transition below then still catches the enter-after-mount ordering.
  const [revealing, setRevealing] = useState(entering)
  const prevEnteringRef = useRef(entering)

  useLayoutEffect(() => {
    if (entering && !prevEnteringRef.current) setRevealing(true)
    prevEnteringRef.current = entering
  }, [entering])

  // Fallback cleanup: once revealing, schedule clearing the class after the
  // reveal duration + buffer. On the normal path `animationend` clears it
  // first and this effect's cleanup cancels the timer, so there is no extra
  // setState; the timer only fires when the animation is suppressed and never
  // delivers an end event.
  useEffect(() => {
    if (!revealing) return
    const timer = window.setTimeout(() => setRevealing(false), revealDurationMs() + FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [revealing])

  const handleAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.animationName === 'grid-clip-reveal') {
      setRevealing(false)
    }
  }

  return (
    <div
      className={`grid-clip-enter${revealing ? ' grid-clip-entering' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="grid-clip-enter-inner">{children}</div>
    </div>
  )
}