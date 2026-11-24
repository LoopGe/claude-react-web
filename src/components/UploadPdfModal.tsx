// Ref-keyed uploaded-PDF preview.
//
// Builder call (Task 6): a DEDICATED modal, not a `crw-resource://upload/<id>`
// provider. The ResourceModal system is a per-session host — mounted inside
// each Chat panel, tabs keyed by sessionId, invalidation driven by
// git-snapshot — while uploaded bytes are durable, immutable and session-less
// (common uploads carry no sessionId, and the Uploads Manager is an app-level
// dialog with no ResourceModal host). The chips carry only a
// FileAttachmentRef, so there is no session identity to open a resource tab
// with. This host fetches raw bytes by upload id from
// GET /api/uploads/:id/content (verified server-side, no live session needed)
// and renders the same LazyPdfBody the cwd preview uses.

import { useEffect, useState } from 'react'
import { Overlay } from './Overlay'
import LazyPdfBody from './file-preview/LazyPdfBody'
import { formatBytes } from '../utils/format'
import type { FileAttachmentRef } from '../../shared/attachments'
import { IconDownload, IconFileText, IconLoader, IconX } from './icons/ToolIcons'

/** View-state retention key for one upload: the upload id is the durable
 *  identity (no session involved). Like the resource modal's tabs, state
 *  survives close/reopen within the page session; the in-memory store resets
 *  on reload. */
function viewStateKeyOf(id: string): string {
  return `upload:${id}`
}

/** Raw bytes of one recorded upload, fetched by id. The content route
 *  verifies the bytes against the registry digest before serving, so a
 *  missing/corrupt file arrives as an HTTP error — surfaced, never guessed
 *  around. Aborts on unmount/id change. */
function useUploadPdfBytes(id: string): { bytes: Uint8Array | null; error: string | null } {
  const [state, setState] = useState<{ bytes: Uint8Array | null; error: string | null }>({
    bytes: null,
    error: null,
  })
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`/api/uploads/${encodeURIComponent(id)}/content`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (!controller.signal.aborted) setState({ bytes, error: null })
      } catch (e) {
        if (!controller.signal.aborted) setState({ bytes: null, error: (e as Error).message })
      }
    })()
    return () => controller.abort()
  }, [id])
  return state
}

/** The ref-keyed byte-source host: bytes-by-id → LazyPdfBody, with the
 *  fetch's loading/error states. Shared by the chip modal below and
 *  UploadPreview's PDF branch so both surfaces fetch identically. */
export function UploadPdfViewer({ id, name }: { id: string; name: string }) {
  const { bytes, error } = useUploadPdfBytes(id)
  return (
    <div className="upload-pdf-viewer">
      {bytes === null && error === null && (
        <div className="pdf-status pdf-status-center" role="status">
          <IconLoader size={16} className="glyph-spin" /> Loading document…
        </div>
      )}
      {error !== null && (
        <div className="pdf-status pdf-status-center" role="alert">
          Failed to load: {error}
        </div>
      )}
      {bytes !== null && (
        <LazyPdfBody bytes={bytes} title={name} viewStateKey={viewStateKeyOf(id)} />
      )}
    </div>
  )
}

/** In-app PDF preview opened by a sent-message / composer-draft PDF chip.
 *  Same chrome family as UploadPreview (header + download + close); the body
 *  is the shared ref-keyed viewer. Portalled fixed backdrop (Overlay 'modal'
 *  default) so a chip inside a panel opens it above every panel-scoped
 *  surface. */
export function UploadPdfModal({
  file,
  onClose,
}: {
  file: FileAttachmentRef
  onClose: () => void
}) {
  const contentUrl = `/api/uploads/${encodeURIComponent(file.id)}/content`
  return (
    <Overlay
      variant="modal"
      open
      onClose={onClose}
      ariaLabel="PDF preview"
      cardClassName="upload-pdf-modal"
    >
      <div className="modal-header">
        <h3>
          <IconFileText size={16} aria-hidden />{' '}
          <span className="uploads-preview-title">{file.name}</span>
        </h3>
        <span className="uploads-stats">{formatBytes(file.size)}</span>
        <a
          className="btn btn-icon"
          href={`${contentUrl}?download=1`}
          download={file.name}
          title="Download file"
          aria-label="Download file"
        >
          <IconDownload size={16} />
        </a>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close preview">
          <IconX size={16} />
        </button>
      </div>
      <div className="upload-pdf-modal-body">
        <UploadPdfViewer id={file.id} name={file.name} />
      </div>
    </Overlay>
  )
}
