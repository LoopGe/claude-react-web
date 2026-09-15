import { type PastedTextToken } from './pastedText'

/**
 * DOM ⇄ token bridge for the rich composer.
 *
 * The editor renders `PastedTextToken`s as DOM and serializes that DOM back to
 * the same tokens. Both directions live here, together, so the round-trip is
 * testable without mounting React — that round-trip is the whole safety
 * property of replacing a textarea with a contenteditable.
 *
 * ONE model of "what does this DOM mean as text" lives here
 * (`collectSegments`), and both the serializer below and the caret
 * measurement in `richPromptCaret` are built on it. They used to each walk the
 * DOM with their own rules, and promptly drifted: the serializer learned that
 * a lone `<br>` is not a break while the caret arithmetic still counted it,
 * so a caret offset could exceed the length of the value it was measured
 * against.
 *
 * Line breaks are literal `\n` characters in text nodes, which the editor
 * styles with `white-space: pre-wrap` rather than materialising as `<br>`.
 * The walker still understands the shapes a browser produces on its own —
 * `<br>`, and the block containers `execCommand('insertText')` builds for
 * newlines — so a break it inserted behind our back is never silently joined
 * into the line above.
 */

/** Marks a chip element and carries the reference id it stands for. */
export const CHIP_ATTR = 'data-pasted-ref'
export const CHIP_CLASS = 'pasted-text-chip'

// Numeric node types rather than the `Node` globals, so this module needs no
// DOM globals in scope to be imported.
const ELEMENT_NODE = 1
const TEXT_NODE = 3

/**
 * Containers a contenteditable uses to hold a line. `execCommand('insertText')`
 * turns a `\n` into `<div>…</div>` (Chromium) or `<p>…</p>`, so each of these
 * carries an implicit break before its content.
 */
const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'BLOCKQUOTE',
  'LI',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
])

/**
 * One piece of the serialized value, with the DOM node it came from.
 *
 * `textNode` is set when the piece is literal text; `element` is set for a
 * chip and for a break the browser materialised as an element. The caret
 * module uses those to put the selection back where an offset points.
 */
export type DomSegment = {
  /** Characters this segment contributes to the serialized value. */
  text: string
  textNode: Text | null
  element: Element | null
}

/** A DOM position to stop the walk at, as a (node, offset) pair. */
export type StopPoint = { container: Node; offset: number }

/**
 * A container whose only child is a `<br>` holds no content: that `<br>` is
 * the host a contenteditable keeps so the caret has somewhere to sit (which is
 * what an editor emptied by select-all + delete looks like). Treating it as a
 * break injects a newline the user never typed — it lands in the value, and
 * the next paste is spliced after it, arriving with a blank line in front.
 *
 * A `<br>` that sits among content is a real break; only the sole-child case
 * is structural.
 */
function isLoneBrContainer(node: Node): boolean {
  const kids = node.childNodes
  return (
    kids.length === 1 &&
    kids[0]!.nodeType === ELEMENT_NODE &&
    (kids[0] as Element).tagName === 'BR'
  )
}

/**
 * The one DOM → text walk.
 *
 * Returns the value's pieces in order, and — when `stop` is given — stops as
 * soon as that position is reached, so the caller gets exactly the prefix
 * before it. `offsetOf` relies on that: the sum of the returned segments'
 * lengths IS the character offset, which is what keeps the measurement and the
 * serializer from disagreeing.
 */
