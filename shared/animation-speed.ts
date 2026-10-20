/**
 * Global animation speed — a 3-step setting (slow / standard / fast) that
 * paces the app's CSS transitions and animations. It is the sibling of the
 * font-size (`--fs-scale`), transcript-spacing (`--chat-row-gap`) and message
 * text-density (`--md-*`) presets, but controls MOTION rather than size or
 * spacing.
 *
 * Scope note: this scales every `var(--motion-duration-*)` consumer. The
 * framer-motion (motion/react) animations in src/utils/transitions.ts and
 * src/utils/flip.ts pass numeric durations to motion's `transition` prop (not
 * CSS variables), so they are NOT paced by this setting — they carry their own
 * "keep in sync with tokens.css" contract.
 *
 * Unlike font-size (which scales via one `calc(base * var(--fs-scale))`
 * factor), the motion durations cannot be wrapped in a `calc()`: two JS
 * consumers read `--motion-duration-moderate` numerically via
 * `parseFloat(getComputedStyle(...).getPropertyValue(...))` (MessageList's
 * panel-unhide sweep and useRevealClass's cleanup fallback), and a custom
 * property's computed value substitutes `var()` but never evaluates `calc()`,
 * so `parseFloat` would see `calc(...)` and read NaN. App.tsx therefore
 * multiplies the base values below by the chosen scale and writes the FINAL
 * `'NNNms'` inline on <html> (mirroring how `--chat-row-gap` is applied), so
 * CSS transitions and those JS readers observe the same scaled duration.
 *
 * Only duration changes — easing curves and travel distances are untouched, so
 * a slower/faster setting never distorts the motion language, only its pace.
 * `prefers-reduced-motion` wins over this setting (App.tsx skips the write
 * entirely, and the per-element reduced-motion blocks snap independently).
 *
 * Order in the array is the display order for the settings segmented control.
 */

export type AnimationSpeedPreset = 'slow' | 'standard' | 'fast'

export const ANIMATION_SPEED_PRESETS: readonly AnimationSpeedPreset[] = [
  'slow',
  'standard',
  'fast',
]

/** Preset the app ships with when nothing is configured. Standard = scale 1,
 *  i.e. the current hardcoded duration values. */
export const DEFAULT_ANIMATION_SPEED: AnimationSpeedPreset = 'standard'

/** Unitless multiplier each preset applies to every --motion-duration-* token. */
export const ANIMATION_SPEED_SCALE: Record<AnimationSpeedPreset, number> = {
  slow: 1.5,
  standard: 1,
  fast: 0.6,
}

/** Human-facing labels for the settings segmented control. */
export const ANIMATION_SPEED_LABELS: Record<AnimationSpeedPreset, string> = {
  slow: 'Slow',
  standard: 'Standard',
  fast: 'Fast',
}

/** Base ms of each --motion-duration-* token — mirrors the `:root` defaults in
 *  src/styles/tokens.css (those are the pre-mount fallback; once App.tsx's
 *  effect runs, this inline write is the runtime authority). App.tsx multiplies
 *  by ANIMATION_SPEED_SCALE and writes the final value inline on <html> (see
 *  the module doc above for why the durations are set inline rather than
 *  scaled via `calc()`). Pinned to tokens.css by animation-speed.test.ts. */
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
