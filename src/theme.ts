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

/** The custom properties a themed chrome container can override per session,
 *  each paired with how its value derives from the session's hex. ONE source for
 *  both sides of the portal boundary: `buildSessionAccentMap` iterates it to
 *  write, `applyPortaledThemeVars` iterates it to copy — so a fourth per-session
 *  property appears on both sides automatically, and reordering cannot land a
 *  value on the wrong property (which positional indexing would allow). */
const ACCENT_VARS = {
  '--accent': (hex: string) => hex,
  '--accent-strong': (hex: string) => accentStrongFor(hex),
  '--on-accent': (hex: string) => onAccentFor(hex),
} as const satisfies Record<string, (hex: string) => string>

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
    const style: Record<string, string> = {}
    for (const [name, derive] of Object.entries(ACCENT_VARS)) style[name] = derive(hex)
    map.set(id, style as CSSProperties)
  }
  return map
}

/** Attribute stamped on the root of every surface that had to be portalled out
 *  of its themed container. ONE seam for all three compensations portalling
 *  forces, so a new floating surface never has to be added to a list of class
 *  names:
 *    * `body.has-bg [data-portaled]` re-declares the wallpaper fill remap
 *      (layout.css) that it left behind with its container,
 *    * `[data-portaled] .os-thumb` keeps the accent-tinted overlay scrollbar
 *      (overlay-scrollbar.css), whose rules were ancestor-scoped,
 *    * and its VALUE is the owning panel's `data-panel-id` ('' when the surface
 *      belongs to the app rather than one panel), which is what lets
 *      `EasterEggGame` tell "clicked a popover of THIS panel" apart from
 *      "clicked out of the panel" — a question DOM ancestry can no longer answer.
 *  Set by `markPortaledSurface` / `applyPortaledThemeVars` (pickers) and by
 *  Overlay's portal branch (dialogs). Canonical hazard statement: layout.css. */
export const PORTAL_MARKER = 'data-portaled'

/** The containers whose subtree a portalled surface leaves, and which may
 *  override the accent triple inline: the frosted chrome (`.chat-panel` /
 *  `.sidebar` / `.main-header` — the same three layout.css re-declares the remap
 *  on) plus `.session-item`, which carries its own `style={accentStyle}` inside
 *  the sidebar. `closest()` takes the nearest, so a card-anchored surface picks
 *  the card's tint rather than the sidebar's absence of one. */
const THEME_CONTAINER_SELECTOR = '.chat-panel, .sidebar, .main-header, .session-item'

/** The panel a surface was opened from, if any — the marker's ownership value. */
const PANEL_SELECTOR = '.chat-panel'

/** Declare `el` as a portalled surface so the `[data-portaled]` compensations
 *  apply, recording which panel owns it (`owner`'s `data-panel-id`, or '' when
 *  the surface is app-level). Called by `applyPortaledThemeVars`, so surfaces
 *  that also override the accent don't have to remember this separately.
 *  When no owner is passed and a value is already stamped, it is PRESERVED: a
 *  picker whose anchor element went detached mid-lifetime (a header chip
 *  re-created by a re-render) would otherwise wipe its ownership — and with it
 *  the EasterEgg "same panel" exemption — back to ''. */
export function markPortaledSurface(el: HTMLElement, owner?: Element | null): void {
  if (owner) {
    el.setAttribute(PORTAL_MARKER, owner.getAttribute('data-panel-id') ?? '')
    return
  }
  if (!el.hasAttribute(PORTAL_MARKER)) el.setAttribute(PORTAL_MARKER, '')
}

