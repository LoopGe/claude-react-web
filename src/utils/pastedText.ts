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
import { messageQuoteRanges } from './quote-text'

/** The grammar's quoted alternative (`@"[^"\n]+"`): a COMPLETE quoted mention.
 *  Used to tell a settled `@"…"` span from an open-quote opener fragment that the
 *  unquoted alternative also matches. Mirrors shared/file-mention's MENTION_SOURCE. */
const CLOSED_QUOTED_MENTION = /^@"[^"\n]+"$/

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
 * One piece of composer content: literal text, a collapsed-paste reference, an
 * `@file`/`@folder` mention, or a line-leading blockquote run — the chip kinds
 * the rich editor draws as one atomic element.
 *
 * A mention's `text` is the exact matched substring (its serialized form), so
 * `joinTokens` stays lossless even for a hand-typed backslash path; `path`/`dir`
 * are the normalized facts parsed from it (canonicalization of the TEXT happens
 * at pick time via `formatFileMention`, never here).
 *
 * A quote's `text` is likewise the EXACT matched run (`text.slice(start, end)`
 * from `messageQuoteRanges`, trailing line break excluded) — never decoded or
 * re-formatted — so the round-trip invariant holds for nested `>>`, a missing
 * space after `>`, trailing whitespace and CRLF alike. Decoding for display is
 * the render layer's job (`quoteTextOf`), not the token model's.
 */
export type PastedTextToken =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; id: number; label: string }
  | { kind: 'mention'; text: string; path: string; dir: boolean }
  | { kind: 'quote'; text: string }

/**
 * Split composer text into literal runs, paste-ref, mention and quote tokens.
 *
 * `joinTokens` is its exact inverse, which is what lets a DOM editor round-trip
 * through markup without the canonical string ever losing information: the
 * string stays the single source of truth, and the editor is only a view.
 *
 * All matchers scan the whole string; their hits are merged in document order
 * and a hit that starts inside an earlier token is dropped (first start wins),
 * so the kinds never overlap or double-count. A quote run is line-leading and
 * spans whole lines, so it normally swallows any mention/ref hit that falls
 * inside it (the run is atomic). That ordering is not absolute: the grammar's
 * quoted alternative (`@"[^"\n]+"`) admits a lone CR or U+2028/U+2029, which the
 * multiline `^` treats as a line boundary — so a quoted mention can contain a
 * quote run's start and win the merge instead. Losslessness does not depend on
 * which kind wins: every token carries its exact UTF-16 span, and `joinTokens`'
 * composition guards key on the actual line-terminator characters, so the
 * round-trip holds for either ordering.
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
  // Line-leading blockquote runs (messageQuoteRanges excludes inline `>` and
  // blank decoded runs). The token carries the exact UTF-16 span — CRLF pairs
  // keep both code units — so joinTokens reproduces the source verbatim.
  for (const range of messageQuoteRanges(text)) {
    hits.push({
      index: range.start,
      length: range.end - range.start,
      token: { kind: 'quote', text: text.slice(range.start, range.end) },
    })
  }
  // matchAll, not .exec/.test on the shared global regex (it carries lastIndex).
  for (const m of text.matchAll(MENTION_PATTERN_G)) {
    // An open-quote opener (`@"my` in the forming drill `@"my dir/`) is matched
    // by the grammar's UNQUOTED alternative because the quoted alternative needs
    // a closing quote. That fragment is not a mention — it is the head of an
    // unfinished quoted span — so it stays editable text. Without this, the
    // caret gate (which only demotes the token spanning the caret) would chipify
    // `@"my` the moment the caret moved past it into ` dir/`, breaking the
    // folder drill. A COMPLETE quoted span (`@"…"`) is kept: it is a real mention.
    if (m[0].startsWith('@"') && !CLOSED_QUOTED_MENTION.test(m[0])) continue
    // Every remaining hit is exactly one of parseFileMention's two accepted
    // forms (closed quoted span or `@` + non-space run), so this never nulls.
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

/** Whether `ch` is a JS line terminator — the set a multiline `^` treats as a
 *  line boundary (LF, CR, U+2028, U+2029). The quote guards key on exactly this
 *  set, so a boundary `tokenize` recognized (a lone CR or a unicode separator
 *  included) is never "fixed" a second time. Char codes rather than a regex
 *  literal keep the U+2028/U+2029 members readable instead of invisible. */
export function isLineTerminator(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029
}

/**
 * Inverse of `tokenize`: `joinTokens(tokenize(s)) === s` for any `s`.
 *
 * ref → its label; text/mention/quote → their `text` (each IS its serialized
 * form). A quote run additionally carries two composition guarantees — it must
 * start on its own line, and a blank line separates it from following prose.
 * Those guards fire ONLY when composing new tokens whose neighbours lack the
 * break: on `tokenize` output they are structurally inert, which is what keeps
 * the round-trip exact:
 *
 * - A quote token is either first (output empty) or preceded by a text token
 *   ending in the line break that made the run line-leading — so the leading
 *   `\n` guard never fires.
 * - A run spans to end-of-line, so the next token is text starting with the
 *   run's trailing `\r`/`\n` (or nothing) — so the blank-line guard never fires.
 *
 * A hand-composed list (a quote spliced beside prose with no break of its own)
 * is where the guards earn their keep: `prose` + `> q` + `more` joins as
 * `prose\n> q\n\nmore`.
 */
export function joinTokens(tokens: PastedTextToken[]): string {
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === 'quote') {
      // Guarantee line-leading: a run spliced after mid-line prose gets a break.
      if (out.length > 0 && !isLineTerminator(out[out.length - 1]!)) out += '\n'
      out += t.text
      // Guarantee a blank line before following prose that carries no break.
      const next = tokens[i + 1]
      if (
        next !== undefined &&
        next.kind === 'text' &&
        next.text.length > 0 &&
        !isLineTerminator(next.text[0]!)
      ) {
        out += '\n\n'
      }
      continue
    }
    out += t.kind === 'ref' ? t.label : t.text
  }
  return out
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

/** Where a paste lands: the current composer value and the UTF-16 offset the
 *  text inserts at (the live caret, or a saved selection's start). The collapse
 *  policy reads it to keep a paste that would land inside a line-leading quote
 *  run verbatim-quoted instead of collapsing it to a reference the run would
 *  swallow. Optional — a caller with no caret context keeps the plain policy. */
export type PasteInsertionContext = {
  value: string
  offset: number
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
