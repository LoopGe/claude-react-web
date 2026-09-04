// Per-session Worktree-changes overlay — "what did the isolated worktree
// do". Three tabs, all scoped to the worktree's own git state via
// cwd = the worktree path (a sibling working directory of the same repo):
//
//   - Uncommitted  — staged/unstaged/untracked in the worktree (via the
//                    shared status + per-file diff surface, cwd-targeted).
//   - Branch       — the worktree branch's own commits since it forked off
//                    baseRef (`baseRef...branch`, three-dot).
//   - vs base      — the head-to-head diff baseRef..branch (two-dot), which
//                    also reflects baseRef changes the branch doesn't have.
//
// Renders as an in-column overlay (same `git` variant as the GitPanel),
// only mounted while open — no lazy chunk needed. Reuses the git-panel
// CSS classes so the rows / diffs read identically to the main Git panel.

import { useState } from 'react'
import { Overlay } from './Overlay'
import { FileViewer } from './FileViewer'
import { Tooltip } from './Tooltip'
import { DiffView } from './DiffView'
import {
  useGitStatus,
  useGitDiff,
  useGitRangeDiff,
  useGitRangeDiffFile,
} from '../hooks/useGitStatus'
import {
  IconX,
  IconRefresh,
  IconLoader,
  IconGitFork,
  IconSearch,
  IconChevronDown,
  IconChevronRight,
} from './icons/ToolIcons'
import type { GitDiff, GitRangeFile, GitStatus } from '../../shared/git-types'

type Tab = 'uncommitted' | 'branch' | 'base'

type RangeRow = GitRangeFile

interface Props {
  sessionId: string
  /** Worktree directory (its own working tree). Null while the EnterWorktree
   *  intent is a claimed-but-unconfirmed worktree (no matching git path). */
  cwd: string | null
  /** The worktree's checked-out head branch, e.g. `worktree-feature-auth`. */
  branchName: string | null
  /** The session's own branch (the diff base), e.g. `main`. */
  baseRef: string | null
  /** Human label for the header (the worktree name). */
  displayName: string
  onClose: () => void
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'uncommitted', label: 'Uncommitted' },
  { id: 'branch', label: 'Branch' },
  { id: 'base', label: 'vs base' },
]

function diffTitle(files: RangeRow[] | undefined): string {
  if (!files || files.length === 0) return 'No file changes'
  const ins = files.reduce((n, f) => n + f.insertions, 0)
  const del = files.reduce((n, f) => n + f.deletions, 0)
  return `+${ins} −${del} across ${files.length} file${files.length === 1 ? '' : 's'}`
}