/**
 * Carry the container's per-session accent onto a surface portalled out of it.
 *
 * Portalling is not optional for these: they are `position: fixed` with
 * viewport-derived coordinates, and a container's `backdrop-filter` (wallpaper
 * on) or its `entering` transform hijacks the containing block those numbers
 * are read against — see the canonical note in layout.css. The cost is that CSS
 * inheritance follows the DOM tree, so the surface also stops seeing the
 * container's inline `--accent` triple, and a tinted session's popover silently
 * reverts to the global accent.
 *
 * Deliberately reads the container's OWN inline declarations rather than
 * `getComputedStyle`: all three properties are also declared on `:root`
 * (tokens.css), so a computed read never comes back empty — it would snapshot
 * `:root`'s value onto every un-tinted popover too, freezing it at open time
 * where the cascade would have kept tracking theme / accent changes. Inline is
 * exactly "what this container overrides", so an un-tinted container carries
 * nothing and inheritance keeps working on its own.
 *
 * Known limit, accepted for a surface that lives for seconds: the copy is a
 * snapshot taken whenever the calling effect runs (open, and each re-layout),
 * so a session recolor that lands *while* the popover is open shows up on the
 * next re-layout rather than instantly. Re-observing the container would mean a
 * MutationObserver per popover for a transient surface.
 */
export function applyPortaledThemeVars(el: HTMLElement, fromElement: Element | null): void {
  const container = fromElement?.closest<HTMLElement>(THEME_CONTAINER_SELECTOR) ?? null
  // Ownership comes from the panel specifically, not from whichever themed
  // container happened to be nearest (a card's inline tint doesn't make the
  // sidebar the popover's owner).
  markPortaledSurface(el, fromElement?.closest(PANEL_SELECTOR) ?? null)
  if (!container) return
  for (const name of Object.keys(ACCENT_VARS)) {
    const value = container.style.getPropertyValue(name).trim()
    if (value) el.style.setProperty(name, value)
  }
}

// ── Global background image (default/glow skins only) ──────────────────
//
// A host appearance preference on the same footing as the accent colour:
// stored client-side, applied by useBackground() as CSS variables on <html>.
// Only the `default` and `glow` skins expose it (see isBackgroundLocked in
// utils/theme.ts); the branded/a11y skins suppress the effect but preserve
// the stored choice.

export type BackgroundPref =
  | { kind: 'none' }
  | { kind: 'custom'; src: string }     // http(s) URL, or /api/background/files/<uuid>.<ext>

export interface BackgroundSetting {
  pref: BackgroundPref
  /** Chrome-surface translucency, 0..1 — lower = more of the image shows. */
  opacity: number
  /** Chrome frost, 0..BACKGROUND_BLUR_MAX px — how blurred the wallpaper looks
   *  through those surfaces. Optional: prefs saved before this control existed
   *  carry no key and resolve to BACKGROUND_DEFAULT_BLUR. */
  blur?: number
  /** Fill strength of the surfaces *inside* the chrome (message cards, the
   *  composer, code blocks) — 0..1, applied as `--app-surface-alpha`. Separate
   *  from `opacity`, which is the chrome's own fill: one knob for the frame,
   *  one for the content panels. Optional, same pre-feature reasoning as blur. */
  surface?: number
  /** The most recent real `src`, kept across a switch to `none` so that
   *  re-selecting "Custom image" restores the wallpaper instead of dropping it.
   *  A convenience copy only — `pref` remains the sole source of truth for what
   *  is applied, and never holds an empty `src`. */
  lastSrc?: string
}

export const BACKGROUND_KEY = 'claude-react-web:background'
export const BACKGROUND_DEFAULT_OPACITY = 0.85
export const BACKGROUND_OPACITY_MIN = 0
export const BACKGROUND_OPACITY_MAX = 1
export const BACKGROUND_OPACITY_STEP = 0.05

/** Chrome frost strength. The default sits well below the top of the range:
 *  a heavy blur turns the wallpaper into an unreadable smear, so "how frosted"
 *  is a choice the user makes rather than a fixed cost of enabling a backdrop. */
export const BACKGROUND_DEFAULT_BLUR = 12
export const BACKGROUND_BLUR_MIN = 0
export const BACKGROUND_BLUR_MAX = 24
export const BACKGROUND_BLUR_STEP = 1

