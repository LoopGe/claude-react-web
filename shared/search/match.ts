// Pure-function range matching.  Decoupled from React, hast, and the
// session store so it can be exercised under unit tests without any
// rendering setup.  Future "case-sensitive / whole-word / regex"
// toggles are isolated here.

import type { MatchOptions, Range } from './types.js'

/** Escape regex metacharacters in a literal query.  Includes `\`
 *  inside the character class so a query containing a backslash is
 *  matched literally rather than as a regex escape. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+^${}()|[\]\\]/g, '\\$&')
}

/** Find every non-overlapping match of `query` inside `text`.
 *  Returns ranges in document order.  Empty queries and empty text
 *  return an empty array — never null. */
export function findRanges(
  text: string,
  query: string,
  opts: MatchOptions = {},
): Range[] {
  if (!text || !query) return []
  const flags = opts.caseSensitive ? 'g' : 'gi'
  const re = new RegExp(escapeRegex(query), flags)
  const out: Range[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Defensive: a zero-length match on an empty query would loop
    // forever.  We already guard against empty `query` above, but
    // keep this as a belt-and-braces step.
    if (m[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** Convenience: count matches without allocating the full range list.
 *  Useful for the search bar's "5 / 12" total — we don't need the
 *  positions of every match per message, only the sum. */
export function countMatches(
  text: string | null | undefined,
  query: string,
  opts: MatchOptions = {},
): number {
  if (!text || !query) return 0
  const flags = opts.caseSensitive ? 'g' : 'gi'
  const re = new RegExp(escapeRegex(query), flags)
  let count = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    count++
  }
  return count
}
