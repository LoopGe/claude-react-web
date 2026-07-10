// Generic confirmation dialog — used by destructive git operations
// (discard, amend, stash-drop, abort-merge, abort-rebase, branch
// checkout-with-conflict-resolution).
//
// Reuses the same .perm-overlay / .perm-card / .modal-* CSS family that
// PermissionDialog and QuestionDialog use; styling consistency comes
// from there rather than per-dialog overrides.
//
// Behaviour:
//   - Esc cancels (calls onCancel)
//   - Enter on the confirm button confirms (browsers handle this
//     natively because the button is auto-focused)
//   - Both buttons disabled while `busy` is true
//   - The confirm button gains `.btn-danger` styling when destructive

import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useOverlayMotion } from '../utils/transitions'

interface Props {
  title: string
  /** ReactNode so callers can render multi-line text or `<code>file/path</code>`
   *  for clarity, without us trying to parse markdown. */
  message: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** When true, the confirm button gets red `.btn-danger` styling.
   *  Use for any operation that loses work (discard, drop, abort). */
  destructive?: boolean
  /** When true, both buttons are disabled — used for the brief window
   *  between click and the server's response landing. */
  busy?: boolean
  /** Called on confirm-button click. Returning a promise blocks the
   *  next click until it settles, but does NOT auto-close the dialog —
   *  the caller is expected to update state to unmount it. */
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Open/close motion is driven by motion.div + AnimatePresence (the caller
  // gates mount on the confirm state). Mirrors the old overlay-backdrop/panel
  // keyframes via useOverlayMotion; reduced motion snaps both.
  const m = useOverlayMotion()
  // restoreFocus: true — ConfirmDialog is opened from a real trigger button
  // (a destructive git action, a delete, etc). Without restore the keyboard
  // user's focus lands on <body> after the dialog closes and the next Tab
  // restarts from the top of the document. (Panel-style overlays that
  // deliberately don't restore pass restoreFocus: false explicitly.)
  useFocusTrap(dialogRef, { restoreFocus: true })

  // Window-level Escape handler — matches the pattern used by ContextMenu
  // and GlobalSettingsModal. Stops at the document layer so it doesn't
  // also collapse a parent overlay (e.g. the Git overlay underneath).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (!busy) onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <motion.div
      className="perm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // Click on the backdrop dismisses; click on the card itself
      // bubbles back into our own onMouseDown which discards.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
      {...m.backdrop}
    >
      <motion.div className="perm-card" ref={dialogRef} {...m.card}>
        <div className="modal-header">
          <h3>{title}</h3>
        </div>
        <div className="modal-section">
          <div className="confirm-dialog-message">{message}</div>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => { void onConfirm() }}
            disabled={busy}
            // Auto-focus so Enter triggers confirm directly. Destructive
            // dialogs still require a deliberate Enter because the
            // button is the active element from the start.
            autoFocus
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
