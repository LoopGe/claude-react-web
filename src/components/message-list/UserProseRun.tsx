// One inline prose run of a sent user message: consecutive text + mention
// segments rendered in a single inline flow, so `see @src/a.ts and @bob` reads
// as one sentence with clickable chips instead of stacking every fragment into
// its own block. File/image segments break runs (they keep their block layout).
//
// Boundary whitespace is preserved as literal text nodes around each fragment's
// trimmed markdown core: the markdown pipeline strips a document's leading /
// trailing structural whitespace, which would otherwise glue the prose to the
// chips (`see@src/a.ts`). The core keeps its inline markdown (bold, links, code)
// and its search marks; the run container's pre-wrap keeps the literal spaces
// and newlines faithful to the source.

import type { ReactNode } from 'react'
import { compileMarkdown } from '../../utils/markdown-cache'
import type { UserContentSegment } from '../../utils/file-blocks'
import { QuotePreview } from '../QuotePreview'
import { UserMentionChip } from './UserMentionChip'

export interface ProseRunItem {
  segment: UserContentSegment
  /** Index in the message's full segment list (keys + active-match maps). */
  index: number
}

/** A text fragment: literal boundary whitespace + its trimmed markdown core
 *  rendered inline. A whitespace-only fragment renders as literal text.
 *
 *  `collapseStart` / `collapseEnd` mark a fragment whose left / right neighbour
 *  in the run is a quote chip: the facing paragraph separator (the blank line
 *  `joinTokens` guarantees around a quote run) renders as a single inline space
 *  so the quote flows with the surrounding prose (DSH quote-rule parity)
 *  instead of stacking onto its own line. */
function ProseText({ text, searchQuery, activeMatchIdx, collapseStart = false, collapseEnd = false }: {
  text: string
  searchQuery?: string
  activeMatchIdx?: number
  collapseStart?: boolean
  collapseEnd?: boolean
}) {
  const core = text.trim()
  if (core === '') {
    // A whitespace-only fragment beside a quote is just the separator.
    if ((collapseStart || collapseEnd) && text.length > 0) return <> </>
    return <>{text}</>
  }
  const leadingLen = text.length - text.trimStart().length
  const trailingLen = text.length - text.trimEnd().length
  const leading = collapseStart && leadingLen > 0 ? ' ' : text.slice(0, leadingLen)
  const trailing = collapseEnd && trailingLen > 0 ? ' ' : text.slice(text.length - trailingLen)
  return (
    <>
      {leading}
      <span className="md md-inline">
        {compileMarkdown(core, { breaks: true, searchQuery, activeMatchIdx })}
      </span>
      {trailing}
    </>
  )
}

export function UserProseRun({ items, searchQuery, textActive, mentionActive }: {
  items: readonly ProseRunItem[]
  searchQuery?: string
  textActive: ReadonlyMap<number, number>
  mentionActive: ReadonlySet<number>
}) {
  const out: ReactNode[] = []
  for (let i = 0; i < items.length; i++) {
    const { segment, index } = items[i]!
    if (segment.type === 'mention') {
      out.push(
        <UserMentionChip
          key={`mention-${index}`}
          text={segment.text}
          path={segment.path}
          searchQuery={searchQuery}
          active={mentionActive.has(index)}
        />,
      )
    } else if (segment.type === 'quote') {
      // Inert sent quote: the exact run; QuotePreview decodes the excerpt.
      out.push(<QuotePreview key={`quote-${index}`} text={segment.text} />)
    } else if (segment.type === 'text') {
      out.push(
        <ProseText
          key={`text-${index}`}
          text={segment.text}
          searchQuery={searchQuery}
          activeMatchIdx={textActive.get(index)}
          collapseStart={items[i - 1]?.segment.type === 'quote'}
          collapseEnd={items[i + 1]?.segment.type === 'quote'}
        />,
      )
    }
  }
  return <div className="msg-prose-run">{out}</div>
}
