/**
 * Global message text density — the `--md-*` / `--msg-pad-*` CSS values exposed
 * to users as a reading-density setting (compact / comfortable / spacious / airy).
 *
 * This is the sibling of `--chat-row-gap` (transcript spacing, which controls
 * vertical rhythm BETWEEN message cards). This one controls the rhythm INSIDE a
 * card: prose line-height, paragraph/heading/list margins, block spacing
 * (code / blockquote / table), and the card's own padding.
 *
 * Every consumer reads these variables at runtime from documentElement, so a
 * chosen preset scales all `.md` prose surfaces (chat bodies, recaps, composer
 * preview, dialogs, plan cards) plus the `.msg` card padding together. The CSS
 * fallbacks equal the `spacious` preset, so an unset value is a no-op — no
 * visual regression when nothing is configured.
 *
 * Order in the array is the display order for the settings segmented control.
 */

export type TextSpacingPreset = 'compact' | 'comfortable' | 'spacious' | 'airy'

export const TEXT_SPACING_PRESETS: readonly TextSpacingPreset[] = [
  'compact',
  'comfortable',
  'spacious',
  'airy',
]

/** Preset the app ships with when nothing is configured. Spacious = current
 *  hardcoded spacing (10/14 card padding, 1.55 line-height, 6px paragraphs). */
export const DEFAULT_TEXT_SPACING: TextSpacingPreset = 'spacious'

/**
 * CSS variables each preset writes to documentElement. Keys are the var name
 * (without `--`), values are ready-to-use CSS tokens. Must stay in sync with
 * the var(...) fallbacks in messages.css / chat.css, which hardcode the
 * `spacious` column.
 */
export const TEXT_SPACING_CSS: Record<TextSpacingPreset, Record<string, string>> = {
  compact: {
    'msg-pad-y': '8px',
    'msg-pad-x': '12px',
    'md-lh-p': '1.4',
    'md-lh-list': '1.35',
    'md-lh-head': '1.2',
    'md-p-mt': '4px',
    'md-p-mb': '4px',
    'md-head-mt': '10px',
    'md-head-mb': '3px',
    'md-list-mt': '4px',
    'md-list-mb': '4px',
    'md-block-mt': '4px',
    'md-block-mb': '4px',
  },
  comfortable: {
    'msg-pad-y': '9px',
    'msg-pad-x': '13px',
    'md-lh-p': '1.47',
    'md-lh-list': '1.42',
    'md-lh-head': '1.25',
    'md-p-mt': '5px',
    'md-p-mb': '5px',
    'md-head-mt': '12px',
    'md-head-mb': '5px',
    'md-list-mt': '5px',
    'md-list-mb': '5px',
    'md-block-mt': '6px',
    'md-block-mb': '6px',
  },
  spacious: {
    'msg-pad-y': '10px',
    'msg-pad-x': '14px',
    'md-lh-p': '1.55',
    'md-lh-list': '1.5',
    'md-lh-head': '1.3',
    'md-p-mt': '6px',
    'md-p-mb': '6px',
    'md-head-mt': '14px',
    'md-head-mb': '6px',
    'md-list-mt': '6px',
    'md-list-mb': '6px',
    'md-block-mt': '8px',
    'md-block-mb': '8px',
  },
  airy: {
    'msg-pad-y': '12px',
    'msg-pad-x': '16px',
    'md-lh-p': '1.7',
    'md-lh-list': '1.65',
    'md-lh-head': '1.4',
    'md-p-mt': '8px',
    'md-p-mb': '8px',
    'md-head-mt': '18px',
    'md-head-mb': '8px',
    'md-list-mt': '8px',
    'md-list-mb': '8px',
    'md-block-mt': '12px',
    'md-block-mb': '12px',
  },
}

/** Human-facing labels for the settings segmented control. */
export const TEXT_SPACING_LABELS: Record<TextSpacingPreset, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  spacious: 'Spacious',
  airy: 'Airy',
}

/** Runtime type guard for values read from config.json / the PUT body. */
export function isTextSpacingPreset(v: unknown): v is TextSpacingPreset {
  return typeof v === 'string' && (TEXT_SPACING_PRESETS as readonly string[]).includes(v)
}