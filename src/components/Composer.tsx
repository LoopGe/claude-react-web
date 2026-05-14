// Chat composer: textarea + attachments + send/interrupt buttons.
//
// Pure UI — all side-effecting bits (upload, send, interrupt, history
// persistence) are passed in. The keyboard handling is deliberately
// terminal-ish: Enter sends, Shift+Enter newlines, Ctrl/Cmd+P/N walks
// history, bare ↑/↓ walks history only at the text edge so multi-line
// drafts stay editable.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '../hooks/useAttachments'
import type { InputHistoryApi } from '../hooks/useInputHistory'
import type { PastedImage, SlashCommand } from '../types'
import { CommandPicker } from './CommandPicker'

interface Props {
  input: string
  setInput: (v: string) => void
  sending: boolean
  disabled: boolean
  /** True when the session has permanently ended (terminated). Shows a
   *  "session ended" message instead of the disabled textarea. */
  terminated?: boolean
  /** Why the session terminated (shown below the ended message). */
  terminatedReason?: string
  /** True when the session has no cwd — attach button greyed with a tooltip. */
  canAttach: boolean

  attachments: Attachment[]
  uploading: boolean
  dragOver: boolean
  onUploadFiles: (files: File[]) => void
  onRemoveAttachment: (path: string) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void

  history: InputHistoryApi
  /** Slash commands from the SDK, fetched by the parent. */
  commands?: SlashCommand[]
  /** Pending pasted images to send inline. */
  pastedImages: PastedImage[]
  onPasteImage: (file: File) => Promise<void>
  onRemovePastedImage: (id: string) => void
  onSend: () => void
  onInterrupt: () => void
  /** True only while there's an outstanding turn the server can interrupt.
   *  When no turn is in flight, Interrupt is a no-op, and leaving the
   *  button active just confuses users. */
  canInterrupt: boolean
  /** Bump this number whenever the parent wants the textarea refocused
   *  (e.g. after a successful send, where the click on the Send button
   *  would otherwise leave focus on the button). */
  focusSignal?: number
}

