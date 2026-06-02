import { useEffect, useState } from 'react'

/** Breakpoint (px) below which the UI switches to single-panel / drawer mode.
 *  Kept in sync with the `@media (max-width: 768px)` block in styles.css. */
export const MOBILE_BREAKPOINT = 768

const QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`

/** Safely resolve a MediaQueryList, or null when matchMedia is unavailable
 *  (SSR, jsdom test env, very old browsers). */
function getMql(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  return window.matchMedia(QUERY)
}

/** True when the viewport is at or below the mobile breakpoint. Subscribes to
 *  the matchMedia `change` event so it reacts to window resize / device
 *  rotation. Mirrors the matchMedia subscription pattern in
 *  `utils/theme.ts:onSystemThemeChange`. Returns false when matchMedia is
 *  unavailable (treat as desktop). */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => getMql()?.matches ?? false)

  useEffect(() => {
    const mql = getMql()
    if (!mql) return
    // Use a functional update so the rare render→effect race (viewport
    // changed between the lazy initializer and effect commit) is caught
    // without an unconditional setState that triggers a cascading render.
    const handler = (e: { matches: boolean }) =>
      setIsMobile((prev) => (prev === e.matches ? prev : e.matches))
    handler(mql)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}
