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

import { memo, useMemo, useState } from 'react'
import { useGitDiff, useGitLog, useGitBranches, useGitStashes, useSessionFiles } from '../hooks/useGitStatus'
import { useGitWrite } from '../hooks/useGitWrite'
import { ConfirmDialog } from './ConfirmDialog'
import { useErrorToast } from '../hooks/useErrorToast'
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
  const [toastError, showError, clearError] = useErrorToast()
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  // Commit message state lives at the GitPanel level (not inside the
  // CommitSection) so the "This session" generate button can populate
  // it without prop-drilling a setter through unrelated subtrees.
  const [commitMessage, setCommitMessage] = useState('')
  // "This session" file list — only fetched when status indicates a
  // running repo, since gitStartSha is meaningless otherwise. Drives
  // the top-of-panel section AND the ✨ badges in the regular sections.
  const sessionFiles = useSessionFiles(sessionId, status?.isRepo === true)
  const sessionPaths = useMemo(() => {
    if (!sessionFiles.data) return new Set<string>()
    return new Set(sessionFiles.data.map((f) => f.path))
  }, [sessionFiles.data])

  // Helper used inside event handlers: run a write op and translate
  // any rejection into a toast. Returns void so callers can `void run(...)`.
  async function runOp(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showError(`${label}: ${msg}`)
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
          showError(`${errLabel}: ${msg}`)
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
          <span className="git-panel-branch">⎇ git</span>
          <span className="git-panel-spacer" />
          <button className="git-panel-icon-btn" onClick={onRefresh} title="Refresh">⟳</button>
          <button className="git-panel-icon-btn" onClick={onClose} title="Close">✕</button>
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
          <span className="git-panel-branch">⎇ git</span>
          <span className="git-panel-spacer" />
          <button className="git-panel-icon-btn" onClick={onClose} title="Close">✕</button>
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
          <span className="git-panel-branch">⎇ …</span>
          <span className="git-panel-spacer" />
          <button className="git-panel-icon-btn" onClick={onClose} title="Close">✕</button>
        </header>
        <div className="git-panel-empty">
          <p>Loading git status…</p>
        </div>
      </aside>
    )
  }

  // ── Repo state ──────────────────────────────────────────────────
  const inProgress = status.state !== 'clean' && status.state !== 'dirty'

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
    <aside className="git-panel" role="region" aria-label="Git">
      <header className="git-panel-header">
        <span className="git-panel-branch" title={status.upstream ? `tracking ${status.upstream}` : 'no upstream'}>
          ⎇ {status.detached ? 'detached' : (status.branch ?? 'unknown')}
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-panel-syncs" title={`${status.ahead} ahead · ${status.behind} behind`}>
            {status.ahead > 0 && <>↑{status.ahead}</>}
            {status.behind > 0 && <> ↓{status.behind}</>}
          </span>
        )}
        <span className="git-panel-spacer" />
        <button
          className="git-panel-icon-btn"
          onClick={onRefresh}
          disabled={loading}
          title={loading ? 'Refreshing…' : 'Refresh'}
        >
          {loading ? '…' : '⟳'}
        </button>
        <button className="git-panel-icon-btn" onClick={onClose} title="Close">✕</button>
      </header>

      {toastError && (
        <div className="git-panel-toast" role="alert">
          <span>{toastError}</span>
          <button className="git-panel-icon-btn" onClick={clearError} title="Dismiss">✕</button>
        </div>
      )}

      {inProgress && (
        <div className="git-panel-banner" role="alert">
          <span>⚠ {status.state} in progress</span>
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

      <ThisSessionSection
        sessionFiles={sessionFiles.data}
        gitStartSha={sessionFiles.gitStartSha}
        loading={sessionFiles.loading}
        writeOps={writeOps}
        commitMessage={commitMessage}
        setCommitMessage={setCommitMessage}
        onError={(label, err) => showError(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <Section
        title="Staged"
        count={status.staged.length}
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
              inSession={sessionPaths.has(f.path)}
              writeOps={writeOps}
              onError={(label, err) => showError(`${label}: ${err}`)}
              askConfirm={askThenRun}
            />
          ))
        )}
      </Section>

      <Section
        title="Changes"
        count={status.unstaged.length}
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
              inSession={sessionPaths.has(f.path)}
              writeOps={writeOps}
              onError={(label, err) => showError(`${label}: ${err}`)}
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
              inSession={sessionPaths.has(f.path)}
              writeOps={writeOps}
              onError={(label, err) => showError(`${label}: ${err}`)}
              askConfirm={askThenRun}
            />
          ))
        )}
      </Section>

      <CommitSection
        canAmend={true}
        commit={writeOps.commit}
        busy={writeOps.busyOps.has('commit') || writeOps.busyOps.has('commit:amend')}
        message={commitMessage}
        setMessage={setCommitMessage}
        onError={(err) => showError(`Commit: ${err}`)}
        askConfirm={askThenRun}
      />

      <BranchesSection
        sessionId={sessionId}
        currentBranch={status.detached ? null : status.branch}
        writeOps={writeOps}
        onError={(label, err) => showError(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <StashesSection
        sessionId={sessionId}
        writeOps={writeOps}
        onError={(label, err) => showError(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <Section title="Recent commits" count={null} defaultOpen={false}>
        <CommitList cwd={cwd} />
      </Section>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive}
          busy={confirmBusy}
          onConfirm={confirm.onConfirm}
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
}

function Section({ title, count, defaultOpen, children, actions }: SectionProps) {
  return (
    <details className="git-panel-section" open={defaultOpen}>
      <summary>
        <span className="git-panel-section-title">{title}</span>
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
      </summary>
      <div className="git-panel-section-body">{children}</div>
    </details>
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
  /** True when this file also appears in the "This session" set —
   *  drives the ✨ badge so the user can tell at a glance which
   *  changes were touched during the current conversation. */
  inSession?: boolean
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function FileRow({ file, cwd, staged, inSession, writeOps, onError, askConfirm }: FileRowProps) {
  const [open, setOpen] = useState(false)
  const { data: diff, loading, error } = useGitDiff(cwd, file.path, staged, open)

  const stageBusy = writeOps.busyOps.has(`stage:${file.path}`)
  const unstageBusy = writeOps.busyOps.has(`unstage:${file.path}`)
  const discardBusy = writeOps.busyOps.has(`discard:${file.path}`)
  const anyBusy = stageBusy || unstageBusy || discardBusy

  return (
    <div className={`git-file-row ${open ? 'open' : ''}`}>
      <div className="git-file-row-line">
        <button
          type="button"
          className="git-file-row-toggle"
          onClick={() => setOpen((v) => !v)}
          title={file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
        >
          <span className={`git-file-status status-${file.status}`}>{file.status}</span>
          <span className="git-file-path">
            {inSession && <span className="git-file-session-badge" title="Changed during this session">✨</span>}
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
          <span className="git-file-arrow">{open ? '▾' : '▸'}</span>
        </button>
        <div className="git-file-actions">
          {staged ? (
            <button
              type="button"
              className="git-action-btn"
              title="Unstage"
              disabled={anyBusy}
              onClick={async () => {
                try { await writeOps.unstage([file.path]) } catch (e) { onError('Unstage', (e as Error).message) }
              }}
            >−</button>
          ) : (
            <>
              <button
                type="button"
                className="git-action-btn"
                title="Stage"
                disabled={anyBusy}
                onClick={async () => {
                  try { await writeOps.stage([file.path]) } catch (e) { onError('Stage', (e as Error).message) }
                }}
              >+</button>
              <button
                type="button"
                className="git-action-btn danger"
                title="Discard changes"
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
              >↺</button>
            </>
          )}
        </div>
      </div>
      {open && (
        <div className="git-file-diff-wrap">
          {loading && <div className="git-file-diff-loading">Loading diff…</div>}
          {error && <div className="git-file-diff-error">{error}</div>}
          {diff && diff.isBinary && (
            <div className="git-file-diff-binary">Binary file — no preview</div>
          )}
          {diff && !diff.isBinary && (
            <DiffView text={diff.text} truncated={diff.truncated} totalLines={diff.totalLines} />
          )}
        </div>
      )}
    </div>
  )
}

interface UntrackedRowProps {
  file: GitFileEntry
  inSession?: boolean
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function UntrackedRow({ file, inSession, writeOps, onError, askConfirm }: UntrackedRowProps) {
  const stageBusy = writeOps.busyOps.has(`stage:${file.path}`)
  const discardBusy = writeOps.busyOps.has(`discard:${file.path}`)
  const anyBusy = stageBusy || discardBusy
  return (
    <div className="git-file-row untracked">
      <div className="git-file-row-line">
        <span className="git-file-row-toggle untracked-static" title={file.path}>
          <span className="git-file-status status-?">?</span>
          <span className="git-file-path">
            {inSession && <span className="git-file-session-badge" title="Changed during this session">✨</span>}
            {file.path}
          </span>
        </span>
        <div className="git-file-actions">
          <button
            type="button"
            className="git-action-btn"
            title="Stage"
            disabled={anyBusy}
            onClick={async () => {
              try { await writeOps.stage([file.path]) } catch (e) { onError('Stage', (e as Error).message) }
            }}
          >+</button>
          <button
            type="button"
            className="git-action-btn danger"
            title="Delete from disk"
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
          >×</button>
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
  return (
    <pre className="git-file-diff">
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
  commit: ReturnType<typeof useGitWrite>['commit']
  busy: boolean
  /** Lifted from this component to GitPanel so the "This session"
   *  Generate button can populate the textarea without prop-drilling
   *  a setter through unrelated subtrees. */
  message: string
  setMessage: (m: string) => void
  onError: (err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function CommitSection({ canAmend, commit, busy, message, setMessage, onError, askConfirm }: CommitSectionProps) {
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

  return (
    <details className="git-panel-section" open={false}>
      <summary>
        <span className="git-panel-section-title">Commit</span>
      </summary>
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
    </details>
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
    <details
      className="git-panel-section"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
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
      </summary>
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
        {branches.loading && <div className="git-section-empty">Loading branches…</div>}
        {branches.error && <div className="git-section-empty git-commits-error">{branches.error}</div>}
        {branches.data && branches.data.length === 0 && (
          <div className="git-section-empty">No local branches</div>
        )}
        {branches.data && branches.data.map((b) => {
          const isCurrent = b.name === currentBranch
          const busy = writeOps.busyOps.has(`checkout:${b.name}`)
          return (
            <button
              key={b.name}
              type="button"
              className={`git-branch-row ${isCurrent ? 'current' : ''}`}
              disabled={isCurrent || busy}
              onClick={() => tryCheckout(b.name)}
              title={b.upstream ? `tracks ${b.upstream}` : 'no upstream'}
            >
              <span className="git-branch-mark">{isCurrent ? '✓' : ' '}</span>
              <span className="git-branch-name">{b.name}</span>
              {b.upstream && <span className="git-branch-upstream">→ {b.upstream}</span>}
            </button>
          )
        })}
      </div>
    </details>
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
    <details
      className="git-panel-section"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
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
      </summary>
      <div className="git-panel-section-body">
        {stashes.loading && <div className="git-section-empty">Loading…</div>}
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
                <button
                  className="git-action-btn"
                  disabled={popBusy || dropBusy}
                  onClick={async () => {
                    try { await writeOps.stashPop(s.index) }
                    catch (err) { onError('Pop stash', (err as Error).message) }
                  }}
                  title="Pop (apply and remove)"
                >pop</button>
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
                  title="Drop (delete)"
                >drop</button>
              </div>
            </div>
          )
        })}
      </div>
    </details>
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

// ── This-session section ──────────────────────────────────────────────
//
// The headline view: every file changed since the user started talking
// to Claude, plus two action buttons:
//   - ✨ Generate: ask the model for a conventional commit message,
//     populate the existing Commit textarea
//   - Commit Claude's changes: stage all session files, generate the
//     message if the textarea is empty, then preview-and-commit behind
//     a ConfirmDialog so the user can sanity-check before history is
//     written.
//
// Hidden entirely when the session has no anchor (gitStartSha is null —
// session was started outside a git repo, or HEAD was unborn/detached
// at spawn time).

interface ThisSessionSectionProps {
  sessionFiles: GitFileEntry[] | null
  gitStartSha: string | null
  loading: boolean
  writeOps: ReturnType<typeof useGitWrite>
  commitMessage: string
  setCommitMessage: (m: string) => void
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function ThisSessionSection({
  sessionFiles,
  gitStartSha,
  loading,
  writeOps,
  commitMessage,
  setCommitMessage,
  onError,
  askConfirm,
}: ThisSessionSectionProps) {
  // Hide entirely when:
  //  - we have no anchor (non-git session)
  //  - the fetch is still settling and we have no data yet (avoid a
  //    flash of an empty section then content)
  //  - nothing has changed since spawn (no point dedicating UI to it)
  if (!gitStartSha) return null
  if (!sessionFiles && !loading) return null
  if (sessionFiles && sessionFiles.length === 0) return null

  const generateBusy = writeOps.busyOps.has('commit-message')
  const stageBusy = sessionFiles?.some((f) => writeOps.busyOps.has(`stage:${f.path}`)) ?? false
  const commitBusy = writeOps.busyOps.has('commit') || writeOps.busyOps.has('commit:amend')

  async function generate() {
    try {
      const r = await writeOps.generateCommitMessage()
      setCommitMessage(r.message)
      if (r.fallback) {
        onError(
          'Generate commit message',
          'Used a local fallback message — Anthropic API was unreachable. Edit before committing.',
        )
      }
    } catch (e) {
      onError('Generate commit message', (e as Error).message)
    }
  }

  function commitAll() {
    const files = sessionFiles ?? []
    if (files.length === 0) {
      onError('Commit Claude\'s changes', 'No session files to commit.')
      return
    }
    askConfirm(
      {
        title: 'Commit all session changes?',
        message: (
          <>
            <p>This will stage and commit:</p>
            <ul className="commit-claudes-files">
              {files.slice(0, 20).map((f) => (
                <li key={f.path}><code>{f.path}</code></li>
              ))}
              {files.length > 20 && <li>… {files.length - 20} more</li>}
            </ul>
            <p>With message:</p>
            <pre className="commit-claudes-preview">{commitMessage.trim() || '(generating…)'}</pre>
          </>
        ),
        confirmLabel: 'Stage & commit',
      },
      async () => {
        // If textarea is empty, generate now. We do this inside the
        // confirm callback so the dialog above shows the placeholder
        // text — but we also want to ensure the message we actually
        // commit with is non-empty. Re-fetch if needed.
        let message = commitMessage
        if (!message.trim()) {
          const r = await writeOps.generateCommitMessage()
          message = r.message
          setCommitMessage(message)
        }
        await writeOps.stage(files.map((f) => f.path))
        await writeOps.commit(message, false)
        setCommitMessage('')
      },
      'Commit Claude\'s changes',
    )
  }

  return (
    <details className="git-panel-section git-this-session" open>
      <summary>
        <span className="git-panel-section-title">This session</span>
        <span className="git-panel-section-count">{sessionFiles?.length ?? '·'}</span>
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-section-action"
            disabled={generateBusy || !sessionFiles || sessionFiles.length === 0}
            onClick={(e) => { e.preventDefault(); void generate() }}
            title="Generate a conventional-commit message from the diff"
          >
            {generateBusy ? '…' : '✨ Generate'}
          </button>
          <button
            className="git-section-action"
            disabled={generateBusy || stageBusy || commitBusy || !sessionFiles || sessionFiles.length === 0}
            onClick={(e) => { e.preventDefault(); commitAll() }}
            title="Stage all session files and commit (with confirmation)"
          >
            Commit Claude&apos;s changes
          </button>
        </span>
      </summary>
      <div className="git-panel-section-body">
        {loading && !sessionFiles && (
          <div className="git-section-empty">Loading session changes…</div>
        )}
        {sessionFiles && sessionFiles.map((f) => (
          <div key={'session:' + f.path} className="git-file-row session-static">
            <div className="git-file-row-line">
              <span className="git-file-row-toggle untracked-static" title={f.path}>
                <span className={`git-file-status status-${f.status}`}>{f.status}</span>
                <span className="git-file-path">
                  <span className="git-file-session-badge" aria-hidden>✨</span>
                  {f.renamedFrom && (
                    <span className="git-file-renamed-from">{f.renamedFrom} → </span>
                  )}
                  {f.path}
                </span>
                {(f.insertions != null || f.deletions != null) && (
                  <span className="git-file-changes">
                    {f.insertions != null && f.insertions > 0 && (
                      <span className="git-file-additions">+{f.insertions}</span>
                    )}
                    {f.deletions != null && f.deletions > 0 && (
                      <span className="git-file-deletions">-{f.deletions}</span>
                    )}
                  </span>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}
