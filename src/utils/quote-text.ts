/** Pure blockquote text utilities: format a selection as a Markdown quote,
 *  decode one quote marker per line, and locate quote runs in message text.
 *  No DOM — shared by the composer token model and sent-message rendering. */

/**
 * Project selected visible text as an ordinary Markdown blockquote.
 * @param text - selected visible text without quote markers.
 * @returns one `> `-prefixed line per input line; CRLF and lone CR normalize
 * to `\n` first, so an empty line becomes a bare `> ` marker line.
 */
export function formatQuoteText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').split('\n').map((line) => `> ${line}`).join('\n')
}

/**
 * Remove one blockquote marker from each explicitly quoted line.
 * @param text - consecutive blockquote lines, with up to three leading spaces.
 * @returns excerpt text with original line endings normalized to `\n`. A
 * nested `>>` keeps its inner marker; only one `> ` (or `>\t`, or bare `>`)
 * is stripped per line.
 */
export function quoteTextOf(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/^ {0,3}>[ \t]?/gmu, '')
}

/** One blockquote span in original UTF-16 text, excluding its trailing line break. */
export interface MessageQuoteRange {
  readonly start: number
  readonly end: number
}

/**
 * Recognize consecutive explicitly marked Markdown blockquote lines.
 * @param text - complete original message text.
 * @returns ordered nonblank quote spans, as UTF-16 offsets into `text` (NOT
 * a normalized copy — CRLF pairs keep both code units). A run is one or more
 * consecutive line-leading `^ {0,3}>` lines; an inline `>` mid-line is
 * ordinary text, and a run whose decoded text is blank is excluded.
 */
export function messageQuoteRanges(text: string): readonly MessageQuoteRange[] {
  const ranges: MessageQuoteRange[] = []
  for (const match of text.matchAll(/^ {0,3}>[^\r\n]*(?:\r?\n {0,3}>[^\r\n]*)*/gmu)) {
    if (quoteTextOf(match[0]).trim() !== '') ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/**
 * Whether an insertion at `offset` lands inside a line-leading blockquote line —
 * on a line matching `^ {0,3}>` and PAST its `>` marker, so the marker survives
 * the insert and the line stays quoted.
 *
 * This is the insertion-time complement to `messageQuoteRanges`, which excludes
 * a run whose decoded text is blank: a lone `> ` (the forming-quote gesture) is
 * NOT a range there, yet a paste-ref dropped after its marker WOULD be swallowed
 * by the quote run once the label makes the run non-blank. So the test is
 * per-line, not per-run: it reads the caret's own line for the line-leading
 * marker and requires the offset past it. An offset at/before the marker is
 * excluded — a ref inserted there lands in front of the `>`, breaking the
 * line-leading marker, so it stays a live reference. Line boundaries are exactly
 * the set a multiline `^` treats as such (LF, CR, U+2028, U+2029), matching
 * `messageQuoteRanges`; char codes keep those two members readable.
 */
export function offsetInQuoteLine(text: string, offset: number): boolean {
  let lineStart = 0
  for (let i = offset - 1; i >= 0; i--) {
    const c = text.charCodeAt(i)
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) {
      lineStart = i + 1
      break
    }
  }
  const marker = /^ {0,3}>/.exec(text.slice(lineStart))
  return marker !== null && offset >= lineStart + marker[0].length
}
