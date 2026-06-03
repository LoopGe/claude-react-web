// Recently-used custom accent colours, persisted globally.
//
// A colour picked via the native <input type="color"> is the current accent
// only until the user switches to a preset — after that the exact hex is
// lost unless they re-dial it in the OS picker. This hook keeps a small
// LRU list (newest first) so those colours stay one click away.
//
// Storage is a single global key shared by all three picker sites; thanks to
// useLocalStorage's same-tab listener fan-out, adding a colour in one picker
// shows up in the others without prop threading.

import { useCallback } from 'react'
import { useLocalStorage } from './useLocalStorage'
import {
  MAX_RECENT_COLORS,
  RECENT_COLORS_KEY,
  isHexColor,
  isHexColorList,
  isPresetAccent,
} from '../theme'

export interface UseRecentColorsResult {
  /** Recently-used custom colours, newest first (already capped + deduped). */
  recents: string[]
  /** Record a colour as just-used. No-ops for presets (always in the grid)
   *  and malformed hex. Moves an existing entry to the front rather than
   *  duplicating it, and trims to MAX_RECENT_COLORS. */
  addRecent: (hex: string) => void
}

export function useRecentColors(): UseRecentColorsResult {
  const [recents, setRecents] = useLocalStorage<string[]>(RECENT_COLORS_KEY, [], {
    validate: isHexColorList,
  })

  const addRecent = useCallback(
    (hex: string) => {
      // Normalise to lower-case so '#FFAA00' and '#ffaa00' don't both
      // occupy a slot. The native picker emits lower-case already, but a
      // value loaded from a preset comparison / hand-edit might not.
      if (!isHexColor(hex)) return
      const norm = hex.toLowerCase()
      // Presets live in the grid permanently — never duplicate them here.
      if (isPresetAccent(norm)) return
      setRecents((prev) => {
        const next = [norm, ...prev.filter((c) => c.toLowerCase() !== norm)]
        return next.slice(0, MAX_RECENT_COLORS)
      })
    },
    [setRecents],
  )

  return { recents, addRecent }
}
