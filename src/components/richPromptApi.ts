import { offsetOf, placeCaretAtOffset } from './richPromptCaret'

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
 * Focus the element and place a collapsed caret at `offset` characters into
 * its serialized text.  For textareas this is `setSelectionRange`; for
 * contenteditable elements it delegates to `placeCaretAtOffset` from
 * `richPromptCaret`.
 *
 * This is the only deferred-action primitive the context menu needs: the
 * caller has already applied the text edit via `setInput` / React re-render,
 * so the DOM is up to date — only the caret needs restoring.
 */
export function placeCaretIn(el: HTMLElement, offset: number): void {
  el.focus()
  if (el instanceof HTMLTextAreaElement) {
    el.setSelectionRange(offset, offset)
    return
  }
  placeCaretAtOffset(el, offset)
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

