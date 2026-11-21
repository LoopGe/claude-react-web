// Ctrl+` — toggle the focused panel's embedded-terminal overlay.
//
// Extracted from App's shortcuts useMemo so the routing — combo spelling,
// focused-session gate, open-vs-close decision, true-modal suppression — is
// unit-testable against the real dispatcher (terminal-shortcut.test.ts), the
// same contract as scroll-nav-shortcuts.ts.
//
// Platform-fixed `ctrl`, never `mod`: Cmd+` is macOS window cycling and must
// not toggle the terminal (the dispatcher's distinct ctrl/meta tokens).
// allowInInput because the toggle must work while the xterm textarea holds
// focus; IME composition is blocked by the dispatcher itself.
//
// All inputs are plain VALUES baked in at build time (react-hooks/refs — no
// ref reads during render). App lists every one of them in the shortcuts
// useMemo's deps, so a keypress always lands on the latest committed render
// and the baked values are never stale — the scroll-nav-shortcuts contract.
//
// Open routes through the overlay union's handleOpenTerminal, which REPLACES
// any sibling overlay (settings/git/tasks/worktree/search) — sibling overlays
// do not suppress the toggle. `modalOpen` is App's disjunction of its hosted
// true modals (palette, confirm/prompt hosts, pickers, settings/help dialogs):
// while one is up the keypress belongs to the modal, not the panel beneath.
import type { Shortcut } from '../hooks/useKeyboardShortcuts'

export interface TerminalToggleInput {
  /** Currently focused panel's session id, or null. */
  focusedId: string | null
  /** The focused session's terminalSupported — false makes the toggle a no-op
   *  (the overlay would only render the unavailable panel). */
  supported: boolean
  /** Session whose terminal overlay is the open one (union), or null. Equal
   *  to focusedId → the toggle closes; anything else → it opens (replacing). */
  terminalOpenFor: string | null
  /** Any App-hosted true modal is open (palette / ConfirmDialog / picker…). */
  modalOpen: boolean
  onOpen: (sessionId: string) => void
  onClose: () => void
}

export function terminalToggleShortcut(input: TerminalToggleInput): Shortcut {
  return {
    combo: 'ctrl+`',
    allowInInput: true,
    description: 'Toggle terminal',
    handler: () => {
      if (input.modalOpen) return
      const fid = input.focusedId
      if (fid == null || !input.supported) return
      if (input.terminalOpenFor === fid) input.onClose()
      else input.onOpen(fid)
    },
  }
}
