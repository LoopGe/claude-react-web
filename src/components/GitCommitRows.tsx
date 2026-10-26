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

import { useCallback, useState, useEffect } from 'react'
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
  /** Parent's "this commit is the expanded one" flag (one at a time). */
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
  // Semi-controlled open state. The click flips local state so a row
  // toggles even before the parent has re-rendered (and so an isolated
  // mount whose onToggle is a no-op still opens); the parent's `expanded`
  // prop is authoritative whenever it CHANGES, which is what collapses the
  // previously-open commit when another one is opened.
  const [open, setOpen] = useState(expanded)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional controlled-component sync (same shape as MessageSearch's activeIndex mirror)
    setOpen(expanded)
  }, [expanded])

  // The cache is what makes collapse → re-expand free: the fetch is
  // skipped entirely on a hit and the file rows paint immediately.
  const { data, loading, error } = useCachedCommitFiles(cwd, hash, open, cache)

  const handleToggle = () => {
    setOpen((v) => !v)
    onToggle()
  }

  // Prefer an explicit body (parent already has one); otherwise take it
  // from the fetched commit detail — /log omits the body, so the detail is
  // where the real message body comes from.
  const bodyText = body || data?.commit.body || ''

  return (
    <li className={`git-commit ${open ? 'open' : ''}`} onClick={handleToggle}>
      <code className="git-commit-hash" title={hash}>{hash.slice(0, 7)}</code>
      <span className="git-commit-subject">{subject}</span>
      <span className="git-commit-meta">
        {author} · {formatRelativeFromMs(date)}
      </span>
      {open && (
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
