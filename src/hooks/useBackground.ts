// Global background appearance preference (default/glow skins only).
//
// Owns the localStorage BackgroundSetting (src/theme.ts) and applies it to
// the document the same way useTheme applies accent colour: write CSS custom
// properties onto <html> and toggle body.has-bg. Under a background-locked
// skin (Anthropic / HC / Soft-HC) the effect is suppressed but the stored
// choice is preserved, so switching back to default/glow restores it.
//
// A video wallpaper cannot be a CSS value, so it is reported through
// `activeVideoSrc` for the caller to render as a <video> (BackgroundVideo)
// instead of through --app-bg-image.

import { useCallback, useEffect } from 'react'
import { useLocalStorage } from './useLocalStorage'
import {
  BACKGROUND_KEY,
  BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_DEFAULT_BLUR,
  BACKGROUND_DEFAULT_SURFACE,
  BACKGROUND_OPACITY_MAX,
  type BackgroundSetting,
  isBackgroundSetting,
  isBackgroundVideoSrc,
  mediaOfPref,
} from '../theme'
import { isBackgroundLocked, type Skin } from '../utils/theme'

const DEFAULT_SETTING: BackgroundSetting = { pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY }

/** Strip characters that would break a CSS url("…") string. */
function sanitizeCssUrl(src: string): string {
  return src.replace(/["'\\\n\r]/g, '')
}

/** The video a caller should render right now, or null when the CSS-background
 *  path (or nothing at all) applies instead.
 *
 *  A video is a separate DOM element rather than a CSS value, so this is the
 *  one place that decides *whether* one exists — App renders exactly what this
 *  returns, and the effect below keeps the image slot empty whenever it is
 *  non-null, so the two can never both paint. */
export function resolveActiveVideoSrc(setting: BackgroundSetting, skin: Skin): string | null {
  const pref = setting.pref
  if (pref.kind !== 'custom' || mediaOfPref(pref) !== 'video') return null
  if (isBackgroundLocked(skin)) return null
  // Defends the invariant against a caller that skipped the store's validator:
  // handing an image to the <video> layer paints nothing at all.
  return isBackgroundVideoSrc(pref.src) ? pref.src : null
}

export interface UseBackgroundResult {
  setting: BackgroundSetting
  /** Persist a whole new setting. Transitioning none → an image while
   *  opacity is at its max (image would be invisible) auto-sets the default. */
  setSetting: (next: BackgroundSetting) => void
  /** Non-null when a video wallpaper is live: the caller must render a
   *  BackgroundVideo for it (see the component). Null covers every other
   *  case, including a video pref suppressed by a background-locked skin. */
  activeVideoSrc: string | null
}

export function useBackground(skin: Skin): UseBackgroundResult {
  const [setting, setStored] = useLocalStorage<BackgroundSetting>(
    BACKGROUND_KEY,
    DEFAULT_SETTING,
    { validate: isBackgroundSetting },
  )

  const setSetting = useCallback((next: BackgroundSetting) => {
    setStored((prev) => {
      // Committing an image while chrome is fully opaque would show nothing at
      // all, so step a first pick down to the default. Re-enabling an image the
      // setting already remembers is not a pick — honour the stored opacity.
      const picking = next.pref.kind === 'custom'
        && prev.pref.kind === 'none'
        && next.pref.src !== prev.lastSrc
      return picking && next.opacity >= BACKGROUND_OPACITY_MAX
        ? { ...next, opacity: BACKGROUND_DEFAULT_OPACITY }
        : next
    })
  }, [setStored])

  const activeVideoSrc = resolveActiveVideoSrc(setting, skin)

  useEffect(() => {
    const root = document.documentElement.style
    // A `custom` pref is only ever committed with a real src, but defend the
    // invariant here too: an empty src must not frost the chrome.
    const hasBackdrop = setting.pref.kind === 'custom' && setting.pref.src.length > 0
    const active = hasBackdrop && !isBackgroundLocked(skin)
    if (!active) {
      root.setProperty('--app-bg-image', 'none')
      root.setProperty('--app-chrome-alpha', '100%')
      root.setProperty('--app-chrome-blur', `${BACKGROUND_DEFAULT_BLUR}px`)
      root.setProperty('--app-surface-alpha', '100%')
      document.body.classList.remove('has-bg')
      return
    }
    // A video paints itself; the image slot must stay empty so a previously
    // applied wallpaper cannot sit behind it.
    if (setting.pref.kind === 'custom' && !activeVideoSrc) {
      const clean = sanitizeCssUrl(setting.pref.src)
      root.setProperty('--app-bg-image', `url("${clean}")`)
    } else {
      root.setProperty('--app-bg-image', 'none')
    }
    root.setProperty('--app-chrome-alpha', `${Math.round(setting.opacity * 100)}%`)
    root.setProperty('--app-chrome-blur', `${setting.blur ?? BACKGROUND_DEFAULT_BLUR}px`)
    root.setProperty('--app-surface-alpha', `${Math.round((setting.surface ?? BACKGROUND_DEFAULT_SURFACE) * 100)}%`)
    document.body.classList.add('has-bg')
  }, [setting, skin, activeVideoSrc])

  return { setting, setSetting, activeVideoSrc }
}
