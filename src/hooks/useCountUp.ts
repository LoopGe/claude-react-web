import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMotionSuppressed } from '../utils/reduced-motion'

/**
 * Animate a live number toward a changing `target`, returning the current
 * displayed value each render. Designed for frequently-updating readouts
 * (token rate, running-task counts, usage cost): rather than restarting a
 * tween from the start on every update, it eases from wherever it currently
 * is toward the *latest* target, so bursts of updates read as a smooth
 * chase instead of jumping or strobing.
 *
 * - Renders `target` immediately on first mount (no entrance animation).
 * - Honors motion suppression (OS reduced-motion OR the in-app Animation
 *   speed = Off preset) by snapping straight to the target (deterministic
 *   final state, no frames).
 * - `durationMs` is the tween length per retarget; pass shorter values for
 *   high-frequency (e.g. tok/s) readouts.
 *
 * Returns a raw number; callers round / format (e.g. tokens vs money).
 */
export function useCountUp(target: number, durationMs = 400): number {
  const [value, setValue] = useState(target)
  // Reactive suppression (OS preference OR the in-app Off preset) so the
  // returned value snaps to `target` the moment either source flips rather
  // than waiting for the next tween.
  const reduced = useMotionSuppressed()
  const valueRef = useRef(target)
  const targetRef = useRef(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | null>(null)
  const wasReducedRef = useRef(reduced)

  // Sync state to the destination on the suppression FALLING edge, before
  // paint. While suppressed the render returns `target`, so `value` can stay
  // stale without being visible; but when suppression clears without a target
  // change the next render would read that stale mid-tween value and show a
  // backwards jump before the resumed tween starts. Doing it only at the edge
  // keeps the suppressed path render-free (no setState per target update).
  useLayoutEffect(() => {
    if (wasReducedRef.current && !reduced) {
      setValue(target)
    }
    wasReducedRef.current = reduced
  }, [reduced, target])

  useEffect(() => {
    if (reduced) {
      // Suppressed: no animation. The render-time `reduced ? target : value`
      // returns the destination while this is armed. Pin the refs so the tween
      // resumes from the destination instead of a stale mid-tween position.
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      valueRef.current = target
      targetRef.current = target
      fromRef.current = target
      return
    }

    // Settled guard. `targetRef` alone is not enough: a durationMs change
    // re-runs this effect while the value is still mid-tween, and the effect
    // cleanup has already cancelled the rAF — early-returning there would
    // strand the displayed value partway. Requiring valueRef to actually be
    // at the target keeps that case arming a fresh tween. (The suppression
    // edge pins valueRef to the target, so it exits here in the settled case.)
    if (target === targetRef.current && valueRef.current === target) return
    // Retarget: keep gliding from the current displayed value toward the
    // newest target (don't hop back to a stale starting point).
    fromRef.current = valueRef.current
    targetRef.current = target
    const start = performance.now()

    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1)
      // Ease-out cubic: arrive decelerating (arrival = deceleration).
      const eased = 1 - Math.pow(1 - t, 3)
      const next = fromRef.current + (targetRef.current - fromRef.current) * eased
      valueRef.current = next
      setValue(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [target, durationMs, reduced])

  // Under reduced motion the displayed number is always the destination —
  // no easing, no intermediate frames.
  return reduced ? target : value
}
