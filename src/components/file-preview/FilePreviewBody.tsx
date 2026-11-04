// The file content body rendered by the resource pane
// (docs/resource-tabs-research.md §13). Hosts own the chrome (pane frame) and
// the data source; this component owns the decision tree:
// pending → error → unavailable → image → markdown preview/source → code.
//
// Image/markdown detection follows `path` (the bytes actually read), never the
// display `title` — callers may pass a bare label there.

import { useEffect, useState } from 'react'
import { Markdown } from '../Markdown'
import { MsgImage } from '../MsgImage'
import { NumberedCode } from './NumberedCode'
import { detectLanguage, imageMediaTypeOf, splitFilePath } from '../../utils/file-display'
import { imageDataUrl } from '../../utils/image-block'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { IMAGE_PREVIEW_MAX_BYTES, type FileReadResult } from '../../../shared/read-file'

export interface FilePreviewBodyProps {
  /** Absolute path of the bytes in `data` (drives image/markdown detection). */
  path: string | null
  /** Display title (the code block's language hint comes from it). */
  title: string
  /** null = no response has landed yet (initial paint / in flight). */
  data: FileReadResult | null
  error: string | null
  loading: boolean
  /** 1-based navigation target from a Markdown `#L…` link. */
  line?: number
  endLine?: number
  /** Bumps on every re-open so the same line re-scrolls. */
  revision?: number
}

export function FilePreviewBody({
  path,
  title,
  data,
  error,
  loading,
  line,
  endLine,
  revision = 0,
}: FilePreviewBodyProps) {
  const mediaType = path ? imageMediaTypeOf(path) : null
  const imageSrc =
    mediaType && data?.encoding === 'base64' && data.contents
      ? imageDataUrl(mediaType, data.contents)
      : null
  const isMarkdown = path ? detectLanguage(path) === 'markdown' : false
  // Markdown renders formatted by default; the source toggle keeps the code
  // view (and its copy button) one click away. Sticky per mount — hosts mount
  // one body per open target (modal) or per active tab (pane). A line target
  // starts in source view so the jump lands on a real line, and re-applies on
  // every reopen (revision bump).
  const [showSource, setShowSource] = useState(line != null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: a reopened line target forces the source view
    if (line != null) setShowSource(true)
  }, [line, revision])
  // Custom thin scrollbar on whichever body scrolls: the code view's <pre>
  // (CodeBlock forwards the preRef — same pattern DiffView uses for the diff
  // body) or the markdown preview container. The two are mutually exclusive
  // in the tree, so one ref callback covers both without stealing the
  // attach/destroy lifecycle from the other.
  const setCodeOs = useOverlayScrollbar({ autoHide: 'leave' })
  // `data === null` means no response has landed yet (initial paint before the
  // fetch effect, or an in-flight request) — don't flash the "needs permission"
  // hint before we actually know the read was denied/missed.
  const pending = loading || (!error && data === null)
  const available = data?.available ?? false
  const contents = data?.contents
  const truncated = data?.truncated

  return (
    <>
      {pending && <div className="hint">Reading…</div>}
      {!pending && error && <div className="field-error">{error}</div>}
      {!pending && !error && !available && (
        <div className="hint">Needs read permission, or the file is missing.</div>
      )}
      {/* No `!error` gate on the content: the registry retains the last good
          value beside a refetch failure, and a transient error must not blank
          the file the user is looking at. */}
      {!pending && available && contents !== undefined && (
        // An image only becomes a preview when the read really returned base64:
        // the SDK documents `encoding` as absent when an older CLI ignored the
        // request, in which case `contents` is utf-8 text and must NOT be fed
        // to a base64 data URL (broken <img>). An empty read has no payload to
        // preview either. Both fall back to the code view.
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
        ) : isMarkdown && !showSource ? (
          <>
            <button
              type="button"
              className="btn file-viewer-source-toggle"
              onClick={() => setShowSource(true)}
            >
              View source
            </button>
            {/* Same renderer the transcript uses — GFM, math, syntax
                highlighting, and embedded images already wire into the
                Lightbox. Inner .md pre/.md table scrollbars are already
                CSS-hidden (overlay-scrollbar.css) — only this outer container
                scrolls natively, so it gets the overlay thumb too. */}
            <div className="file-viewer-md" ref={setCodeOs}>
              <Markdown text={contents} />
            </div>
            {truncated && (
              <div className="hint file-viewer-truncated">
                File is large — content truncated by the read cap.
              </div>
            )}
          </>
        ) : (
          <>
            {isMarkdown && (
              <button
                type="button"
                className="btn file-viewer-source-toggle"
                onClick={() => setShowSource(false)}
              >
                View preview
              </button>
            )}
            <NumberedCode
              contents={contents}
              lang={splitFilePath(title).base || title}
              line={line}
              endLine={endLine}
              revision={revision}
            />
            {truncated && (
              <div className="hint file-viewer-truncated">
                File is large — content truncated by the read cap.
              </div>
            )}
          </>
        )
      )}
    </>
  )
}