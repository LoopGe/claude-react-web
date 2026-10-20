/**
 * CSS `cubic-bezier()` easing as a JS function — the standard Newton-Raphson /
 * bisection solver (same contract as the CSS timing-function spec: x1/x2 are
 * clamped to [0,1], y1/y2 may exceed).
 *
 * Needed by AnimatedCollapse's per-frame integer height tween: a CSS
 * transition interpolates height at FRACTIONAL px per frame, which re-phases
 * every glyph raster downstream of the animated box (text AA shimmers even
 * when the visual offset is scroll-compensated). Driving the same curve from
 * rAF and rounding each frame's height to whole CSS px keeps every downstream
 * layout position on integer steps, so nothing below the fold ever re-phases.
 */

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  // CSS clamps the x control points to [0,1] (out-of-range inputs render as
  // the clamped curve); matching that here keeps x(t) monotonic so the
  // Newton step and the bisection bracket below stay valid.
  x1 = Math.min(1, Math.max(0, x1))
  x2 = Math.min(1, Math.max(0, x2))
  // Coefficients of the Bézier polynomial per axis: x(t) = ((1-t)²·3x1 + 3t(1-t)·... expanded.
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx

  // Solve x(t) = x for the curve parameter. Newton first (fast, converges for
  // the shallow start of ease-out curves), bisection as the guaranteed floor.
  const solveT = (x: number): number => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x
      if (Math.abs(dx) < 1e-6) return t
      const d = sampleDX(t)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    let lo = 0
    let hi = 1
    t = x
    while (lo < hi) {
      const mid = sampleX(t)
      if (Math.abs(mid - x) < 1e-6) return t
      if (mid < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return t
  }

  if (x1 === y1 && x2 === y2) return (t) => t // linear
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return sampleY(solveT(x))
  }
}

/** The design system's standard ease — tokens.css' `--motion-ease-standard`
 *  (`cubic-bezier(0.22, 1, 0.36, 1)`) as a ready-made solver. One shared
 *  constant so a future token tune can't strand per-file copies of the magic
 *  numbers (dnd/motion.ts carries its own copy of the same curve today; it
 *  should import this when next touched). */
export const easeStandard = cubicBezier(0.22, 1, 0.36, 1)
