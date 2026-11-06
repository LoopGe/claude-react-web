// Turn changes owns its viewport and patch-level rows so GitPanel's inline
// constraints cannot leak in. Code rows share Edit's canonical dual-gutter
// primitive; only the parser, scrollbar utility, and that row are shared.

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TurnDiffViewMode } from '../../shared/turn-changes.js'
import { parseUnifiedDiff } from '../utils/diff-parse'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { DiffLine, detectLangSafe } from './tool-views/diff-shared'

const RENDER_CHUNK_LINES = 5000

/** How many lines of leading context stay visible above the first modified
 *  line when the view opens / the file switches. */
const SCROLL_ANCHOR_MARGIN_LINES = 3

/** The anchor auto-extends the render limit so the first modification is
 *  actually on screen, but only within this bound — beyond it the extension
 *  would commit so many rows in one paint that it defeats the chunking the
 *  limit exists for. Such deep-first-change patches open at the top instead. */
const ANCHOR_RENDER_CAP = 20_000

export interface TurnDiffViewProps {
  text: string
  view?: TurnDiffViewMode
  truncated: boolean
  totalLines: number
  onShowFull?: () => void
  /** File path the patch belongs to — drives syntax highlighting via the
   *  same extension table the Edit card uses. */
  filePath?: string
}

export const TurnDiffView = memo(function TurnDiffView({ text, view = 'changes', truncated, totalLines, onShowFull, filePath }: TurnDiffViewProps) {
  const rows = useMemo(() => parseUnifiedDiff(text), [text])
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK_LINES)
  const viewRef = useRef<HTMLDivElement | null>(null)
  const setDiffOs = useOverlayScrollbar({ orientation: 'both', autoHide: 'leave' })
  // One stable callback ref: the inline `(el) => { ... }` form detaches and
  // reattaches on every commit (Show more, etc.), costing a bail-out render.
  const setViewRef = useCallback((el: HTMLDivElement | null) => {
    viewRef.current = el
    setDiffOs(el)
  }, [setDiffOs])

  const language = filePath ? detectLangSafe(filePath) : null

  // One per-view filter, shared by the renderer and every count below so the
  // "Show more" and truncation numbers always describe what can render:
  //   full-file → code rows only (no git headers, no @@ markers)
  //   part      → code rows + @@ markers (the markers only drive hunk gaps;
  //               they are excluded from the counts)
  // Both drop meta (---/+++) rows; part also drops \ No newline.
  const displayRows = useMemo(
    () => view === 'full-file'
      ? rows.filter((row) => row.type !== 'meta' && row.type !== 'hunk')
      : rows.filter((row) => row.type === 'add' || row.type === 'del' || row.type === 'ctx' || row.type === 'hunk'),
    [rows, view],
  )
  // The first modified line — where the view opens. When it falls beyond the
  // first render chunk, extend the limit so the anchor row actually renders
  // (capped, see ANCHOR_RENDER_CAP).
  const firstChangeIdx = useMemo(
    () => displayRows.findIndex((row) => row.type === 'add' || row.type === 'del'),
    [displayRows],
  )
  const anchorable = firstChangeIdx >= 0 && firstChangeIdx < ANCHOR_RENDER_CAP
  const limit = anchorable ? Math.max(renderLimit, firstChangeIdx + 1) : renderLimit
  const visibleRows = displayRows.slice(0, limit)
  // "Show more" counts content rows only — @@ markers are never rendered as
  // rows, so they must not be counted as remaining lines.
  let remaining = 0
  for (let i = visibleRows.length; i < displayRows.length; i++) {
    if (displayRows[i]!.type !== 'hunk') remaining++
  }
  // The truncation footer's "showing N": like-for-like with the server's
  // totalLines, which counts ALL patch lines (headers and @@ markers
  // included) — rows.length is exactly the fetched body's line count.
  const fetchedLines = rows.length

  // Open on the first modification with a few lines of leading context. Keyed
  // on `rows`, not on mount: remounts (file / view switch via the panel's
  // key) re-run it, while "Show more" (renderLimit only) does not yank the
  // scroll back. No-op when the patch has no changed line at all, and when
  // the first change sits beyond ANCHOR_RENDER_CAP (the row isn't rendered).
  // Measured from offsetTop, not getBoundingClientRect: the hosting overlay
  // card runs a scale-in entry animation, and rect-based math measured in
  // scaled space undershoots by (1 − scale) × depth with no re-run to correct.
  // position: relative on the container makes it every row's offsetParent, so
  // offsetTop is directly the in-container coordinate.
  useLayoutEffect(() => {
    const el = viewRef.current
    const anchor = el?.querySelector<HTMLElement>('.diff-line-add, .diff-line-del')
    if (!el || !anchor) return
    const rowH = anchor.offsetHeight || 1
    el.scrollTop = anchor.offsetTop - rowH * SCROLL_ANCHOR_MARGIN_LINES
  }, [rows])

  // Both cells remain present for added/deleted files so code stays aligned.
  let maxOld = 0
  let maxNew = 0
  for (const row of rows) {
    maxOld = Math.max(maxOld, row.oldLine ?? 0)
    maxNew = Math.max(maxNew, row.newLine ?? 0)
  }
  const gutterOldWidth = Math.max(1, String(maxOld).length)
  const gutterNewWidth = Math.max(1, String(maxNew).length)

  // Part mode renders Edit-card style: hunk rows carry no text of their own —
  // each one starts a new group, separated from the previous by a quiet gap.
  // (meta / nonewline rows never reach this loop; displayRows dropped them.)
  const rendered: ReactNode[] = []
  for (const row of visibleRows) {
    if (row.type === 'hunk') {
      if (rendered.length > 0) {
        rendered.push(<div key={`gap-${rendered.length}`} className="turn-review-diff-hunk-gap" aria-hidden />)
      }
      continue
    }
    if (row.type === 'ctx' || row.type === 'add' || row.type === 'del') {
      rendered.push(
        <DiffLine
          key={rendered.length}
          line={row.content || ' '}
          marker={row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
          variant={row.type}
          language={language}
          oldLine={row.oldLine ?? undefined}
          newLine={row.newLine ?? undefined}
          gutterOldWidth={gutterOldWidth}
          gutterNewWidth={gutterNewWidth}
        />,
      )
    } else {
      rendered.push(
        <div key={rendered.length} className={`turn-review-diff-row ${row.type}`}>
          <span className="turn-review-diff-gutter" />
          <span className="turn-review-diff-sign" />
          <span className="turn-review-diff-body">{row.content || ' '}</span>
        </div>,
      )
    }
  }

  return (
    <div className="turn-review-diff-view" ref={setViewRef}>
      {rendered}
      {remaining > 0 && (
        <button
          type="button"
          className="turn-review-diff-more"
          onClick={() => { setRenderLimit((value) => value + RENDER_CHUNK_LINES) }}
        >
          Show more ({remaining} lines remaining)
        </button>
      )}
      {truncated && (
        <div className="turn-review-diff-row truncated">
          <span className="turn-review-diff-gutter" />
          <span className="turn-review-diff-sign" />
          <span className="turn-review-diff-body">
            {fetchedLines < totalLines
              ? `— diff truncated; showing ${fetchedLines} of ${totalLines} lines —`
              : '— long lines shortened —'}
            {onShowFull && (
              <button type="button" className="turn-review-diff-show-full" onClick={onShowFull}>
                View full diff
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
})
