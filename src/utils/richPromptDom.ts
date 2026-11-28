import { type PastedTextToken } from './pastedText'
import { quoteTextOf } from './quote-text'

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
// The base classes carry the shared chip anatomy (.chip-inline in chat.css);
// the per-kind class keeps its semantic surface (color/data hooks). Selector
// constants below exist because a multi-token class value cannot feed
// `.${X_CLASS}` concatenation (it becomes a descendant selector).
export const CHIP_CLASS = 'chip-inline pasted-text-chip'
export const CHIP_SELECTOR = '.pasted-text-chip'

/**
 * Marks an `@file`/`@folder` mention chip. `MENTION_CHIP_ATTR` carries the
 * URI-component-encoded mention path (decode with `decodeURIComponent`);
 * `data-dir` is '1' for a directory, '0' for a file. The chip's label text IS
 * the serialized mention (`@path`), so the string value stays the source of
 * truth and the attrs only carry the parsed facts.
 */
export const MENTION_CHIP_ATTR = 'data-file-mention'
export const MENTION_CHIP_CLASS = 'chip-inline file-mention-chip'
export const MENTION_CHIP_SELECTOR = '.file-mention-chip'
const MENTION_DIR_ATTR = 'data-dir'

/**
 * Marks a blockquote quote chip. `QUOTE_CHIP_ATTR` carries the EXACT blockquote
 * run (the serialization — `> …` markers and line breaks verbatim); the chip's
 * rendered text is the DECODED excerpt (`quoteTextOf`), which is NOT the value.
 * This is the one chip kind whose display ≠ serialization: the DOM → text walk
 * and the caret arithmetic read the attribute, never `textContent`.
 * `QUOTE_REMOVE_ATTR` marks the composer-only whole-run removal button.
 */
export const QUOTE_CHIP_ATTR = 'data-quote-text'
export const QUOTE_CHIP_CLASS = 'chip-inline quote-chip'
export const QUOTE_CHIP_SELECTOR = '.quote-chip'
export const QUOTE_REMOVE_ATTR = 'data-quote-remove'

/** Shared quote-mark icon geometry (DSH QuotePreview parity). Exported so the
 *  plain-DOM composer chip and the React `QuotePreview` draw the identical mark. */
export const QUOTE_MARK_VIEWBOX = '0 0 16 16'
export const QUOTE_MARK_TRANSFORM = 'translate(6.8 2.4)'
export const QUOTE_MARK_PATHS = [
  'M2.8125 0.583008L3.2002 1.16602C2.43912 1.6713 1.88491 2.41238 1.60547 3.25684H2.98926V6.70605H0V4.52148C1.96593e-05 2.70313 0.9109 1.00575 2.42578 0L2.8125 0.583008Z',
  'M7.50781 0.583008L7.89551 1.16602C7.13443 1.6713 6.58022 2.41238 6.30078 3.25684H7.68457V6.70605H4.69531V4.52148C4.69533 2.70313 5.60621 1.00575 7.12109 0L7.50781 0.583008Z',
] as const

/** Every chip kind is an opaque atomic unit to the DOM → text walk. */
function isChipElement(element: Element): boolean {
  return (
    element.hasAttribute(CHIP_ATTR) ||
    element.hasAttribute(MENTION_CHIP_ATTR) ||
    element.hasAttribute(QUOTE_CHIP_ATTR)
  )
}

/** Read the parsed facts back from a mention chip element — the inverse of
 *  the attribute writes in {@link renderTokens} (the path attr is
 *  URI-component-encoded, so it MUST be decoded here). Returns null for an
 *  element that is not a mention chip. */
