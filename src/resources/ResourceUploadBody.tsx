// `upload` resource tab body — the uploads-manager eye opens here instead of
// the former standalone UploadPreview modal.
//
// Routes by the provider's preview kind across the app's EXISTING byte paths
// (the PDF section's "two byte sources, one viewer" posture extended):
//   image  → direct content URL in <MsgImage> (browser-streamed, Lightbox on
//            click; a vanished upload surfaces through onError, the old modal's
//            list-snapshot caveat).
//   pdf    → UploadPdfViewer (raw bytes by id → LazyPdfBody, over-cap refused
//            from the address's recorded size BEFORE fetching).
//   text   → FilePreviewBody fed by the provider's capped FileReadResult:
//            markdown preview/source, frontmatter, NumberedCode line numbers —
//            the full cwd-preview tree for uploaded text files.
//   other  → the no-preview notice (download lives in the modal header).

import { useState } from 'react'
import { parseUploadResource } from '../../shared/resource-address'
import { FilePreviewBody } from '../components/file-preview/FilePreviewBody'
import { MsgImage } from '../components/MsgImage'
import { UploadPdfViewer } from '../components/UploadPdfModal'
import { useResource } from './useResource'
import type { UploadResourceValue } from './providers/upload'

/** Direct content route for one upload (the durable, session-less byte path). */
function uploadContentUrl(id: string): string {
  return `/api/uploads/${encodeURIComponent(id)}/content`
}

export function ResourceUploadBody({ address }: { address: string }) {
  const snapshot = useResource<UploadResourceValue>(address)
  const resource = parseUploadResource(address)
  if (!resource) return <div className="hint">This address does not name an upload.</div>

  const value = snapshot.value ?? null
  if (!value) {
    if (snapshot.status === 'loading') return <div className="hint">Reading…</div>
    return (
      <div className="field-error">
        {snapshot.failure?.message ?? 'Failed to load this upload.'}
      </div>
    )
  }

  switch (value.kind) {
    case 'image':
      return <UploadImage src={uploadContentUrl(resource.id)} name={resource.name} />
    case 'pdf':
      return <UploadPdfViewer id={resource.id} name={resource.name} size={resource.size} />
    case 'text':
      return (
        <FilePreviewBody
          address={address}
          path={resource.name}
          title={resource.name}
          data={value.text ?? null}
          error={null}
          loading={false}
        />
      )
    default:
      return (
        <div className="hint">
          No preview available for this file type. Use the download button to save it.
        </div>
      )
  }
}

/** The exists flag on the manager row is a list-time snapshot — the upload can
 *  vanish (delete, GC) between opening the tab and the <img> resolving, so the
 *  direct-URL render keeps the old modal's explicit failure hint. */
function UploadImage({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <div className="hint">Failed to load image — the file may have been deleted.</div>
  }
  return <MsgImage src={src} alt={name} decoding="async" onError={() => setFailed(true)} />
}
