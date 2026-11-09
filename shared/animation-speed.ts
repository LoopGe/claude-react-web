/**
 * Global animation speed — a 4-step setting (slow / standard / fast / off)
 * that paces the app's motion. It is the sibling of the font-size
 * (`--fs-scale`), transcript-spacing (`--chat-row-gap`) and message
 * text-density (`--md-*`) presets, but controls MOTION rather than size or
 * spacing.
 *
 * Two channels are driven from this one setting:
 *  - CSS: every `var(--motion-duration-*)` consumer, scaled through the
 *    single inline token write in src/utils/motion-preference-dom.ts (called
 *    from an App.tsx effect);
 *  - JS/motion: the app-level motion gate in src/utils/reduced-motion.ts
 *    (`setAppMotionOff`). `off` is folded into `motionSuppressed()` so the
 *    framer-motion hooks, FLIP, WAAPI and reveal helpers all snap. The CSS
 *    writer (`applyAnimationSpeedToDocument`) additionally mirrors `off` as
 *    `data-motion="off"` on <html>, which the stylesheet uses to suppress the
 *    remaining hardcoded decorative animations.
 *
 * The framer-motion (motion/react) animations in src/utils/transitions.ts and
 * src/utils/flip.ts pass numeric durations to motion's `transition` prop (not
 * CSS variables), so the token write alone cannot pace them — the motion gate
 * is the second half of the contract. The three non-off presets still do not
 * scale those numeric durations (they carry their own "keep in sync with
 * tokens.css" contract); only `off` affects them, by forcing duration 0.
 *
 * Unlike font-size (which scales via one `calc(base * var(--fs-scale))`
 * factor), the motion durations cannot be wrapped in a `calc()`: two JS
 * consumers read `--motion-duration-moderate` numerically via
 * `parseFloat(getComputedStyle(...).getPropertyValue(...))` (MessageList's
 * panel-unhide sweep and useRevealClass's cleanup fallback), and a custom
 * property's computed value substitutes `var()` but never evaluates `calc()`,
 * so `parseFloat` would see `calc(...)` and read NaN. The document writer
 * therefore resolves the base values below through resolveMotionDurationMs()
 * and writes the FINAL `'NNNms'` inline on <html> (mirroring how
 * `--chat-row-gap` is applied), so CSS transitions and those JS readers
 * observe the same scaled duration.
 *
 * Only duration changes — easing curves and travel distances are untouched, so
 * a slower/faster setting never distorts the motion language, only its pace.
 * `prefers-reduced-motion` wins over the paced presets (App.tsx skips the
 * write entirely, and the per-element reduced-motion blocks snap
 * independently). The Off preset still writes 0.01ms under the OS query, so
 * the tokens stay correct if the query later clears.
 *
 * Order in the array is the display order for the settings segmented control.
 */

export type AnimationSpeedPreset = 'slow' | 'standard' | 'fast' | 'off'

export const ANIMATION_SPEED_PRESETS: readonly AnimationSpeedPreset[] = [
  'slow',
  'standard',
  'fast',
  'off',
]

/** Preset the app ships with when nothing is configured. Standard = scale 1,
 *  i.e. the current hardcoded duration values. */
export const DEFAULT_ANIMATION_SPEED: AnimationSpeedPreset = 'standard'

/** Unitless multiplier each PACED preset applies to every
 *  --motion-duration-* token. `off` is deliberately absent: it does not scale
 *  to 0ms (which would never fire `transitionend`) but resolves to
 *  OFF_MOTION_DURATION_MS through resolveMotionDurationMs(). */
export const ANIMATION_SPEED_SCALE: Record<Exclude<AnimationSpeedPreset, 'off'>, number> = {
  slow: 1.5,
  standard: 1,
  fast: 0.6,
}

/** Human-facing labels for the settings segmented control. */
export const ANIMATION_SPEED_LABELS: Record<AnimationSpeedPreset, string> = {
  slow: 'Slow',
  standard: 'Standard',
  fast: 'Fast',
  off: 'Off',
}

/** Duration used for every --motion-duration-* token under `off`. Not 0ms:
 *  a zero-duration transition never starts and never fires `transitionend`,
 *  which a few flows still observe. 0.01ms matches the value the stylesheets'
 *  `@media (prefers-reduced-motion)` blocks already use for the same reason. */
export const OFF_MOTION_DURATION_MS = 0.01

/** Resolve one token's runtime ms value for a preset. `off` collapses to the
 *  near-zero sentinel; the other presets scale the base duration. */
export function resolveMotionDurationMs(baseMs: number, preset: AnimationSpeedPreset): number {
  if (preset === 'off') return OFF_MOTION_DURATION_MS
  return Math.round(baseMs * ANIMATION_SPEED_SCALE[preset])
}

/** Base ms of each --motion-duration-* token — mirrors the `:root` defaults in
 *  src/styles/tokens.css (those are the pre-mount fallback; once App's effect
 *  runs, the inline write is the runtime authority). resolveMotionDurationMs()
 *  scales these and applyAnimationSpeedToDocument() writes the final value
 *  inline on <html> (see the module doc above for why the durations are set
 *  inline rather than scaled via `calc()`). Pinned to tokens.css by
 *  animation-speed.test.ts. */
export const MOTION_DURATION_TOKENS: ReadonlyArray<{ token: string; baseMs: number }> = [
  { token: '--motion-duration-instant', baseMs: 80 },
  { token: '--motion-duration-fast', baseMs: 120 },
  { token: '--motion-duration-base', baseMs: 180 },
  { token: '--motion-duration-moderate', baseMs: 240 },
  { token: '--motion-duration-slow', baseMs: 320 },
  { token: '--motion-duration-panel-enter', baseMs: 320 },
]

/** Runtime type guard for values read from config.json / the PUT body. */
export function isAnimationSpeedPreset(v: unknown): v is AnimationSpeedPreset {
  return typeof v === 'string' && (ANIMATION_SPEED_PRESETS as readonly string[]).includes(v)
}
