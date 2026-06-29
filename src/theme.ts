// Shared accent-colour presets and storage keys.
//
// Imported by both App.tsx (global picker) and SessionList.tsx (per-session
// context-menu picker) so the two stay in sync without duplication.

import type { CSSProperties } from 'react'
import { isAccentLocked, type Skin } from './utils/theme'

/** Each preset carries a main accent and a stronger variant used for
 *  hover / active states. `--accent-strong` falls back to `accent` when
 *  no matching preset is found (e.g. a value loaded from an older build). */
export const ACCENT_COLORS = [
  { name: 'Indigo', accent: '#7b8cde', strong: '#5b6fc7' },
  { name: 'Cyan', accent: '#5ec4d4', strong: '#3ea8b8' },
  { name: 'Teal', accent: '#4db89e', strong: '#339a82' },
  { name: 'Green', accent: '#6cc88b', strong: '#4eaa6e' },
  { name: 'Amber', accent: '#e6b450', strong: '#c89a38' },
  { name: 'Rose', accent: '#e07080', strong: '#c45465' },
  { name: 'Purple', accent: '#a87bde', strong: '#8a5fc7' },
  { name: 'Slate', accent: '#8c94a3', strong: '#6e7685' },
] as const

export const ACCENT_COLOR_KEY = 'claude-react-web:accent-color'
export const SESSION_COLORS_KEY = 'claude-react-web:session-colors'
/** Globally-shared list of recently-used custom accent colours (newest
 *  first). Lets a colour picked via the native colour input survive being
 *  switched away from, so the user can re-select it later without redialing
 *  it in the OS picker. Presets are never stored here (they're always in
 *  the grid). Shared across all three picker sites via useLocalStorage's
 *  same-tab sync. */
export const RECENT_COLORS_KEY = 'claude-react-web:recent-colors'
/** LRU cap on the recent-custom-colours list. Six keeps the popover's
 *  "Recent" row tidy (the grid is five columns) while still being useful. */
export const MAX_RECENT_COLORS = 6

/** Type-guard for the persisted recent-colours array. Rejects anything
 *  that isn't an array of `#rrggbb` strings so a corrupt / hand-edited
 *  localStorage value can't crash the grid renderer. Used as the
 *  `validate` option to useLocalStorage. */
export function isHexColorList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isHexColor)
}

/** True for a 6-digit `#rrggbb` hex string. The native <input type="color">
 *  always emits this canonical form, so we normalise/validate against it. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/** Resolve the `--accent-strong` value (hover / active variant) for any
 *  accent hex. Presets carry a hand-tuned `strong`; arbitrary colours
 *  (from the custom picker) have none, so we derive one by mixing 80% of
 *  the accent with black — the same `color-mix()` the stylesheet already
 *  relies on for message-bubble tints. Returned as a CSS value string,
 *  which is valid for both `style.setProperty` and inline `style`. */
export function accentStrongFor(hex: string): string {
  const preset = ACCENT_COLORS.find((c) => c.accent === hex)
  return preset?.strong ?? `color-mix(in srgb, ${hex} 80%, #000)`
}

/** True when `hex` is one of the built-in presets. Used by the picker to
 *  decide whether the custom-colour swatch should render as active. */
export function isPresetAccent(hex: string): boolean {
  return ACCENT_COLORS.some((c) => c.accent === hex)
}

/** Dark foreground used on top of *light* accents. A near-black that still
 *  reads as "ink" rather than pure #000, matching the app's dark fg tone. */
const ON_ACCENT_DARK = '#15171c'
const ON_ACCENT_LIGHT = '#ffffff'

/** Luminance above which we flip on-accent text from white to dark. The
 *  curated presets top out at ~0.50 (Amber) and have always used white
 *  text; we keep that by biasing toward white and only switching to dark
 *  ink for genuinely *light* accents — where white would be unreadable
 *  (e.g. a near-white custom accent). This fixes the legibility extremes
 *  without recolouring every preset. The black-accent case is already
 *  handled: on-accent stays white there (luminance ~0). */
const ON_ACCENT_LIGHT_LUM_THRESHOLD = 0.55

/** Pick a legible foreground (white or near-black) for text/icons placed on
 *  top of a given accent background. Hardcoding white breaks once the user
 *  dials in an extreme accent — a near-white accent leaves white text
 *  invisible. We compute the accent's WCAG relative luminance and switch to
 *  dark ink only when the accent is light enough that white would fail, so
 *  any accent (preset or custom) stays readable in both themes. */
export function onAccentFor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return ON_ACCENT_LIGHT
  const int = parseInt(m[1], 16)
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = channel((int >> 16) & 0xff)
  const g = channel((int >> 8) & 0xff)
  const b = channel(int & 0xff)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > ON_ACCENT_LIGHT_LUM_THRESHOLD ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
}

/** Build a `sessionId → CSSProperties` map for per-session accent overrides.
 *  Used by App.tsx (driving ChatPanel) and SessionList.tsx (driving
 *  SessionCard). Each style sets `--accent` and `--accent-strong` so a
 *  single `style={accentStyle}` on the panel root cascades to every
 *  descendant rule that reads those vars.
 *
 *  When `skin` locks the accent (Anthropic / HC), returns an empty map:
 *  the per-session inline `--accent` would otherwise be element-level
 *  inline styles that override the skin's locked `--accent` (defined on
 *  `[data-skin="…"]`), defeating the lock visually. Returning nothing
 *  lets the skin's inherited accent cascade through. */
export function buildSessionAccentMap(
  sessionColors: Record<string, string> | undefined,
  skin?: Skin,
): Map<string, CSSProperties> {
  const map = new Map<string, CSSProperties>()
  if (!sessionColors || isAccentLocked(skin)) return map
  for (const [id, hex] of Object.entries(sessionColors)) {
    map.set(id, {
      '--accent': hex,
      '--accent-strong': accentStrongFor(hex),
      '--on-accent': onAccentFor(hex),
    } as CSSProperties)
  }
  return map
}
