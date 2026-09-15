/**
 * Caret queries for the rich composer, as pure functions over
 * `(text, offset)`.
 *
 * The offsets come from a DOM Range measured against the editor's serialized
 * text -- the same string `RichPromptInput` keeps as its value. The
 * measurement is built on `collectSegments`, the ONE DOM → text walk, so it
 * cannot drift from the serializer; an earlier version walked the DOM with its
 * own rules and promptly did (it counted a lone `<br>` that the serializer had
 * learned to ignore).
 */

import { collectSegments } from '../utils/richPromptDom'

// ---------------------------------------------------------------------------
// DOM-position -> serialized-offset measurement
// ---------------------------------------------------------------------------

/**
 * Map a `(container, offset)` DOM position to a character offset within the
 * editor's serialized text.
 *
 * Stops the shared walk at the given position and sums what came before it, so
 * the answer is by construction the number of characters ahead of the caret in
 * the value the caret arithmetic is about to index into.
 *
 * @param root   The editor root element.
 * @param container  The DOM node containing the caret.
 * @param offset     The caret offset within `container`.
 */
export function offsetOf(root: Element, container: Node, offset: number): number {
  let count = 0
  for (const segment of collectSegments(root, { container, offset })) {
    count += segment.text.length
  }
  return count
}

/**
 * Place the caret at a given serialized character offset within `root`.
 *
 * The inverse of `offsetOf`: walk the same segments and collapse the selection
 * in the one the offset lands in.
 *
 * @returns `true` if the caret was placed, `false` if `target` exceeds the
 *          serialized length.
 */
export function placeCaretAtOffset(root: Element, target: number): boolean {
  const doc = root.ownerDocument
  const selection = doc.getSelection()
  if (!selection) return false

  let remaining = target
  for (const segment of collectSegments(root)) {
    if (remaining > segment.text.length) {
      remaining -= segment.text.length
      continue
    }
    if (segment.textNode) {
      selection.collapse(segment.textNode, remaining)
      return true
    }
    // A chip or a break the browser materialised as an element: there is no
    // text node to sit in, so collapse against that element. WHICH side
    // matters — a target landing exactly at the end of this segment means
    // "after it", and putting the caret before instead sends the next
    // keystroke to the wrong side of the reference.
    if (segment.element) {
      const range = doc.createRange()
      if (remaining === segment.text.length) range.setStartAfter(segment.element)
      else range.setStartBefore(segment.element)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    }
    return false
  }
  return false
}

// ---------------------------------------------------------------------------
// Pure helpers -- (text, offset) only, no DOM dependency
// ---------------------------------------------------------------------------

/** The `/word` ending at `offset`, or null when there isn't one. */
export function slashWordBefore(text: string, offset: number): string | null {
  const before = text.slice(0, offset)
  const wordStart = before.lastIndexOf(' ') + 1
  const word = before.slice(wordStart)
  return word.startsWith('/') && !word.includes(' ') ? word : null
}

/** True when nothing before `offset` spans a line break. */
export function caretOnFirstLine(text: string, offset: number): boolean {
  return !text.slice(0, offset).includes('\n')
}
