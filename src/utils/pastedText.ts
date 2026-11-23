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

import { MENTION_PATTERN_G, parseFileMention } from '../../shared/file-mention'

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

/**
 * One piece of composer content: literal text, a collapsed-paste reference, or
 * an `@file`/`@folder` mention — both chip kinds the rich editor draws as one
 * atomic element.
 *
 * A mention's `text` is the exact matched substring (its serialized form), so
 * `joinTokens` stays lossless even for a hand-typed backslash path; `path`/`dir`
 * are the normalized facts parsed from it (canonicalization of the TEXT happens
 * at pick time via `formatFileMention`, never here).
 */
export type PastedTextToken =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; id: number; label: string }
  | { kind: 'mention'; text: string; path: string; dir: boolean }

/**
 * Split composer text into literal runs, paste-ref tokens and mention tokens.
 *
 * `joinTokens` is its exact inverse, which is what lets a DOM editor round-trip
 * through markup without the canonical string ever losing information: the
 * string stays the single source of truth, and the editor is only a view.
 *
 * Both matchers scan the whole string; their hits are merged in document order
 * and a hit that starts inside an earlier token is dropped (first start wins),
 * so the two kinds never overlap or double-count.
 */
export function tokenize(text: string): PastedTextToken[] {
  const hits: Array<{ index: number; length: number; token: PastedTextToken }> = []
  for (const ref of parseReferences(text)) {
    hits.push({
      index: ref.index,
      length: ref.match.length,
      token: { kind: 'ref', id: ref.id, label: ref.match },
    })
  }
  // matchAll, not .exec/.test on the shared global regex (it carries lastIndex).
  for (const m of text.matchAll(MENTION_PATTERN_G)) {
    // Every MENTION_PATTERN_G hit is exactly one of parseFileMention's two
    // accepted forms (quoted span or `@` + non-space run), so this never nulls.
    const parsed = parseFileMention(m[0])!
    hits.push({
      index: m.index!,
      length: m[0].length,
      token: { kind: 'mention', text: m[0], path: parsed.path, dir: parsed.dir },
    })
  }
  hits.sort((a, b) => a.index - b.index)

  const tokens: PastedTextToken[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.index < cursor) continue // overlaps an earlier token — first start wins
    if (hit.index > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, hit.index) })
    tokens.push(hit.token)
    cursor = hit.index + hit.length
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens
}

/** Inverse of `tokenize`: `joinTokens(tokenize(s)) === s` for any `s`. */
export function joinTokens(tokens: PastedTextToken[]): string {
  // ref → its label; text and mention → their `text` (a mention's text IS its
  // serialized `@path` form).
  return tokens.map((t) => (t.kind === 'ref' ? t.label : t.text)).join('')
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