export function WorktreeChanges({ sessionId, cwd, branchName, baseRef, displayName, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('uncommitted')
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Uncommitted tab uses the shared status surface pointed at the worktree path.
  const status = useGitStatus(cwd ?? undefined, sessionId, { enabled: !!cwd && tab === 'uncommitted' })
  // Branch tabs use the range diff. `...` (mergeBase) for the branch's own
  // work; `..` (tip) for the head-to-head diff vs base.
  const branchRange = useGitRangeDiff(cwd ?? undefined, baseRef ?? undefined, branchName ?? undefined, true, !!cwd && tab === 'branch')
  const baseRange = useGitRangeDiff(cwd ?? undefined, baseRef ?? undefined, branchName ?? undefined, false, !!cwd && tab === 'base')

  const uncommitted = status.data?.isRepo === true ? status.data : null
  const uncommittedFiles = uncommitted ? [...uncommitted.staged, ...uncommitted.unstaged, ...uncommitted.untracked] : []

  const rangeFiles: RangeRow[] =
    tab === 'branch' ? (branchRange.data?.files ?? [])
    : tab === 'base' ? (baseRange.data?.files ?? [])
    : []

  const loading = tab === 'uncommitted' ? status.loading : tab === 'branch' ? branchRange.loading : baseRange.loading
  const error = tab === 'uncommitted' ? status.error : tab === 'branch' ? branchRange.error : baseRange.error
  const refresh = () => {
    status.refresh(); branchRange.refresh(); baseRange.refresh()
  }

  return (
    <Overlay variant="git" ariaLabel="Worktree changes" open onClose={onClose} renderCard={false} trapRefTarget="backdrop" focusEscapeSelector=".chat-panel">
      <div className="git-panel" role="region" aria-label="Worktree changes">
        <header className="git-panel-header">
          <span className="git-panel-branch">
            <IconGitFork size={14} />
            {cwd ? branchName ?? displayName : `${displayName} (unconfirmed)`}
          </span>
          <div className="git-panel-tabs" role="tablist" aria-label="Change scope">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={['git-tab', tab === t.id ? 'active' : ''].filter(Boolean).join(' ')}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="git-panel-spacer" />
          <Tooltip label={diffTitle(tab === 'uncommitted' ? (uncommittedFiles as RangeRow[]) : rangeFiles)} placement="bottom">
            <span className="git-panel-total-changes">
              {tab === 'uncommitted' && uncommittedFiles.length > 0 && (
                <>
                  <span className="git-file-additions">+{uncommittedFiles.reduce((n, f) => n + (f.insertions ?? 0), 0)}</span>
                  <span className="git-file-deletions">−{uncommittedFiles.reduce((n, f) => n + (f.deletions ?? 0), 0)}</span>
                </>
              )}
              {tab !== 'uncommitted' && rangeFiles.length > 0 && (
                <>
                  <span className="git-file-additions">+{rangeFiles.reduce((n, f) => n + f.insertions, 0)}</span>
                  <span className="git-file-deletions">−{rangeFiles.reduce((n, f) => n + f.deletions, 0)}</span>
                </>
              )}
            </span>
          </Tooltip>
          <Tooltip label={loading ? 'Refreshing…' : 'Refresh'} placement="bottom">
            <button className="git-panel-icon-btn" onClick={refresh} disabled={loading} aria-label="Refresh">
              {loading ? <IconLoader size={14} className="git-panel-spin" /> : <IconRefresh size={14} />}
            </button>
          </Tooltip>
          <Tooltip label="Close" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
          </Tooltip>
        </header>

        <div className="git-panel-scroll">
          {!cwd || !branchName ? (
            <div className="git-panel-empty">
              No matching worktree confirmed in git yet (a timing gap right after EnterWorktree, or the claim is stale).
            </div>
          ) : error ? (
            <div className="git-panel-error">{error}</div>
          ) : loading ? (
            <div className="git-panel-empty">Loading…</div>
          ) : tab === 'uncommitted' ? (
            uncommittedFiles.length === 0 ? (
              <div className="git-panel-empty">No uncommitted changes in the worktree.</div>
            ) : (
              <UncommittedList
                cwd={cwd}
                status={uncommitted}
                expanded={expanded}
                onExpanded={setExpanded}
                onOpen={setOpenFile}
              />
            )
          ) : rangeFiles.length === 0 ? (
            <div className="git-panel-empty">No file changes in this range.</div>
          ) : (
            <RangeList
              cwd={cwd}
              baseRef={baseRef!}
              branchName={branchName}
              mergeBase={tab === 'branch'}
              files={rangeFiles}
              expanded={expanded}
              onExpanded={setExpanded}
              onOpen={setOpenFile}
            />
          )}
        </div>

        {openFile && (
          <FileViewer
            sessionId={sessionId}
            open
            path={cwd ? `${cwd}/${openFile}` : null}
            name={openFile}
            onClose={() => setOpenFile(null)}
          />
        )}
      </div>
    </Overlay>
  )
}

// ── Uncommitted list ──────────────────────────────────────────────────

function UncommittedList(props: {
  cwd: string
  status: GitStatus | null
  expanded: string | null
  onExpanded: (k: string | null) => void
  onOpen: (path: string) => void
}) {
  const { cwd, status, expanded, onExpanded, onOpen } = props
  if (!status) return null
  const staged = status.staged.map((f) => ({ ...f, staged: true } as const))
  const unstaged = status.unstaged.map((f) => ({ ...f, staged: false } as const))
  const untracked = status.untracked.map((f) => ({ ...f, staged: false } as const))
  const rows = [...staged, ...unstaged, ...untracked]

  return (
    <FileRowGroup
      cwd={cwd}
      rows={rows}
      mergeBase={false}
      expanded={expanded}
      onExpanded={onExpanded}
      onOpen={onOpen}
    />
  )
}

// ── Range list ────────────────────────────────────────────────────────

function RangeList(props: {
  cwd: string
  baseRef: string
  branchName: string
  mergeBase: boolean
  files: RangeRow[]
  expanded: string | null
  onExpanded: (k: string | null) => void
  onOpen: (path: string) => void
}) {
  const { cwd, files, expanded, onExpanded, onOpen } = props
  const rows = files.map((f) => ({ path: f.path, status: f.status as string, insertions: f.insertions, deletions: f.deletions, staged: false as const }))
  return <FileRowGroup cwd={cwd} rows={rows} mergeBase={props.mergeBase} rangeProps={props} expanded={expanded} onExpanded={onExpanded} onOpen={onOpen} />
}

interface RowLike {
  path: string
  status: string
  insertions?: number
  deletions?: number
  staged: boolean
}

/** Shared file-list + expandable-diff renderer for both the uncommitted
 *  (staged/unstaged) and range (branch/base) tabs. The diff body is
 *  fetched lazily per row on expand via the appropriate endpoint. */
function FileRowGroup(props: {
  cwd: string
  rows: RowLike[]
  mergeBase: boolean
  rangeProps?: { baseRef: string; branchName: string }
  expanded: string | null
  onExpanded: (k: string | null) => void
  onOpen: (path: string) => void
}) {
  const { cwd, rows, mergeBase, rangeProps, expanded, onExpanded, onOpen } = props

  return (
    <>
      {rows.map((row) => (
        <FileRow
          key={`${row.path}:${row.staged}`}
          cwd={cwd}
          row={row}
          mergeBase={mergeBase}
          rangeProps={rangeProps}
          open={expanded === `${row.path}:${row.staged}`}
          onToggle={() => onExpanded(expanded === `${row.path}:${row.staged}` ? null : `${row.path}:${row.staged}`)}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

/** One file row with an expandable diff body. Dispatch to the uncommitted
 *  (staged/unstaged) vs range (branch/base) variants — each is a separate
 *  component so it can call its own diff hook unconditionally. */
function FileRow(props: {
  cwd: string
  row: RowLike
  mergeBase: boolean
  rangeProps?: { baseRef: string; branchName: string }
  open: boolean
  onToggle: () => void
  onOpen: (path: string) => void
}) {
  if (props.rangeProps) {
    return <RangeFileRow {...props} rangeProps={props.rangeProps} />
  }
  return <UncommittedFileRow {...props} />
}

function RowShell(props: {
  row: RowLike
  open: boolean
  onToggle: () => void
  onOpen: (path: string) => void
  diff: { loading: boolean; error: string | null; data: GitDiff | null }
}) {
  const { row, open, onToggle, onOpen, diff } = props
  const path = row.path
  const isUntracked = row.status[0] === '?'
  const hasCounts = row.insertions != null || row.deletions != null
  // Tracked rows are an accordion: a `.git-file-row-line` holding the toggle
  // (status / path / +− counts / chevron) + actions, then the diff body below
  // when open. This mirrors GitPanel's `.git-file-row` DOM contract — the CSS
  // column-flexes `.git-file-row` and expects the header row to be a single
  // full-width toggle, NOT bare sibling spans (which stack vertically).
  if (isUntracked) {
    // Untracked files have no diff to expand (GitPanel treats them the same
    // way): a static inline row with only the open-file action.
    return (
      <div className="git-file-row untracked">
        <div className="git-file-row-line">
          <span className="git-file-row-toggle untracked-static" title={path}>
            <span className="git-file-status status-?">?</span>
            <span className="git-file-path">{path}</span>
          </span>
          <div className="git-file-actions">
            <button
              type="button"
              className="git-action-btn"
              onClick={() => onOpen(path)}
              aria-label={`Open ${path}`}
              title="Open file"
            >
              <IconSearch size={13} />
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={open ? 'git-file-row open' : 'git-file-row'}>
      <div className="git-file-row-line">
        <button
          type="button"
          className="git-file-row-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`Toggle diff for ${path}`}
          title={path}
        >
          <span className={`git-file-status status-${row.status[0]}`}>{row.status[0]}</span>
          <span className="git-file-path">{path}</span>
          {hasCounts && (
            <span className="git-file-changes">
              {row.insertions != null && row.insertions > 0 && (
                <span className="git-file-additions">+{row.insertions}</span>
              )}
              {row.deletions != null && row.deletions > 0 && (
                <span className="git-file-deletions">−{row.deletions}</span>
              )}
            </span>
          )}
          <span className="git-file-arrow" aria-hidden>
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </span>
        </button>
        {row.status[0] !== 'D' && row.status[0] !== 'R' && (
          <div className="git-file-actions">
            <button
              type="button"
              className="git-action-btn"
              onClick={() => onOpen(path)}
              aria-label={`Open ${path}`}
              title="Open file"
            >
              <IconSearch size={13} />
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="git-file-diff-wrap">
          {diff.loading && <div className="git-file-diff-loading">Loading…</div>}
          {diff.error && <div className="git-file-diff-error">{diff.error}</div>}
          {diff.data && diff.data.isBinary && <div className="git-file-diff-binary">(binary file)</div>}
          {diff.data && !diff.data.isBinary && (
            <DiffView text={diff.data.text} truncated={diff.data.truncated} totalLines={diff.data.totalLines} />
          )}
        </div>
      )}
    </div>
  )
}

function UncommittedFileRow(props: {
  cwd: string
  row: RowLike
  open: boolean
  onToggle: () => void
  onOpen: (path: string) => void
}) {
  const { cwd, row, open, onToggle, onOpen } = props
  const { data, loading, error } = useGitDiff(cwd, open ? row.path : undefined, row.staged, open)
  return <RowShell row={row} open={open} onToggle={onToggle} onOpen={onOpen} diff={{ loading, error, data }} />
}

function RangeFileRow(props: {
  cwd: string
  row: RowLike
  mergeBase: boolean
  rangeProps: { baseRef: string; branchName: string }
  open: boolean
  onToggle: () => void
  onOpen: (path: string) => void
}) {
  const { cwd, row, mergeBase, rangeProps, open, onToggle, onOpen } = props
  const { data, loading, error } = useGitRangeDiffFile(
    cwd,
    rangeProps.baseRef,
    rangeProps.branchName,
    mergeBase,
    open ? row.path : undefined,
    open,
  )
  return <RowShell row={row} open={open} onToggle={onToggle} onOpen={onOpen} diff={{ loading, error, data }} />
}
