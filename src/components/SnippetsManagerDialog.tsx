// Composer snippets manager. CRUD UI for the localStorage-backed list
// of reusable text blocks driven by useComposerSnippets.
//
// Layout: vertical list of existing snippets with inline edit + delete +
// move-up/down, followed by an "Add new" form. Mirrors the .perm-overlay /
// .perm-card / .modal-* structure used by ConfirmDialog and PromptDialog
// so it inherits dark/light theme handling without bespoke CSS.
//
// Close / dismiss handling deliberately routes through `tryClose`:
// pressing Escape, clicking the backdrop, or clicking the Close button
// all check `isDirty` (any unsaved edit or non-empty new-form draft)
// and switch the footer into a "Discard unsaved changes?" mode rather
// than silently destroying the work. This is in-band rather than a
// stacked ConfirmDialog because nested modals create focus-trap and
// z-index ambiguity that's not worth the complexity.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconPencil, IconTrash, IconArrowUp, IconArrowDown } from './icons/ToolIcons'
import type { ComposerSnippet, ComposerSnippetsApi } from '../hooks/useComposerSnippets'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  open?: boolean
  api: ComposerSnippetsApi
  onClose: () => void
}

export function SnippetsManagerDialog({ open = true, api, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { restoreFocus: true })

  // Inline-edit state — only one snippet is editable at a time. The draft
  // is a local copy so cancelling cleanly reverts; on save we forward to
  // the api.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editContent, setEditContent] = useState('')

  // New-snippet form state.
  const [newLabel, setNewLabel] = useState('')
  const [newContent, setNewContent] = useState('')

  /** When the user has unsaved changes and tries to close, the footer
   *  flips to a "Discard?" prompt instead of unmounting. They can either
   *  go back to editing or confirm the discard. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  /** Ref on the new-form label input — used to override useFocusTrap's
   *  default first-focusable-child behaviour, which would otherwise
   *  land on the row-0 Move-up button (often disabled, always
   *  surprising). */
  const initialFocusRef = useRef<HTMLInputElement>(null)

  const startEdit = (s: ComposerSnippet) => {
    setEditingId(s.id)
    setEditLabel(s.label)
    setEditContent(s.content)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditLabel('')
    setEditContent('')
  }

  const commitEdit = () => {
    const id = editingId
    if (!id) return
    const label = editLabel.trim()
    const content = editContent
    if (!label || !content) return
    api.update(id, { label, content })
    cancelEdit()
  }

  const addNew = () => {
    const label = newLabel.trim()
    const content = newContent
    if (!label || !content) return
    api.add(label, content)
    setNewLabel('')
    setNewContent('')
  }

  const canAdd = newLabel.trim() !== '' && newContent !== ''
  const canCommitEdit = editLabel.trim() !== '' && editContent !== ''

  /** True when there's a real edit in progress whose draft would be lost
   *  on close. We compare against the persisted snippet rather than just
   *  checking `editingId !== null` so that "clicked Edit then immediately
   *  closed without typing" doesn't pester the user. */
  const isDirty = useMemo(() => {
    const editing = editingId ? api.snippets.find((s) => s.id === editingId) : null
    const editDirty = editing
      ? editLabel !== editing.label || editContent !== editing.content
      : false
    const addDirty = newLabel.trim() !== '' || newContent.trim() !== ''
    return editDirty || addDirty
  }, [editingId, editLabel, editContent, newLabel, newContent, api.snippets])

  const tryClose = useCallback(() => {
    if (isDirty) {
      setConfirmingDiscard(true)
    } else {
      onClose()
    }
  }, [isDirty, onClose])

  // Window-level Escape — matches PromptDialog's pattern. Container-only
  // onKeyDown was fragile because Escape could be missed if focus drifted
  // outside the dialog (autofill popup, browser chrome).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open || e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      tryClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, tryClose])

  // Override useFocusTrap's first-child autofocus. The trap's effect
  // also runs after mount; this one runs after-after so it wins. We
  // also intentionally don't re-focus on every state change — the user
  // may have moved focus elsewhere and we shouldn't yank it back.
  useEffect(() => {
    initialFocusRef.current?.focus()
  }, [])

  return (
    <div
      className="perm-overlay"
      data-state={open ? 'open' : 'closing'}
      role="dialog"
      aria-modal={open ? 'true' : 'false'}
      aria-hidden={!open}
      aria-label="Manage composer snippets"
      onMouseDown={(e) => {
        if (open && e.target === e.currentTarget) tryClose()
      }}
    >
      <div className="perm-card snippets-manager-card" ref={dialogRef}>
        <div className="modal-header">
          <h3>Composer snippets</h3>
        </div>

        <div className="modal-section snippets-manager-list">
          {api.snippets.length === 0 ? (
            <div className="snippets-manager-empty">
              No snippets yet. Add one below — they appear in the right-click menu of every chat composer.
            </div>
          ) : (
            api.snippets.map((s, i) => {
              const isEditing = editingId === s.id
              return (
                <div key={s.id} className={`snippet-row ${isEditing ? 'snippet-row-editing' : ''}`}>
                  {isEditing ? (
                    <div className="snippet-edit-form">
                      <input
                        type="text"
                        className="input"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        aria-label="Snippet label"
                        placeholder="Label"
                        autoFocus
                      />
                      <textarea
                        className="textarea"
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        aria-label="Snippet content"
                        placeholder="Snippet content"
                        rows={4}
                      />
                      <div className="snippet-edit-actions">
                        <button type="button" className="btn" onClick={cancelEdit}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={commitEdit}
                          disabled={!canCommitEdit}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="snippet-meta">
                        <div className="snippet-label">{s.label}</div>
                        <div className="snippet-preview" title={s.content}>{s.content}</div>
                      </div>
                      <div className="snippet-actions">
                        <button
                          type="button"
                          className="btn btn-icon"
                          title="Move up"
                          aria-label="Move up"
                          disabled={i === 0}
                          onClick={() => api.move(i, -1)}
                        >
                          <IconArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          title="Move down"
                          aria-label="Move down"
                          disabled={i === api.snippets.length - 1}
                          onClick={() => api.move(i, 1)}
                        >
                          <IconArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          title="Edit"
                          onClick={() => startEdit(s)}
                        >
                          <IconPencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon btn-danger"
                          title="Delete"
                          onClick={() => api.remove(s.id)}
                        >
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="modal-section snippets-manager-add">
          <div className="snippets-manager-add-title">Add new snippet</div>
          <input
            ref={initialFocusRef}
            type="text"
            className="input"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            aria-label="Snippet label"
            placeholder="Label (shown in the menu)"
          />
          <textarea
            className="textarea"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            aria-label="Snippet content"
            placeholder="Snippet content (inserted at caret)"
            rows={3}
          />
          <div className="snippet-edit-actions">
            <button type="button" className="btn btn-primary" onClick={addNew} disabled={!canAdd}>
              Add snippet
            </button>
          </div>
        </div>

        <div className="modal-footer">
          {confirmingDiscard ? (
            <>
              <span className="snippets-discard-warning">Discard unsaved changes?</span>
              <div className="snippets-discard-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirmingDiscard(false)}
                  autoFocus
                >
                  Keep editing
                </button>
                <button type="button" className="btn btn-danger" onClick={onClose}>
                  Discard
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn" onClick={tryClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