export function mentionChipFacts(element: Element): { path: string; dir: boolean } | null {
  const encoded = element.getAttribute(MENTION_CHIP_ATTR)
  if (encoded === null) return null
  return {
    path: decodeURIComponent(encoded),
    dir: element.getAttribute(MENTION_DIR_ATTR) === '1',
  }
}

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
    if (isChipElement(element)) {
      // Quote chip: display ≠ serialization. The value contribution is the exact
      // blockquote run in the attribute, NOT the decoded excerpt the chip shows.
      const quoteRun = element.getAttribute(QUOTE_CHIP_ATTR)
      if (quoteRun !== null) {
        // Atomic: a quote run has no interior text position (its rendered excerpt
        // does not map character-for-character onto the serialization). A stop
        // inside it — a double-click on the excerpt — resolves to the chip's
        // START, so the whole run stays one unit and the caret gate keeps it
        // settled (start-exclusive) rather than demoting it.
        if (stop !== undefined && (stop.container === element || element.contains(stop.container))) {
          reached = true
          return
        }
        push(quoteRun, null, element)
        return
      }
      const label = element.textContent ?? ''
      // Opaque: one token (paste-ref or mention), whatever the chip renders. A
      // stop point inside it still has to be honoured — a real double-click on a
      // chip selects INSIDE it (its text node), and ignoring that made `offsetOf`
      // report the offset past the whole value instead of the caret's.
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
        !isChipElement(childElement)
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

/**
 * Demote any mention OR quote run whose serialized range spans the caret to
 * editable text.
 *
 * An unquoted mention has no closing delimiter — every prefix (`@s`, `@sr`,
 * `@src/`) is grammatically complete — so a context-free chipify would turn the
 * forming query into an atomic chip on the second keystroke. The caret gate is
 * `start < caretOffset <= end`: end-INCLUSIVE because a forming word's caret
 * sits at its end, start-EXCLUSIVE because a caret resting before a settled
 * chip is not forming it (and must not de-chipify it). A picked mention is
 * therefore settled by leaving the caret PAST its end (the pick appends a
 * trailing space). With no caret (unfocused editor / draft restore) every
 * mention is settled.
 *
 * A quote run uses the SAME gate, and because the whole run is ONE token the
 * demotion is whole-run: a caret entering a multi-line blockquote de-chipifies
 * every line at once into editable `> …` text, and leaving re-settles it. The
 * range length is the SERIALIZATION length (the exact run, line breaks counted),
 * never the decoded excerpt the chip displays — so the gate's offsets line up
 * with the value the caret arithmetic indexes into.
 *
 * ArrowRight crossing a settled chip lands the caret at the run end, where the
 * end-inclusive gate demotes it to editable `> …` text for that one keystroke;
 * the next caret move past the end re-settles it. This demote-on-cross is
 * accepted — it is the same end-inclusive semantics the mention gate uses, not a
 * defect to special-case.
 */
function demoteCaretMentions(
  tokens: PastedTextToken[],
  caretOffset: number | undefined,
): PastedTextToken[] {
  if (caretOffset === undefined) return tokens
  let start = 0
  let demoted = false
  const out = tokens.map((token) => {
    const length = token.kind === 'ref' ? token.label.length : token.text.length
    const end = start + length
    const spansCaret = start < caretOffset && caretOffset <= end
    start = end
    if ((token.kind === 'mention' || token.kind === 'quote') && spansCaret) {
      demoted = true
      return { kind: 'text', text: token.text } as PastedTextToken
    }
    return token
  })
  return demoted ? out : tokens
}

/** Merge adjacent text tokens (demotion can create them; `tokenize` never does). */
function mergeAdjacentText(tokens: PastedTextToken[]): PastedTextToken[] {
  const out: PastedTextToken[] = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (token.kind === 'text' && last !== undefined && last.kind === 'text') {
      last.text += token.text
    } else {
      out.push({ ...token })
    }
  }
  return out
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Append the shared quote-mark SVG (DSH parity) to `parent`. */
function appendQuoteMark(doc: Document, parent: Element, className: string): void {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', QUOTE_MARK_VIEWBOX)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  const g = doc.createElementNS(SVG_NS, 'g')
  g.setAttribute('transform', QUOTE_MARK_TRANSFORM)
  for (const d of QUOTE_MARK_PATHS) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'currentColor')
    g.appendChild(path)
  }
  svg.appendChild(g)
  parent.appendChild(svg)
}

/**
 * Build the composer's atomic quote chip: a `contenteditable=false` span whose
 * `data-quote-text` is the EXACT blockquote run (the serialization) and whose
 * visible text is the DECODED excerpt. The whole-run removal button swaps the
 * quote mark for a × on hover (CSS). The full decoded text rides a native `title`:
 * the bridge is React-free (it runs in a layout effect rebuilt per reconcile), so
 * the chip cannot host the React `HoverPopover` the sent presentation uses — not
 * because of overflow clipping (a portalled popover escapes `overflow: hidden`).
 * The sent-message presentation (`QuotePreview`) shares these classes and the mark.
 */
function buildQuoteChip(doc: Document, exactText: string): Element {
  const chip = doc.createElement('span')
  chip.className = QUOTE_CHIP_CLASS
  chip.setAttribute('contenteditable', 'false')
  chip.setAttribute(QUOTE_CHIP_ATTR, exactText)
  const excerpt = quoteTextOf(exactText)
  chip.setAttribute('title', excerpt)
  const remove = doc.createElement('button')
  remove.type = 'button'
  remove.className = 'quote-chip-remove'
  remove.setAttribute(QUOTE_REMOVE_ATTR, '')
  remove.setAttribute('aria-label', 'Remove quote')
  appendQuoteMark(doc, remove, 'quote-chip-mark')
  const close = doc.createElement('span')
  close.className = 'quote-chip-close'
  close.setAttribute('aria-hidden', 'true')
  close.textContent = '×'
  remove.appendChild(close)
  chip.appendChild(remove)
  const text = doc.createElement('span')
  text.className = 'quote-chip-text'
  text.textContent = excerpt
  chip.appendChild(text)
  return chip
}

