// Global background-image appearance preference (default/glow skins only).
//
// Owns the localStorage BackgroundSetting (src/theme.ts) and applies it to
// the document the same way useTheme applies accent colour: write CSS custom
// properties onto <html> and toggle body.has-bg. Under a background-locked
// skin (Anthropic / HC / Soft-HC) the effect is suppressed but the stored
// choice is preserved, so switching back to default/glow restores it.

import { useCallback, useEffect } from 'react'
import { useLocalStorage } from './useLocalStorage'
import {
  BACKGROUND_KEY,
  BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_OPACITY_MAX,
  type BackgroundSetting,
  isBackgroundSetting,
} from '../theme'
import { isBackgroundLocked, type Skin } from '../utils/theme'

const DEFAULT_SETTING: BackgroundSetting = { pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY }

/** Strip characters that would break a CSS url("…") string. */
function sanitizeCssUrl(src: string): string {
  return src.replace(/["'\\\n\r]/g, '')
}

export interface UseBackgroundResult {
  setting: BackgroundSetting
  /** Persist a whole new setting. Transitioning none → an image while
   *  opacity is at its max (image would be invisible) auto-sets the default. */
  setSetting: (next: BackgroundSetting) => void
}

export function useBackground(skin: Skin): UseBackgroundResult {
  const [setting, setStored] = useLocalStorage<BackgroundSetting>(
    BACKGROUND_KEY,
    DEFAULT_SETTING,
    { validate: isBackgroundSetting },
  )

  const setSetting = useCallback((next: BackgroundSetting) => {
    setStored((prev) => {
      const picking = prev.pref.kind === 'none' && next.pref.kind !== 'none'
      return picking && next.opacity >= BACKGROUND_OPACITY_MAX
        ? { ...next, opacity: BACKGROUND_DEFAULT_OPACITY }
        : next
    })
  }, [setStored])

  useEffect(() => {
    const root = document.documentElement.style
    // An active image requires a non-empty src for `custom` — selecting
    // "Custom image" before a URL/upload lands must not frost the chrome.
    const hasImage =
      setting.pref.kind === 'custom' ? setting.pref.src.length > 0 : setting.pref.kind !== 'none'
    const active = hasImage && !isBackgroundLocked(skin)
    if (!active) {
      root.setProperty('--app-bg-image', 'none')
      root.setProperty('--app-chrome-alpha', '100%')
      document.body.classList.remove('has-bg')
      return
    }
    if (setting.pref.kind === 'custom') {
      const clean = sanitizeCssUrl(setting.pref.src)
      root.setProperty('--app-bg-image', `url("${clean}")`)
    } else {
      root.setProperty('--app-bg-image', 'none')
    }
    root.setProperty('--app-chrome-alpha', `${Math.round(setting.opacity * 100)}%`)
    document.body.classList.add('has-bg')
  }, [setting, skin])

  return { setting, setSetting }
}
