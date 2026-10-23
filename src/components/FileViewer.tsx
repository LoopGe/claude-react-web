// Per-session read-only file content viewer (SDK Query.readFile). Reads a
// file's CURRENT content through a live session — gated by that session's
// Read-permission rules inside the SDK. Content is viewed, never edited.
// Binary image files preview as images (MsgImage → the app-wide Lightbox);
// everything else renders as code.

import { Overlay } from './Overlay'
import { CodeBlock } from './Markdown'
import { MsgImage } from './MsgImage'
import { imageMediaTypeOf, splitFilePath } from '../utils/file-display'
import { imageDataUrl } from '../utils/image-block'
import { useReadFile } from '../hooks/useReadFile'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { IconX } from './icons/ToolIcons'

interface Props {
  open: boolean
  onClose: () => void
  /** Session whose read-permission rules gate the read. */
  sessionId: string
  /** Absolute path to read (relative to that session's cwd is also accepted by
   *  the SDK, but the GitPanel call site always sends an absolute path). */
  path: string | null
  /** Display title (e.g. repo-relative path). */
  name?: string
}

/** Read cap for image previews. The SDK default (1 MB) truncates ordinary
 *  screenshots, and a truncated base64 payload decodes to an undecodable —
 *  broken — image, so previews ask for more headroom before giving up. */
const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

export function FileViewer({ open, onClose, sessionId, path, name }: Props) {
  const title = name ?? path ?? '(no file)'
  // Content kind follows the path actually read, not the display label: `name`
  // is documented as a title and callers may pass a bare label there.
  const mediaType = path ? imageMediaTypeOf(path) : null
  const { data, contents, available, truncated, error, loading } = useReadFile(
    sessionId,
    open ? path : null,
    mediaType ? { encoding: 'base64', maxBytes: IMAGE_PREVIEW_MAX_BYTES } : undefined,
  )
  const imageSrc =
    mediaType && data?.encoding === 'base64' && contents ? imageDataUrl(mediaType, contents) : null
  // Custom thin scrollbar on the scrolling <pre> (CodeBlock forwards the
  // preRef — same pattern DiffView uses for the diff body).
  const setCodeOs = useOverlayScrollbar({ autoHide: 'leave' })
  // `data === null` means no response has landed yet (initial paint before the
  // fetch effect, or an in-flight request) — don't flash the "needs permission"
  // hint before we actually know the SDK denied/missed the read.
  const pending = loading || (!error && data === null)

  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="modal"
      ariaLabel="File viewer"
      cardClassName="file-viewer"
      cardStyle={{ width: 720, maxWidth: '92vw' }}
      // Portal to <body>: callers mount FileViewer inside a per-panel overlay
      // (`.git-overlay` / settings), whose backdrop-filter makes it the
      // containing block for fixed descendants — a non-portaled modal would be
      // clipped to that panel box and render visibly cut off.
      portal
    >
      <div className="modal-header">
        <h3 className="file-viewer-title" title={path ?? undefined}>{title}</h3>
        <button className="btn btn-icon-sm" onClick={onClose} aria-label="Close"><IconX /></button>
      </div>
      <div className="modal-section file-viewer-body">
        {pending && <div className="hint">Reading…</div>}
        {!pending && error && <div className="field-error">{error}</div>}
        {!pending && !error && !available && (
          <div className="hint">Needs read permission, or the file is missing.</div>
        )}
        {!pending && !error && available && contents !== undefined && (
          // An image only becomes a preview when the read really returned
          // base64: the SDK documents `encoding` as absent when an older CLI
          // ignored the request, in which case `contents` is utf-8 text and
          // must NOT be fed to a base64 data URL (broken <img>). An empty
          // read has no payload to preview either. Both fall back to the
          // code view, which is exactly what a non-image gets.
          imageSrc ? (
            truncated ? (
              // A truncated base64 payload is an undecodable image — say so
              // rather than rendering a broken <img>.
              <div className="hint file-viewer-truncated">
                Image is too large to preview (over {IMAGE_PREVIEW_MAX_BYTES / (1024 * 1024)}&nbsp;MB).
              </div>
            ) : (
              <MsgImage src={imageSrc} alt={title} decoding="async" />
            )
          ) : (
            <>
              <CodeBlock lang={splitFilePath(title).base || title} className="file-viewer-code" showCopy preRef={setCodeOs}>
                {contents}
              </CodeBlock>
              {truncated && (
                <div className="hint file-viewer-truncated">
                  File is large — content truncated by the read cap (default 1&nbsp;MB).
                </div>
              )}
            </>
          )
        )}
      </div>
    </Overlay>
  )
}