// Tracks whether the key-hint modifiers are currently held, so the UI can
// reveal shortcut hints while the user holds them:
//   - Ctrl/Cmd held  → slot pills highlight (mod+1/2/3 to focus a panel)
//
// The flag set is computed from KeyboardEvent modifier fields (e.ctrlKey /
// e.metaKey) rather than e.key === 'Control', so a modifier held while a
// *second* key is pressed (e.g. the "1" in "Ctrl+1") still reads as held.
//
// State updates are functional and bail out when unchanged, so ordinary
// typing (no modifier keys) never triggers a re-render. A window `blur`
// resets the flag — a modifier released while the window isn't focused
// (e.g. Cmd+Tab away while holding Cmd) would otherwise leave a stale
// hint on screen.

import { useEffect, useState } from 'react'

export interface HeldModifiers {
  /** Ctrl (Windows/Linux) or Meta/Cmd (Mac) currently held. Matches the
   *  shortcut dispatcher's `mod` convention. */
  ctrlOrMeta: boolean
}

const IDLE: HeldModifiers = { ctrlOrMeta: false }

export function useHeldModifiers(): HeldModifiers {
  const [held, setHeld] = useState<HeldModifiers>(IDLE)

  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      setHeld((prev) => {
        const next: HeldModifiers = { ctrlOrMeta: e.ctrlKey || e.metaKey }
        // Same reference → React skips the re-render (modifier auto-repeat,
        // plain typing, key presses *inside* a held modifier, etc.).
        return next.ctrlOrMeta === prev.ctrlOrMeta ? prev : next
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
