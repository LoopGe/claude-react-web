// Shared unified-diff renderer for the git-panel row diffs. Splits the raw
// `git diff` text into rows (gutter line-number + +/- sign + content) so the
// add/del/hunk/meta styling in git-panel.css applies — the plain raw text
// would otherwise render monochrome. Used by both GitPanel and the
// Worktree-changes overlay so the two diff bodies read identically.
//
// memo: GitPanel re-renders on every commit-textarea keystroke. Without memo,
// every open DiffView re-parses the diff and re-renders ~500 rows even though
// its props are unchanged.

import { memo, useMemo } from 'react'
import { parseUnifiedDiff } from '../utils/diff-parse'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'

export interface DiffViewProps {
  text: string
  truncated: boolean
  totalLines: number
  /** Escape hatch for a truncated preview: opens the complete body. Omit
   *  (e.g. Worktree-changes for now) and no action is rendered. */
  onShowFull?: () => void
}

export const DiffView = memo(function DiffView({ text, truncated, totalLines, onShowFull }: DiffViewProps) {
  const rows = useMemo(() => parseUnifiedDiff(text), [text])
  // Telling the two truncation shapes apart: the wire carries one
  // `truncated` flag for both "tail lines dropped" and "line bodies
  // shortened". Both counts use the same split('\n') yardstick as the
  // server's `totalLines`, so a kept body with all its lines (width clip
  // only) compares equal and only a real tail drop reads lower.
  const keptLineCount = text.split('\n').length
  const setDiffOs = useOverlayScrollbar({ orientation: 'both', autoHide: 'leave' })
  return (
    <div className="git-file-diff" ref={setDiffOs}>
      {rows.map((row, i) => (
        <div key={i} className={`git-diff-row ${row.type}`}>
          <span className="git-diff-gutter">{row.newLine ?? row.oldLine ?? ''}</span>
          <span className="git-diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span>
          <span className="git-diff-body">{row.content || ' '}</span>
        </div>
      ))}
      {truncated && (
        <div className="git-diff-row truncated">
          <span className="git-diff-gutter" />
          <span className="git-diff-sign" />
          <span className="git-diff-body">
            {/* Two different truncation shapes, told apart by whether any
                lines were actually dropped: the byte/line caps lose whole
                tail lines, the per-line width cap keeps every line but cuts
                its body. Both use the same `truncated` flag (one wire
                field), so the split is derived from the kept body itself. */}
            {keptLineCount < totalLines
              ? `— diff truncated; showing ${keptLineCount} of ${totalLines} lines —`
              : '— long lines shortened —'}
            {onShowFull && (
              <button type="button" className="git-diff-show-full" onClick={onShowFull}>
                View full diff
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
})
