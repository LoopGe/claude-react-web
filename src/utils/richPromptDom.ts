import { type PastedTextToken } from './pastedText'

/**
 * DOM ⇄ token bridge for the rich composer.
 *
 * The editor renders `PastedTextToken`s as DOM and serializes that DOM back to
 * the same tokens. Both directions live here, together, so the round-trip is
 * testable without mounting React — that round-trip is the whole safety
 * property of replacing a textarea with a contenteditable.
 *
 * Line breaks are literal `\n` characters in text nodes, which the editor
 * styles with `white-space: pre-wrap` rather than materialising as `<br>`. The
 * serializer still accepts `<br>` so it can't silently drop a break a browser
 * or an IME inserted behind our back.
 */

/** Marks a chip element and carries the reference id it stands for. */
export const CHIP_ATTR = 'data-pasted-ref'
export const CHIP_CLASS = 'pasted-text-chip'

// Numeric node types rather than the `Node` globals, so this module needs no
// DOM globals in scope to be imported.
const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Build DOM for `tokens`. The caller owns `doc` (usually `document`). */
export function renderTokens(doc: Document, tokens: PastedTextToken[]): DocumentFragment {
  const fragment = doc.createDocumentFragment()
  for (const token of tokens) {
    if (token.kind === 'text') {
      fragment.appendChild(doc.createTextNode(token.text))
      continue
    }
    const chip = doc.createElement('span')
    chip.className = CHIP_CLASS
    chip.setAttribute(CHIP_ATTR, String(token.id))
    // Not editable: the chip must behave as one unit for the caret and for
    // Backspace, which is precisely what an offset-based textarea could not do.
    chip.setAttribute('contenteditable', 'false')
    chip.textContent = token.label
    fragment.appendChild(chip)
  }
  return fragment
}

/**
 * Serialize an editor element's children back to tokens.
 *
 * Adjacent text is merged, so `serializeTokens` is the inverse of
 * `renderTokens` for any token list `tokenize` can produce.
 */
export function serializeTokens(root: Node): PastedTextToken[] {
  const tokens: PastedTextToken[] = []

  const pushText = (text: string) => {
    if (text === '') return
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === 'text') last.text += text
    else tokens.push({ kind: 'text', text })
  }

  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        pushText(child.nodeValue ?? '')
        continue
      }
      if (child.nodeType !== ELEMENT_NODE) continue
      const element = child as Element
      const rawId = element.getAttribute(CHIP_ATTR)
      if (rawId !== null) {
        tokens.push({ kind: 'ref', id: Number(rawId), label: element.textContent ?? '' })
      } else if (element.tagName === 'BR') {
        pushText('\n')
      } else {
        visit(element)
      }
    }
  }

  visit(root)
  return tokens
}
