/**
 * The changed-files card that closes a turn: the files one turn changed,
 * with git's line counts, and a click-through to the per-turn review panel.
 *
 * The summary is read by {@link useTurnChanges}; the card renders nothing
 * until it is known, so a turn with no changes leaves no gap in the
 * transcript.
 */
import { useState } from 'react'
import type { TurnChangedFile } from '../../../shared/turn-changes.js'
import { useTurnChanges } from '../../hooks/useTurnChanges'
import { useTurnChangesContext } from './turn-changes-context'

/** Rows shown before the fold. */
const COLLAPSED_ROWS = 4

function basename(display: string): string {
  const slash = display.lastIndexOf('/')
  return slash < 0 ? display : display.slice(slash + 1)
}

/** Added/deleted counts (or the binary/oversized label). */
export function Counts({ file }: { file: TurnChangedFile }) {
  if (file.binary === true) return <span className="turn-changes-note-inline">binary</span>
  if (file.oversized === true) return <span className="turn-changes-note-inline">too large</span>
  return (
    <>
      <span className="turn-changes-added">+{file.additions}</span>
      <span className="turn-changes-deleted">−{file.deletions}</span>
    </>
  )
}

/**
 * Render one turn's changed files.
 * @param props.sessionId - viewed session; the card is inert without it.
 * @param props.resultUuid - the result frame that closed the turn.
 * @returns the card, or null while the summary is unknown or empty.
 */
export function TurnChangesCard({ sessionId, resultUuid }: { sessionId?: string; resultUuid: string }) {
  const { loading, summary } = useTurnChanges(sessionId, resultUuid)
  const { openTurnReview } = useTurnChangesContext()
  const [expanded, setExpanded] = useState(false)

  if (!sessionId || !resultUuid || loading || summary === null || summary.total === 0) return null

  const single = summary.total === 1 ? summary.files[0] : undefined
  const foldable = summary.files.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? summary.files.slice(0, COLLAPSED_ROWS) : summary.files

  return (
    <div className="turn-changes-card" data-changed-files>
      <button
        type="button"
        className="turn-changes-header"
        aria-label={single === undefined ? 'View this turn’s changes' : `View changes to ${single.display}`}
        onClick={() => { openTurnReview(resultUuid, 0) }}
      >
        <span className="turn-changes-tile" aria-hidden="true">±</span>
        <span className="turn-changes-titles">
          <span className="turn-changes-title">
            {single === undefined ? `Edited ${summary.total} files` : `Edited ${basename(single.display)}`}
          </span>
          <span className="turn-changes-stat">
            {single === undefined
              ? <><span className="turn-changes-added">+{summary.added}</span><span className="turn-changes-deleted">−{summary.deleted}</span></>
              : <Counts file={single} />}
          </span>
        </span>
      </button>
      {single === undefined && (
        <ul className="turn-changes-list">
          {rows.map((file, index) => (
            <li key={file.display}>
              <button
                type="button"
                className="turn-changes-row"
                aria-label={`View changes to ${file.display}`}
                onClick={() => { openTurnReview(resultUuid, index) }}
              >
                <span className="turn-changes-path">{file.display}</span>
                <span className="turn-changes-counts"><Counts file={file} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {foldable && (
        <button
          type="button"
          className="turn-changes-toggle"
          aria-expanded={expanded}
          onClick={() => { setExpanded((value) => !value) }}
        >
          {expanded ? 'Show fewer' : `Show all ${summary.files.length}`}
        </button>
      )}
    </div>
  )
}
