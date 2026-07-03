// Per-session Git overlay — interactive view of branch state, file
// changes, recent commits, stashes, and branch operations. Mounted as a
// sibling of <SettingsPanel> inside the Chat panel; the parent (Chat.tsx)
// wraps us in a `.git-overlay` backdrop whose click-outside / Escape
// handling matches SettingsPanel's exactly.
//
// Capabilities:
//   - Status: staged / unstaged / untracked sections with per-row
//     stage / unstage / discard and section-level bulk actions
//   - Commit form: message textarea + Commit / Amend; an AI button on
//     the "This session" section pre-fills the textarea from the
//     gitStartSha…HEAD diff
//   - Branches: current + list + new branch + checkout with optional
//     auto-stash on conflict
//   - Stashes: list with pop / drop + "stash all changes"
//   - In-progress state banners (merge / rebase / cherry-pick) with
//     abort buttons
//
// All destructive operations (discard, drop, abort, amend, force
// checkout) are gated by <ConfirmDialog>.

import { memo, useEffect, useState } from 'react'
import { useGitDiff, useGitLog, useGitBranches, useGitStashes } from '../hooks/useGitStatus'
import { useGitWrite } from '../hooks/useGitWrite'
import { ConfirmDialog } from './ConfirmDialog'
import { AnimatedCollapse, AnimatedDetails } from './AnimatedCollapse'
import { Tooltip } from './Tooltip'
import { IconX, IconSparkles, IconChevronDown, IconChevronRight, IconCheck, IconAlertTriangle, IconRefresh, IconLoader, IconGitBranch, IconArrowUp, IconArrowDown, IconRotateCcw } from './icons/ToolIcons'
import { Skeleton } from './Skeleton'
import { useToast } from '../hooks/useToast'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { usePresenceValue } from '../hooks/useExitPresence'
import type {
  GitFileEntry,
  GitStatusResponse,
} from '../../shared/git-types'

interface Props {
  /** Session id powering the per-session POST routes (writes) and WS
   *  subscription (auto-refresh). Required for any of the write
   *  operations to function. */
  sessionId: string
  /** Working directory the panel is operating against. Always defined
   *  in normal flow (the chip isn't rendered without one), but accept
   *  undefined defensively so a cwd swap mid-render doesn't crash. */
  cwd: string | undefined
  /** Latest status snapshot from useGitStatus. May be null while the
   *  initial fetch is in flight, or { isRepo: false } on a race. */
  status: GitStatusResponse | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onClose: () => void
}

/** Aggregate insertion/deletion counts across a set of file entries. */
interface ChangeTotals {
  insertions: number
  deletions: number
}

/** Sum the per-file numstat counts into a single total. Files without
 *  counts (untracked, binary) contribute zero. */
function sumChanges(files: GitFileEntry[]): ChangeTotals {
  let insertions = 0
  let deletions = 0
  for (const f of files) {
    insertions += f.insertions ?? 0
    deletions += f.deletions ?? 0
  }
  return { insertions, deletions }
}

/** Confirmation dialog state — driven by file-row and section actions
 *  that need user sign-off before mutating. The whole structure gets
 *  cleared on confirm or cancel. */
interface ConfirmState {
  title: string
  message: React.ReactNode
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void>
}

