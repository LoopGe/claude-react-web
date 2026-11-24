// The file content body rendered by the resource pane
// (docs/resource-tabs-research.md §13). Hosts own the chrome (pane frame) and
// the data source; this component owns the decision tree:
// pending → error → unavailable → image → pdf → markdown preview/source → code.
//
// Image/pdf/markdown detection follows `path` (the bytes actually read), never
// the display `title` — callers may pass a bare label there.

import { useEffect, useMemo, useState } from 'react'
import { Markdown } from '../Markdown'
import { MsgImage } from '../MsgImage'
import { NumberedCode } from './NumberedCode'
import LazyPdfBody from './LazyPdfBody'
import { FrontmatterFields } from './FrontmatterFields'
import { splitFrontmatter } from '../../utils/frontmatter'
import { detectLanguage, imageMediaTypeOf, isPdfPath, splitFilePath } from '../../utils/file-display'
import { imageDataUrl } from '../../utils/image-block'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import {
  IMAGE_PREVIEW_MAX_BYTES,
  PDF_PREVIEW_MAX_BYTES,
  type FileReadResult,
} from '../../../shared/read-file'

/** Decode a base64 read payload to the bytes pdf.js consumes. Synchronous and
 *  memoized on the payload string (see useMemo below): the server produced valid
 *  base64 from real file bytes, so there is no decode-failure state to handle,
 *  and a re-render must never re-decode a multi-MB document. */
function decodePdfBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export interface FilePreviewBodyProps {
  /** Absolute path of the bytes in `data` (drives image/markdown detection). */
  path: string | null
  /** Display title — the code block's bar label. The highlight language comes
   *  from `path` (detectLanguage), never from this label. */
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
  /** The file resource address (`crw-resource://file/<sid>/<path>`) — the
   *  (session,file) identity PDF view-state retention keys on. Absent = no
   *  retention (the viewer's viewStateKey is optional). */
  address?: string
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
  address,
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
  // PDF preview gates on base64 exactly like the image branch: a read without
  // `encoding` is utf-8 text and must not be fed to pdf.js. The bytes are decoded
  // once per payload string and memoized, so the viewer's load (keyed on byte
  // identity) never re-runs on an unrelated re-render. A truncated read is
  // over-cap — refused below rather than decoded into partial bytes.
  const pdfBase64 =
    path && isPdfPath(path) && data?.encoding === 'base64' && data.contents
      ? data.contents
      : null
  const pdfBytes = useMemo(
    () => (pdfBase64 !== null && !truncated ? decodePdfBytes(pdfBase64) : null),
    [pdfBase64, truncated],
  )
  // Preview-mode metadata split: a leading frontmatter block renders as a
  // field list above the markdown body. Source mode is untouched — it always
  // shows the FULL original contents, delimiters included — so the split is
  // only computed in preview mode, memoized on its inputs.
  const markdownSplit = useMemo(
    () => (!showSource && isMarkdown && contents !== undefined ? splitFrontmatter(contents) : null),
    [showSource, isMarkdown, contents],
  )

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
        ) : pdfBase64 !== null ? (
          // Within this branch pdfBytes is null exactly when the read was
          // truncated (the useMemo guard): an over-cap PDF is undecodable, so
          // refuse it — never feed partial bytes to pdf.js (the image precedent).
          pdfBytes !== null ? (
            <LazyPdfBody bytes={pdfBytes} title={title} viewStateKey={address} />
          ) : (
            <div className="hint file-viewer-truncated">
              PDF is too large to preview (over {PDF_PREVIEW_MAX_BYTES / (1024 * 1024)}&nbsp;MB).
            </div>
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
              {markdownSplit?.frontmatter != null ? (
                <>
                  <FrontmatterFields source={markdownSplit.frontmatter} />
                  <Markdown text={markdownSplit.body} />
                </>
              ) : (
                <Markdown text={contents} />
              )}
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
              lang={path ? (detectLanguage(path) ?? undefined) : undefined}
              label={splitFilePath(title).base || title}
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