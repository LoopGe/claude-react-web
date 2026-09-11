/**
 * Placeholder bookkeeping for long pastes in the composer.
 *
 * A paste that exceeds the collapse threshold is replaced in the input by a
 * `[Pasted text #N +X lines]` reference; the real text lives in a side map
 * keyed by N. The map is spliced back in on send, so the model receives the
 * pasted text rather than the placeholder.
 *
 * Ported from Claude Code's `src/history.ts`.
 */

export type PastedText = {
  id: number
  content: string
}

export type PastedTextMap = Record<number, PastedText>

export type PastedRef = {
  id: number
  /** The exact matched substring, e.g. `[Pasted text #1 +10 lines]`. */
  match: string
  /** Offset of `match` in the input the refs were parsed from. */
  index: number
}

/**
 * Number of newlines in the text.
 *
 * Deliberate: `"line1\nline2\nline3"` is three lines but reports 2. The count
 * is part of the user-visible `+N lines` label, so it keeps the off-by-one the
 * original shipped with rather than "fixing" it into a mismatch.
 */
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

/**
 * A paste collapses once it reaches this many newlines — the same number the
 * `+N lines` label shows.
 *
 * Claude Code collapses at 2, but that threshold exists to protect the
 * terminal renderer, where any multi-line paste costs a full repaint. This is
 * an ordinary textarea: a few dozen lines display and edit fine, so collapsing
 * that eagerly would just make small snippets annoying to fix.
 */
export const PASTED_TEXT_COLLAPSE_LINES = 15

/**
 * Character cap for a paste that never trips the newline threshold — a single
 * minified line can still be hundreds of KB, and that is the case a controlled
 * textarea handles worst.
 */
export const PASTED_TEXT_COLLAPSE_CHARS = 8_000

/**
 * Normalize a paste before it is measured or stored.
 *
 * Every paste path must run this first: the `+N lines` label is derived from
 * the stored text, so the count and the body have to come from one string.
 * Folding CRLF/CR to LF leaves the newline count unchanged (see the test), so
 * normalizing cannot desync the label.
 *
 * ANSI escapes are deliberately left alone — browser `text/plain` clips don't
 * carry them, and the package that strips them is only a transitive
 * dependency here.
 */
export function normalizePastedText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replaceAll('\t', '    ')
}

export function shouldCollapsePaste(text: string): boolean {
  return (
    getPastedTextRefNumLines(text) >= PASTED_TEXT_COLLAPSE_LINES ||
    text.length > PASTED_TEXT_COLLAPSE_CHARS
  )
}

/**
 * Leading text of every reference. Exported so callers that only need a cheap
 * "is there anything to expand here?" check don't have to run the full regex —
 * a draft write-through runs on every keystroke.
 */
export const PASTED_TEXT_REF_PREFIX = '[Pasted text #'

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) return `[Pasted text #${id}]`
  return `[Pasted text #${id} +${numLines} lines]`
}

/**
 * Find every `[Pasted text #N ...]` reference, in document order.
 *
 * Only the pasted-text kind is matched. This app never emits `[Image #N]` or
 * `[...Truncated text...]`, and matching them would let a user-typed
 * `[Image #1]` collide with pasted text #1 and be spliced with its content.
 */
export function parseReferences(input: string): PastedRef[] {
  const pattern = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g
  return [...input.matchAll(pattern)]
    .map((m) => ({ id: parseInt(m[1] ?? '0', 10), match: m[0], index: m.index! }))
    .filter((ref) => ref.id > 0)
}

export type RefRange = {
  id: number
  /** Offset of the opening bracket. */
  start: number
  /** Offset just past the closing bracket. */
  end: number
}

/** Half-open `[start, end)` ranges of every reference in `text`. */
export function refRanges(text: string): RefRange[] {
  return parseReferences(text).map((ref) => ({
    id: ref.id,
    start: ref.index,
    end: ref.index + ref.match.length,
  }))
}

export type RefKeyAction =
  | { kind: 'delete'; from: number; to: number }
  | { kind: 'move'; caret: number }

/**
 * What Backspace / Delete / ← / → should do to a reference the collapsed caret
 * is sitting against, or null to let the browser handle the key normally.
 *
 * A reference is one unit, not the two dozen characters it is spelled with:
 * Backspace/Delete remove it whole and the arrows step over it. Only a caret
 * exactly at an edge qualifies — a caret *inside* the token returns null, so
 * the reference itself stays editable.
 */
export function refKeyAction(text: string, caret: number, key: string): RefKeyAction | null {
  const ranges = refRanges(text)
  const deleting =
    key === 'Backspace'
      ? ranges.find((r) => r.end === caret)
      : key === 'Delete'
        ? ranges.find((r) => r.start === caret)
        : undefined
  if (deleting) return { kind: 'delete', from: deleting.start, to: deleting.end }

  const caretTarget =
    key === 'ArrowLeft'
      ? ranges.find((r) => r.end === caret)?.start
      : key === 'ArrowRight'
        ? ranges.find((r) => r.start === caret)?.end
        : undefined
  return caretTarget === undefined ? null : { kind: 'move', caret: caretTarget }
}

/**
 * Decide what a clipboard paste should become.
 *
 * The caller inserts/stores `normalized` either way, so the `+N lines` label
 * and the stored body are always derived from the same string. Every composer
 * that supports collapsed pastes goes through here so the threshold and the
 * normalization cannot drift between entry points or between components.
 */
export type PastePlan = {
  collapsed: boolean
  /** Normalized text — what the caller inserts or stores. */
  normalized: string
  /** Newline count of `normalized`, for the reference label. Carried here so
   *  a caller that already planned a paste doesn't re-scan the whole string. */
  numLines: number
}

export function planPaste(raw: string): PastePlan {
  const normalized = normalizePastedText(raw)
  return {
    collapsed: shouldCollapsePaste(normalized),
    normalized,
    numLines: getPastedTextRefNumLines(normalized),
  }
}

/**
 * Splice each reference's stored content back into the text.
 *
 * Replacements walk the refs in reverse, using offsets computed from the
 * ORIGINAL input. That keeps earlier offsets valid after a later replacement,
 * and means a ref-shaped string *inside* pasted content is never mistaken for
 * a real reference and expanded a second time.
 *
 * Unresolvable refs (no entry in the map) are left verbatim.
 */
export function expandPastedTextRefs(input: string, texts: PastedTextMap): string {
  const refs = parseReferences(input)
  let expanded = input
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const content = texts[ref.id]?.content
    if (content === undefined) continue
    expanded =
      expanded.slice(0, ref.index) + content + expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}
