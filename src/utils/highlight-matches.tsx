import type { ReactNode } from 'react'
import { findRanges } from '../../shared/search/match'
import type { MatchOptions } from '../../shared/search/types'

/**
 * Render every match of `query` in `text` as a themed `<mark>`.
 *
 * The range semantics come from `findRanges`, the same matcher the server-side
 * search index counts with, so a hit reported there highlights exactly the
 * characters the user was told matched. Empty queries and no-match text return
 * the original string (no wrapper elements).
 */
export function renderMatchMarks(
  text: string,
  query: string,
  opts?: MatchOptions & {
    /** Index of the ONE range that is the active navigation target; its
     *  <mark> gets the extra search-hl-active class. Undefined = all marks
     *  render at the default colour. */
    activeIdx?: number
  },
): ReactNode {
  const ranges = findRanges(text, query, opts)
  if (ranges.length === 0) return text

  const out: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i]
    if (start > cursor) out.push(text.slice(cursor, start))
    out.push(
      <mark key={i} className={i === opts?.activeIdx ? 'search-hl search-hl-active' : 'search-hl'}>
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}