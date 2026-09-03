// Shared git types — sent over the /api/git/* REST surface.
//
// Lives in shared/ so both the server (Node-side parsing in server/git.ts)
// and the browser (useGitStatus / useGitDiff hooks) can import the same
// declarations without duplicating them. Mirrors the convention used by
// shared/session-info.ts and shared/ws-protocol.ts.

/** Two-letter porcelain v1 status code, projected onto a single axis.
 *  Renames (`R`) and copies (`C`) keep the destination path; the original
 *  is exposed via `renamedFrom`. Untracked entries use `?`, ignored use `!`. */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '?' | '!'

export interface GitFileEntry {
  /** Path relative to the repo root, forward-slash separated (git's native form). */
  path: string
  /** Effective status — for cleanly-staged files this is the index column;
   *  for unstaged-only changes it's the worktree column. */
  status: GitFileStatus
  /** True iff the index column shows a change (i.e. this file is in the
   *  staging area). */
  staged: boolean
  /** True iff the worktree column shows a change. A file can be both
   *  staged and unstaged simultaneously when its index and worktree
   *  versions differ from each other and from HEAD. */
  unstaged: boolean
  /** Original path for renames/copies (R/C). Forward-slash form. */
  renamedFrom?: string
  /** Lines added (from `git diff --numstat`). Undefined for untracked files. */
  insertions?: number
  /** Lines deleted (from `git diff --numstat`). Undefined for untracked files. */
  deletions?: number
}

/** One entry from `git worktree list --porcelain`. The first entry is
 *  always the primary checkout; the rest are linked worktrees. Used to
 *  reconcile an agent's EnterWorktree intent against the git fact. */
export interface GitLinkedWorktree {
  /** Absolute worktree directory (primary = repo top level; linked e.g.
   *  `<repo>/.claude/worktrees/<name>`). */
  path: string
  /** Checked-out head branch, or null when detached. */
  branch: string | null
  /** True when the worktree has a `locked` file (git worktree lock). */
  locked: boolean
  /** Contents of the `locked` file when present (e.g. "claude session
   *  <name> (pid …)"), else null. */
  lockMessage: string | null
}

/** Repo-wide working state. `dirty` just means "has any file changes";
 *  the other states correspond to in-progress git operations that block
 *  commits and need a banner in the UI. */
export type GitRepoState =
  | 'clean'
  | 'dirty'
  | 'merging'
  | 'rebasing'
  | 'cherry-picking'
  | 'reverting'
  | 'bisecting'

export interface GitStatus {
  isRepo: true
  /** Absolute path of the work-tree top level (`git rev-parse
   *  --show-toplevel`). Git status paths are relative to THIS, not to the
   *  cwd the status was queried from — callers that need an absolute path
   *  (e.g. the read-only FileViewer) must anchor against repoRoot, not cwd,
   *  or they break when the session cwd is a subdirectory of the repo. */
  repoRoot: string
  /** Branch name, or null when HEAD is detached. */
  branch: string | null
  detached: boolean
  /** Commits ahead of upstream (0 when no upstream configured). */
  ahead: number
  /** Commits behind upstream (0 when no upstream configured). */
  behind: number
  /** Upstream tracking ref (e.g. "origin/main"), or null. */
  upstream: string | null
  state: GitRepoState
  /** All worktrees of this repo (includes the primary checkout at
   *  repoRoot). Lets clients reconcile an agent-driven EnterWorktree
   *  intent against the git fact of what worktrees + branches actually
   *  exist, and whether one of Claude's sessions has locked it. */
  linkedWorktrees: GitLinkedWorktree[]
  /** Files with index-column changes. May overlap with `unstaged` when
   *  a file has been staged AND further modified. */
  staged: GitFileEntry[]
  /** Tracked files with worktree-column changes (excludes untracked). */
  unstaged: GitFileEntry[]
  /** `??` files. */
  untracked: GitFileEntry[]
}

/** Returned when the cwd is reachable but not inside a git work tree.
 *  HTTP status is still 200 — "no repo" is a normal state, not an error. */
export interface GitNotARepo {
  isRepo: false
}

export type GitStatusResponse = GitStatus | GitNotARepo

/** One file changed between two refs (branch range diff), for the
 *  Worktree-changes view — "what did the isolated worktree branch do". */
export interface GitRangeFile {
  /** Repo-relative path on the destination side (for renames, the new path). */
  path: string
  /** A/M/D/R/C status projected from the range diff's name-status. */
  status: GitFileStatus
  insertions: number
  deletions: number
  /** Original path for renames/copies. */
  renamedFrom?: string
}

export interface GitRangeDiffResponse {
  from: string
  to: string
  files: GitRangeFile[]
}

export interface GitDiff {
  /** Path the diff is for (the destination side for renames). */
  path: string
  /** Whether this is the staged (--cached) diff or the worktree diff. */
  staged: boolean
  /** True when the diff was clipped at MAX_DIFF_LINES; the trailing
   *  context is dropped and `text` ends with the last kept line. */
  truncated: boolean
  /** Total line count of the original (un-truncated) diff. */
  totalLines: number
  /** Unified diff text. Empty string when isBinary is true. */
  text: string
  /** Binary file — git emitted "Binary files ... differ"; we don't
   *  attempt to render content. */
  isBinary: boolean
}

export interface GitCommit {
  /** Full 40-char SHA-1. */
  hash: string
  /** Short 7-char SHA-1 (git's default abbreviation). */
  shortHash: string
  /** Author name (no email, to keep payload lean). */
  author: string
  /** Author date as unix milliseconds (UTC). */
  date: number
  /** First line of the commit message — never contains newlines. */
  subject: string
}

export interface GitLogResponse {
  commits: GitCommit[]
}

// ── Stashes + branches ────────────────────────────────────────────────

export interface GitStashEntry {
  /** Stack index — `git stash pop <index>` and `drop <index>` use it. */
  index: number
  /** Symbolic ref, e.g. "stash@{0}". */
  ref: string
  /** First-line description: "WIP on main: <sha> <subject>" or whatever
   *  the user passed via `git stash push -m`. */
  message: string
  /** Author date as unix milliseconds. */
  date: number
}

export interface GitBranch {
  /** Branch name without refs/heads/ prefix. */
  name: string
  /** True for the currently-checked-out branch (HEAD points at it). */
  current: boolean
  /** Tracked upstream ref (e.g. "origin/main"), or null. */
  upstream: string | null
}

export interface GitBranchesResponse {
  branches: GitBranch[]
}

export interface GitStashesResponse {
  stashes: GitStashEntry[]
}

/** Generic write-op response — the freshly-fetched status snapshot
 *  alongside the operation's own optional payload (e.g. checkout
 *  reports whether it auto-stashed). */
export interface GitWriteResponse {
  status: GitStatus
}

export interface GitCheckoutResponse extends GitWriteResponse {
  branches: GitBranch[]
  /** True when the server auto-stashed dirty changes to allow the
   *  checkout. The frontend surfaces this so the user knows their work
   *  is now in stash@{0}. */
  stashed: boolean
}
