// Preview panel for one recorded upload, opened from the Uploads
// Manager's per-row view button. Images render inline (<img>); text
// files stream in capped to TEXT_PREVIEW_LIMIT bytes (uploads are
// capped at 500 MB server-side, so a full text() is not safe); other
// kinds show an unsupported notice. Every kind carries a Download
// button (GET /uploads/:id/content?download=1).
//
// The panel reuses the Overlay 'perm' shell and nests inside the
// manager dialog the same way ConfirmDialog does.

import { useEffect, useState } from 'react'
import { Overlay } from './Overlay'
import { CodeBlock } from './Markdown'
import { formatBytes } from '../utils/format'
import { uploadPreviewKind, type UploadListItem } from '../../shared/uploads'
import { IconDownload, IconEye, IconLoader, IconX } from './icons/ToolIcons'

export const TEXT_PREVIEW_LIMIT = 512 * 1024

interface Props {
  target: UploadListItem
  onClose: () => void
}

export function UploadPreview({ target, onClose }: Props) {
  const kind = uploadPreviewKind(target.name)
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(kind === 'text')
  // Image fetches surface through <img onError> — the exists flag on the
  // row is a list-time snapshot, so the file can vanish between listing
  // and preview.
  const [imgError, setImgError] = useState(false)

  const contentUrl = `/api/uploads/${encodeURIComponent(target.id)}/content`

  useEffect(() => {
    if (kind !== 'text') return
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(contentUrl, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Stream up to the cap, then cancel — the file may be far larger.
        const reader = res.body?.getReader()
        if (!reader) throw new Error('no response body')
        const chunks: Uint8Array[] = []
        let received = 0
        let over = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          if (received >= TEXT_PREVIEW_LIMIT) {
            // Truncated when bytes were dropped (received past the cap) OR
            // the stream has more left. A stream landing exactly on the cap
            // may still be complete — confirm with one more read.
            const next = await reader.read()
            over = received > TEXT_PREVIEW_LIMIT || !next.done
            if (!next.done) void reader.cancel()
            break
          }
        }
        const cut = Math.min(received, TEXT_PREVIEW_LIMIT)
        const merged = new Uint8Array(cut)
        let offset = 0
        for (const chunk of chunks) {
          if (offset >= cut) break
          merged.set(chunk.subarray(0, cut - offset), offset)
          offset += Math.min(chunk.length, cut - offset)
        }
        const body = new TextDecoder('utf-8', { fatal: false }).decode(merged)
        if (controller.signal.aborted) return
        setText(body)
        setTruncated(over)
        setLoading(false)
      } catch (e) {
        if (controller.signal.aborted) return
        setError((e as Error).message)
        setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [kind, contentUrl])

  return (
    <Overlay
      variant="perm"
      open
      onClose={onClose}
      ariaLabel="File preview"
      cardClassName="uploads-preview-card"
    >
      <div className="modal-header">
        <h3>
          <IconEye size={16} aria-hidden /> <span className="uploads-preview-title">{target.name}</span>
        </h3>
        <span className="uploads-stats">{formatBytes(target.size)}</span>
        <a className="btn btn-icon" href={`${contentUrl}?download=1`} download={target.name} title="Download file" aria-label="Download file">
          <IconDownload size={16} />
        </a>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close preview">
          <IconX size={16} />
        </button>
      </div>

      <div className="uploads-preview-body">
        {kind === 'image' && !imgError && (
          <img
            className="uploads-preview-image"
            src={contentUrl}
            alt={target.name}
            onError={() => setImgError(true)}
          />
        )}

        {kind === 'image' && imgError && (
          <div className="uploads-state">
            <span>Failed to load image — the file may have been deleted.</span>
          </div>
        )}

        {kind === 'text' && loading && (
          <div className="uploads-state">
            <IconLoader size={16} className="glyph-spin" /> Loading…
          </div>
        )}

        {kind === 'text' && error !== null && (
          <div className="uploads-state">
            <span>Failed to load: {error}</span>
          </div>
        )}

        {kind === 'text' && !loading && error === null && (
          <>
            {truncated && (
              <div className="uploads-preview-truncated">
                Preview limited to the first {formatBytes(TEXT_PREVIEW_LIMIT)} — use Download for the full file.
              </div>
            )}
            <CodeBlock lang={target.name} className="uploads-preview-text">
              {text}
            </CodeBlock>
          </>
        )}

        {kind === 'other' && (
          <div className="uploads-state uploads-empty">
            No preview available for this file type. Use the download button to save it.
          </div>
        )}
      </div>
    </Overlay>
  )
}
