// Prompt dialog — extends ConfirmDialog with a text input field.
// Used for rename operations where the user needs to type a new value.
//
// Same .perm-overlay / .perm-card / .modal-* CSS family as ConfirmDialog.
// The input is auto-focused so the user can start typing immediately.
// Enter in the input submits; Escape cancels.

import { useRef, useState } from 'react'
import { Overlay } from './Overlay'

interface Props {
  title: string
  message: React.ReactNode
  defaultValue: string
  confirmLabel: string
  cancelLabel?: string
  placeholder?: string
  busy?: boolean
  onConfirm: (value: string) => void | Promise<void>
  onCancel: () => void
}

export function PromptDialog({
  title,
  message,
  defaultValue,
  confirmLabel,
  cancelLabel = 'Cancel',
  placeholder,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)
  // Open/close motion is driven by motion.div + AnimatePresence (the caller
  // gates mount on the prompt state). Mirrors the old overlay-backdrop/panel
  // keyframes via useOverlayMotion (Overlay's motion mode); reduced motion
  // snaps both. restoreFocus (Overlay default) lands the keyboard user back
  // on the trigger button (rename / save-snippet) after the dialog closes.
  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== defaultValue.trim() && !busy

  const handleSubmit = () => {
    if (canSubmit) void onConfirm(trimmed)
  }

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
        <input
          ref={inputRef}
          type="text"
          className="input prompt-dialog-input"
          // placeholder is the only hint this field carries (the dialog
          // title names the operation) — surface it as the accessible name
          // so AT users get the same instruction sighted users see.
          aria-label={placeholder || undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder={placeholder}
          autoFocus
          disabled={busy}
        />
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
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Overlay>
  )
}