export const GitPanel = memo(function GitPanel({ sessionId, cwd, status, loading, error, onRefresh, onClose }: Props) {
  const writeOps = useGitWrite(sessionId)
  const setPanelOs = useOverlayScrollbar({ autoHide: 'leave' })
  // Git op failures used to render an in-panel error strip; they now
  // surface as global toasts so the user sees them even if they've
  // already moved off the Git overlay.
  const toast = useToast()
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const confirmPresence = usePresenceValue(confirm)
  const [commitMessage, setCommitMessage] = useState('')

  // Helper used inside event handlers: run a write op and translate
  // any rejection into a toast. Returns void so callers can `void run(...)`.
  async function runOp(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`${label}: ${msg}`)
    }
  }

  /** Run a write op behind a ConfirmDialog. The dialog stays mounted
   *  while the op is in flight (busy) and only unmounts after the
   *  promise settles, so a slow git command doesn't visually jump. */
  function askThenRun(state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) {
    setConfirm({
      ...state,
      onConfirm: async () => {
        setConfirmBusy(true)
        try {
          await fn()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          toast.error(`${errLabel}: ${msg}`)
        } finally {
          setConfirmBusy(false)
          setConfirm(null)
        }
      },
    })
  }

  // ── Empty / error states ────────────────────────────────────────
  if (error) {
    return (
      <aside className="git-panel" role="region" aria-label="Git">
        <header className="git-panel-header">
          <span className="git-panel-branch"><IconGitBranch size={13} /> git</span>
          <span className="git-panel-spacer" />
          <Tooltip label="Refresh" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onRefresh} aria-label="Refresh"><IconRefresh size={14} /></button>
          </Tooltip>
          <Tooltip label="Close" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
          </Tooltip>
        </header>
        <div className="git-panel-empty">
          <p className="git-panel-error">{error}</p>
          <button className="git-panel-action" onClick={onRefresh}>Try again</button>
        </div>
      </aside>
    )
  }

  if (status && status.isRepo === false) {
    return (
      <aside className="git-panel" role="region" aria-label="Git">
        <header className="git-panel-header">
          <span className="git-panel-branch"><IconGitBranch size={13} /> git</span>
          <span className="git-panel-spacer" />
          <Tooltip label="Close" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
          </Tooltip>
        </header>
        <div className="git-panel-empty">
          <p>Not a git repository.</p>
        </div>
      </aside>
    )
  }

  if (!status) {
    return (
      <aside className="git-panel" role="region" aria-label="Git">
        <header className="git-panel-header">
          <span className="git-panel-branch"><IconGitBranch size={13} /> …</span>
          <span className="git-panel-spacer" />
          <Tooltip label="Close" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
          </Tooltip>
        </header>
        <div className="git-panel-empty">
          <p>Loading git status…</p>
        </div>
      </aside>
    )
  }

  // ── Repo state ──────────────────────────────────────────────────
  const inProgress = status.state !== 'clean' && status.state !== 'dirty'

  // Aggregate line-change totals across every changed file. Staged and
  // unstaged are separate diffs, so a file that's both staged AND further
  // modified contributes from both buckets — that matches what the user
  // sees if they expand each section. Untracked files have no diff counts.
  const totals = sumChanges([...status.staged, ...status.unstaged])

  // Section action helpers — each builds a Promise then routes errors to
  // the toast or, for destructive ones, to a ConfirmDialog.
  function stageAll(files: GitFileEntry[]) {
    if (files.length === 0) return
    void runOp('Stage all', () => writeOps.stage(files.map((f) => f.path)))
  }
  function unstageAll(files: GitFileEntry[]) {
    if (files.length === 0) return
    void runOp('Unstage all', () => writeOps.unstage(files.map((f) => f.path)))
  }
  function discardAllUnstaged(files: GitFileEntry[]) {
    if (files.length === 0) return
    askThenRun(
      {
        title: 'Discard all changes?',
        message: (
          <>
            <p>This will revert {files.length} file{files.length === 1 ? '' : 's'} to their last committed state.</p>
            <p><strong>This cannot be undone.</strong></p>
          </>
        ),
        confirmLabel: 'Discard',
        destructive: true,
      },
      () => writeOps.discard(files.map((f) => f.path), false),
      'Discard',
    )
  }

  return (
    <aside className="git-panel" role="region" aria-label="Git" ref={setPanelOs}>
      <header className="git-panel-header">
        <Tooltip label={status.upstream ? `tracking ${status.upstream}` : 'no upstream'} placement="bottom">
          <span className="git-panel-branch">
            <IconGitBranch size={13} /> {status.detached ? 'detached' : (status.branch ?? 'unknown')}
          </span>
        </Tooltip>
        {(status.ahead > 0 || status.behind > 0) && (
          <Tooltip label={`${status.ahead} ahead · ${status.behind} behind`} placement="bottom">
            <span className="git-panel-syncs">
              {status.ahead > 0 && <><IconArrowUp size={11} />{status.ahead}</>}
              {status.behind > 0 && <> <IconArrowDown size={11} />{status.behind}</>}
            </span>
          </Tooltip>
        )}
        {status.upstream && (
          <span className="git-panel-sync-actions">
            {status.behind > 0 && (
              <Tooltip label="Pull (fast-forward only)" placement="bottom">
                <button
                  className="git-panel-icon-btn"
                  disabled={writeOps.busyOps.has('pull') || writeOps.busyOps.has('push')}
                  onClick={(e) => {
                    e.preventDefault()
                    void runOp('Pull', async () => {
                      const result = await writeOps.pull()
                      if (!result.updated) toast.success('Already up to date')
                    })
                  }}
                  aria-label="Pull from remote"
                >
                  <IconArrowDown size={13} />
                </button>
              </Tooltip>
            )}
            {status.ahead > 0 && (
              <Tooltip label="Push to remote" placement="bottom">
                <button
                  className="git-panel-icon-btn"
                  disabled={writeOps.busyOps.has('pull') || writeOps.busyOps.has('push')}
                  onClick={(e) => {
                    e.preventDefault()
                    void runOp('Push', () => writeOps.push())
                  }}
                  aria-label="Push to remote"
                >
                  <IconArrowUp size={13} />
                </button>
              </Tooltip>
            )}
          </span>
        )}
        {(totals.insertions > 0 || totals.deletions > 0) && (
          <Tooltip
            label={`${totals.insertions} insertion${totals.insertions === 1 ? '' : 's'}, ${totals.deletions} deletion${totals.deletions === 1 ? '' : 's'} across all changes`}
            placement="bottom"
          >
            <span className="git-panel-total-changes">
              {totals.insertions > 0 && <span className="git-file-additions">+{totals.insertions}</span>}
              {totals.deletions > 0 && <span className="git-file-deletions">−{totals.deletions}</span>}
            </span>
          </Tooltip>
        )}
        <span className="git-panel-spacer" />
        <Tooltip label={loading ? 'Refreshing…' : 'Refresh'} placement="bottom">
          <button
            className="git-panel-icon-btn"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh"
          >
            {loading ? <IconLoader size={14} className="git-panel-spin" /> : <IconRefresh size={14} />}
          </button>
        </Tooltip>
        <Tooltip label="Close" placement="bottom">
          <button className="git-panel-icon-btn" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
        </Tooltip>
      </header>

      {inProgress && (
        <div className="git-panel-banner" role="alert">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAlertTriangle size={12} /> {status.state} in progress</span>
          <span className="git-panel-spacer" />
          {status.state === 'merging' && (
            <button
              className="btn btn-danger git-banner-action"
              onClick={() =>
                askThenRun(
                  {
                    title: 'Abort merge?',
                    message: 'Discards in-progress merge state. Local changes that were not yet committed will be lost.',
                    confirmLabel: 'Abort merge',
                    destructive: true,
                  },
                  () => writeOps.abortMerge(),
                  'Abort merge',
                )
              }
            >Abort merge</button>
          )}
          {status.state === 'rebasing' && (
            <button
              className="btn btn-danger git-banner-action"
              onClick={() =>
                askThenRun(
                  {
                    title: 'Abort rebase?',
                    message: 'Returns the branch to its pre-rebase state. Any conflict resolutions made so far will be discarded.',
                    confirmLabel: 'Abort rebase',
                    destructive: true,
                  },
                  () => writeOps.abortRebase(),
                  'Abort rebase',
                )
              }
            >Abort rebase</button>
          )}
        </div>
      )}

      {/* Section order: Changes (unstaged) is what the user is iterating
          on, so it sits at the top. Staged sits next — the holding pen
          on the way to commit. Untracked is collapsed by default;
          new files only matter once the user wants to add them. */}
      <Section
        title="Changes"
        count={status.unstaged.length}
        changeTotals={sumChanges(status.unstaged)}
        defaultOpen={status.unstaged.length > 0}
        actions={status.unstaged.length > 0 ? (
          <>
            <button
              className="git-section-action"
              onClick={(e) => { e.preventDefault(); stageAll(status.unstaged) }}
              disabled={writeOps.busyOps.size > 0}
            >Stage all</button>
            <button
              className="git-section-action danger"
              onClick={(e) => { e.preventDefault(); discardAllUnstaged(status.unstaged) }}
              disabled={writeOps.busyOps.size > 0}
            >Discard all</button>
          </>
        ) : null}
      >
        {status.unstaged.length === 0 ? (
          <EmptyHint>No unstaged changes</EmptyHint>
        ) : (
          status.unstaged.map((f) => (
            <FileRow
              key={'u:' + f.path}
              file={f}
              cwd={cwd}
              staged={false}
              writeOps={writeOps}
              onError={(label, err) => toast.error(`${label}: ${err}`)}
              askConfirm={askThenRun}
            />
          ))
        )}
      </Section>

      <Section
        title="Staged"
        count={status.staged.length}
        changeTotals={sumChanges(status.staged)}
        defaultOpen={status.staged.length > 0}
        actions={status.staged.length > 0 ? (
          <button
            className="git-section-action"
            onClick={(e) => { e.preventDefault(); unstageAll(status.staged) }}
            disabled={writeOps.busyOps.size > 0}
          >Unstage all</button>
        ) : null}
      >
        {status.staged.length === 0 ? (
          <EmptyHint>No staged changes</EmptyHint>
        ) : (
          status.staged.map((f) => (
            <FileRow
              key={'s:' + f.path}
              file={f}
              cwd={cwd}
              staged
              writeOps={writeOps}
              onError={(label, err) => toast.error(`${label}: ${err}`)}
              askConfirm={askThenRun}
            />
          ))
        )}
      </Section>

      <Section
        title="Untracked"
        count={status.untracked.length}
        defaultOpen={false}
        actions={status.untracked.length > 0 ? (
          <button
            className="git-section-action"
            onClick={(e) => { e.preventDefault(); stageAll(status.untracked) }}
            disabled={writeOps.busyOps.size > 0}
          >Stage all</button>
        ) : null}
      >
        {status.untracked.length === 0 ? (
          <EmptyHint>No untracked files</EmptyHint>
        ) : (
          status.untracked.map((f) => (
            <UntrackedRow
              key={'?:' + f.path}
              file={f}
              writeOps={writeOps}
              onError={(label, err) => toast.error(`${label}: ${err}`)}
              askConfirm={askThenRun}
            />
          ))
        )}
      </Section>

      <CommitSection
        canAmend={true}
        hasStaged={status.staged.length > 0}
        commit={writeOps.commit}
        generateCommitMessage={writeOps.generateCommitMessage}
        busy={writeOps.busyOps.has('commit') || writeOps.busyOps.has('commit:amend')}
        generateBusy={writeOps.busyOps.has('commit-message')}
        message={commitMessage}
        setMessage={setCommitMessage}
        onError={(err) => toast.error(`Commit: ${err}`)}
        askConfirm={askThenRun}
      />

      <BranchesSection
        sessionId={sessionId}
        currentBranch={status.detached ? null : status.branch}
        writeOps={writeOps}
        onError={(label, err) => toast.error(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <StashesSection
        sessionId={sessionId}
        writeOps={writeOps}
        onError={(label, err) => toast.error(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <Section title="Recent commits" count={null} defaultOpen={false}>
        <CommitList cwd={cwd} />
      </Section>

      {confirmPresence.value && (
        <ConfirmDialog
          open={confirm != null}
          title={confirmPresence.value.title}
          message={confirmPresence.value.message}
          confirmLabel={confirmPresence.value.confirmLabel}
          destructive={confirmPresence.value.destructive}
          busy={confirmBusy}
          onConfirm={confirmPresence.value.onConfirm}
          onCancel={() => { if (!confirmBusy) setConfirm(null) }}
        />
      )}
    </aside>
  )
})

// ── Section wrapper using native <details>/<summary> ──────────────────

interface SectionProps {
  title: string
  count: number | null
  defaultOpen: boolean
  children: React.ReactNode
  /** Optional buttons rendered to the right of the section title. */
  actions?: React.ReactNode
  /** Aggregate line-change counts for this section's files, shown as a
   *  +N −M badge beside the count. Omitted for sections without diffs. */
  changeTotals?: ChangeTotals
}

function Section({ title, count, defaultOpen, children, actions, changeTotals }: SectionProps) {
  const summary = (
    <>
      <span className="git-panel-section-title">{title}</span>
      {changeTotals && (changeTotals.insertions > 0 || changeTotals.deletions > 0) && (
        <span className="git-section-change-totals">
          {changeTotals.insertions > 0 && <span className="git-file-additions">+{changeTotals.insertions}</span>}
          {changeTotals.deletions > 0 && <span className="git-file-deletions">-{changeTotals.deletions}</span>}
        </span>
      )}
      {count !== null && <span className="git-panel-section-count">{count}</span>}
      {actions && (
        // Stop the click from bubbling into <summary> (which would
        // toggle the section). The outer wrapper preserves the
        // grid-end alignment.
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </>
  )

  return (
    <AnimatedDetails
      className="git-panel-section"
      defaultOpen={defaultOpen}
      summary={summary}
      contentClassName="git-panel-section-body"
    >
      {children}
    </AnimatedDetails>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="git-panel-section-empty">{children}</div>
}

// ── File rows ─────────────────────────────────────────────────────────

interface FileRowProps {
  file: GitFileEntry
  cwd: string | undefined
  staged: boolean
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

const FileRow = memo(function FileRow({ file, cwd, staged, writeOps, onError, askConfirm }: FileRowProps) {
  const [open, setOpen] = useState(false)
  const [renderDiff, setRenderDiff] = useState(false)
  // Pending-open: the user clicked to open but the diff fetch is still in
  // flight. We defer flipping `open` until the fetch resolves so the
  // AnimatedCollapse runs ONE animation from 0 → final-diff-height instead
  // of two (0 → loading-placeholder, then snap → diff). The chevron flips
  // immediately and the toggle gets `aria-busy` so the click still feels
  // responsive while we wait.
  const [pendingOpen, setPendingOpen] = useState(false)
  const { data: diff, loading, error } = useGitDiff(cwd, file.path, staged, renderDiff)

  // Resolve pending → open as soon as the fetch produces a verdict.
  // Triggers on either: (a) success, (b) error, (c) renderDiff was already
  // true and a refresh re-fetched. We require either `diff` or `error` to
  // have landed so we don't open during the brief window where renderDiff
  // is true but the fetching effect hasn't yet flipped `loading` to true.
  useEffect(() => {
    if (!pendingOpen) return
    if (loading) return
    if (diff == null && error == null) return
    // Synchronizing UI to an external async source (the diff fetch) — this
    // is the legitimate setState-in-effect case the rule's docs call out
    // ("subscribe for updates from some external system"). The alternative
    // (kick off the fetch and flip `open` immediately) is exactly the
    // two-stage animation we're trying to avoid.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(true)
    setPendingOpen(false)
  }, [pendingOpen, loading, diff, error])

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

  const stageBusy = writeOps.busyOps.has(`stage:${file.path}`)
  const unstageBusy = writeOps.busyOps.has(`unstage:${file.path}`)
  const discardBusy = writeOps.busyOps.has(`discard:${file.path}`)
  const anyBusy = stageBusy || unstageBusy || discardBusy

  const handleToggle = () => {
    if (open) {
      // Closing — immediate.
      setOpen(false)
      setPendingOpen(false)
      return
    }
    if (pendingOpen) {
      // User clicked again before the deferred open resolved — cancel.
      setPendingOpen(false)
      return
    }
    // Opening — kick off the fetch and wait for it (or the safety timer)
    // before flipping `open`. Chevron + aria-busy give immediate feedback.
    setRenderDiff(true)
    setPendingOpen(true)
  }

  return (
    <div className={`git-file-row ${open ? 'open' : ''}`}>
      <div className="git-file-row-line">
        <button
          type="button"
          className="git-file-row-toggle"
          aria-busy={pendingOpen || undefined}
          aria-expanded={open}
          onClick={handleToggle}
          title={file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
        >
          <span className={`git-file-status status-${file.status}`}>{file.status}</span>
          <span className="git-file-path">
            {file.renamedFrom && (
              <span className="git-file-renamed-from">{file.renamedFrom} → </span>
            )}
            {file.path}
          </span>
          {(file.insertions != null || file.deletions != null) && (
            <span className="git-file-changes">
              {file.insertions != null && file.insertions > 0 && (
                <span className="git-file-additions">+{file.insertions}</span>
              )}
              {file.deletions != null && file.deletions > 0 && (
                <span className="git-file-deletions">-{file.deletions}</span>
              )}
            </span>
          )}
          <span className="git-file-arrow">{(open || pendingOpen) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
        </button>
        <div className="git-file-actions">
          {staged ? (
            <Tooltip label="Unstage" placement="left">
              <button
                type="button"
                className="git-action-btn"
                aria-label="Unstage"
                disabled={anyBusy}
                onClick={async () => {
                  try { await writeOps.unstage([file.path]) } catch (e) { onError('Unstage', (e as Error).message) }
                }}
              >−</button>
            </Tooltip>
          ) : (
            <>
              <Tooltip label="Stage" placement="left">
                <button
                  type="button"
                  className="git-action-btn"
                  aria-label="Stage"
                  disabled={anyBusy}
                  onClick={async () => {
                    try { await writeOps.stage([file.path]) } catch (e) { onError('Stage', (e as Error).message) }
                  }}
                >+</button>
              </Tooltip>
              <Tooltip label="Discard changes" placement="left">
                <button
                  type="button"
                  className="git-action-btn danger"
                  aria-label="Discard changes"
                  disabled={anyBusy}
                  onClick={() =>
                    askConfirm(
                      {
                        title: 'Discard changes?',
                        message: (
                          <>Revert <code>{file.path}</code> to its committed state. This cannot be undone.</>
                        ),
                        confirmLabel: 'Discard',
                        destructive: true,
                      },
                      () => writeOps.discard([file.path], false),
                      'Discard',
                    )
                  }
                >
                  <IconRotateCcw size={12} />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      <AnimatedCollapse
        open={open}
        className="git-file-diff-collapse"
        onExitComplete={() => setRenderDiff(false)}
      >
        {renderDiff && (
          <div className="git-file-diff-wrap">
            {loading && <div className="git-file-diff-loading">Loading diff...</div>}
            {error && <div className="git-file-diff-error">{error}</div>}
            {diff && diff.isBinary && (
              <div className="git-file-diff-binary">Binary file - no preview</div>
            )}
            {diff && !diff.isBinary && (
              <DiffView text={diff.text} truncated={diff.truncated} totalLines={diff.totalLines} />
            )}
          </div>
        )}
      </AnimatedCollapse>
    </div>
  )
}, (prev, next) => {
  // Custom comparator: skip re-render when only writeOps reference changed
  // but the file's busy state is the same.
  if (prev.file !== next.file || prev.cwd !== next.cwd || prev.staged !== next.staged) return false
  const path = prev.file.path
  const prevBusy = prev.writeOps.busyOps.has(`stage:${path}`) || prev.writeOps.busyOps.has(`unstage:${path}`) || prev.writeOps.busyOps.has(`discard:${path}`)
  const nextBusy = next.writeOps.busyOps.has(`stage:${path}`) || next.writeOps.busyOps.has(`unstage:${path}`) || next.writeOps.busyOps.has(`discard:${path}`)
  return prevBusy === nextBusy
})

interface UntrackedRowProps {
  file: GitFileEntry
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function UntrackedRow({ file, writeOps, onError, askConfirm }: UntrackedRowProps) {
  const stageBusy = writeOps.busyOps.has(`stage:${file.path}`)
  const discardBusy = writeOps.busyOps.has(`discard:${file.path}`)
  const anyBusy = stageBusy || discardBusy
  return (
    <div className="git-file-row untracked">
      <div className="git-file-row-line">
        <span className="git-file-row-toggle untracked-static" title={file.path}>
          <span className="git-file-status status-?">?</span>
          <span className="git-file-path">
            {file.path}
          </span>
        </span>
        <div className="git-file-actions">
          <Tooltip label="Stage" placement="left">
            <button
              type="button"
              className="git-action-btn"
              aria-label="Stage"
              disabled={anyBusy}
              onClick={async () => {
                try { await writeOps.stage([file.path]) } catch (e) { onError('Stage', (e as Error).message) }
              }}
            >+</button>
          </Tooltip>
          <Tooltip label="Delete from disk" placement="left">
          <button
            type="button"
            className="git-action-btn danger"
            aria-label="Delete from disk"
            disabled={anyBusy}
            onClick={() =>
              askConfirm(
                {
                  title: 'Delete untracked file?',
                  message: (
                    <>
                      <p>Permanently remove <code>{file.path}</code> from disk.</p>
                      <p><strong>This file is not tracked by git — there is no way to recover it.</strong></p>
                    </>
                  ),
                  confirmLabel: 'Delete file',
                  destructive: true,
                },
                () => writeOps.discard([file.path], true),
                'Delete',
              )
            }
          ><IconX size={14} /></button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

// ── Diff renderer ────────────────────────────────────────────────────

interface DiffViewProps {
  text: string
  truncated: boolean
  totalLines: number
}

// memo: GitPanel re-renders on every commit-textarea keystroke. Without
// memo, every open DiffView re-runs split() and re-renders ~500 spans
// even though its props are unchanged.
const DiffView = memo(function DiffView({ text, truncated, totalLines }: DiffViewProps) {
  const lines = text.split('\n')
  const setDiffOs = useOverlayScrollbar({ orientation: 'both', autoHide: 'leave' })
  return (
    <pre className="git-file-diff" ref={setDiffOs}>
      {lines.map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---') ? 'meta'
          : line.startsWith('@@') ? 'hunk'
          : line.startsWith('+') ? 'add'
          : line.startsWith('-') ? 'del'
          : ''
        return (
          <span key={i} className={`git-diff-line ${cls}`}>
            {line}
            {'\n'}
          </span>
        )
      })}
      {truncated && (
        <span className="git-diff-line truncated">
          {`\n— diff truncated; ${totalLines} lines total —\n`}
        </span>
      )}
    </pre>
  )
})

// ── Commit form ───────────────────────────────────────────────────────

interface CommitSectionProps {
  canAmend: boolean
  /** Whether anything is currently staged. Drives the Generate button's
   *  disabled state — the AI message is only meaningful when there's
   *  a staged diff to summarise; an empty staged area would 400 from
   *  the server and confuse the user. */
  hasStaged: boolean
  commit: ReturnType<typeof useGitWrite>['commit']
  generateCommitMessage: ReturnType<typeof useGitWrite>['generateCommitMessage']
  busy: boolean
  generateBusy: boolean
  message: string
  setMessage: (m: string) => void
  onError: (err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function CommitSection({
  canAmend,
  hasStaged,
  commit,
  generateCommitMessage,
  busy,
  generateBusy,
  message,
  setMessage,
  onError,
  askConfirm,
}: CommitSectionProps) {
  async function doCommit(amend: boolean) {
    if (!amend && !message.trim()) {
      onError('Commit message required')
      return
    }
    try {
      await commit(message, amend)
      setMessage('')
    } catch (e) {
      onError((e as Error).message)
    }
  }

  async function doGenerate() {
    try {
      const r = await generateCommitMessage()
      setMessage(r.message)
      if (r.fallback) {
        onError(
          'Used a local fallback message — Anthropic API was unreachable. Edit before committing.',
        )
      }
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <AnimatedDetails
      key={hasStaged ? 'staged' : 'empty'}
      className="git-panel-section"
      defaultOpen={hasStaged}
      summary={(
        <>
        <span className="git-panel-section-title">Commit</span>
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-section-action"
            type="button"
            disabled={generateBusy || busy || !hasStaged}
            onClick={(e) => { e.preventDefault(); void doGenerate() }}
            title={
              hasStaged
                ? 'Generate a Conventional Commit message from the staged diff'
                : 'Stage some changes first to generate a commit message'
            }
          >
            {generateBusy ? '…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconSparkles size={12} /> Generate</span>}
          </button>
        </span>
        </>
      )}
    >
      <div className="git-panel-section-body git-commit-form">
        <textarea
          className="git-commit-textarea"
          placeholder="Commit message…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          disabled={busy}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits, mirroring the composer pattern.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy) {
              e.preventDefault()
              void doCommit(false)
            }
          }}
        />
        <div className="git-commit-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !message.trim()}
            onClick={() => doCommit(false)}
          >Commit</button>
          {canAmend && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                askConfirm(
                  {
                    title: 'Amend last commit?',
                    message: (
                      <>
                        <p>Replaces the previous commit with the staged changes (if any) and
                        {message.trim() ? ' the new message.' : ' keeps its existing message.'}</p>
                        <p>Don't amend a commit that has already been pushed to a shared branch.</p>
                      </>
                    ),
                    confirmLabel: 'Amend',
                    destructive: false,
                  },
                  () => doCommit(true),
                  'Amend',
                )
              }
            >Amend last</button>
          )}
        </div>
      </div>
    </AnimatedDetails>
  )
}

// ── Branches section ─────────────────────────────────────────────────

interface BranchesSectionProps {
  sessionId: string
  currentBranch: string | null
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function BranchesSection({ sessionId, currentBranch, writeOps, onError, askConfirm }: BranchesSectionProps) {
  const [open, setOpen] = useState(false)
  const branches = useGitBranches(sessionId, open)
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newName, setNewName] = useState('')

  /** Try checkout. On 409 (uncommitted-changes conflict), prompt for
   *  auto-stash. Other errors land in the toast. */
  async function tryCheckout(name: string) {
    try {
      await writeOps.checkout(name, false)
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status === 409) {
        askConfirm(
          {
            title: 'Uncommitted changes block this checkout',
            message: (
              <>
                <p>Switching to <code>{name}</code> would overwrite uncommitted changes in your working tree.</p>
                <p>Auto-stash and switch? Your changes will be saved as <code>stash@{'{0}'}</code>.</p>
              </>
            ),
            confirmLabel: 'Auto-stash & switch',
            destructive: false,
          },
          () => writeOps.checkout(name, true),
          `Checkout ${name}`,
        )
      } else {
        onError(`Checkout ${name}`, err.message)
      }
    }
  }

  async function createNewBranch(checkout: boolean) {
    if (!newName.trim()) return
    try {
      await writeOps.createBranch(newName.trim(), checkout)
      setNewName('')
      setNewBranchOpen(false)
    } catch (e) {
      const err = e as Error & { status?: number }
      if (checkout && err.status === 409) {
        askConfirm(
          {
            title: 'Uncommitted changes block branch creation',
            message: (
              <>
                <p>Creating and switching to <code>{newName.trim()}</code> would overwrite uncommitted changes.</p>
                <p>Auto-stash and create? Your changes will be saved as <code>stash@{'{0}'}</code>.</p>
              </>
            ),
            confirmLabel: 'Auto-stash & create',
            destructive: false,
          },
          async () => {
            await writeOps.createBranch(newName.trim(), true, true)
            setNewName('')
            setNewBranchOpen(false)
          },
          `Create branch ${newName.trim()}`,
        )
      } else {
        onError('Create branch', err.message)
      }
    }
  }

  return (
    <AnimatedDetails
      className="git-panel-section"
      open={open}
      onOpenChange={setOpen}
      summary={(
        <>
        <span className="git-panel-section-title">Branches</span>
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-section-action"
            onClick={(e) => { e.preventDefault(); setNewBranchOpen((v) => !v) }}
          >+ new</button>
        </span>
        </>
      )}
    >
      <div className="git-panel-section-body">
        {newBranchOpen && (
          <div className="git-new-branch-form">
            <input
              type="text"
              className="git-new-branch-input"
              placeholder="branch name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void createNewBranch(true) }
                if (e.key === 'Escape') { e.preventDefault(); setNewBranchOpen(false); setNewName('') }
              }}
            />
            <button
              className="btn btn-primary"
              disabled={!newName.trim() || writeOps.busyOps.size > 0}
              onClick={() => createNewBranch(true)}
            >Create & checkout</button>
            <button
              className="btn"
              disabled={!newName.trim() || writeOps.busyOps.size > 0}
              onClick={() => createNewBranch(false)}
            >Create</button>
          </div>
        )}
        {branches.loading && <Skeleton rows={3} className="git-section-skeleton" />}
        {branches.error && <div className="git-section-empty git-commits-error">{branches.error}</div>}
        {branches.data && branches.data.length === 0 && (
          <div className="git-section-empty">No local branches</div>
        )}
        {branches.data && branches.data.map((b) => {
          const isCurrent = b.name === currentBranch
          const busy = writeOps.busyOps.has(`checkout:${b.name}`)
          return (
            <Tooltip
              key={b.name}
              label={b.upstream ? `tracks ${b.upstream}` : 'no upstream'}
              placement="left"
            >
              <button
                type="button"
                className={`git-branch-row ${isCurrent ? 'current' : ''}`}
                disabled={isCurrent || busy}
                onClick={() => tryCheckout(b.name)}
              >
                <span className="git-branch-mark">{isCurrent ? <IconCheck size={12} /> : ' '}</span>
                <span className="git-branch-name">{b.name}</span>
                {b.upstream && <span className="git-branch-upstream">→ {b.upstream}</span>}
              </button>
            </Tooltip>
          )
        })}
      </div>
    </AnimatedDetails>
  )
}

// ── Stashes section ──────────────────────────────────────────────────

interface StashesSectionProps {
  sessionId: string
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function StashesSection({ sessionId, writeOps, onError, askConfirm }: StashesSectionProps) {
  const [open, setOpen] = useState(false)
  const stashes = useGitStashes(sessionId, open)

  return (
    <AnimatedDetails
      className="git-panel-section"
      open={open}
      onOpenChange={setOpen}
      summary={(
        <>
        <span className="git-panel-section-title">Stashes</span>
        <span className="git-panel-section-count">{stashes.data?.length ?? '·'}</span>
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-section-action"
            disabled={writeOps.busyOps.size > 0}
            onClick={async (e) => {
              e.preventDefault()
              try { await writeOps.stashCreate({ includeUntracked: true }) }
              catch (err) { onError('Stash all', (err as Error).message) }
            }}
          >Stash all</button>
        </span>
        </>
      )}
    >
      <div className="git-panel-section-body">
        {stashes.loading && <Skeleton rows={2} className="git-section-skeleton" />}
        {stashes.error && <div className="git-section-empty git-commits-error">{stashes.error}</div>}
        {stashes.data && stashes.data.length === 0 && (
          <div className="git-section-empty">No stashes</div>
        )}
        {stashes.data && stashes.data.map((s) => {
          const popBusy = writeOps.busyOps.has(`stash-pop:${s.index}`)
          const dropBusy = writeOps.busyOps.has(`stash-drop:${s.index}`)
          return (
            <div key={s.ref} className="git-stash-row">
              <code className="git-stash-ref">{s.ref}</code>
              <span className="git-stash-message">{s.message}</span>
              <div className="git-stash-actions">
                <Tooltip label="Pop (apply and remove)" placement="left">
                  <button
                    className="git-action-btn"
                    disabled={popBusy || dropBusy}
                    onClick={async () => {
                      try { await writeOps.stashPop(s.index) }
                      catch (err) { onError('Pop stash', (err as Error).message) }
                    }}
                    aria-label="Pop stash"
                  >pop</button>
                </Tooltip>
                <Tooltip label="Drop (delete)" placement="left">
                  <button
                    className="git-action-btn danger"
                    disabled={popBusy || dropBusy}
                    onClick={() =>
                      askConfirm(
                        {
                          title: 'Drop this stash?',
                          message: (
                            <>
                              <p>Permanently remove <code>{s.ref}</code>.</p>
                              <p><strong>This cannot be undone.</strong></p>
                            </>
                          ),
                          confirmLabel: 'Drop',
                          destructive: true,
                        },
                        () => writeOps.stashDrop(s.index),
                        'Drop stash',
                      )
                    }
                    aria-label="Drop stash"
                  >drop</button>
                </Tooltip>
              </div>
            </div>
          )
        })}
      </div>
    </AnimatedDetails>
  )
}

// ── Recent commits ────────────────────────────────────────────────────

function CommitList({ cwd }: { cwd: string | undefined }) {
  const { data: commits, loading, error } = useGitLog(cwd, 30, true)
  if (loading) return <div className="git-commits-empty">Loading commits…</div>
  if (error) return <div className="git-commits-empty git-commits-error">{error}</div>
  if (!commits || commits.length === 0) return <div className="git-commits-empty">No commits yet</div>
  return (
    <ul className="git-commits-list">
      {commits.map((c) => (
        <li key={c.hash} className="git-commit">
          <code className="git-commit-hash" title={c.hash}>{c.shortHash}</code>
          <span className="git-commit-subject">{c.subject}</span>
          <span className="git-commit-meta">
            {c.author} · {formatRelative(c.date)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function formatRelative(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  const d = new Date(ms)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

