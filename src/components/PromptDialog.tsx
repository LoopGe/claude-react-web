// Prompt dialog — extends ConfirmDialog with a text input field.
// Used for rename operations where the user needs to type a new value.
//
// Same .perm-overlay / .perm-card / .modal-* CSS family as ConfirmDialog.
// The input is auto-focused so the user can start typing immediately.
// Enter in the input submits; Escape cancels.

import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  open?: boolean
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
  open = true,
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
  useFocusTrap(dialogRef)

  // Window-level Escape handler — same pattern as ConfirmDialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (open && !busy) onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel, open])

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== defaultValue.trim() && !busy

  const handleSubmit = () => {
    if (canSubmit) void onConfirm(trimmed)
  }

  return (
    <div
      className="perm-overlay"
      data-state={open ? 'open' : 'closing'}
      role="dialog"
      aria-modal={open ? 'true' : 'false'}
      aria-hidden={!open}
      aria-label={title}
      onMouseDown={(e) => {
        if (open && e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div className="perm-card" ref={dialogRef}>
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
      </div>
    </div>
  )
}
