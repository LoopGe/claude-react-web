/**
 * Per-turn change review: the changed-file picker lives in the header (a
 * FieldPicker dropdown — the whole body belongs to the diff), showing the
 * selected file's turn-start / turn-end comparison. Opened from the
 * transcript's changed-files card.
 */
import { useId, useState } from 'react'
import { motion } from 'motion/react'
import type { TurnDiffPayload, TurnDiffViewMode } from '../../shared/turn-changes.js'
import { countsLabel } from '../../shared/turn-changes.js'
import { api } from '../hooks/useApi'
import { useTurnChanges, useTurnDiff } from '../hooks/useTurnChanges'
import { ENTER_TRANSITION, useMotionTransition } from '../utils/transitions'
import { TurnDiffView } from './TurnDiffView'
import { FullDiffViewer } from './FullDiffViewer'
import { FieldPicker } from './FieldPicker'

export interface TurnChangesPanelProps {
  sessionId: string
  /** The result frame that closed the turn. */
  resultUuid: string
  /** File index selected by the card row that opened the panel. */
  initialIndex: number
  onClose: () => void
}

export function TurnChangesPanel({ sessionId, resultUuid, initialIndex, onClose }: TurnChangesPanelProps) {
  // Per-key diff switch: snap under suppressed motion (OS preference or the
  // in-app Off preset) like every other migrated motion surface.
  const enterTransition = useMotionTransition(ENTER_TRANSITION)
  // Up to 3 chat panels can host this overlay at once — the picker's trigger /
  // menu / option ids must be unique per instance.
  const pickerId = useId()
  const { loading, summary } = useTurnChanges(sessionId, resultUuid)
  const [selected, setSelected] = useState(initialIndex)
  const [view, setView] = useState<TurnDiffViewMode>('full-file')
  const { diff, loading: diffLoading } = useTurnDiff(sessionId, resultUuid, selected, {
    view,
    full: view === 'full-file',
  })
  const [fullOpen, setFullOpen] = useState(false)

  if (loading) {
    return <div className="turn-review"><div className="turn-review-loading">Loading turn changes…</div></div>
  }
  if (summary === null || summary.files.length === 0) {
    return <div className="turn-review"><div className="turn-review-loading">No changed files recorded for this turn.</div></div>
  }

  const selectedFile = summary.files[selected] ?? summary.files[0]!

  const fetchFull = async (signal?: AbortSignal): Promise<string> => {
    const query = new URLSearchParams({ resultUuid, index: String(selected), view: 'changes', full: '1' })
    const result = await api.get<TurnDiffPayload>(
      `/sessions/${encodeURIComponent(sessionId)}/turn-diff?${query}`,
      { signal },
    )
    return result.patch ?? ''
  }

  const selectView = (next: TurnDiffViewMode): void => {
    setView(next)
    setFullOpen(false)
  }

  return (
    <div className="turn-review" data-changes-review>
      <header className="turn-review-head">
        <span className="turn-review-title">Turn changes</span>
        <span className="turn-review-stat">
          {summary.total} file{summary.total === 1 ? '' : 's'} · +{summary.added} −{summary.deleted}
        </span>
        <div className="turn-review-file-select">
          <FieldPicker
            id={pickerId}
            label={selectedFile.display}
            sub={countsLabel(selectedFile)}
            menuLabel="Changed files in this turn"
            options={summary.files.map((file, index) => ({
              key: file.display,
              label: file.display,
              sub: countsLabel(file),
              selected: index === selected,
              onSelect: () => { setSelected(index); setFullOpen(false) },
            }))}
          />
        </div>
        <div className="turn-review-diff-modes" role="group" aria-label="Diff view">
          <button type="button" aria-pressed={view === 'changes'} onClick={() => { selectView('changes') }}>Part</button>
          <button type="button" aria-pressed={view === 'full-file'} onClick={() => { selectView('full-file') }}>Full</button>
        </div>
        <button type="button" className="turn-review-close" aria-label="Close turn changes" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="turn-review-diff">
        <motion.div
          key={`${selected}:${view}`}
          className="turn-review-diff-anim"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={enterTransition}
        >
          {diffLoading ? (
            <span className="turn-changes-note">Loading comparison…</span>
          ) : diff === null || !diff.available ? (
            <span className="turn-changes-note">
              {diff?.reason === 'binary' ? 'Binary file' : diff?.reason === 'oversized' ? 'File too large to preview' : 'No comparison available.'}
            </span>
          ) : diff.reason === 'binary' ? (
            <span className="turn-changes-note">Binary file</span>
          ) : diff.reason === 'oversized' ? (
            <span className="turn-changes-note">File too large to preview</span>
          ) : (
            <TurnDiffView
              text={diff.patch ?? ''}
              view={view}
              truncated={diff.truncated === true}
              totalLines={diff.totalLines ?? 0}
              onShowFull={view === 'changes' && diff.truncated === true ? () => { setFullOpen(true) } : undefined}
              filePath={selectedFile.path}
            />
          )}
        </motion.div>
      </div>
      <FullDiffViewer
        open={fullOpen && view === 'changes'}
        onClose={() => { setFullOpen(false) }}
        name={selectedFile.display}
        fetchText={fetchFull}
      />
    </div>
  )
}
