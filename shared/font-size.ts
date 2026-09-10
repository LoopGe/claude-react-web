/**
 * Global font size — the `--fs-scale` multiplier exposed to users as a
 * 4-step setting (small / standard / large / xlarge). It is the sibling of
 * transcript spacing (`--chat-row-gap`) and message text density (`--md-*`),
 * but controls SIZE rather than SPACING.
 *
 * Every `--fs-*` type-scale token is `calc(base * var(--fs-scale))`, so a
 * single factor rescales the whole app's typography (sidebar, message prose,
 * buttons, panel headers, code blocks, micro-labels) in lockstep. It is
 * application-wide on purpose — not scoped to a panel.
 *
 * Spacing is intentionally unaffected: block margins/line-heights are px or
 * unitless and do not reference `--fs-scale`, so changing font size never
 * warps the layout rhythm controlled by the sibling spacing settings.
 *
 * Order in the array is the display order for the settings segmented control.
 */

export type FontSizePreset = 'small' | 'standard' | 'large' | 'xlarge'

export const FONT_SIZE_PRESETS: readonly FontSizePreset[] = [
  'small',
  'standard',
  'large',
  'xlarge',
]

/** Preset the app ships with when nothing is configured. Standard = scale 1,
 *  i.e. the current hardcoded px values (13px reading baseline). */
export const DEFAULT_FONT_SIZE: FontSizePreset = 'standard'

/** Unitless multiplier each preset applies to the base px of every --fs-* token. */
export const FONT_SIZE_SCALE: Record<FontSizePreset, number> = {
  small: 0.9,
  standard: 1.0,
  large: 1.15,
  xlarge: 1.3,
}

/** Human-facing labels for the settings segmented control. */
export const FONT_SIZE_LABELS: Record<FontSizePreset, string> = {
  small: 'Small',
  standard: 'Standard',
  large: 'Large',
  xlarge: 'X-Large',
}

/** Runtime type guard for values read from config.json / the PUT body. */
export function isFontSizePreset(v: unknown): v is FontSizePreset {
  return typeof v === 'string' && (FONT_SIZE_PRESETS as readonly string[]).includes(v)
}