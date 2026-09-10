/**
 * Global transcript spacing — the `--chat-row-gap` CSS value exposed to users
 * as a density setting (compact / comfortable / spacious / airy).
 *
 * Every consumer reads this one value at runtime, so a chosen preset scales
 * message rows, the folded tool-group body, and the floating bottom cards
 * (todo / monitor) together; a manually-chosen preset in config.json just
 * overrides the CSS default of `var(--space-*)`.
 *
 * Order in the array is the display order for the settings segmented control.
 */

export type RowGapPreset = 'compact' | 'comfortable' | 'spacious' | 'airy'

export const ROW_GAP_PRESETS: readonly RowGapPreset[] = [
  'compact',
  'comfortable',
  'spacious',
  'airy',
]

/** Preset the app ships with when nothing is configured. Spacious = 12px. */
export const DEFAULT_ROW_GAP: RowGapPreset = 'spacious'

/** px each preset maps to (mirrors the design-token scale, minus the gaps we
 *  retired when folding spacing into a single value). */
export const ROW_GAP_PX: Record<RowGapPreset, number> = {
  compact: 4,
  comfortable: 8,
  spacious: 12,
  airy: 16,
}

/** Human-facing labels for the settings segmented control. */
export const ROW_GAP_LABELS: Record<RowGapPreset, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  spacious: 'Spacious',
  airy: 'Airy',
}

/** Runtime type guard for values read from config.json / the PUT body. */
export function isRowGapPreset(v: unknown): v is RowGapPreset {
  return typeof v === 'string' && (ROW_GAP_PRESETS as readonly string[]).includes(v)
}