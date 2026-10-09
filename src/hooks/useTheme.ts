// Theme + accent-colour management.
//
// Encapsulates: light/dark/system theme and the global accent colour.
//
// Two things this hook deliberately does NOT own:
//   - notifications: separate concern, separate hook.
//   - keyboard shortcuts: ditto.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalStorage } from './useLocalStorage'
import {
  ACCENT_COLORS,
  ACCENT_COLOR_KEY,
  accentStrongFor,
  onAccentFor,
} from '../theme'
import { applySkin, applyTheme, getStoredSkin, getStoredTheme, onSystemThemeChange, toggleTheme, type Skin, type Theme } from '../utils/theme'

export interface UseThemeResult {
  theme: Theme
  toggleThemeNext: () => void
  /** Set the light/dark/system mode directly (used by the appearance panel,
   *  which offers explicit choices rather than a cycle). */
  setMode: (mode: Theme) => void
  /** Active skin (default / glow) — orthogonal to the mode above. */
  skin: Skin
  setSkin: (skin: Skin) => void
  accentColor: string
  setAccentColor: (v: string) => void
}

export function useTheme(): UseThemeResult {
  // --- Light/dark/system theme --------------------------------------------
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  // Tracks whether applyTheme has run once already; the transition class is
  // armed only from the second application onward (see the effect below).
  const themeAppliedRef = useRef(false)
  // Apply theme on mount and whenever it changes. applyTheme() resolves
  // 'system' to 'dark'/'light' before writing the data-theme attribute.
  // The `.theme-transitioning` class is armed for the swap only: it gives
  // `*` a short color crossfade for that one moment, then is removed so no
  // permanent global transition lingers (avoiding jank + white flash while
  // keeping the switch smooth). CSS guards it under prefers-reduced-motion.
  //
  // The transition is intended ONLY for user-triggered swaps, so the initial
  // mount (where the stored theme is applied for the first time) arms nothing
  // — otherwise every page load that overrides the CSS default crossfades the
  // whole tree on paint.
  useEffect(() => {
    applyTheme(theme)
    const root = document.documentElement
    if (themeAppliedRef.current) {
      root.classList.add('theme-transitioning')
    } else {
      themeAppliedRef.current = true
    }
    const id = setTimeout(() => root.classList.remove('theme-transitioning'), 250)
    return () => {
      clearTimeout(id)
      root.classList.remove('theme-transitioning')
    }
  }, [theme])
  // Subscribe to OS theme changes so 'system' mode stays in sync when the
  // user switches their OS preference.
  useEffect(() => {
    if (theme !== 'system') return
    return onSystemThemeChange(() => {
      applyTheme('system')
      // Force a re-render so children pick up the resolved value.
      setTheme('system')
    })
  }, [theme])
  const toggleThemeNext = useCallback(() => {
    setTheme((prev) => toggleTheme(prev))
  }, [])
  const setMode = useCallback((mode: Theme) => {
    setTheme(mode)
  }, [])

  // --- Skin (default / glow) — orthogonal to the light/dark mode. --------
  const [skin, setSkinState] = useState<Skin>(getStoredSkin)
  useEffect(() => {
    applySkin(skin)
  }, [skin])
  const setSkin = useCallback((next: Skin) => {
    setSkinState(next)
  }, [])

  // --- Accent colour ------------------------------------------------------
  const [accentColor, setAccentColor] = useLocalStorage<string>(
    ACCENT_COLOR_KEY,
    ACCENT_COLORS[0].accent,
  )

  // Sync the chosen accent colour into :root CSS custom properties so the
  // entire stylesheet picks up the change without any further wiring.
  useEffect(() => {
    const root = document.documentElement.style
    // The Anthropic, High-Contrast, and Soft High-Contrast skins lock the
    // accent (brand terracotta / bright blue / indigo respectively). Remove
    // any inline accent overrides so the values defined in the
    // [data-skin="…"] blocks take effect — inline styles on <html> would
    // otherwise win. Switching back re-runs this effect and writes the
    // user's accent again.
    if (skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc') {
      root.removeProperty('--accent')
      root.removeProperty('--accent-strong')
      root.removeProperty('--on-accent')
      return
    }
    root.setProperty('--accent', accentColor)
    root.setProperty('--accent-strong', accentStrongFor(accentColor))
    // Adapt the on-accent foreground to the chosen accent's luminance so
    // text/icons sitting on an accent fill stay legible for any accent
    // (e.g. a near-black accent picked under the light theme).
    root.setProperty('--on-accent', onAccentFor(accentColor))
  }, [accentColor, skin])

  return {
    theme,
    toggleThemeNext,
    setMode,
    skin,
    setSkin,
    accentColor,
    setAccentColor,
  }
}
