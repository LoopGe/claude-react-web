// Theme management — reads/writes the `data-theme` attribute on <html>.
// Theme preference is persisted in localStorage.

const THEME_KEY = 'claude-react-web:theme'

export type Theme = 'dark' | 'light'

export function getStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* ignored */ }
  // Default to dark if no preference is stored.
  return 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch { /* ignored */ }
}

export function toggleTheme(current: Theme): Theme {
  const next = current === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}
