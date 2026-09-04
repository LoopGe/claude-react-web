// Per-session read-only file content viewer (SDK Query.readFile). Reads a
// file's CURRENT content through a live session — gated by that session's
// Read-permission rules inside the SDK. Content is viewed, never edited;
// binary files pass through as UTF-8 text (no image preview this pass).

import { Overlay } from './Overlay'
import { CodeBlock } from './Markdown'
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

export function FileViewer({ open, onClose, sessionId, path, name }: Props) {
  const { data, contents, available, truncated, error, loading } = useReadFile(sessionId, open ? path : null)
  // Custom thin scrollbar on the scrolling <pre> (CodeBlock forwards the
  // preRef — same pattern DiffView uses for the diff body).
  const setCodeOs = useOverlayScrollbar({ autoHide: 'leave' })

  const title = name ?? path ?? '(no file)'
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
          <>
            <CodeBlock lang={title.split('/').pop() ?? title} className="file-viewer-code" showCopy preRef={setCodeOs}>
              {contents}
            </CodeBlock>
            {truncated && (
              <div className="hint file-viewer-truncated">
                File is large — content truncated by the read cap (default 1&nbsp;MB).
              </div>
            )}
          </>
        )}
      </div>
    </Overlay>
  )
}