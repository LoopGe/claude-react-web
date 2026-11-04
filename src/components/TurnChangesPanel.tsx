/**
 * Per-turn change review: every file one turn changed on the left, the
 * selected file's turn-start / turn-end comparison on the right. Opened from
 * the transcript's changed-files card.
 */
import { useState } from 'react'
import type { TurnDiffPayload } from '../../shared/turn-changes.js'
import { api } from '../hooks/useApi'
import { useTurnChanges, useTurnDiff } from '../hooks/useTurnChanges'
import { Counts } from './message-list/TurnChangesCard'
import { DiffView } from './DiffView'
import { FullDiffViewer } from './FullDiffViewer'

export interface TurnChangesPanelProps {
  sessionId: string
  /** The result frame that closed the turn. */
  resultUuid: string
  /** File index selected by the card row that opened the panel. */
  initialIndex: number
  onClose: () => void
}

export function TurnChangesPanel({ sessionId, resultUuid, initialIndex, onClose }: TurnChangesPanelProps) {
  const { loading, summary } = useTurnChanges(sessionId, resultUuid)
  const [selected, setSelected] = useState(initialIndex)
  const { diff } = useTurnDiff(sessionId, resultUuid, selected)
  const [fullOpen, setFullOpen] = useState(false)

  if (loading) {
    return <div className="turn-review"><div className="turn-review-loading">Loading turn changes…</div></div>
  }
  if (summary === null || summary.files.length === 0) {
    return <div className="turn-review"><div className="turn-review-loading">No changed files recorded for this turn.</div></div>
  }

  const selectedFile = summary.files[selected] ?? summary.files[0]!

  const fetchFull = async (signal?: AbortSignal): Promise<string> => {
    const query = new URLSearchParams({ resultUuid, index: String(selected), full: '1' })
    const result = await api.get<TurnDiffPayload>(
      `/sessions/${encodeURIComponent(sessionId)}/turn-diff?${query}`,
      { signal },
    )
    return result.patch ?? ''
  }

  return (
    <div className="turn-review" data-changes-review>
      <header className="turn-review-head">
        <span className="turn-review-title">Turn changes</span>
        <span className="turn-review-stat">
          {summary.total} file{summary.total === 1 ? '' : 's'} · +{summary.added} −{summary.deleted}
        </span>
        <button type="button" className="turn-review-close" aria-label="Close turn changes" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="turn-review-body">
        <ul className="turn-review-files">
          {summary.files.map((file, index) => (
            <li key={file.display}>
              <button
                type="button"
                className={`turn-review-file${index === selected ? ' selected' : ''}`}
                aria-pressed={index === selected}
                onClick={() => { setSelected(index) }}
              >
                <span className="turn-changes-path">{file.display}</span>
                <span className="turn-changes-counts"><Counts file={file} /></span>
              </button>
            </li>
          ))}
        </ul>
        <div className="turn-review-diff">
          <div className="turn-review-diff-path">{selectedFile.display}</div>
          {diff === null || !diff.available ? (
            <span className="turn-changes-note">
              {diff?.reason === 'binary' ? 'Binary file' : diff?.reason === 'oversized' ? 'File too large to preview' : 'No comparison available.'}
            </span>
          ) : diff.reason === 'binary' ? (
            <span className="turn-changes-note">Binary file</span>
          ) : diff.reason === 'oversized' ? (
            <span className="turn-changes-note">File too large to preview</span>
          ) : (
            <DiffView
              text={diff.patch ?? ''}
              truncated={diff.truncated === true}
              totalLines={diff.totalLines ?? 0}
              onShowFull={diff.truncated === true ? () => { setFullOpen(true) } : undefined}
            />
          )}
        </div>
      </div>
      <FullDiffViewer
        open={fullOpen}
        onClose={() => { setFullOpen(false) }}
        name={selectedFile.display}
        fetchText={fetchFull}
      />
    </div>
  )
}