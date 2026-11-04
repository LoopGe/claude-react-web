/**
 * The changed-files card that closes a turn: the files one turn changed,
 * with git's line counts, a hover diff preview, and a click-through to the
 * per-turn review panel.
 *
 * The summary is read by {@link useTurnChanges}; the card renders nothing
 * until it is known, so a turn with no changes leaves no gap in the
 * transcript.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TurnChangedFile } from '../../../shared/turn-changes.js'
import { useTurnChanges, useTurnDiff } from '../../hooks/useTurnChanges'
import { AnchoredPopover } from '../AnchoredPopover'
import { DiffView } from '../DiffView'
import { useTurnChangesContext } from './turn-changes-context'

/** Rows shown before the fold. */
const COLLAPSED_ROWS = 4
/** Hover delay before a preview reads its comparison. */
const PREVIEW_DELAY_MS = 400

function basename(display: string): string {
  const slash = display.lastIndexOf('/')
  return slash < 0 ? display : display.slice(slash + 1)
}

function Counts({ file }: { file: TurnChangedFile }) {
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
  const first = summary.files[0]
  const foldable = summary.files.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? summary.files.slice(0, COLLAPSED_ROWS) : summary.files

  return (
    <div className="turn-changes-card" data-changed-files>
      <PreviewTrigger
        className="turn-changes-header"
        label={single === undefined ? 'View this turn’s changes' : `View changes to ${single.display}`}
        display={single?.display ?? first?.display ?? ''}
        sessionId={sessionId}
        resultUuid={resultUuid}
        index={0}
        onOpen={() => { openTurnReview(resultUuid, 0) }}
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
      </PreviewTrigger>
      {single === undefined && (
        <ul className="turn-changes-list">
          {rows.map((file, index) => (
            <li key={file.display}>
              <PreviewTrigger
                className="turn-changes-row"
                label={`View changes to ${file.display}`}
                display={file.display}
                sessionId={sessionId}
                resultUuid={resultUuid}
                index={index}
                onOpen={() => { openTurnReview(resultUuid, index) }}
              >
                <span className="turn-changes-path">{file.display}</span>
                <span className="turn-changes-counts"><Counts file={file} /></span>
              </PreviewTrigger>
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

/** A clickable row/header that opens the review and previews after a hover delay. */
function PreviewTrigger({ className, label, display, sessionId, resultUuid, index, onOpen, children }: {
  className: string
  label: string
  display: string
  sessionId: string
  resultUuid: string
  index: number
  onOpen: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const timer = useRef<number | null>(null)

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancel, [])

  const open = () => {
    cancel()
    timer.current = window.setTimeout(() => { setPreviewOpen(true) }, PREVIEW_DELAY_MS)
  }
  const close = () => {
    cancel()
    setPreviewOpen(false)
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        aria-label={label}
        onClick={onOpen}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {children}
      </button>
      {previewOpen && (
        <AnchoredPopover
          className="turn-changes-preview"
          ariaLabel={`Changes to ${display}`}
          triggerRef={ref}
          placement="above"
          onClose={close}
        >
          <span className="turn-changes-preview-path">{display}</span>
          <TurnFilePreview sessionId={sessionId} resultUuid={resultUuid} index={index} />
        </AnchoredPopover>
      )}
    </>
  )
}

/** Mounted only while its hover card is open, so passing over a row does not read a diff. */
function TurnFilePreview({ sessionId, resultUuid, index }: {
  sessionId: string
  resultUuid: string
  index: number
}) {
  const { diff, loading } = useTurnDiff(sessionId, resultUuid, index)
  if (loading) return <span className="turn-changes-note">Loading…</span>
  if (diff === null || !diff.available) {
    return <span className="turn-changes-note">{diff?.reason === 'binary' ? 'Binary file' : diff?.reason === 'oversized' ? 'File too large to preview' : 'No preview available'}</span>
  }
  if (diff.reason === 'binary') return <span className="turn-changes-note">Binary file</span>
  if (diff.reason === 'oversized') return <span className="turn-changes-note">File too large to preview</span>
  return (
    <div className="turn-changes-diff">
      <DiffView text={diff.patch ?? ''} truncated={diff.truncated === true} totalLines={diff.totalLines ?? 0} />
    </div>
  )
}