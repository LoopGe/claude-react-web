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
//   - Enter on the confirm button confirms when NOT destructive. For
//     destructive dialogs the initial focus lands on Cancel instead, so a
//     reflexive Enter can't fire the destructive action.
//   - Both buttons disabled while `busy` is true
//   - The confirm button gains `.btn-danger` styling when destructive

import { Overlay } from './Overlay'

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
  /** Optional checkbox rendered below the message (e.g. "permanently
   *  delete"). When `checkboxLabel` is set, the checkbox is controlled:
   *  `checkboxChecked` is its state and `onCheckboxChange` flips it.
   *  Undefined = no checkbox (the default; existing callers unaffected). */
  checkboxLabel?: string
  checkboxChecked?: boolean
  onCheckboxChange?: (checked: boolean) => void
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
  checkboxLabel,
  checkboxChecked = false,
  onCheckboxChange,
  onConfirm,
  onCancel,
}: Props) {
  // Open/close motion is driven by motion.div + AnimatePresence (the caller
  // gates mount on the confirm state). Mirrors the old overlay-backdrop/panel
  // keyframes via useOverlayMotion (Overlay's motion mode); reduced motion
  // snaps both. The busy guards (`canCloseOnEscape` / `canCloseOnBackdrop`)
  // swallow Esc / backdrop clicks while `busy` without falling through to a
  // parent overlay or App's interrupt chain.
  //
  // restoreFocus: true (Overlay default) — ConfirmDialog is opened from a real
  // trigger button (a destructive git action, a delete, etc). Without restore
  // the keyboard user's focus lands on <body> after the dialog closes and the
  // next Tab restarts from the top of the document.
  return (
    <Overlay
      variant="perm"
      ariaLabel={title}
      motion="motion"
      onClose={onCancel}
      canCloseOnEscape={() => !busy}
      canCloseOnBackdrop={() => !busy}
    >
      <div className="modal-header">
        <h3>{title}</h3>
      </div>
      <div className="modal-section">
        <div className="confirm-dialog-message">{message}</div>
        {checkboxLabel && (
          <label className="confirm-dialog-checkbox">
            <input
              type="checkbox"
              checked={checkboxChecked}
              onChange={(e) => onCheckboxChange?.(e.target.checked)}
              disabled={busy}
            />
            {checkboxLabel}
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
          // Destructive dialogs focus Cancel — the first Enter must be a
          // deliberate choice, never a reflex that fires the destructive
          // action ("Discard", "Drop stash", "Abort merge", …).
          autoFocus={destructive}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? 'btn btn-danger-solid' : 'btn btn-primary'}
          onClick={() => { void onConfirm() }}
          disabled={busy}
          // Non-destructive dialogs focus confirm so Enter confirms.
          autoFocus={!destructive}
        >
          {busy ? 'Working...' : confirmLabel}
        </button>
      </div>
    </Overlay>
  )
}
