// Theme management — reads/writes the `data-theme` attribute on <html>.
// Theme preference is persisted in localStorage.
//
// Supports three modes: 'dark', 'light', and 'system' (follow OS preference).
// The `data-theme` attribute is always set to 'dark' or 'light' — never 'system'.

const THEME_KEY = 'claude-react-web:theme'
const SKIN_KEY = 'claude-react-web:skin'

export type Theme = 'dark' | 'light' | 'system'

/** A "skin" is orthogonal to the light/dark mode: it changes the visual
 *  *feel* (depth, glow, gradients) while inheriting the colour tokens of
 *  whichever mode is active. 'default' is the original flat look. */
export type Skin = 'default' | 'glow'

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
    if (v === 'default' || v === 'glow') return v
  } catch { /* ignored */ }
  // Default skin keeps the original look for existing users.
  return 'default'
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
