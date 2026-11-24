import { useState, type ReactNode } from 'react'
import type { FileAttachmentRef } from '../../../shared/attachments'
import { uploadPreviewKind } from '../../../shared/uploads'
import { findRanges } from '../../search/match'
import { formatBytes } from '../../utils/format'
import { IconFileText } from '../icons/ToolIcons'
import { UploadPdfModal } from '../UploadPdfModal'

/** One file occurrence in a user message. The occurrence key includes the
 * source segment index, so attaching the same upload twice stays distinct.
 * A PDF ref opens the in-app preview (bytes fetched by upload id); every
 * other kind keeps the download link to the stored copy. */
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
  const [previewOpen, setPreviewOpen] = useState(false)
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

  const body = (
    <>
      <IconFileText size={14} className="msg-file-icon" />
      <span className="msg-file-name">{name}</span>
      <span className="msg-file-size">{formatBytes(file.size)}</span>
    </>
  )

  if (uploadPreviewKind(file.name) === 'pdf') {
    return (
      <>
        <button
          type="button"
          className="msg-file-chip"
          data-file-occurrence={occurrenceKey}
          data-text-interaction-exclude=""
          title={file.name}
          onClick={() => setPreviewOpen(true)}
        >
          {body}
        </button>
        {previewOpen && <UploadPdfModal file={file} onClose={() => setPreviewOpen(false)} />}
      </>
    )
  }

  return (
    <a
      className="msg-file-chip"
      data-file-occurrence={occurrenceKey}
      data-text-interaction-exclude=""
      href={`/api/uploads/${encodeURIComponent(file.id)}/content`}
      target="_blank"
      rel="noreferrer"
      title={file.name}
    >
      {body}
    </a>
  )
}
