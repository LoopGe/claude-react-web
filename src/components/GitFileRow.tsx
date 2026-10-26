// Shared git file row — the deferred-open accordion shell behind the Git
// panel's Changes / Staged rows (and, for the commit-diff UI, read-only
// commit file rows). Owns the two-stage deferred open (the diff fetch
// starts on the first click; the body expands when the fetch verdict
// lands, or after a 600 ms safety timer), the whole `git-file-row` DOM
// contract (`.git-file-row-line` / `.git-file-row-toggle` / status chip /
// path / +− counts / chevron / `.git-file-diff-wrap` / FullDiffViewer),
// and the full-diff escape hatch.
//
// Write actions (stage / unstage / discard / open-file) are NOT row
// concerns: the parent supplies them via `actions`, which is rendered
// inside `.git-file-actions` (the whole div is omitted when `actions` is
// undefined — read-only rows pass nothing).

import { memo, useCallback, useEffect, useState } from 'react'
import { FullDiffViewer } from './FullDiffViewer'
import { AnimatedCollapse } from './AnimatedCollapse'
import { DiffView } from './DiffView'
import { IconChevronDown, IconChevronRight } from './icons/ToolIcons'
import { gitStatusTitle } from '../utils/git-status'
import type { GitDiff } from '../../shared/git-types'

export interface GitFileRowProps {
  /** Single-char status letter from git: A/M/D/R/C/? */
  status: string
  path: string
  renamedFrom?: string
  insertions?: number
  deletions?: number
  selected?: boolean
  onSelect?: () => void
  /** Parent has started the diff fetch (set true on the first open attempt). */
  fetchStarted: boolean
  onFetchStart: () => void
  /** Called when the collapse exit animation completes — the parent resets
   *  its fetch latch so a later reopen re-fetches. Mirrors the pre-refactor
   *  `onExitComplete={() => setRenderDiff(false)}`. */
  onFetchReset: () => void
  diff: { data: GitDiff | null; loading: boolean; error: string | null }
  fetchFullText: (signal?: AbortSignal) => Promise<string>
  /** Stage/unstage/discard buttons. Omit for read-only rows. */
  actions?: React.ReactNode
}

