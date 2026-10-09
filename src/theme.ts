// Shared accent-colour presets and storage keys.
//
// Imported by App.tsx / AppearancePanel (global accent picker) and the
// AccentSwatchGrid so every site stays in sync without duplication.

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
 *  Set by `markPortaledSurface` (pickers) and by Overlay's portal branch
 *  (dialogs). Canonical hazard statement: layout.css. */
export const PORTAL_MARKER = 'data-portaled'

/** The panel a surface was opened from, if any — the marker's ownership value. */
export const PANEL_SELECTOR = '.chat-panel'

/** Declare `el` as a portalled surface so the `[data-portaled]` compensations
 *  apply, recording which panel owns it (`owner`'s `data-panel-id`, or '' when
 *  the surface is app-level).
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

// ── Global background image (default/glow skins only) ──────────────────
//
// A host appearance preference on the same footing as the accent colour:
// stored client-side, applied by useBackground() as CSS variables on <html>.
// Only the `default` and `glow` skins expose it (see isBackgroundLocked in
// utils/theme.ts); the branded/a11y skins suppress the effect but preserve
// the stored choice.

/** What kind of file a `custom` src points at. Drives which element renders it
 *  (a CSS background-image vs. a <video>) — the two cannot be swapped at
 *  runtime, so the choice is stored rather than guessed. */
export type BackgroundMedia = 'image' | 'video'

export type BackgroundPref =
  | { kind: 'none' }
  // http(s) URL, or /api/background/files/<uuid>.<ext>. `media` is absent on
  // prefs saved before video existed and then means 'image'.
  | { kind: 'custom'; src: string; media?: BackgroundMedia }

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
   *  re-selecting its media restores the wallpaper instead of dropping it.
   *  A convenience copy only — `pref` remains the sole source of truth for what
   *  is applied, and never holds an empty `src`. */
  lastSrc?: string
  /** The media `lastSrc` belongs to. Stored beside it because a remote URL's
   *  kind cannot be recovered from the string, and restoring an image src into
   *  the video player (or vice versa) would render nothing. Absent means
   *  'image', matching `pref.media`. */
  lastMedia?: BackgroundMedia
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

/** Every container this feature serves, by extension, and the media it belongs
 *  to. ONE table on the client: the upload-name regex and the video-name test
 *  are derived from it, and it is what decides whether a URL's own extension
 *  contradicts the media the user declared for it. Must stay in step with
 *  server/background-routes.ts's ALLOWED_UPLOAD (the server owns what it will
 *  accept and serve; this owns what the client will apply). */
const MEDIA_BY_EXT: Record<string, BackgroundMedia> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  mp4: 'video',
  webm: 'video',
}

// Longest first, so an extension that is a prefix of another can never win.
const EXT_PATTERN = Object.keys(MEDIA_BY_EXT).sort((a, b) => b.length - a.length).join('|')

/** Server-assigned upload name: `<uuid>.<ext>` under this path (see
 *  server/background-routes.ts, which generates it with randomUUID()). */
const BACKGROUND_UPLOAD_NAME = new RegExp(
  `^/api/background/files/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:${EXT_PATTERN})$`,
  'i',
)

/** The media a src's own extension names, or null when it names none we serve.
 *  Only the path is read: a query or fragment (`.mp4#t=5`) is not part of the
 *  name, and `?next=b.mp4` must not be mistaken for one. */
