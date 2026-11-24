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
  return text.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join('\n')
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