/**
 * Text a message actually ships with.
 *
 * Both the immediate send and the scheduled-send path build their payload from
 * this one place, so the two can't drift — and, more importantly, so the
 * `[Pasted text #N]` expansion can't be applied in one path and forgotten in
 * the other. A placeholder that reaches the model unexpanded is worse than
 * useless: it tells the model nothing and hides the text the user pasted.
 */

import { messageQuoteRanges } from './quote-text'

/**
 * Expand pasted-text references.
 *
 * Returns `text` (what the user typed, expanded — the shell and slash-command
 * branches match against this) and `full` (what gets sent).
 *
 * The composer text is trimmed BEFORE expansion so the pasted body keeps its
 * own leading/trailing whitespace.
 *
 * Quote runs are OPAQUE: a line-leading blockquote run (`messageQuoteRanges`)
 * is quoted prose, so neither the trim nor the expansion may reach inside it.
 * A `[Pasted text #N]`-shaped string inside a quote stays literal (splicing
 * paste content into it would resurrect an attachment the user only quoted),
 * and the run's own leading indent / trailing interior whitespace survive the
 * trim. The trim therefore stops at a quote span it would otherwise eat into,
 * and `expand` runs only on the non-quote pieces between runs.
 *
 * No alias rewriting happens here: the old `/summarize` → `/compact` rewrite
 * died with the app-side compact flow (now /handoff — see local-commands.ts).
 * A stray `/summarize` reaching the model is benign (the model answers
 * in-band), and the composer stays honest about what will actually be sent.
 */
export function composeOutgoing(
  input: string,
  expand: (text: string) => string,
): { text: string; full: string } {
  const ranges = messageQuoteRanges(input)
  // Whole-string trim boundaries, then pulled back so they never cut into a
  // quote span. Only the first run can start inside the leading whitespace and
  // only the last run can end inside the trailing whitespace (runs are ordered
  // and non-overlapping), so those two are the only boundaries a run can bound.
  let leadEnd = input.length - input.trimStart().length
  let trailStart = input.trimEnd().length
  if (ranges.length > 0) {
    const first = ranges[0]!
    if (first.start < leadEnd) leadEnd = first.start
    const last = ranges[ranges.length - 1]!
    if (last.end > trailStart) trailStart = last.end
  }
  const trimmed = input.slice(leadEnd, trailStart)
  // Expand only the non-quote pieces; each quote run passes through verbatim.
  // A paste-ref carries no line break, so it can never straddle a line-leading
  // quote boundary — piecewise expansion is identical to whole-string expansion
  // everywhere outside the runs.
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    const start = range.start - leadEnd
    const end = range.end - leadEnd
    if (start > cursor) out += expand(trimmed.slice(cursor, start))
    out += trimmed.slice(start, end)
    cursor = end
  }
  if (cursor < trimmed.length) out += expand(trimmed.slice(cursor))
  return { text: out, full: out }
}
