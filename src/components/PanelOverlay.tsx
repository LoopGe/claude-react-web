// Shared in-panel overlay primitive.
//
// The codebase had five near-identical copies of the same overlay chrome:
// .settings-overlay, .git-overlay, .resume-overlay, .subagent-overlay, and the
// workflow overlay — each `position:absolute; inset:0;` with a backdrop click
// guard, an Esc handler, a focus trap, and the same enter/exit keyframes. This
// component is the single owner of that pattern.
//
// It is column-scoped: rendered inside a single chat panel, it covers only
// that panel (not the whole app). The global/full-app modal pattern
// (.modal-backdrop / .palette-backdrop) is a different concern and stays
// separate.
//
// Responsibilities:
//   - enter/exit animation via `data-state` + `useExitPresence`
//   - backdrop mousedown-to-close (only direct clicks on the backdrop, not
//     bubbled clicks from inside the card)
//   - capture-phase Esc to close (fires even if a child holds focus)
//   - focus trap with restore-on-close (matches the existing settings/git/
//     resume overlays — focus stays inside the card while open)
//
// Consumers own the card's inner content + layout; this wraps it in the
// backdrop + card shell and wires the shared behaviour.

import { useEffect, useRef, type ReactNode } from 'react'
import { useExitPresence } from '../hooks/useExitPresence'
import { useFocusTrap } from '../hooks/useFocusTrap'

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
  const presence = useExitPresence(open)
  const ref = useRef<HTMLDivElement>(null)

  // Focus trap is active only while open; on close it restores the previously
  // focused element. During the exit animation (open=false, shouldRender=true)
  // the trap is inactive so focus can return to the app immediately. Palettes
  // opt out (they manage Tab themselves to keep the search input focused).
  useFocusTrap(ref, { restoreFocus: true, active: open && trapFocus })

  // Keep the latest onClose in a ref so the Esc listener effect can depend on
  // `[open]` alone. Consumers (e.g. Chat) pass an inline onClose arrow that
  // changes identity every render; depending on it would re-subscribe the
  // window keydown listener on every render — churning the listener registry
  // continuously while a panel is open over a streaming session.
  const onCloseRef = useRef(onClose)
  /* eslint-disable react-hooks/refs -- sync ref to latest prop during render,
     same pattern as App's ref-sync block; the ref is only read inside the
     Esc effect (after commit), never during this render */
  onCloseRef.current = onClose
  /* eslint-enable react-hooks/refs */

  // Capture-phase Escape so it fires even if a child input holds focus, and
  // before any child's own keydown can swallow it. stopPropagation keeps App's
  // window-level Esc handler from also firing (it would fall through to
  // interrupt the focused session if our state lagged a tick).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!presence.shouldRender) return null

  return (
    <div
      className="panel-overlay"
      data-state={open ? 'open' : 'closing'}
      onMouseDown={(e) => {
        if (open && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`panel-overlay-card${panelClassName ? ' ' + panelClassName : ''}`}
        ref={ref}
        role="dialog"
        aria-modal={open ? 'true' : 'false'}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
