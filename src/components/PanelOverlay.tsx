// Shared in-panel overlay primitive.
//
// Historically this component hand-owned the full overlay chrome: enter/exit
// animation via data-state + useExitPresence, a guarded backdrop mousedown,
// a capture-phase Esc handler, and a focus trap — one of five near-identical
// copies of that pattern (settings/git/resume/subagent/workflow). Since PR-B
// phase 0 introduced the unified <Overlay> primitive (src/components/Overlay.tsx),
// this is now a thin, behavior-identical adapter: `variant="panel"` renders
// the .panel-overlay / .panel-overlay-card class pair and wires Escape via the
// useEscapeStack, backdrop-dismiss, focus trap + restore, and css-mode
// data-state exit animation — all owned by Overlay. Consumers keep passing the
// same props and are unchanged.
//
// It is column-scoped: rendered inside a single chat panel, it covers only
// that panel (not the whole app). The global/full-app modal pattern
// (.modal-backdrop / .palette-backdrop) is a different concern and stays
// separate.

import type { ReactNode } from 'react'
import { Overlay } from './Overlay'

export interface PanelOverlayProps {
  /** Whether the overlay is open. While closing, the card stays mounted through
   *  the exit animation (~180ms) before unmounting. */
  open: boolean
  /** Close the overlay. Called on backdrop click or Escape. */
  onClose: () => void
  /** The card's content. */
  children: ReactNode
  /** Accessible name for the dialog. */
  ariaLabel: string
  /** Extra class(es) on the card element (e.g. a consumer-specific width). */
  panelClassName?: string
  /** Whether to trap Tab focus inside the card while open. Default true
   *  (matches settings/git/resume forms). Palettes — command palette, input
   *  history — set this false: they keep the search input focused and contain
   *  Tab themselves by refocusing the input, rather than wrapping onto result
   *  buttons. */
  trapFocus?: boolean
  /** Card-level keydown handler (arrow navigation, Enter to confirm, Tab
   *  containment for palettes). Attached to the card so it fires regardless of
   *  which child holds focus. */
  onKeyDown?: (e: React.KeyboardEvent) => void
}

export function PanelOverlay({
  open,
  onClose,
  children,
  ariaLabel,
  panelClassName,
  trapFocus = true,
  onKeyDown,
}: PanelOverlayProps) {
  return (
    <Overlay
      variant="panel"
      open={open}
      onClose={onClose}
      ariaLabel={ariaLabel}
      cardClassName={panelClassName}
      trapFocus={trapFocus}
      onKeyDown={onKeyDown}
      trapRefTarget="card"
    >
      {children}
    </Overlay>
  )
}
