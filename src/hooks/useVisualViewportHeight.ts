import { useEffect } from 'react'

/** On mobile, the on-screen keyboard does NOT shrink the layout viewport, so
 *  a `100dvh` app over-extends and the composer / send button get pushed
 *  under the keyboard. The visualViewport API reports the *visible* height
 *  (excluding the keyboard), so we mirror it into a CSS variable
 *  (`--app-vh`) that the `@media (max-width: 768px)` block uses for `.app`'s
 *  height. No-op when disabled (desktop) or when the API is unavailable —
 *  the stylesheet falls back to `100dvh`.
 *
 *  @param enabled gate so desktop never pays for the listener (pass isMobile). */
export function useVisualViewportHeight(enabled: boolean): void {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const root = document.documentElement
    if (!enabled || !vv) {
      root.style.removeProperty('--app-vh')
      return
    }
    const sync = () => {
      root.style.setProperty('--app-vh', `${vv.height}px`)
    }
    sync()
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
      root.style.removeProperty('--app-vh')
    }
  }, [enabled])
}