export function collectSegments(root: Node, stop?: StopPoint): DomSegment[] {
  const out: DomSegment[] = []
  // The root has no parent to carry its break, so its lone-`<br>` case is
  // handled here rather than in `walkNode`: an editor emptied by
  // select-all + delete is exactly `<div><br></div>`, and it holds no content.
  if (isLoneBrContainer(root)) return out
  let reached = false

  const push = (text: string, textNode: Text | null, element: Element | null) => {
    if (text === '') return
    out.push({ text, textNode, element })
  }

  const walkNode = (node: Node) => {
    if (reached) return
    if (node.nodeType === TEXT_NODE) {
      const textNode = node as Text
      const value = textNode.nodeValue ?? ''
      if (stop && stop.container === textNode) {
        push(value.slice(0, stop.offset), textNode, null)
        reached = true
        return
      }
      push(value, textNode, null)
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const element = node as Element
    if (element.hasAttribute(CHIP_ATTR)) {
      const label = element.textContent ?? ''
      // Opaque: one reference, whatever the chip renders. A stop point inside
      // it still has to be honoured — a real double-click on a chip selects
      // INSIDE it (its text node), and ignoring that made `offsetOf` report
      // the offset past the whole value instead of the caret's.
      if (stop !== undefined && (stop.container === element || element.contains(stop.container))) {
        const inner = stop.container === element ? 0 : stop.offset
        push(label.slice(0, inner), null, element)
        reached = true
        return
      }
      push(label, null, element)
      return
    }
    if (element.tagName === 'BR') {
      push('\n', null, element)
      return
    }
    // A lone `<br>` holds no content: it is the host a contenteditable keeps
    // so the caret has somewhere to sit. Nested, it is an EMPTY LINE — the
    // break that makes it a line of its own was already emitted by
    // `walkChildren` above (see there), so nothing more is contributed here.
    if (isLoneBrContainer(element)) return
    walkChildren(element)
  }

  const walkChildren = (parent: Node) => {
    const kids = parent.childNodes
    // A block element IS a line. Lines are joined by '\n', which is why the
    // break is decided by the SIBLING structure rather than by "has anything
    // been emitted yet" — that older rule made a leading empty line vanish
    // (`<div><br></div><div>foo</div>` is '\nfoo', not 'foo'), which is
    // exactly the shape `execCommand('insertText')` builds for a paste that
    // begins with a blank line.
    let previousWasBlock = false
    for (let i = 0; i < kids.length; i++) {
      if (reached) return
      if (stop !== undefined && stop.container === parent && stop.offset === i) {
        reached = true
        return
      }
      const child = kids[i]!
      const childElement = child.nodeType === ELEMENT_NODE ? (child as Element) : null
      const childIsBlock =
        childElement !== null &&
        BLOCK_TAGS.has(childElement.tagName) &&
        !childElement.hasAttribute(CHIP_ATTR)
      // A block opens a line (so a break before it), and anything after a
      // block starts a new line too.
      if (i > 0 && childIsBlock) push('\n', null, childElement)
      else if (previousWasBlock && !childIsBlock) push('\n', null, childElement)
      walkNode(child)
      previousWasBlock = childIsBlock
    }
    if (stop !== undefined && stop.container === parent && stop.offset === kids.length) {
      reached = true
    }
  }

  walkChildren(root)
  return out
}

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
  for (const segment of collectSegments(root)) {
    const rawId = segment.element?.getAttribute(CHIP_ATTR)
    if (rawId != null) {
      tokens.push({ kind: 'ref', id: Number(rawId), label: segment.text })
      continue
    }
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === 'text') last.text += segment.text
    else tokens.push({ kind: 'text', text: segment.text })
  }
  return tokens
}

/**
 * Does the DOM already represent `value` — text AND reference structure?
 *
 * Equality of the serialized string is not enough. A `[Pasted text #N]`
 * reference that was just inserted as literal text serializes back to exactly
 * `value`, so a plain string comparison reports "already in sync" and the
 * chip is never built: the composer shows the placeholder as ordinary text,
 * Backspace eats it a character at a time, and half-deleting it leaves
 * something `parseReferences` cannot match, so the body silently never reaches
 * the model. Comparing the token structure catches that: a reference in
 * `value` must be an element in the DOM.
 */
export function domRepresentsValue(root: Node, valueTokens: PastedTextToken[]): boolean {
  // An empty value is represented ONLY by a truly empty editor. When the
  // browser's content is deleted it keeps a caret-host element behind — a
  // lone `<br>` at the root, or nested inside the block container it
  // materialised for a newline (`<div><br></div>`). The serializer reports ''
  // for every one of those shapes, so a token-count comparison would call
  // them in sync and leave the placeholder CSS `:empty` permanently defeated.
  if (valueTokens.length === 0) return root.childNodes.length === 0
  const domTokens = serializeTokens(root)
  if (domTokens.length !== valueTokens.length) return false
  return domTokens.every((domToken, i) => {
    const valueToken = valueTokens[i]!
    if (domToken.kind !== valueToken.kind) return false
    return domToken.kind === 'text'
      ? domToken.text === (valueToken as { text: string }).text
      : domToken.id === (valueToken as { id: number }).id
  })
}