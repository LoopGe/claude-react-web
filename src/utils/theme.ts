// Theme management — reads/writes the `data-theme` attribute on <html>.
// Theme preference is persisted in localStorage.
//
// Supports three modes: 'dark', 'light', and 'system' (follow OS preference).
// The `data-theme` attribute is always set to 'dark' or 'light' — never 'system'.

const THEME_KEY = 'claude-react-web:theme'

export type Theme = 'dark' | 'light' | 'system'

export function getStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* ignored */ }
  // Default to dark if no preference is stored.
  return 'dark'
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
