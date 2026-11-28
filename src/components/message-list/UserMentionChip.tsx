import type { ReactNode } from 'react'
import { findRanges } from '../../search/match'
import { useResourceLinkContext } from '../../resources/ResourceLinkContext'
import { openMentionResource } from '../../utils/mention-resource'

/** One @file/@folder mention in a sent user message. Clickable when a resource
 *  link context is in scope (the transcript provides it from the session cwd);
 *  plain otherwise — the same "links stay plain" rule markdown links follow.
 *  A mention naming no readable file (prose `@bob`, a deleted path, a dormant
 *  session) surfaces the preview's existing read-failed frame on click. */
export function UserMentionChip({
  text,
  path,
  searchQuery,
  active = false,
}: {
  /** The serialized mention (`@path`, quotes / trailing slash included). */
  text: string
  /** The parsed mention path (directory marker stripped). */
  path: string
  searchQuery?: string
  active?: boolean
}) {
  const link = useResourceLinkContext()

  // Highlight over the SAME text the search loop counts (countMatches on the
  // serialized mention), so ordinals and marks agree.
  const label: ReactNode[] = []
  const ranges = searchQuery ? findRanges(text, searchQuery) : []
  let consumed = 0
  for (const range of ranges) {
    if (range.start > consumed) label.push(text.slice(consumed, range.start))
    label.push(
      <mark key={range.start} className={active ? 'search-hl search-hl-active' : 'search-hl'}>
        {text.slice(range.start, range.end)}
      </mark>,
    )
    consumed = range.end
  }
  if (consumed < text.length) label.push(text.slice(consumed))

  if (!link) {
    return <span className="chip-inline msg-mention-chip" title={path}>{label}</span>
  }
  return (
    <button
      type="button"
      className="chip-inline msg-mention-chip"
      title={path}
      onClick={() => openMentionResource(link.openResource, link.sessionId, link.baseDir, path)}
    >
      {label}
    </button>
  )
}
