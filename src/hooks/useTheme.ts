// Theme and accent colour management.
//
// Encapsulates: theme (dark/light/system), global accent colour,
// per-session accent overrides, and system-event toggle.

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { useLocalStorage } from './useLocalStorage'
import { ACCENT_COLORS, ACCENT_COLOR_KEY, SESSION_COLORS_KEY } from '../theme'
import { SHOW_SYSTEM_EVENTS_KEY } from '../constants/storageKeys'
import { applyTheme, getStoredTheme, onSystemThemeChange, toggleTheme, type Theme } from '../utils/theme'

export interface UseThemeResult {
  theme: Theme
  handleToggleTheme: () => void
  accentColor: string
  setAccentColor: (v: string) => void
  sessionColors: Record<string, string>
  setSessionColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
  sessionAccentStyle: (sessionId: string) => CSSProperties | undefined
  handleSessionColorChange: (id: string, color: string | undefined) => void
  showSystemEvents: boolean
  setShowSystemEvents: (v: boolean | ((prev: boolean) => boolean)) => void
}

export function useTheme(): UseThemeResult {
  // Theme state — persisted in localStorage, applied via data-theme on <html>.
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  // Apply theme on mount and whenever it changes.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  // Subscribe to OS theme changes so 'system' mode stays in sync.
  useEffect(() => {
    if (theme !== 'system') return
    return onSystemThemeChange(() => {
      applyTheme('system')
      setTheme('system')
    })
  }, [theme])
  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => toggleTheme(prev))
  }, [])

  const [accentColor, setAccentColor] = useLocalStorage<string>(ACCENT_COLOR_KEY, ACCENT_COLORS[0].accent)
  const [sessionColors, setSessionColors] = useLocalStorage<Record<string, string>>(SESSION_COLORS_KEY, {})
  const [showSystemEvents, setShowSystemEvents] = useLocalStorage<boolean>(SHOW_SYSTEM_EVENTS_KEY, false)

  // Sync the chosen accent colour into :root CSS custom properties.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--accent', accentColor)
    const preset = ACCENT_COLORS.find((c) => c.accent === accentColor)
    root.setProperty('--accent-strong', preset?.strong ?? accentColor)
  }, [accentColor])

  const sessionAccentStyle = useCallback(
    (sessionId: string): CSSProperties | undefined => {
      const hex = sessionColors[sessionId]
      if (!hex) return undefined
      const preset = ACCENT_COLORS.find((c) => c.accent === hex)
      return { '--accent': hex, '--accent-strong': preset?.strong ?? hex } as CSSProperties
    },
    [sessionColors],
  )

  const handleSessionColorChange = useCallback((id: string, color: string | undefined) => {
    // Bypass the React state updater — see comment in original App.tsx.
    // React 19 may discard a setState updater whose resulting state
    // "won't matter" after unmount. Write through directly, then sync.
    const curr: Record<string, string> = (() => {
      try {
        const raw = window.localStorage.getItem(SESSION_COLORS_KEY)
        return raw ? (JSON.parse(raw) ?? {}) : {}
      } catch {
        return {}
      }
    })()
    if (color) curr[id] = color
    else delete curr[id]
    try {
      window.localStorage.setItem(SESSION_COLORS_KEY, JSON.stringify(curr))
    } catch {
      /* storage full / disabled — in-memory state still reflects it */
    }
    setSessionColors(curr)
  }, [setSessionColors])

  return {
    theme,
    handleToggleTheme,
    accentColor,
    setAccentColor,
    sessionColors,
    setSessionColors,
    sessionAccentStyle,
    handleSessionColorChange,
    showSystemEvents,
    setShowSystemEvents,
  }
}
