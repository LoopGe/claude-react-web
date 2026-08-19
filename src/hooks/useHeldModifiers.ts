// Tracks whether the key-hint modifiers are currently held, so the UI can
// reveal shortcut hints while the user holds them:
//   - Ctrl/Cmd held  → slot pills highlight (mod+1/2/3 to focus a panel)
//   - Alt held       → group pills show their number badge (alt+1..9)
//
// The flag set is computed from KeyboardEvent modifier fields (e.ctrlKey /
// e.metaKey / e.altKey) rather than e.key === 'Control', so a modifier
// held while a *second* key is pressed (e.g. the "1" in "Ctrl+1") still
// reads as held.
//
// State updates are functional and bail out when unchanged, so ordinary
// typing (no modifier keys) never triggers a re-render. A window `blur`
// resets both flags — a modifier released while the window isn't focused
// (e.g. Alt+Tab away while holding Alt) would otherwise leave a stale
// hint on screen.

import { useEffect, useState } from 'react'

export interface HeldModifiers {
  /** Ctrl (Windows/Linux) or Meta/Cmd (Mac) currently held. Matches the
   *  shortcut dispatcher's `mod` convention. */
  ctrlOrMeta: boolean
  /** Alt (Option on Mac) currently held. */
  alt: boolean
}

const IDLE: HeldModifiers = { ctrlOrMeta: false, alt: false }

export function useHeldModifiers(): HeldModifiers {
  const [held, setHeld] = useState<HeldModifiers>(IDLE)

  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      setHeld((prev) => {
        const next: HeldModifiers = { ctrlOrMeta: e.ctrlKey || e.metaKey, alt: e.altKey }
        // Same reference → React skips the re-render (modifier auto-repeat,
        // plain typing, key presses *inside* a held modifier, etc.).
        return next.ctrlOrMeta === prev.ctrlOrMeta && next.alt === prev.alt ? prev : next
      })
    }
    const reset = () => setHeld(IDLE)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', reset)
    }
  }, [])

  return held
}
