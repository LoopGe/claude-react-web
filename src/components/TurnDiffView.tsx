// Turn changes owns its viewport and patch-level rows so GitPanel's inline
// constraints cannot leak in. Code rows share Edit's canonical dual-gutter
// primitive; only the parser, scrollbar utility, and that row are shared.

import { memo, useMemo, useState } from 'react'
import type { TurnDiffViewMode } from '../../shared/turn-changes.js'
import { parseUnifiedDiff } from '../utils/diff-parse'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { DiffLine } from './tool-views/diff-shared'

const RENDER_CHUNK_LINES = 5000

export interface TurnDiffViewProps {
  text: string
  view?: TurnDiffViewMode
  truncated: boolean
  totalLines: number
  onShowFull?: () => void
}

export const TurnDiffView = memo(function TurnDiffView({ text, view = 'changes', truncated, totalLines, onShowFull }: TurnDiffViewProps) {
  const rows = useMemo(() => parseUnifiedDiff(text), [text])
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK_LINES)
  const keptLineCount = text.split('\n').length
  const setDiffOs = useOverlayScrollbar({ orientation: 'both', autoHide: 'leave' })

  const displayRows = useMemo(
    () => view === 'full-file' ? rows.filter((row) => row.type !== 'meta' && row.type !== 'hunk') : rows,
    [rows, view],
  )
  let maxOld = 0
  let maxNew = 0
  for (const row of rows) {
    maxOld = Math.max(maxOld, row.oldLine ?? 0)
    maxNew = Math.max(maxNew, row.newLine ?? 0)
  }
  // Both cells remain present for added/deleted files so code stays aligned.
  const gutterOldWidth = Math.max(1, String(maxOld).length)
  const gutterNewWidth = Math.max(1, String(maxNew).length)
  const visibleRows = displayRows.slice(0, renderLimit)
  const remaining = displayRows.length - visibleRows.length

  return (
    <div className="turn-review-diff-view" ref={setDiffOs}>
      {visibleRows.map((row, i) => {
        if (row.type === 'ctx' || row.type === 'add' || row.type === 'del') {
          return (
            <DiffLine
              key={i}
              line={row.content || ' '}
              marker={row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
              variant={row.type}
              language={null}
              oldLine={row.oldLine ?? undefined}
              newLine={row.newLine ?? undefined}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
            />
          )
        }
        return (
          <div key={i} className={`turn-review-diff-row ${row.type}`}>
            <span className="turn-review-diff-gutter" />
            <span className="turn-review-diff-sign" />
            <span className="turn-review-diff-body">{row.content || ' '}</span>
          </div>
        )
      })}
      {remaining > 0 && (
        <button
          type="button"
          className="turn-review-diff-more"
          onClick={() => { setRenderLimit((limit) => limit + RENDER_CHUNK_LINES) }}
        >
          Show more ({remaining} lines remaining)
        </button>
      )}
      {truncated && (
        <div className="turn-review-diff-row truncated">
          <span className="turn-review-diff-gutter" />
          <span className="turn-review-diff-sign" />
          <span className="turn-review-diff-body">
            {keptLineCount < totalLines
              ? `— diff truncated; showing ${keptLineCount} of ${totalLines} lines —`
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
