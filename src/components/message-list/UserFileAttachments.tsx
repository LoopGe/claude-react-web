import type { ReactNode } from 'react'
import type { FileAttachmentRef } from '../../../shared/attachments'
import { findRanges } from '../../search/match'
import { formatBytes } from '../../utils/format'
import { IconFileText } from '../icons/ToolIcons'

/** One file occurrence in a user message. The occurrence key includes the
 * source segment index, so attaching the same upload twice stays distinct. */
export function UserFileAttachments({
  file,
  occurrenceKey,
  searchQuery,
  active = false,
}: {
  file: FileAttachmentRef
  occurrenceKey: string
  searchQuery?: string
  active?: boolean
}) {
  const name: ReactNode[] = []
  const ranges = searchQuery ? findRanges(file.name, searchQuery) : []
  let consumed = 0
  for (const range of ranges) {
    if (range.start > consumed) name.push(file.name.slice(consumed, range.start))
    name.push(
      <mark key={range.start} className={active ? 'search-hl search-hl-active' : 'search-hl'}>
        {file.name.slice(range.start, range.end)}
      </mark>,
    )
    consumed = range.end
  }
  if (consumed < file.name.length) name.push(file.name.slice(consumed))

  return (
    <a
      className="msg-file-chip"
      data-file-occurrence={occurrenceKey}
      href={`/api/uploads/${encodeURIComponent(file.id)}/content`}
      target="_blank"
      rel="noreferrer"
      title={file.name}
    >
      <IconFileText size={14} className="msg-file-icon" />
      <span className="msg-file-name">{name}</span>
      <span className="msg-file-size">{formatBytes(file.size)}</span>
    </a>
  )
}
