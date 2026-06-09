// Theme + accent-colour management.
//
// Encapsulates: light/dark/system theme, global accent colour, and
// per-session accent overrides (which the SessionList colour picker
// + the New-session dialog feed into).
//
// Three things this hook deliberately does NOT own:
//   - showSystemEvents: a debug toggle, not a theme concern.
//   - notifications: separate concern, separate hook.
//   - keyboard shortcuts: ditto.
//
// Returned `sessionAccentMap` is a Map (referentially stable across
// renders that don't change `sessionColors`), not a per-call function.
// ChatPanel is React.memo'd on its props, so a new accent style per
// render would defeat that — stable map identity preserves the bail-out.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocalStorage } from './useLocalStorage'
import {
  ACCENT_COLORS,
  ACCENT_COLOR_KEY,
  SESSION_COLORS_KEY,
  accentStrongFor,
  buildSessionAccentMap,
  onAccentFor,
} from '../theme'
import type { CSSProperties } from 'react'
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
  /** Raw per-session accent map (id → hex). Exposed so consumers that
   *  need a direct lookup (e.g. SessionList passing the current swatch
   *  to its colour-picker context menu) don't have to allocate over
   *  the pre-computed `sessionAccentMap`. */
  sessionColors: Record<string, string>
  /** Stable Map of per-session accent overrides. Use `.get(sessionId)`
   *  in render to retrieve the inline `CSSProperties` (or undefined
   *  when no override exists — caller passes that through to the
   *  panel root and the global `--accent` cascade applies). */
  sessionAccentMap: ReadonlyMap<string, CSSProperties>
  /** Apply (or clear with `color === undefined`) a per-session accent
   *  override. Writes through localStorage directly before calling
   *  setState — see in-body comment for the React-19 unmount race
   *  this guards against. */
  handleSessionColorChange: (id: string, color: string | undefined) => void
}

/** Read the session-accent map from localStorage. Used inside
 *  `handleSessionColorChange` to merge with the latest persisted state
 *  rather than the React snapshot, which can be stale when the menu
 *  unmounts in the same tick. */
function readSessionColors(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SESSION_COLORS_KEY)
    return raw ? (JSON.parse(raw) ?? {}) : {}
  } catch {
    return {}
  }
}

export function useTheme(): UseThemeResult {
  // --- Light/dark/system theme --------------------------------------------
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  // Apply theme on mount and whenever it changes. applyTheme() resolves
  // 'system' to 'dark'/'light' before writing the data-theme attribute.
  useEffect(() => {
    applyTheme(theme)
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
  const [sessionColors, setSessionColors] = useLocalStorage<Record<string, string>>(
    SESSION_COLORS_KEY,
    {},
  )

  // Sync the chosen accent colour into :root CSS custom properties so the
  // entire stylesheet picks up the change without any further wiring.
  useEffect(() => {
    const root = document.documentElement.style
    // The Anthropic skin locks its brand colour (terracotta). Remove any
    // inline accent overrides so the values defined in styles.css's
    // [data-skin="anthropic"] block take effect — inline styles on <html>
    // would otherwise win over the stylesheet. Switching back to another
    // skin re-runs this effect and writes the user's accent again.
    if (skin === 'anthropic') {
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

  // Pre-computed per-session accent CSS overrides. Stable references so
  // ChatPanel's React.memo can skip unchanged panels — recomputing only
  // when sessionColors itself changes.
  const sessionAccentMap = useMemo(
    () => buildSessionAccentMap(sessionColors),
    [sessionColors],
  )

  const handleSessionColorChange = useCallback(
    (id: string, color: string | undefined) => {
      // Bypass the React state updater. Opening the context menu is the
      // only way this fires, and clicking a colour unmounts the menu in
      // the same tick — React 19 may then discard a setState updater
      // whose resulting state "won't matter" after unmount, exactly like
      // the rememberIn bug. Write through directly, then sync React state
      // for the still-mounted SessionList.
      const curr = readSessionColors()
      if (color) curr[id] = color
      else delete curr[id]
      try {
        window.localStorage.setItem(SESSION_COLORS_KEY, JSON.stringify(curr))
      } catch {
        /* storage full / disabled — in-memory state still reflects it */
      }
      setSessionColors(curr)
    },
    [setSessionColors],
  )

  return {
    theme,
    toggleThemeNext,
    setMode,
    skin,
    setSkin,
    accentColor,
    setAccentColor,
    sessionColors,
    sessionAccentMap,
    handleSessionColorChange,
  }
}
