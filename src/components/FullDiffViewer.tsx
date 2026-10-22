// "View full diff" escape hatch. The panel's DiffView only renders a
// PREVIEW body (capped by line count / total bytes / per-line width — see
// MAX_DIFF_* in server/constants.ts), so a truncated marker needs a way to
// see the complete text. This modal fetches it (`full=1`) and renders it as
// ONE plain <pre> — no per-row grid, no syntax highlighting — revealed in
// chunks so a multi-megabyte body never lands in the DOM at once.
//
// Chunking is render-side, not fetch-side: the complete text is one HTTP
// response (simpler, and the wire is local), but only the first
// FULL_DIFF_CHUNK_CHARS are painted until the user asks for more.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

/** How much of the fetched body is painted per step. 256 KB of text lays out
 *  comfortably; more than one step's worth is available via "Show more". */
export const FULL_DIFF_CHUNK_CHARS = 256 * 1024

interface Props {
  open: boolean
  onClose: () => void
  /** Display title (repo-relative path). */
  name: string
  /** Loads the complete, untruncated diff text (e.g. the `full=1` API).
   *  Receives an AbortSignal to cancel the transfer on close/unmount. */
  fetchText: (signal?: AbortSignal) => Promise<string>
}

export function FullDiffViewer({ open, onClose, name, fetchText }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(FULL_DIFF_CHUNK_CHARS)
  // fetchText identity is caller-owned; keep the latest in a ref so a
  // re-render can't re-trigger the fetch (or fire a stale one). Synced in
  // an effect, never during render (react-hooks/refs).
  const fetchRef = useRef(fetchText)
  useEffect(() => {
    fetchRef.current = fetchText
  })

  useEffect(() => {
    // Clear on close as well as on open: the viewer stays mounted inside the
    // file row (and the panel is keep-alive cached across session switches),
    // so a multi-MB body would otherwise linger in the heap and flash stale
    // on reopen before the refetch lands. Reset-on-input-change, same shape
    // as useGitDiff's disabled branch.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
    setText(null)
    setError(null)
    setShown(FULL_DIFF_CHUNK_CHARS)
    if (!open) return
    const ctrl = new AbortController()
    fetchRef.current(ctrl.signal).then(
      (body) => {
        if (!ctrl.signal.aborted) setText(body)
      },
      (err: Error) => {
        if (!ctrl.signal.aborted) setError(err.message)
      },
    )
    return () => {
      ctrl.abort()
    }
  }, [open])

  const showMore = useCallback(() => setShown((n) => n + FULL_DIFF_CHUNK_CHARS), [])

  const visible = text === null ? '' : text.slice(0, shown)
  const hasMore = text !== null && shown < text.length

  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="modal"
      ariaLabel="Full diff viewer"
      cardClassName="file-viewer full-diff-viewer"
      cardStyle={{ width: 860, maxWidth: '94vw' }}
      // Portal to <body> — same reason FileViewer does: callers mount us
      // inside a per-panel overlay whose backdrop-filter would otherwise be
      // the containing block for fixed descendants and clip the card.
      portal
    >
      <div className="modal-header">
        <h3 className="file-viewer-title" title={name}>{name}</h3>
        <button className="btn btn-icon-sm" onClick={onClose} aria-label="Close"><IconX /></button>
      </div>
      <div className="modal-section file-viewer-body">
        {error && <div className="field-error">{error}</div>}
        {!error && text === null && <div className="hint">Loading full diff…</div>}
        {!error && text !== null && (
          <pre className="full-diff-body" data-testid="full-diff-body">{visible}</pre>
        )}
        {hasMore && (
          <button type="button" className="btn full-diff-more" onClick={showMore}>
            Show more ({Math.ceil((text!.length - shown) / 1024)}&nbsp;KB remaining)
          </button>
        )}
      </div>
    </Overlay>
  )
}
