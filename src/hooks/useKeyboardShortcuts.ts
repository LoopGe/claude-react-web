// Global keyboard shortcut dispatcher.
//
// Hangs a single `keydown` listener on window and routes matching events
// to the handler you registered. Handlers are keyed by a canonical string
// form ("mod+1", "alt+w", "escape", …) so the caller doesn't have to
// hand-match KeyboardEvent fields.
//
// "mod" means Ctrl on Linux/Windows and Meta (Cmd) on Mac — we accept
// either so shortcuts feel native on both.
//
// Input-safe: by default we SKIP the handler if the event target is a
// text input (textarea / input / contenteditable), so typing a prompt
// doesn't accidentally trigger app-level shortcuts. Pass `allowInInput`
// on a specific shortcut to override (useful for Esc).

import { useEffect } from 'react'

export type ShortcutHandler = (e: KeyboardEvent) => void

export interface Shortcut {
  /** Canonical combo string, e.g. "mod+1", "alt+w", "escape", "shift+?". */
  combo: string
  handler: ShortcutHandler
  /** If true, the handler fires even when an input/textarea is focused.
   *  Needed for universal dismissal keys like Esc. Default false. */
  allowInInput?: boolean
  /** Description shown in any future UI that lists shortcuts. Optional. */
  description?: string
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const combo = eventCombo(e)
      if (!combo) return
      for (const s of shortcuts) {
        if (normalise(s.combo) !== combo) continue
        if (!s.allowInInput && isInputTarget(e.target)) return
        // preventDefault: shortcuts like Alt+W / Ctrl+1 shouldn't trigger
        // browser default behaviour (open menu, switch tab). The handler
        // itself is free to re-enable propagation if it wants.
        e.preventDefault()
        s.handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcuts])
}

/** Reduce a KeyboardEvent to its combo string in the same shape the
 *  caller used in `combo`. Modifier order is fixed: mod, alt, shift. */
function eventCombo(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase()
  // Ignore modifier-only presses.
  if (key === 'control' || key === 'meta' || key === 'alt' || key === 'shift') return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

/** Canonicalise user-written combos: lowercase, sort modifier order. */
function normalise(combo: string): string {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim())
  const mods = new Set(parts.slice(0, -1))
  const out: string[] = []
  if (mods.has('mod') || mods.has('ctrl') || mods.has('cmd') || mods.has('meta')) out.push('mod')
  if (mods.has('alt') || mods.has('option')) out.push('alt')
  if (mods.has('shift')) out.push('shift')
  out.push(parts[parts.length - 1])
  return out.join('+')
}

function isInputTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true
  if (t.isContentEditable) return true
  return false
}
