/**
 * Caret queries for the rich composer, as pure functions over
 * `(text, offset)`.
 *
 * The offsets come from a DOM Range measured against the editor's serialized
 * text -- the same string `RichPromptInput` keeps as its value -- so these can
 * be tested without a DOM and cannot drift from the serializer.
 */

const CHIP_ATTR = 'data-pasted-ref'

// ---------------------------------------------------------------------------
// DOM-position -> serialized-offset measurement
// ---------------------------------------------------------------------------

/**
 * Map a `(container, offset)` DOM position to a character offset within the
 * editor's serialized text.
 *
 * Text nodes inside chip elements (spans with `data-pasted-ref`) are ignored
 * for offset counting -- a chip is a single reference in the serialized value,
 * so its DOM text length does not contribute to the character offset.  This is
 * the measurement the slash-command picker and history navigation rely on.
 *
 * @param root   The editor root element.
 * @param container  The DOM node containing the caret.
 * @param offset     The caret offset within `container` (text node offset).
 */
export function offsetOf(
  root: Element,
  container: Node,
  offset: number,
): number {
  let count = 0

  const walk = (node: Node): boolean => {
    // A chip is a single reference token: count its full label text, but
    // do not descend into its children (which could contain arbitrary
    // DOM text that is irrelevant to the serialized offset).
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).hasAttribute(CHIP_ATTR)
    ) {
      count += (node.textContent ?? '').length
      return false
    }

    if (node.nodeType === Node.TEXT_NODE) {
      if (node === container) {
        count += offset
        return true
      }
      count += (node.nodeValue ?? '').length
      return false
    }

    // <br> is serialized as '\n' (one character) by serializeTokens, but
    // Range.toString() returns '' for it.  Count it explicitly.
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      count += 1
      return false
    }

    // Element node (non-chip, non-br) -- walk children.
    let found = false
    for (const child of Array.from(node.childNodes)) {
      if (found) break
      if (walk(child)) found = true
    }
    return found
  }

  walk(root)
  return count
}

/**
 * Place the caret at a given serialized character offset within `root`.
 *
 * This is the inverse of `offsetOf`: given a character position in the
 * serialized value, walk the DOM using the same chip/br rules and collapse
 * the selection at the corresponding DOM node+offset.
 *
 * @returns `true` if the caret was placed, `false` if `target` exceeds the
 *          serialized length.
 */
export function placeCaretAtOffset(root: Element, target: number): boolean {
  let remaining = target

  const walk = (node: Node): boolean => {
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).hasAttribute(CHIP_ATTR)
    ) {
      // Chip: opaque, same count as offsetOf.
      remaining -= (node.textContent ?? '').length
      return false
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length
      if (len >= remaining) {
        const sel = root.ownerDocument.getSelection()
        if (!sel) return false
        sel.collapse(node, remaining)
        return true
      }
      remaining -= len
      return false
    }

    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      remaining -= 1
      return false
    }

    // Element node (non-chip, non-br) -- walk children.
    let found = false
    for (const child of Array.from(node.childNodes)) {
      if (found) break
      if (walk(child)) found = true
    }
    return found
  }

  return walk(root)
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
