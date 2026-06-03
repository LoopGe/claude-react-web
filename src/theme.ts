// Shared accent-colour presets and storage keys.
//
// Imported by both App.tsx (global picker) and SessionList.tsx (per-session
// context-menu picker) so the two stay in sync without duplication.

import type { CSSProperties } from 'react'

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

/** Build a `sessionId → CSSProperties` map for per-session accent overrides.
 *  Used by App.tsx (driving ChatPanel) and SessionList.tsx (driving
 *  SessionCard). Each style sets `--accent` and `--accent-strong` so a
 *  single `style={accentStyle}` on the panel root cascades to every
 *  descendant rule that reads those vars. */
export function buildSessionAccentMap(
  sessionColors: Record<string, string> | undefined,
): Map<string, CSSProperties> {
  const map = new Map<string, CSSProperties>()
  if (!sessionColors) return map
  for (const [id, hex] of Object.entries(sessionColors)) {
    map.set(id, { '--accent': hex, '--accent-strong': accentStrongFor(hex) } as CSSProperties)
  }
  return map
}
