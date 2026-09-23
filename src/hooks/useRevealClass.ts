import { useEffect, useLayoutEffect, useRef, useState, type AnimationEvent } from 'react'

/** How long past the CSS reveal before the `-enter`-family class is
 *  force-cleared as a fallback. Slight buffer so the precise `animationend`
 *  path normally wins; the fallback only fires when the animation is
 *  suppressed (e.g. prefers-reduced-motion) or never delivers its end event.
 *  Shared by every one-shot reveal (GridClipEnter, ToolGroupCard's member
 *  entrance) so the cleanup schedules can't drift apart. */
const FALLBACK_MS = 160

/** Read `--motion-duration-moderate` (the reveal duration) from the theme so
 *  the fallback cleanup tracks CSS edits instead of hardcoding 240ms. */
export const revealDurationMs = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-moderate')
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 240
}

/**
 * One-shot reveal class latch, shared by the entrance animations that grow a
 * parent box (see `.grid-clip-reveal` / `.tool-group-member-enter` in
 * utilities.css): seeds from `entering` (so a row that mounts AFTER the
 * parent's arrival gate armed shows the reveal from its very first frame),
 * re-arms on a genuine false→true transition, and keeps the class applied
 * across the re-renders that land milliseconds after an arrival — then strips
 * it on `animationend` (precise, no timer to desynchronize from
 * `--motion-duration-moderate`), with a timeout fallback for when the
 * animation never runs (`animation: none` under reduced-motion means
 * `animationend` never fires).
 *
 * `entering` must come from a gate in the PERSISTENT parent (e.g.
 * `useEnterOnArrival`, or ToolGroupCard's mount-seen member count) — never
 * from this hook's host mounting: the whole point is that a Virtuoso
 * scroll-back remount, where the content is already present at mount, does
 * not replay.
 */
export function useRevealClass(
  entering: boolean,
  animationName: string,
): {
  revealing: boolean
  handleAnimationEnd: (event: AnimationEvent<HTMLElement>) => void
} {
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

  const handleAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && event.animationName === animationName) {
      setRevealing(false)
    }
  }

  return { revealing, handleAnimationEnd }
}