export const GitFileRow: React.MemoExoticComponent<(props: GitFileRowProps) => React.JSX.Element> = memo(function GitFileRow({
  status,
  path,
  renamedFrom,
  insertions,
  deletions,
  selected,
  onSelect,
  fetchStarted,
  onFetchStart,
  onFetchReset,
  diff,
  fetchFullText,
  actions,
}: GitFileRowProps) {
  const [open, setOpen] = useState(false)
  // Pending-open: the user clicked to open but the diff fetch is still in
  // flight. We defer flipping `open` until the fetch resolves so the
  // AnimatedCollapse runs ONE animation from 0 → final-diff-height instead
  // of two (0 → loading-placeholder, then snap → diff). The chevron flips
  // immediately and the toggle gets `aria-busy` so the click still feels
  // responsive while we wait.
  const [pendingOpen, setPendingOpen] = useState(false)
  const { data, loading, error } = diff

  // Resolve pending → open as soon as the fetch produces a verdict.
  // Triggers on either: (a) success, (b) error, (c) the fetch was already
  // started and a refresh re-fetched. We require either `data` or `error` to
  // have landed so we don't open during the brief window where the fetch is
  // enabled but the fetching effect hasn't yet flipped `loading` to true.
  useEffect(() => {
    if (!pendingOpen) return
    if (loading) return
    if (data == null && error == null) return
    // Synchronizing UI to an external async source (the diff fetch) — this
    // is the legitimate setState-in-effect case the rule's docs call out
    // ("subscribe for updates from some external system"). The alternative
    // (kick off the fetch and flip `open` immediately) is exactly the
    // two-stage animation we're trying to avoid.
    setOpen(true)
    setPendingOpen(false)
  }, [pendingOpen, loading, data, error])

  // Safety net: if the fetch is unusually slow (large diff, slow disk, slow
  // network in dev), don't leave the user staring at an unresponsive row.
  // After 600 ms, open with the loading placeholder visible — the snap to
  // final height once the diff lands is still less jarring than the old
  // two-stage animation, because AnimatedCollapse no longer re-animates on
  // content growth.
  useEffect(() => {
    if (!pendingOpen) return
    const t = window.setTimeout(() => {
      setOpen(true)
      setPendingOpen(false)
    }, 600)
    return () => window.clearTimeout(t)
  }, [pendingOpen])

  // Full-diff escape hatch for a truncated preview (see DiffView's marker).
  // fetchFullText is stable for a given row so FullDiffViewer's open-effect
  // can't refetch on unrelated parent re-renders.
  const [showFull, setShowFull] = useState(false)
  // Stable so DiffView's memo survives parent re-renders (commit-textarea
  // typing, status snapshots).
  const openFull = useCallback(() => setShowFull(true), [])
  const closeFull = useCallback(() => setShowFull(false), [])

  const handleToggle = () => {
    if (open) {
      // Closing — immediate.
      setOpen(false)
      setPendingOpen(false)
      return
    }
    if (pendingOpen) {
      // Second click while the deferred open is still waiting on the fetch:
      // the user is saying "open it NOW", not "cancel". The row looks dead
      // during the pending window (chevron flipped, body not yet grown), so
      // treating the retry as a cancel left the row permanently shut — the
      // "展不开" symptom. Open immediately and show the loading placeholder.
      setOpen(true)
      setPendingOpen(false)
      return
    }
    // Opening — kick off the fetch and wait for it (or the safety timer)
    // before flipping `open`. Chevron + aria-busy give immediate feedback.
    onFetchStart()
    setPendingOpen(true)
  }

  return (
    <div className={`git-file-row ${open ? 'open' : ''} ${selected ? 'selected' : ''}`}>
      <div className="git-file-row-line" onClick={() => onSelect?.()}>
        <button
          type="button"
          className="git-file-row-toggle"
          aria-busy={pendingOpen || undefined}
          aria-expanded={open}
          onClick={handleToggle}
          title={renamedFrom ? `${renamedFrom} → ${path}` : path}
        >
          <span className={`git-file-status status-${status}`} title={gitStatusTitle(status)}>{status}</span>
          <span className="git-file-path">
            {renamedFrom && (
              <span className="git-file-renamed-from">{renamedFrom} → </span>
            )}
            {path}
          </span>
          {(insertions != null || deletions != null) && (
            <span className="git-file-changes">
              {insertions != null && insertions > 0 && (
                <span className="git-file-additions">+{insertions}</span>
              )}
              {deletions != null && deletions > 0 && (
                <span className="git-file-deletions">-{deletions}</span>
              )}
            </span>
          )}
          <span className="git-file-arrow">{(open || pendingOpen) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
        </button>
        {actions != null && (
          <div className="git-file-actions">{actions}</div>
        )}
      </div>
      <AnimatedCollapse
        open={open}
        className="git-file-diff-collapse"
        onExitComplete={onFetchReset}
      >
        {fetchStarted && (
          <div className="git-file-diff-wrap">
            {loading && <div className="git-file-diff-loading">Loading diff...</div>}
            {error && <div className="git-file-diff-error">{error}</div>}
            {data && data.isBinary && (
              <div className="git-file-diff-binary">Binary file - no preview</div>
            )}
            {data && !data.isBinary && (
              <DiffView
                text={data.text}
                truncated={data.truncated}
                totalLines={data.totalLines}
                onShowFull={openFull}
              />
            )}
          </div>
        )}
      </AnimatedCollapse>
      <FullDiffViewer
        open={showFull}
        onClose={closeFull}
        name={path}
        fetchText={fetchFullText}
      />
    </div>
  )
})