/**
 * Build DOM for `tokens`. The caller owns `doc` (usually `document`).
 *
 * `caretOffset` applies the same caret gate as `domRepresentsValue`: a mention
 * or quote run spanning the caret renders as editable text, every other one as
 * a chip.
 */
export function renderTokens(
  doc: Document,
  tokens: PastedTextToken[],
  caretOffset?: number,
): DocumentFragment {
  const fragment = doc.createDocumentFragment()
  for (const token of demoteCaretMentions(tokens, caretOffset)) {
    if (token.kind === 'text') {
      fragment.appendChild(doc.createTextNode(token.text))
      continue
    }
    if (token.kind === 'quote') {
      fragment.appendChild(buildQuoteChip(doc, token.text))
      continue
    }
    const chip = doc.createElement('span')
    // Not editable: the chip must behave as one unit for the caret and for
    // Backspace, which is precisely what an offset-based textarea could not do.
    chip.setAttribute('contenteditable', 'false')
    if (token.kind === 'mention') {
      chip.className = MENTION_CHIP_CLASS
      chip.setAttribute(MENTION_CHIP_ATTR, encodeURIComponent(token.path))
      chip.setAttribute(MENTION_DIR_ATTR, token.dir ? '1' : '0')
      chip.textContent = token.text
    } else {
      chip.className = CHIP_CLASS
      chip.setAttribute(CHIP_ATTR, String(token.id))
      chip.textContent = token.label
    }
    fragment.appendChild(chip)
  }
  return fragment
}

/**
 * Serialize an editor element's children back to tokens.
 *
 * Adjacent text is merged, so `serializeTokens` is the inverse of
 * `renderTokens` for any token list `tokenize` can produce. The quote chip keeps
 * that structural invertibility even though its display ≠ serialization: the
 * walk reads `data-quote-text` (the exact run `renderTokens` wrote), so a quote
 * token round-trips through the chip unchanged — the decoded excerpt is never
 * mistaken for the value.
 */
export function serializeTokens(root: Node): PastedTextToken[] {
  return serializeSegments(collectSegments(root))
}

/**
 * Tokenize an already-collected segment list (the prefix before a caret stop, or
 * the whole walk). Shared by `serializeTokens` and the value-space caret
 * measurement so both read the DOM through ONE serializer.
 */
export function serializeSegments(segments: DomSegment[]): PastedTextToken[] {
  const tokens: PastedTextToken[] = []
  for (const segment of segments) {
    const element = segment.element
    const rawId = element?.getAttribute(CHIP_ATTR)
    if (rawId != null) {
      tokens.push({ kind: 'ref', id: Number(rawId), label: segment.text })
      continue
    }
    const encodedPath = element?.getAttribute(MENTION_CHIP_ATTR)
    if (encodedPath != null) {
      tokens.push({
        kind: 'mention',
        text: segment.text,
        path: decodeURIComponent(encodedPath),
        dir: element!.getAttribute(MENTION_DIR_ATTR) === '1',
      })
      continue
    }
    const quoteRun = element?.getAttribute(QUOTE_CHIP_ATTR)
    if (quoteRun != null) {
      tokens.push({ kind: 'quote', text: quoteRun })
      continue
    }
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === 'text') last.text += segment.text
    else tokens.push({ kind: 'text', text: segment.text })
  }
  return tokens
}

/** Structural equality of two tokens (kind + payload), for the reconcile check. */
function tokensEqual(a: PastedTextToken, b: PastedTextToken): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'text':
      return a.text === (b as { text: string }).text
    case 'quote':
      return a.text === (b as { text: string }).text
    case 'ref':
      return a.id === (b as { id: number }).id
    case 'mention': {
      const bm = b as { text: string; path: string; dir: boolean }
      return a.text === bm.text && a.path === bm.path && a.dir === bm.dir
    }
  }
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
export function domRepresentsValue(
  root: Node,
  valueTokens: PastedTextToken[],
  caretOffset?: number,
): boolean {
  // An empty value is represented ONLY by a truly empty editor. When the
  // browser's content is deleted it keeps a caret-host element behind — a
  // lone `<br>` at the root, or nested inside the block container it
  // materialised for a newline (`<div><br></div>`). The serializer reports ''
  // for every one of those shapes, so a token-count comparison would call
  // them in sync and leave the placeholder CSS `:empty` permanently defeated.
  if (valueTokens.length === 0) return root.childNodes.length === 0
  // A mention spanning the caret is expected as editable TEXT, not a chip, so
  // the forming query is left alone. Demotion can merge it into neighbouring
  // text, so both sides are compared in merged canonical form (the serializer
  // already merges adjacent DOM text).
  const expected = mergeAdjacentText(demoteCaretMentions(valueTokens, caretOffset))
  const domTokens = serializeTokens(root)
  if (domTokens.length !== expected.length) return false
  return domTokens.every((domToken, i) => tokensEqual(domToken, expected[i]!))
}
