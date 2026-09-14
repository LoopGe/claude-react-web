import { offsetOf, placeCaretAtOffset } from './richPromptCaret'
import { joinTokens, tokenize } from '../utils/pastedText'
import { renderTokens, serializeTokens } from '../utils/richPromptDom'

/**
 * Offset-based selection helpers over a rich-prompt editor element.
 *
 * The context menu needs offsets because it acts on a snapshot taken when it
 * opened, not on live DOM state -- see Composer's savedSelection.
 *
 * All functions work on any `HTMLElement`: contenteditable editors (the rich
 * prompt) and textareas (the current textarea path).  Textarea offsets are
 * read from `selectionStart`/`selectionEnd`; contenteditable offsets are
 * measured via `offsetOf` from `richPromptCaret`, which is consistent with
 * `serializeTokens` for chips and `<br>` elements.
 */

/**
 * Offset pair for the current selection or caret.
 *
 * For a non-collapsed selection `{ start, end }` marks the selected range.
 * For a collapsed caret `{ start: N, end: N }` where both values are the same
 * — the context menu needs this to paste at the right position.  Returns
 * `null` only when there is no selection at all (e.g. the element is not
 * focused).
 */
export function selectionOffsets(
  el: HTMLElement,
): { start: number; end: number } | null {
  // Textarea: read native selection offsets directly.
  if (el instanceof HTMLTextAreaElement) {
    return { start: el.selectionStart, end: el.selectionEnd }
  }

  // Contenteditable: measure from the live DOM selection.
  const selection = el.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer))
    return null
  const start = offsetOf(el, range.startContainer, range.startOffset)
  const end = offsetOf(el, range.endContainer, range.endOffset)
  return { start, end }
}

/**
 * Replace `[start, end)` with `text` and leave the caret after it.
 *
 * For contenteditable elements the DOM is rebuilt from the serialized value
 * (same path `RichPromptInput` uses on every `onChange`).  For textareas
 * only the caret is restored -- the value has already been patched by the
 * caller via `setInput`.
 *
 * **Does not fire `onChange`.**  Callers that use this outside the Composer's
 * `insertAtSavedSelection` flow must ensure React's controlled state is
 * updated separately or the parent will desync.
 */
export function replaceOffsets(
  el: HTMLElement,
  start: number,
  end: number,
  text: string,
): void {
  if (el instanceof HTMLTextAreaElement) {
    // Textarea: the caller already patched the value via setInput; only
    // restore focus and place the caret after the inserted text.
    const caret = start + text.length
    el.setSelectionRange(caret, caret)
    return
  }

  // Contenteditable: rebuild from serialized value, same as onChange path.
  const full = joinTokens(serializeTokens(el))
  const next = full.slice(0, start) + text + full.slice(end)
  el.replaceChildren(renderTokens(el.ownerDocument, tokenize(next)))
  // Place the caret after the inserted text.
  placeCaretAtOffset(el, start + text.length)
}

/** Select the whole editor contents. */
export function selectAll(el: HTMLElement): void {
  if (el instanceof HTMLTextAreaElement) {
    el.focus()
    el.setSelectionRange(0, el.value.length)
    return
  }

  const doc = el.ownerDocument
  const range = doc.createRange()
  range.selectNodeContents(el)
  const selection = doc.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

