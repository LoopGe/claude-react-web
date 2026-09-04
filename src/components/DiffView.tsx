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
}

export const DiffView = memo(function DiffView({ text, truncated, totalLines }: DiffViewProps) {
  const rows = useMemo(() => parseUnifiedDiff(text), [text])
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
          <span className="git-diff-body">— diff truncated; {totalLines} lines total —</span>
        </div>
      )}
    </div>
  )
})
