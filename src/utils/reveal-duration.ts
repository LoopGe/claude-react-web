/** Read `--motion-duration-moderate` (the one-shot reveal duration) from the
 *  theme, so both the reveal class's fallback cleanup and the rAF track tween
 *  track CSS edits instead of hardcoding 240ms. */
export const revealDurationMs = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-moderate')
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 240
}