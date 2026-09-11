import { useCallback, useMemo, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react'
import {
  formatPastedTextRef,
  planPaste,
  refKeyAction,
  refRanges,
  type PastePlan,
} from '../utils/pastedText'

/**
 * Textarea behaviour for `[Pasted text #N]` references, shared by every
 * composer that supports collapsed pastes.
 *
 * The paste POLICY lives in `utils/pastedText.ts`; this owns the DOM side of
 * it — where to splice, which keys a reference swallows, how a paste is
 * routed. Keeping it here means the main composer and the side-chat drawer
 * can't drift on the native-insert fallback or the atomic-edit rules.
 */
export interface PastedTextEditing {
  /** Replace `[from, to)` with `text`, native-first so the browser's undo
   *  stack survives. */
  replaceRange: (from: number, to: number, text: string) => void
  /** Insert `text` at the live caret. */
  insertAtCaret: (text: string) => void
  /** Store a clipboard text and insert whatever should land in the composer:
   *  the paste verbatim when small, else a reference. Exposed so a caller
   *  with a different caret target (the context menu's saved selection) can
   *  reuse the same decision. */
  placePastedText: (
    raw: string,
    insert: (text: string) => void,
    plan?: PastePlan,
  ) => void
  /** Reference-aware keydown. Returns true when the key was consumed. */
  handleRefKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Widen the browser's word-select out to the whole reference it landed in. */
  widenToRef: () => void
  /** The textarea's onPaste: attaches any image items, then collapses an
   *  oversized text/plain. */
  handlePaste: (
    e: ClipboardEvent<HTMLTextAreaElement>,
    onPasteImage?: (file: File) => void,
  ) => void
}

export function usePastedTextEditing({
  input,
  setInput,
  textareaRef,
  addPastedText,
  onFallbackEdit,
}: {
  input: string
  setInput: (v: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  addPastedText: (content: string) => number
  /** Called when a native command is unavailable and the edit goes through
   *  the splice fallback — lets a caller reset its history cursor. */
  onFallbackEdit?: () => void
}): PastedTextEditing {
  const replaceRange = useCallback(
    (from: number, to: number, text: string) => {
      const el = textareaRef.current
      if (!el) return
      el.setSelectionRange(from, to)
      // `insertText` with an empty string is a no-op on some engines, so a
      // pure removal goes through the dedicated delete command instead. Both
      // fire a native input event, so the caller's onChange runs for us and
      // the browser's undo stack stays intact.
      const native =
        text === ''
          ? el.ownerDocument?.execCommand?.('delete')
          : el.ownerDocument?.execCommand?.('insertText', false, text)
      if (native) return
      // Fallback for engines without execCommand (e.g. jsdom).
      setInput(input.slice(0, from) + text + input.slice(to))
      onFallbackEdit?.()
      const caret = from + text.length
      requestAnimationFrame(() => el.setSelectionRange(caret, caret))
    },
    [input, setInput, textareaRef, onFallbackEdit],
  )

  const insertAtCaret = useCallback(
    (text: string) => {
      const el = textareaRef.current
      if (!el) return
      replaceRange(el.selectionStart, el.selectionEnd, text)
    },
    [replaceRange, textareaRef],
  )

  const placePastedText = useCallback(
    (raw: string, insert: (text: string) => void, plan: PastePlan = planPaste(raw)) => {
      if (!plan.collapsed) {
        // Verbatim — the exact string the browser would have inserted itself.
        insert(raw)
        return
      }
      const id = addPastedText(plan.normalized)
      insert(formatPastedTextRef(id, plan.numLines))
    },
    [addPastedText],
  )

  const handleRefKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Shift is excluded so Shift+Arrow still extends a selection and
      // Shift+Delete / Shift+Backspace stay the platform cut. The other
      // modifiers keep their word- and line-delete meanings.
      if (
        e.nativeEvent.isComposing ||
        e.shiftKey || e.altKey || e.ctrlKey || e.metaKey
      ) {
        return false
      }
      const el = textareaRef.current
      const caret = el?.selectionStart
      if (!el || caret == null || caret !== el.selectionEnd) return false
      const action = refKeyAction(input, caret, e.key)
      if (!action) return false
      e.preventDefault()
      if (action.kind === 'move') el.setSelectionRange(action.caret, action.caret)
      else replaceRange(action.from, action.to, '')
      return true
    },
    [input, textareaRef, replaceRange],
  )

  const widenToRef = useCallback(() => {
    const el = textareaRef.current
    if (!el || el.selectionStart === el.selectionEnd) return
    const range = refRanges(input).find(
      (r) => r.start <= el.selectionStart && el.selectionStart < r.end,
    )
    if (range) el.setSelectionRange(range.start, range.end)
  }, [input, textareaRef])

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>, onPasteImage?: (file: File) => void) => {
      // Collect every image item, but do NOT return: a clipboard can carry an
      // image AND a large text/plain (copying a selection out of a rich
      // editor, say), and bailing here would let the browser insert that body
      // inline, uncollapsed.
      const items = e.clipboardData?.items
      if (items && onPasteImage) {
        for (const item of items) {
          if (item.type.startsWith('image/') && item.type !== 'image/svg+xml') {
            const file = item.getAsFile()
            if (file) void onPasteImage(file)
          }
        }
      }
      // A paste large enough to hurt the textarea collapses into a reference;
      // anything shorter is left to the browser's own insert.
      const raw = e.clipboardData?.getData('text/plain') ?? ''
      if (!raw) return
      const plan = planPaste(raw)
      if (!plan.collapsed) return
      e.preventDefault()
      placePastedText(raw, insertAtCaret, plan)
    },
    [insertAtCaret, placePastedText],
  )

  return useMemo(
    () => ({ replaceRange, insertAtCaret, placePastedText, handleRefKeyDown, widenToRef, handlePaste }),
    [replaceRange, insertAtCaret, placePastedText, handleRefKeyDown, widenToRef, handlePaste],
  )
}
