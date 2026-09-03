import { useEffect, useRef, useState } from 'react'

/** True when the user has opted into reduced motion (or matchMedia is
 *  unavailable in a test/SSR env). Mirrors the matchMedia guard pattern in
 *  `useIsMobile` / `utils/theme.ts`. */
/** Resolve a MediaQueryList for the reduced-motion query, or null when
 *  matchMedia is unavailable (jsdom test env, SSR, very old browsers). */
function getMotionMql(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}

function prefersReducedMotion(): boolean {
  return getMotionMql()?.matches ?? false
}

/**
 * Animate a live number toward a changing `target`, returning the current
 * displayed value each render. Designed for frequently-updating readouts
 * (token rate, running-task counts, usage cost): rather than restarting a
 * tween from the start on every update, it eases from wherever it currently
 * is toward the *latest* target, so bursts of updates read as a smooth
 * chase instead of jumping or strobing.
 *
 * - Renders `target` immediately on first mount (no entrance animation).
 * - Honors `prefers-reduced-motion: reduce` by snapping straight to the
 *   target (deterministic final state, no frames).
 * - `durationMs` is the tween length per retarget; pass shorter values for
 *   high-frequency (e.g. tok/s) readouts.
 *
 * Returns a raw number; callers round / format (e.g. tokens vs money).
 */
export function useCountUp(target: number, durationMs = 400): number {
  const [value, setValue] = useState(target)
  // Track reduced-motion reactively (initial from matchMedia, updated on OS
  // change) so the returned value snaps to `target` the moment the user's
  // preference swings rather than waiting for the next tween.
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const valueRef = useRef(target)
  const targetRef = useRef(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const mql = getMotionMql()
    if (!mql) return
    const handler = (e: { matches: boolean }) => setReduced(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (reduced) {
      // Reduced motion: no animation. The render-time `reduced ? target :
      // value` returns the destination while this is armed. Do NOT touch the
      // refs here — the render branch already hides them, and overwriting
      // them would corrupt the resume when reduced flips back off.
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }

    // Resume-when-settled guard. The naive `target === targetRef.current`
    // would early-return after a reduced→normal swing even though the
    // displayed `value` never caught up to the pinned target (the reduced
    // branch stops tweens). Requiring valueRef to actually be at the target
    // re-arms the tween in that case.
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