/** Content-surface fill. The default is deliberately below 1: the whole point
 *  of the knob is that fully opaque cards look pasted onto a wallpaper. Only
 *  takes effect under body.has-bg, so with no wallpaper nothing changes.
 *  Must stay on BACKGROUND_SURFACE_STEP's grid — browsers sanitize an
 *  off-grid range value, which would misreport the applied fill and make the
 *  default unreachable from the slider (pinned by theme.test.ts). */
export const BACKGROUND_DEFAULT_SURFACE = 0.9
export const BACKGROUND_SURFACE_MIN = 0
export const BACKGROUND_SURFACE_MAX = 1
export const BACKGROUND_SURFACE_STEP = 0.05

/** Upper bound on a persisted image reference: the src is injected into an
 *  inline `--app-bg-image: url("…")` on <html>, so it must not be unbounded. */
export const BACKGROUND_SRC_MAX = 4096

/** Server-assigned upload name: `<uuid>.<raster ext>` under this path
 *  (see server/background-routes.ts, which generates it with randomUUID()). */
const BACKGROUND_UPLOAD_NAME
  = /^\/api\/background\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpe?g|png|webp)$/i

/** Is `src` one of OUR uploaded background files? Also the guard on
 *  BackgroundPicker's delete-on-replace fetch: a loose prefix test would let a
 *  dot-segment path through, and the browser normalizes it before the request
 *  leaves — turning a persisted string into an arbitrary same-origin DELETE. */
export function isBackgroundUpload(src: string): boolean {
  return BACKGROUND_UPLOAD_NAME.test(src)
}

/** Is `v` an image reference the background can actually apply — a remote
 *  http(s) URL or one of our own uploads, bounded in length?
 *
 *  This is the single rule for both `pref.src` and `lastSrc`, and the picker's
 *  commit gate enforces the same predicate it persists with. That symmetry is
 *  load-bearing: a value offered to useLocalStorage that its validator rejects
 *  is dropped (see useLocalStorage), so a weaker gate would mean a click that
 *  silently does nothing. */
export function isBackgroundSrc(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > BACKGROUND_SRC_MAX) return false
  return /^https?:\/\//i.test(v) || isBackgroundUpload(v)
}

/** Type-guard for useLocalStorage's `validate` — rejects corrupt /
 *  hand-edited values so a bad localStorage entry collapses to the default.
 *
 *  `custom` always means *has an applicable image* (see isBackgroundSrc).
 *  BackgroundPicker's "Custom image selected, URL not yet supplied" is UI state
 *  held in the component, never a persisted one — a durable half-selection would
 *  outlive the gesture and render a checked radio with nothing behind it. */
export function isBackgroundSetting(v: unknown): v is BackgroundSetting {
  if (!v || typeof v !== 'object') return false
  const s = v as { pref?: unknown; opacity?: unknown; blur?: unknown; surface?: unknown; lastSrc?: unknown }
  if (typeof s.opacity !== 'number' || Number.isNaN(s.opacity)) return false
  if (s.opacity < BACKGROUND_OPACITY_MIN || s.opacity > BACKGROUND_OPACITY_MAX) return false
  // Optional numeric fields: absent is legitimate (a pref saved before the
  // field existed), present must be in range.
  const absentOrInRange = (x: unknown, min: number, max: number) =>
    x === undefined || (typeof x === 'number' && !Number.isNaN(x) && x >= min && x <= max)
  if (!absentOrInRange(s.blur, BACKGROUND_BLUR_MIN, BACKGROUND_BLUR_MAX)) return false
  if (!absentOrInRange(s.surface, BACKGROUND_SURFACE_MIN, BACKGROUND_SURFACE_MAX)) return false
  if (s.lastSrc !== undefined && !isBackgroundSrc(s.lastSrc)) return false
  const p = s.pref as { kind?: unknown; src?: unknown } | null
  if (!p || typeof p !== 'object') return false
  if (p.kind === 'none') return true
  if (p.kind === 'custom') return isBackgroundSrc(p.src)
  return false
}
