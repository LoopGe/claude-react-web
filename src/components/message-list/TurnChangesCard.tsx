/**
 * The changed-files card that closes a turn: the files one turn changed,
 * with git's line counts, and a click-through to the per-turn review panel.
 *
 * The summary is read by {@link useTurnChanges}; the card renders nothing
 * until it is known, so a turn with no changes leaves no gap in the
 * transcript.
 */
import { useCallback, useId, useState } from 'react'
import type { TurnChangedFile } from '../../../shared/turn-changes.js'
import { useTurnChanges } from '../../hooks/useTurnChanges'
import { AnimatedCollapse } from '../AnimatedCollapse'
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

/** One clickable changed-file row. `index` addresses the FULL summary. */
function FileRow({ file, index, onOpen }: {
  file: TurnChangedFile
  index: number
  onOpen: (index: number) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="turn-changes-row"
        aria-label={`View changes to ${file.display}`}
        onClick={() => { onOpen(index) }}
      >
        <span className="turn-changes-path">{file.display}</span>
        <span className="turn-changes-counts"><Counts file={file} /></span>
      </button>
    </li>
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
  // The tail mounts on the first expand only, and unmounts again once the close
  // tween settles: a card for a turn that touched hundreds of files must not
  // carry hundreds of hidden rows while folded. The outer collapse body stays
  // mounted (unmountOnExit=false), so its 0px pin survives and the next open
  // still tweens from 0.
  const [revealed, setRevealed] = useState(false)
  const hideRevealed = useCallback(() => { setRevealed(false) }, [])
  const listId = useId()

  if (!sessionId || !resultUuid || loading || summary === null || summary.total === 0) return null

  const single = summary.total === 1 ? summary.files[0] : undefined
  const foldable = summary.files.length > COLLAPSED_ROWS
  // The first COLLAPSED_ROWS rows stay static; only the tail folds. Folding the
  // whole list would replay the visible rows from height 0 on expand.
  const rows = foldable ? summary.files.slice(0, COLLAPSED_ROWS) : summary.files
  const extraRows = foldable ? summary.files.slice(COLLAPSED_ROWS) : []

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
        /* One logical list across the fold boundary: the two <ul>s are
           presentation-only partitions, so AT still hears a single list. */
        <div role="list">
          <ul role="presentation" className="turn-changes-list">
            {rows.map((file, index) => (
              <FileRow
                key={file.display}
                file={file}
                index={index}
                onOpen={(i) => { openTurnReview(resultUuid, i) }}
              />
            ))}
          </ul>
          {/* Only the tail is inside the animated body. AnimatedCollapse
              registers in collapse-animation.ts, so the transcript's
              fold-lockstep compensates the row-height change while following
              the bottom (a hand-written CSS transition would not).
              unmountOnExit={false} is load-bearing: a remounted body has no
              0px pin, so currentBodyHeight() would read its natural height and
              the second expand would snap instead of tweening. */}
          {foldable && (
            <AnimatedCollapse
              open={expanded}
              unmountOnExit={false}
              id={listId}
              onExitComplete={hideRevealed}
            >
              {revealed && (
                /* inert while folded: unmountOnExit keeps these buttons mounted
                   through the close, and without it Tab would reach the
                   invisible rows before the toggle. */
                <ul
                  role="presentation"
                  className="turn-changes-list turn-changes-list-tail"
                  inert={!expanded}
                >
                  {extraRows.map((file, index) => (
                    <FileRow
                      key={file.display}
                      file={file}
                      index={COLLAPSED_ROWS + index}
                      onOpen={(i) => { openTurnReview(resultUuid, i) }}
                    />
                  ))}
                </ul>
              )}
            </AnimatedCollapse>
          )}
        </div>
      )}
      {foldable && (
        <button
          type="button"
          className="turn-changes-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            setRevealed(true)
            setExpanded((value) => !value)
          }}
        >
          {expanded ? 'Show fewer' : `Show all ${summary.files.length}`}
        </button>
      )}
    </div>
  )
}
