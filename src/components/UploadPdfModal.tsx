// Ref-keyed uploaded-PDF preview.
//
// The chips (sent message / composer draft) keep this DEDICATED modal: they
// carry only a FileAttachmentRef, and the ResourceModal is a per-session host —
// a chip's panel may be any session, and a draft has none at all. The Uploads
// Manager's row eye is the exception that got a resource strip entry
// (`crw-resource://upload/<id>` provider → ResourceUploadBody), decided later;
// both paths share UploadPdfViewer for the bytes.
//
// The viewer fetches raw bytes by upload id from GET /api/uploads/:id/content
// (verified server-side, no live session needed) and renders the same
// LazyPdfBody the cwd preview uses — refusing over-cap sizes before the fetch,
// the same posture as the cwd read path.

import { useEffect, useState } from 'react'
import { Overlay } from './Overlay'
import LazyPdfBody from './file-preview/LazyPdfBody'
import { uploadViewStateKeyOf } from './file-preview/pdf-view-state'
import { formatBytes } from '../utils/format'
import type { FileAttachmentRef } from '../../shared/attachments'
import { PDF_PREVIEW_MAX_BYTES } from '../../shared/read-file'
import { IconDownload, IconFileText, IconLoader, IconX } from './icons/ToolIcons'

/** Raw bytes of one recorded upload, fetched by id. The content route
 *  verifies the bytes against the registry digest before serving, so a
 *  missing/corrupt file arrives as an HTTP error — surfaced, never guessed
 *  around. Aborts on unmount. A null id means there is nothing to fetch
 *  (the over-cap refusal never reads the bytes). */
function useUploadPdfBytes(id: string | null): { bytes: Uint8Array | null; error: string | null } {
  const [state, setState] = useState<{ bytes: Uint8Array | null; error: string | null }>({
    bytes: null,
    error: null,
  })
  useEffect(() => {
    if (id === null) return
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
 *  fetch's loading/error states. Shared by the chip modal below and the
 *  resource strip's upload body (ResourceUploadBody) so both surfaces fetch
 *  identically.
 *
 *  `size` (the ref's recorded byte count) gates the fetch: uploads are
 *  capped at 500 MB server-side, and buffering + parsing an oversized PDF
 *  whole is the same hazard the sibling text branch refuses with its
 *  512 KB stream cap. Over-cap refuses BEFORE fetching — the cwd path's
 *  refusal posture (PDF_PREVIEW_MAX_BYTES), with the chrome's Download
 *  button as the hatch. */
export function UploadPdfViewer({ id, name, size }: { id: string; name: string; size: number }) {
  const overCap = size > PDF_PREVIEW_MAX_BYTES
  const { bytes, error } = useUploadPdfBytes(overCap ? null : id)
  return (
    <div className="upload-pdf-viewer">
      {overCap && (
        <div className="pdf-status pdf-status-center">
          PDF is too large to preview (over {PDF_PREVIEW_MAX_BYTES / (1024 * 1024)}&nbsp;MB).
        </div>
      )}
      {!overCap && bytes === null && error === null && (
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
        <LazyPdfBody bytes={bytes} title={name} viewStateKey={uploadViewStateKeyOf(id)} />
      )}
    </div>
  )
}

/** In-app PDF preview opened by a sent-message / composer-draft PDF chip.
 *  A header + download + close card; the body is the shared ref-keyed viewer.
 *  Portalled fixed backdrop (Overlay 'modal' default) so a chip inside a panel
 *  opens it above every panel-scoped surface. (The Uploads Manager's row eye
 *  no longer opens a modal like this — it routes to the resource strip's
 *  `upload` tab, which reuses this file's UploadPdfViewer for the body.) */
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
          <span className="upload-pdf-modal-title">{file.name}</span>
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
        <UploadPdfViewer id={file.id} name={file.name} size={file.size} />
      </div>
    </Overlay>
  )
}
