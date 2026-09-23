/** Clamp `value` into `[min, max]`.
 *
 *  The single home for the `Math.max(min, Math.min(max, value))` ladder that
 *  was previously inlined across ~25 call sites. NOTE: only equivalent to
 *  the idiom when the operands are in the same positions — expressions like
 *  `Math.min(x, Math.max(0, hi))` (no floor for negative x) or
 *  `Math.min(a, b)` (two-value pick) are NOT clamps and must not be
 *  migrated. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
