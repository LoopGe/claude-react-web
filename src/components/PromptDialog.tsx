// Prompt dialog — extends ConfirmDialog with a text input field.
// Used for rename operations where the user needs to type a new value.
//
// Same .perm-overlay / .perm-card / .modal-* CSS family as ConfirmDialog.
// The input is auto-focused so the user can start typing immediately.
// Enter in the input submits; Escape cancels.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useOverlayMotion } from '../utils/transitions'

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
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)
  // Open/close motion is driven by motion.div + AnimatePresence (the caller
  // gates mount on the prompt state). Mirrors the old overlay-backdrop/panel
  // keyframes via useOverlayMotion; reduced motion snaps both.
  const m = useOverlayMotion()
  // restoreFocus so the keyboard user lands back on the trigger button
  // (rename / save-snippet) after the dialog closes, not on <body>.
  useFocusTrap(dialogRef, { restoreFocus: true })

  // Window-level Escape handler — same pattern as ConfirmDialog.
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

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== defaultValue.trim() && !busy

  const handleSubmit = () => {
    if (canSubmit) void onConfirm(trimmed)
  }

  return (
    <motion.div
      className="perm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
          <input
            ref={inputRef}
            type="text"
            className="input prompt-dialog-input"
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
      </motion.div>
    </motion.div>
  )
}
