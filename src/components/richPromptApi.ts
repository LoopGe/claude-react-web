import { offsetOf, placeCaretAtOffset } from './richPromptCaret'

/**
 * Offset-based selection helpers over the rich-prompt contenteditable editor.
 *
 * The context menu needs offsets because it acts on a snapshot taken when it
 * opened, not on live DOM state -- see Composer's savedSelection.
 *
 * Offsets are measured via `offsetOf` from `richPromptCaret`, which is
 * consistent with `serializeTokens` for chips and `<br>` elements.
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
  // Measure from the live DOM selection.
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
 * its serialized text.  Delegates to `placeCaretAtOffset` from
 * `richPromptCaret`.
 *
 * This is the only deferred-action primitive the context menu needs: the
 * caller has already applied the text edit via `setInput` / React re-render,
 * so the DOM is up to date — only the caret needs restoring.
 */
export function placeCaretIn(el: HTMLElement, offset: number): void {
  el.focus()
  placeCaretAtOffset(el, offset)
}

/** Select the whole editor contents. */
export function selectAll(el: HTMLElement): void {
  const doc = el.ownerDocument
  const range = doc.createRange()
  range.selectNodeContents(el)
  const selection = doc.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * Build an `onPasteText` callback that splices the inserted text at the live
 * caret and restores the caret afterwards. Shared by the main Composer and
 * the SideChatDrawer so the two can't diverge on caret handling — they once
 * did (the drawer appended to the end instead of splicing, and did not
 * restore the caret).
 *
 * `getEl` reads the element lazily (at paste time) so a ref's `.current` is
 * always current. `input`/`setInput` are captured at the render that
 * produces the callback, which is correct because the paste event fires
 * after the render commits.
 *
 * Returns the callback for `RichPromptInput.onPasteText`: it returns `true`
 * when the paste was collapsed into a reference (the editor should not
 * insert anything itself) and `false` when the caller declined (the editor
 * falls back to inserting the verbatim text).
 */
export function pasteAtCaret(
  getEl: () => HTMLElement | null,
  input: string,
  setInput: (v: string) => void,
  placePastedText: (raw: string, insert: (text: string) => void) => void,
): (raw: string) => boolean {
  return (raw: string) => {
    let textToInsert: string | null = null
    placePastedText(raw, (text) => { textToInsert = text })
    if (textToInsert === null) return false
    const text: string = textToInsert
    const el = getEl()
    const offsets = el ? selectionOffsets(el) : null
    const pos = offsets?.start ?? input.length
    const endPos = offsets?.end ?? pos
    const next = input.slice(0, pos) + text + input.slice(endPos)
    setInput(next)
    if (el) {
      const caretPos = pos + text.length
      requestAnimationFrame(() => placeCaretIn(el, caretPos))
    }
    return true
  }
}

