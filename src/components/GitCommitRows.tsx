// Commit accordion rows for the Git panel's "Recent commits" section.
//
// `CommitRow` is one log row: collapsed it keeps the plain
// hash/subject/meta grid; expanded it adds the commit body and one
// `CommitFileRow` per changed file. Extracted from GitPanel so it is
// mountable in isolation (that is the test surface) — CommitList stays in
// GitPanel and owns only the list shape.
//
// `CommitFileRow` is a `GitFileRow` with NO `actions`: a commit's files are
// read-only history (no stage / unstage / discard / open-file), which is
// what keeps the row shell identical to the worktree rows while dropping
// every write affordance.

import { useCallback, useState } from 'react'
import { GitFileRow } from './GitFileRow'
import {
  useCachedCommitFiles,
  useGitCommitDiffFile,
  gitCommitDiffFileQuery,
} from '../hooks/useGitStatus'
import { api } from '../hooks/useApi'
import { formatRelativeFromMs } from '../utils/format'
import type { GitCommitResponse, GitDiff, GitRangeFile } from '../../shared/git-types'

export interface CommitRowProps {
  cwd: string
  hash: string
  subject: string
  author: string
  /** Committer date, unix ms. */
  date: number
  /** Rest of the commit message. Empty string when subject-only. When the
   *  caller has no body (the log endpoint omits it), the fetched commit
   *  detail fills in — see `bodyText` below. */
  body: string
  /** Parent's "this commit is the expanded one" flag. Fully controlled:
   *  the row renders its detail exactly when this is true, so the parent's
   *  one-at-a-time accordion holds against every click. */
  expanded: boolean
  onToggle: () => void
  /** Caller-owned hash → commit-detail cache (owned at GitPanel level so
   *  collapse → re-expand never refetches). */
  cache: Map<string, GitCommitResponse>
  /** Path of the keyboard-selected file row within this commit, or null. */
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

export function CommitRow({
  cwd,
  hash,
  subject,
  author,
  date,
  body,
  expanded,
  onToggle,
  cache,
  selectedPath,
  onSelectFile,
}: CommitRowProps) {
  // Fully controlled: `expanded` IS the open state. Clicking the row only
  // calls onToggle() — the parent flips its state and this row follows in
  // the same commit, so switching commits never leaves two details mounted.
  // The cache is what makes collapse → re-expand free: the fetch is
  // skipped entirely on a hit and the file rows paint immediately.
  const { data, loading, error } = useCachedCommitFiles(cwd, hash, expanded, cache)

  // Prefer an explicit body (parent already has one); otherwise take it
  // from the fetched commit detail — /log omits the body, so the detail is
  // where the real message body comes from.
  const bodyText = body || data?.commit.body || ''

  return (
    // The row header is an activatable control: focusable, Enter/Space
    // toggle it, and aria-expanded tracks the accordion — so a keyboard- or
    // AT-only user can open a commit at all. (The file rows inside an
    // already-expanded commit ride the existing Selectable path.)
    <li
      className={`git-commit ${expanded ? 'open' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        // Keys from a nested control (a file-row toggle, the full-diff
        // modal's buttons) are that control's — handling them here would
        // collapse the whole commit the user is working in, and Space
        // would be cancelled outright.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') {
          // Don't let this reach the panel's key handler: its Enter branch
          // clicks `.git-file-row.selected .git-file-row-toggle`, which
          // would toggle a file diff open as a side effect of the commit.
          e.stopPropagation()
          onToggle()
        } else if (e.key === ' ') {
          // Space would scroll the panel otherwise.
          e.preventDefault()
          e.stopPropagation()
          onToggle()
        }
      }}
    >
      <code className="git-commit-hash" title={hash}>{hash.slice(0, 7)}</code>
      <span className="git-commit-subject">{subject}</span>
      <span className="git-commit-meta">
        {author} · {formatRelativeFromMs(date)}
      </span>
      {expanded && (
        // Clicks inside the detail must not bubble to the row toggle (they
        // would collapse the commit the user is working in).
        <div className="git-commit-detail" onClick={(e) => e.stopPropagation()}>
          {bodyText !== '' && <div className="git-commit-body">{bodyText}</div>}
          {loading && <div className="git-commits-empty">Loading files…</div>}
          {error && <div className="git-commits-empty git-commits-error">{error}</div>}
          {data && data.files.length === 0 && (
            <div className="git-panel-empty">No file changes in this commit.</div>
          )}
          {data && data.files.map((f) => (
            <CommitFileRow
              key={f.path}
              cwd={cwd}
              hash={hash}
              file={f}
              selected={selectedPath === f.path}
              onSelect={() => onSelectFile(f.path)}
            />
          ))}
        </div>
      )}
    </li>
  )
}

export interface CommitFileRowProps {
  cwd: string
  hash: string
  file: GitRangeFile
  /** Whether this row is the current keyboard-selection target. */
  selected: boolean
  onSelect: () => void
}

export function CommitFileRow({ cwd, hash, file, selected, onSelect }: CommitFileRowProps) {
  // Same deferred-open fetch latch as the worktree FileRow: the diff is
  // one git invocation per file, so it is only spent when the user opens
  // the row. Reset on collapse exit so a later reopen re-fetches.
  const [fetchStarted, setFetchStarted] = useState(false)
  const { data, loading, error } = useGitCommitDiffFile(cwd, hash, file.path, fetchStarted)
  const handleFetchStart = useCallback(() => setFetchStarted(true), [])
  const handleFetchReset = useCallback(() => setFetchStarted(false), [])

  // Full-diff escape hatch for a truncated preview. Stable per row so
  // FullDiffViewer's open-effect can't refetch on unrelated re-renders.
  const fetchFullText = useCallback(
    (signal?: AbortSignal): Promise<string> =>
      api
        .get<GitDiff>(gitCommitDiffFileQuery(cwd, hash, file.path, { full: true }), { signal })
        .then((d) => d.text),
    [cwd, hash, file.path],
  )

  return (
    <GitFileRow
      status={file.status}
      path={file.path}
      renamedFrom={file.renamedFrom}
      insertions={file.insertions}
      deletions={file.deletions}
      selected={selected}
      onSelect={onSelect}
      fetchStarted={fetchStarted}
      onFetchStart={handleFetchStart}
      onFetchReset={handleFetchReset}
      diff={{ data, loading, error }}
      fetchFullText={fetchFullText}
    />
  )
}
