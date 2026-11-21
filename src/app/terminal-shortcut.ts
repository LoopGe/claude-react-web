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
//
// Capability degradation (design spec): `supported` follows the three-state
// taskControlSupported convention — App passes `terminalSupported !== false`,
// so an unknown/undefined capability is treated as supported and only an
// explicit false disables. On an unsupported host the toggle no-ops WITH a
// toast (`onUnsupported`) and the palette entry is hidden (`paletteHidden`),
// while the shortcut stays registered so the keypress can surface the notice.
import type { Shortcut } from '../hooks/useKeyboardShortcuts'

export interface TerminalToggleInput {
  /** Currently focused panel's session id, or null. */
  focusedId: string | null
  /** The focused session's terminal capability, three-state collapsed by App
   *  (`terminalSupported !== false`). False → toast + no toggle + hidden
   *  palette entry; true (incl. unknown) → normal toggle. */
  supported: boolean
  /** Session whose terminal overlay is the open one (union), or null. Equal
   *  to focusedId → the toggle closes; anything else → it opens (replacing). */
  terminalOpenFor: string | null
  /** Any App-hosted true modal is open (palette / ConfirmDialog / picker…). */
  modalOpen: boolean
  onOpen: (sessionId: string) => void
  onClose: () => void
  /** Fired when a focused, unsupported session's toggle is pressed — App
   *  wires this to the toast hub. Not fired under a modal or with no focus. */
  onUnsupported: () => void
}

export function terminalToggleShortcut(input: TerminalToggleInput): Shortcut {
  // The toggle itself, WITHOUT the modal gate. Shared by the keydown handler
  // (which adds the gate) and the palette action (which must not carry it —
  // the palette being open implies modalOpen=true, so a gated palette action
  // would be dead on every supported host). Focus/support gates and the
  // unsupported toast apply on BOTH invocation paths.
  const toggle = () => {
    const fid = input.focusedId
    if (fid == null) return
    if (!input.supported) {
      input.onUnsupported()
      return
    }
    if (input.terminalOpenFor === fid) input.onClose()
    else input.onOpen(fid)
  }
  return {
    combo: 'ctrl+`',
    allowInInput: true,
    description: 'Toggle terminal',
    // Same capability fact gates the toggle, the toast, and palette visibility.
    paletteHidden: !input.supported,
    paletteAction: toggle,
    handler: () => {
      // Modal suppression belongs to the KEYDOWN context only: Ctrl+` while a
      // true modal (incl. the palette) is open must not toggle.
      if (input.modalOpen) return
      toggle()
    },
  }
}
