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
 * Offset pair for the current selection, or null when nothing is selected
 * (collapsed caret or no selection).
 */
export function selectionOffsets(
  el: HTMLElement,
): { start: number; end: number } | null {
  // Textarea: read native selection offsets directly.
  if (el instanceof HTMLTextAreaElement) {
    if (el.selectionStart === el.selectionEnd) return null
    return { start: el.selectionStart, end: el.selectionEnd }
  }

  // Contenteditable: measure from the live DOM selection.
  const selection = el.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
    return null
  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer))
    return null
  return {
    start: offsetOf(el, range.startContainer, range.startOffset),
    end: offsetOf(el, range.endContainer, range.endOffset),
  }
}

/**
 * Replace `[start, end)` with `text` and leave the caret after it.
 *
 * For contenteditable elements the DOM is rebuilt from the serialized value
 * (same path `RichPromptInput` uses on every `onChange`).  For textareas
 * the value is patched directly; the caller must still call `setInput` so
 * React's controlled state stays in sync.
 */
export function replaceOffsets(
  el: HTMLElement,
  start: number,
  end: number,
  text: string,
): void {
  if (el instanceof HTMLTextAreaElement) {
    // Textarea: patch the value and re-sync React's selection.
    const full = el.value
    el.value = full.slice(0, start) + text + full.slice(end)
    const caret = start + text.length
    el.setSelectionRange(caret, caret)
    return
  }

  // Contenteditable: rebuild from serialized value, same as onChange path.
  const full = joinTokens(serializeTokens(el))
  const next = full.slice(0, start) + text + full.slice(end)
  el.replaceChildren(renderTokens(el.ownerDocument, tokenize(next)))
  // Place the caret after the inserted text.
  placeCaretAfter(el, start + text.length)
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

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Place the collapsed caret at `target` offset within the editor's serialized
 * value.  Uses `placeCaretAtOffset` from `richPromptCaret` which handles
 * chips (opaque) and `<br>` (one character) consistently with `offsetOf`.
 */
function placeCaretAfter(el: HTMLElement, target: number): void {
  placeCaretAtOffset(el, target)
}