export function mediaOfExtension(src: string): BackgroundMedia | null {
  const path = src.split(/[?#]/, 1)[0]
  const m = /\.([a-z0-9]+)$/i.exec(path)
  if (!m) return null
  const ext = m[1].toLowerCase()
  // `hasOwn` — a bare index walks the prototype chain, so `.constructor` would
  // resolve to the Object function (truthy, and not a media) and be read back
  // as a real extension.
  return Object.hasOwn(MEDIA_BY_EXT, ext) ? MEDIA_BY_EXT[ext] : null
}

/** Is `src` one of OUR uploaded background files — image or video? Also the
 *  guard on BackgroundPicker's delete-on-replace fetch: a loose prefix test
 *  would let a dot-segment path through, and the browser normalizes it before
 *  the request leaves — turning a persisted string into an arbitrary
 *  same-origin DELETE. */
export function isBackgroundUpload(src: string): boolean {
  return BACKGROUND_UPLOAD_NAME.test(src)
}

/** Is `src` one of our video uploads? Used to keep a declared media honest for
 *  files we named ourselves; a remote URL is taken on the user's word. */
export function isBackgroundVideoUpload(src: string): boolean {
  return isBackgroundUpload(src) && mediaOfExtension(src) === 'video'
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
  if (!isUsableSrc(v)) return false
  // Our own video uploads are excluded: an image pref pointing at an .mp4
  // would render a broken background image.
  return isRemoteSrc(v) || (isBackgroundUpload(v) && !isBackgroundVideoUpload(v))
}

/** Is `v` a *video* reference the background can actually play — a remote
 *  http(s) URL (taken on the user's word; only they know what a bare link
 *  serves) or one of our own .mp4/.webm uploads? */
export function isBackgroundVideoSrc(v: unknown): v is string {
  if (!isUsableSrc(v)) return false
  return isRemoteSrc(v) || isBackgroundVideoUpload(v)
}

/** The shape rule both src predicates share: a bounded, non-empty string. */
function isUsableSrc(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= BACKGROUND_SRC_MAX
}

/** Is `v` a remote reference that could actually be fetched? A bare scheme
 *  (`https://`, `https://?a=1`) satisfies a prefix test but resolves to
 *  nothing, so it would commit a checked radio and an "Applied" badge over a
 *  wallpaper that paints nothing. */
function isRemoteSrc(v: unknown): v is string {
  if (!isUsableSrc(v) || !/^https?:\/\//i.test(v)) return false
  try {
    return new URL(v).hostname.length > 0
  } catch {
    return false
  }
}

export function isBackgroundMedia(v: unknown): v is BackgroundMedia {
  return v === 'image' || v === 'video'
}

/** Which media a pref applies as. An absent `media` means 'image' — the shape
 *  written before video existed. ONE definition, because the store's validator,
 *  useBackground's policy and the picker must not be able to disagree about
 *  what a stored pref means: a mismatch there is a checked radio over nothing.
 *
 *  A `none` pref has no media; it reports 'image', which no caller may act on. */
export function mediaOfPref(pref: { kind?: unknown; media?: unknown }): BackgroundMedia {
  return pref.kind === 'custom' && pref.media === 'video' ? 'video' : 'image'
}

/** Does `src` satisfy the contract of the media it is declared as? The picker's
 *  commit gate and the store's validator share this one rule, so a pick the
 *  picker accepts is exactly one the store keeps. */
export function srcMatchesMedia(src: unknown, media: BackgroundMedia): src is string {
  if (media === 'video') {
    if (!isBackgroundVideoSrc(src)) return false
  } else if (!isBackgroundSrc(src)) {
    return false
  }
  // The shape is fine; now check the declaration against the one thing a bare
  // URL does say about itself. Trusting the user past a *contradiction* commits
  // a wallpaper nothing can paint (a .png handed to the <video> element) and
  // reports it as applied. A URL naming no container we know is still theirs to
  // vouch for — only they know what `…/stream?v=1` serves.
  const named = mediaOfExtension(src)
  return named === null || named === media
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
  const s = v as {
    pref?: unknown; opacity?: unknown; blur?: unknown; surface?: unknown
    lastSrc?: unknown; lastMedia?: unknown
  }
  if (typeof s.opacity !== 'number' || Number.isNaN(s.opacity)) return false
  if (s.opacity < BACKGROUND_OPACITY_MIN || s.opacity > BACKGROUND_OPACITY_MAX) return false
  // Optional numeric fields: absent is legitimate (a pref saved before the
  // field existed), present must be in range.
  const absentOrInRange = (x: unknown, min: number, max: number) =>
    x === undefined || (typeof x === 'number' && !Number.isNaN(x) && x >= min && x <= max)
  if (!absentOrInRange(s.blur, BACKGROUND_BLUR_MIN, BACKGROUND_BLUR_MAX)) return false
  if (!absentOrInRange(s.surface, BACKGROUND_SURFACE_MIN, BACKGROUND_SURFACE_MAX)) return false
  if (s.lastMedia !== undefined) {
    // `lastMedia` without a `lastSrc` is half a memory — it can only mislead a
    // restore, so it must not survive a load.
    if (s.lastSrc === undefined || !isBackgroundMedia(s.lastMedia)) return false
    if (!srcMatchesMedia(s.lastSrc, s.lastMedia)) return false
  } else if (s.lastSrc !== undefined && !isBackgroundSrc(s.lastSrc) && !isBackgroundVideoSrc(s.lastSrc)) {
    // A media-less `lastSrc` may still name a video: a pre-video build wrote
    // only this field, and rejecting the whole setting over it would take the
    // applied wallpaper and its tuning down with it. The picker declines to
    // restore a src its row cannot apply, so this cannot become a dead click.
    return false
  }
  const p = s.pref as { kind?: unknown; src?: unknown; media?: unknown } | null
  if (!p || typeof p !== 'object') return false
  if (p.kind === 'none') return true
  if (p.kind === 'custom') {
    // A value we do not know is rejected outright; an absent one falls back to
    // 'image' (mediaOfPref) because that is what pre-video prefs mean. Declared
    // media must also agree with the src: a mismatch renders nothing and is
    // never a state the picker writes, so it must not survive a load.
    if (p.media !== undefined && !isBackgroundMedia(p.media)) return false
    return srcMatchesMedia(p.src, mediaOfPref(p))
  }
  return false
}