export const Composer = memo(function Composer({
  input,
  setInput,
  sending,
  disabled,
  terminated,
  terminatedReason,
  canAttach,
  attachments,
  uploading,
  dragOver,
  onUploadFiles,
  onRemoveAttachment,
  onDragOver,
  onDragLeave,
  onDrop,
  history,
  commands,
  pastedImages,
  onPasteImage,
  onRemovePastedImage,
  onSend,
  onInterrupt,
  canInterrupt,
  focusSignal,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ---- Slash command picker state ----
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerIndex, setPickerIndex] = useState(0)

  /** Filter commands by prefix match against name + aliases. */
  const filteredCommands = useMemo(() => {
    if (!commands) return []
    if (!pickerQuery) return commands
    const q = pickerQuery.toLowerCase()
    return commands.filter(
      (c) =>
        c.name.toLowerCase().startsWith(q) ||
        c.aliases?.some((a) => a.toLowerCase().startsWith(q)),
    )
  }, [commands, pickerQuery])

  /** Replace the current "/xxx" token with the confirmed command name. */
  const confirmPicker = useCallback(() => {
    const cmd = filteredCommands[pickerIndex]
    if (!cmd) return
    const caret = textareaRef.current?.selectionStart ?? input.length
    const before = input.slice(0, caret)
    const wordStart = before.lastIndexOf(' ') + 1
    const after = input.slice(caret)
    const newText = input.slice(0, wordStart) + '/' + cmd.name + ' ' + after
    setInput(newText)
    setPickerOpen(false)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const newPos = wordStart + cmd.name.length + 2 // '/' + name + ' '
      el.focus()
      el.setSelectionRange(newPos, newPos)
    })
  }, [input, setInput, pickerIndex, filteredCommands])

  // After a history step the textarea's caret is still where it was,
  // which on a multi-line recall puts you in the middle of the prompt.
  // Move it to the end so the next keystroke feels like editing the tail,
  // matching bash / Claude Code CLI history behaviour.
  const recall = useCallback(
    (text: string) => {
      setInput(text)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(text.length, text.length)
      })
    },
    [setInput],
  )

  // Focus the textarea when the composer (re)mounts for a new session.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Refocus on parent request (e.g. after send, where clicking the Send
  // button moved focus off the textarea). A number signal instead of a
  // boolean so repeated identical requests still fire — every increment
  // is a distinct event even if the previous one hadn't settled.
  useEffect(() => {
    if (focusSignal == null) return
    textareaRef.current?.focus()
  }, [focusSignal])

  const openFilePicker = () => fileInputRef.current?.click()

  const canSend = !disabled && !sending && (input.trim() !== '' || attachments.length > 0 || pastedImages.length > 0)

  if (terminated) {
    const reasonText =
      terminatedReason === 'query_error' ? 'Upstream error'
      : terminatedReason === 'query_ended' ? 'Connection closed'
      : terminatedReason === 'process_killed' ? 'Process killed'
      : terminatedReason === 'process_exited' ? 'Process exited'
      : terminatedReason === 'init_stuck' ? 'Init timed out'
      : terminatedReason === 'stuck' ? 'Session unresponsive'
      : terminatedReason === 'deleted' ? 'Session deleted'
      : null
    return (
      <div className="session-ended">
        <span>This session has ended{reasonText ? `: ${reasonText}` : ''}.</span>
        <span className="session-ended-hint">Create a new session to continue.</span>
      </div>
    )
  }

  return (
    <div
      className={`chat-composer ${dragOver ? 'chat-composer-drag' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="composer-main">
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a) => (
              <span key={a.path} className="attachment-chip" title={a.path}>
                <span className="attachment-chip-name">📎 {a.name}</span>
                <span className="attachment-chip-size">{formatBytes(a.size)}</span>
                <button
                  type="button"
                  className="attachment-chip-remove"
                  onClick={() => onRemoveAttachment(a.path)}
                  aria-label={`Remove ${a.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
            {uploading && <span className="attachment-chip attachment-chip-ghost">uploading…</span>}
          </div>
        )}
        {pastedImages.length > 0 && (
          <div className="image-previews">
            {pastedImages.map((img) => (
              <div key={img.id} className="image-preview-card">
                <img src={img.previewUrl} alt={img.mediaType} />
                <button
                  type="button"
                  className="image-preview-remove"
                  onClick={() => onRemovePastedImage(img.id)}
                  aria-label="Remove image"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="textarea"
          placeholder={
            dragOver
              ? 'Drop files to attach…'
              : 'Send a message (Enter = send, Shift+Enter = newline, ↑/↓ history, 📎 to attach)'
          }
          value={input}
          onPaste={(e) => {
            const items = e.clipboardData?.items
            if (!items) return
            for (const item of items) {
              if (item.type.startsWith('image/') && item.type !== 'image/svg+xml') {
                e.preventDefault()
                const file = item.getAsFile()
                if (file) void onPasteImage(file)
                return
              }
            }
          }}
          onChange={(e) => {
            const val = e.target.value
            setInput(val)
            if (history.isBrowsing()) history.reset()

            // Slash command trigger: detect if the caret is inside a
            // word that starts with "/" (at a word boundary).
            const caret = e.target.selectionStart
            const before = val.slice(0, caret)
            const wordStart = before.lastIndexOf(' ') + 1
            const word = before.slice(wordStart)
            if (word.startsWith('/') && !word.includes(' ') && commands && commands.length > 0) {
              setPickerOpen(true)
              setPickerQuery(word.slice(1))
              setPickerIndex(0)
            } else if (pickerOpen) {
              setPickerOpen(false)
            }
          }}
          onKeyDown={(e) => {
            // When the slash command picker is open, route arrow/enter/escape
            // to the picker instead of the existing history/send handlers.
            if (pickerOpen) {
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setPickerIndex((i) => Math.max(0, i - 1))
                return
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setPickerIndex((i) => i + 1)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                confirmPicker()
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setPickerOpen(false)
                return
              }
              // All other keys (letters, backspace, etc.) fall through to
              // onChange which will re-filter or close the picker.
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
              return
            }
            // Ctrl/Cmd+P / Ctrl/Cmd+N — unconditional history nav, matches
            // bash / emacs bindings. Works even mid-line.
            if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'n')) {
              e.preventDefault()
              const next = e.key === 'p' ? history.prev(input) : history.next()
              if (next != null) recall(next)
              return
            }
            // Bare ↑ / ↓ only recall history when the caret is at a line
            // edge that would otherwise do nothing useful (first line for
            // up, last line for down) — so editing a multi-line draft
            // still works naturally.
            const el = textareaRef.current
            if (!el) return
            if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey) {
              const caretAtTop = el.selectionStart === 0 || !input.slice(0, el.selectionStart).includes('\n')
              if (caretAtTop) {
                const next = history.prev(input)
                if (next != null) {
                  e.preventDefault()
                  recall(next)
                }
              }
            } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey) {
              const caretAtBottom =
                el.selectionEnd === input.length || !input.slice(el.selectionEnd).includes('\n')
              if (caretAtBottom && history.isBrowsing()) {
                const next = history.next()
                if (next != null) {
                  e.preventDefault()
                  recall(next)
                }
              }
            }
          }}
          disabled={disabled}
        />
        {pickerOpen && filteredCommands.length > 0 && (
          <CommandPicker
            commands={commands!}
            query={pickerQuery}
            selectedIndex={pickerIndex}
            anchorRef={textareaRef}
            onSelect={(cmd) => {
              // Confirm directly with the clicked command.
              const caret = textareaRef.current?.selectionStart ?? input.length
              const before = input.slice(0, caret)
              const wordStart = before.lastIndexOf(' ') + 1
              const after = input.slice(caret)
              const newText = input.slice(0, wordStart) + '/' + cmd.name + ' ' + after
              setInput(newText)
              setPickerOpen(false)
              requestAnimationFrame(() => {
                const el = textareaRef.current
                if (!el) return
                const newPos = wordStart + cmd.name.length + 2
                el.focus()
                el.setSelectionRange(newPos, newPos)
              })
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <div className="chat-composer-actions">
        <button
          className="btn"
          type="button"
          onClick={openFilePicker}
          disabled={disabled || uploading || !canAttach}
          title={canAttach ? 'Attach files' : 'Attach disabled: session has no cwd'}
        >
          📎
        </button>
        <button className="btn btn-primary" onClick={onSend} disabled={!canSend}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button
          className="btn btn-danger"
          onClick={onInterrupt}
          disabled={disabled || !canInterrupt}
          title={canInterrupt ? 'Interrupt the current turn' : 'Nothing to interrupt'}
        >
          Interrupt
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : []
          // Reset the input so selecting the same file twice in a row
          // still triggers a change event.
          e.target.value = ''
          if (files.length > 0) onUploadFiles(files)
        }}
      />
    </div>
  )
})

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
