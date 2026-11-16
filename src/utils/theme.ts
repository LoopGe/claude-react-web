// Theme management — reads/writes the `data-theme` attribute on <html>.
// Theme preference is persisted in localStorage.
//
// Supports three modes: 'dark', 'light', and 'system' (follow OS preference).
// The `data-theme` attribute is always set to 'dark' or 'light' — never 'system'.

export const THEME_KEY = 'claude-react-web:theme'
export const SKIN_KEY = 'claude-react-web:skin'
export const TRANSPARENCY_KEY = 'claude-react-web:transparency'

export type Theme = 'dark' | 'light' | 'system'
export type TransparencyMode = 'glass' | 'no-frost' | 'opaque'

export function isTransparencyMode(value: unknown): value is TransparencyMode {
  return value === 'glass' || value === 'no-frost' || value === 'opaque'
}

/** A "skin" is orthogonal to the light/dark mode: it changes the visual
 *  *feel* (depth, glow, gradients, or — for 'hc' — a VSCode-style high
 *  contrast accessibility treatment) while inheriting the colour tokens of
 *  whichever mode is active. 'default' is the original flat look. */
export type Skin = 'default' | 'glow' | 'anthropic' | 'hc' | 'soft-hc' | 'brutalist'

export function getStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* ignored */ }
  // Default to dark if no preference is stored.
  return 'dark'
}

export function getStoredSkin(): Skin {
  try {
    const v = window.localStorage.getItem(SKIN_KEY)
    if (v === 'default' || v === 'glow' || v === 'anthropic' || v === 'hc' || v === 'soft-hc' || v === 'brutalist') return v
  } catch { /* ignored */ }
  // Default skin keeps the original look for existing users.
  return 'default'
}

/** True for skins that lock the accent colour to a brand value (Anthropic
 *  terracotta / High-Contrast blue / Soft High-Contrast indigo / Brutalist
 *  sticker palette) defined in tokens.css's `[data-skin="…"]` blocks. When
 *  locked, the global accent picker is suppressed and the user's stored
 *  accent is not applied, so the skin's CSS-defined accent wins. Centralised
 *  here so every gating site (AppearancePanel, useTheme) agrees on which
 *  skins lock the accent. */
export function isAccentLocked(skin: Skin | undefined | null): boolean {
  return skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc' || skin === 'brutalist'
}

/** Backgrounds are available only on the expressive skins. The branded /
 *  a11y skins (Anthropic, HC, Soft-HC, Brutalist) stay pristine — kept in
 *  lockstep with the accent lock (same skins) so gating sites agree. */
export function isBackgroundLocked(skin: Skin | undefined | null): boolean {
  return skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc' || skin === 'brutalist'
}

/** Apply a skin by toggling the `data-skin` attribute on <html>. The
 *  'default' skin removes the attribute entirely so the base :root /
 *  [data-theme] rules apply untouched. */
export function applySkin(skin: Skin): void {
  if (skin === 'default') {
    document.documentElement.removeAttribute('data-skin')
  } else {
    document.documentElement.setAttribute('data-skin', skin)
  }
  try {
    window.localStorage.setItem(SKIN_KEY, skin)
  } catch { /* ignored */ }
}

/** Apply the global transparency preference through <html>. Absent = glass
 *  (the historical look); "off" preserves the previous floating-glass-only
 *  opaque behavior; "opaque" also forces wallpaper chrome and every direct
 *  translucent surface fill to its solid token (see glass.css/layout.css). */
export function applyTransparency(mode: TransparencyMode): void {
  if (mode === 'glass') {
    document.documentElement.removeAttribute('data-transparency')
  } else {
    document.documentElement.setAttribute('data-transparency', mode === 'opaque' ? 'opaque' : 'off')
  }
}

/** Resolve the OS-level colour scheme preference. */
export function resolveSystemTheme(): 'dark' | 'light' {
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

/** Apply a theme to the document. Always resolves 'system' to 'dark' or
 *  'light' before setting the `data-theme` attribute. */
export function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? resolveSystemTheme() : theme
  document.documentElement.setAttribute('data-theme', resolved)
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch { /* ignored */ }
}

/** Cycle dark → light → system → dark. */
export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark'
  applyTheme(next)
  return next
}

/** Subscribe to OS theme changes. The callback fires whenever the user's
 *  system preference switches between light and dark. Returns an
 *  unsubscribe function. */
export function onSystemThemeChange(cb: () => void): () => void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => cb()
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
