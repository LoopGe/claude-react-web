# Git panel — view each commit's changes

Date: 2026-10-26

## Problem

GitPanel's "Recent commits" section is metadata-only. Each row shows
shortHash / subject / author / relative time and nothing else
(`CommitList` in `src/components/GitPanel.tsx`, fed by `getLog` whose
format string is `%H %h %an %ct %s`). There is no way to see what a
commit actually changed.

The panel *can* show diffs for working-tree changes (Changes / Staged,
via `getDiff`) and for a ref *range* (WorktreeChanges branch/base tabs,
via `getRangeDiffFiles` / `getRangeDiffFile`). What's missing is the
per-commit case: "open this commit, show me its files, show me the diff
of this one file."

## Goal / non-goals

- **Goal:** each row in "Recent commits" expands to the commit's changed
  file list; each file row expands to that file's unified diff for the
  commit.
- **Goal:** file-row interaction is **full parity with the Changes
  section**: deferred two-stage open, `↑↓` selection + `Enter` expand,
  several files may be open at once inside a commit. The keyboard hint
  line reads `↑↓ select · Enter expand` (no s/u/x — read-only).
- **Goal:** preview truncation with a "View full diff" escape hatch,
  binary files as `(binary file)` — identical to every other diff in
  the panel.
- **Goal:** read-only. No stage / unstage / discard / revert.
- **Non-goal (v1):** commit-to-commit comparison, range selection,
  cherry-pick / revert / reset, "copy hash" actions.
- **Non-goal (v1):** history pagination — `/log` stays "latest 30".
- **Non-goal:** viewing a file's content at that commit — and therefore
  **no "open file" button on commit file rows**. FileViewer shows the
  worktree copy, which on a two-week-old commit is often unrelated or
  gone; putting it on a historical row is the exact silent-misleading
  affordance this feature must not ship. (Settled with the human
  partner: drop the button.)
- **Non-goal:** the panel's file filter box filtering commit file rows.
  It stays Changes-only.
- **Non-goal:** animated / virtualized diffs for very large commits. The
  existing preview caps already bound the payload.

## Design

### 1. Server — resolve the commit's diff base, then reuse the range layer

Two new read endpoints on the existing read-only git router
(`server/git-routes.ts`, mounted at `/api/git`), matching the
`cwd`-scoped GET conventions already there:

```
GET /api/git/commit?cwd=<abs>&hash=<sha>
  → {
      commit: { hash, shortHash, author, date, subject, body },
      files: GitRangeFile[]          // same shape as /diff-range
    }

GET /api/git/commit-file?cwd=<abs>&hash=<sha>&path=<rel>&full=1?
  → GitDiff                         // same shape as /diff-range-file
```

New functions in `server/git.ts`, alongside the existing range
functions:

- `getCommitFiles(cwd, hash)` — changed-file list for one commit
- `getCommitDiffFile(cwd, hash, path, opts?)` — one file's unified body

**One spawn for metadata + parents.** A single
`git log -1 --pretty=format:<COMMIT_FORMAT> <hash>` yields everything:
subject (`%s`), body (`%B` minus the first line, trimmed — `''` for a
subject-only message), author (`%an`), committer time (`%ct`), and
parents (`%P`, space-separated SHAs; absent for a root commit). This
supersedes a separate `rev-list` parent lookup — one `runGit`, one
parse. Field separators reuse the `\x1f` / `\x1e` convention from
`LOG_FORMAT`.

**`date` is committer time (`%ct`),** matching what `getLog` actually
emits today (its type doc saying "author date" is wrong — fix both docs
to say "committer date" so the collapsed row and the expanded header
never disagree).

**Diff base resolution.** A commit's changes are "diff against its
parent". Rather than write a second diff path, both functions resolve a
base **SHA** (never a `hash^` ref expression) and then delegate to the
existing `getRangeDiffFiles` / `getRangeDiffFile`:

| commit kind | base | git semantics |
|---|---|---|
| normal (1 parent) | `parents[0]` | `p1..hash` |
| merge (≥2 parents) | `parents[0]` (first parent) | GitHub-style "what this merge brought in" |
| root (0 parents) | `EMPTY_TREE_SHA` | `emptytree..hash` |

`EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'` is a named
constant (git's well-known empty tree; the SHA-1 contract in
`GitCommit` means this is stable). Verified: the object exists even in a
pristine `git init` repo, and `git diff --numstat <emptytree> <root>`
reports every file as `A` with no special-casing.

Truncation, binary detection, rename handling and the `full=1` escape
hatch all come free from the range layer — already implemented and
tested there. The empty-tree SHA passes `validateRef` (hex, no leading
`-`).

**Validation and errors.**

- `hash` is a commit id, not a general ref, and lands in a `git` argv.
  It must be hex-only (`/^[0-9a-f]{7,40}$/i`) so it can never be read as
  an option or as `HEAD~5`-style syntax. Uppercase hex is accepted
  (git is). SHA-256 repos (64-hex) 400 — consistent with `GitCommit`'s
  "Full 40-char SHA-1" contract.
- Missing `hash` / `path` → `HttpError(400, 'hash query param is
  required')` etc., in the `requireCwd` style.
- Hex-valid but unknown commit → `HttpError(404, 'unknown commit')`
  (do **not** let `runGit`'s exit-128 mapping surface as a 500).
- `path` goes through the existing `validateRepoRelativePath`.
- `cwd` uses the existing `requireCwd`.
- `runGit` stays `execFile` with a fixed argv — no shell.

**Known boundary:** in a `--depth=1` shallow clone the boundary commit
reports no parents, so it diffs against the empty tree and every file
shows `A`. Rare in local work repos; accepted, not special-cased.

### 2. Client — accordion commits, Changes-section row interaction

**Hooks** (`src/hooks/useGitStatus.ts`), following the existing
`useGitRangeDiff` / `useGitRangeDiffFile` pattern exactly
(`enabled`-gated, AbortController, `refresh` tick):

- `useGitCommitFiles(cwd, hash, enabled)` → `{ data: GitCommitResponse, loading, error, refresh }`
- `useGitCommitDiffFile(cwd, hash, path, enabled)` → `{ data: GitDiff, … }`
- `gitCommitDiffFileQuery(cwd, hash, path, opts?)` → query string for the
  `full=1` fetch (mirrors `gitDiffQuery` / `gitRangeDiffFileQuery`)

**Caching.** The `enabled` hooks drop their data when `enabled` goes
false, and `AnimatedCollapse` unmounts on exit by default — so "collapse
does not refetch" needs an explicit home. Hold each
`GitCommitResponse` in a `CommitList`-level `Map<hash, …>`, and render
the expanded body with `AnimatedCollapse unmountOnExit={false}` (the
`AnimatedDetails` path). Per-file diffs keep today's refetch-on-re-expand
behavior; only the file **list** is cached (a commit's contents are
immutable, so the list needs no invalidation).

**CommitList** becomes an accordion:

```
▸ abc1234  fix: silence the pump       Alice · 2h ago
  (collapsed — same as today)

▾ abc1234  fix: silence the pump       Alice · 2h ago
    body text, if any (clamped, small)
    M  server/session-pump.ts            +12 −3
       └─ deferred-open → DiffView (truncated + "View full diff")
    D  server/old-thing.ts               +0 −80
```

- Only one **commit** expanded at a time (same `expanded: string | null`
  shape as WorktreeChanges). Re-clicking collapses.
- Within an open commit, file rows follow the **Changes** model: each
  row owns its open state, so several files can be open at once.
- File rows use the **Changes `FileRow` interaction** — the two-stage
  deferred open (`setRenderDiff` + `pendingOpen`, chevron/aria-busy
  feedback, safety timer), not WorktreeChanges' immediate toggle.
- Zero-file commit (empty / merge-noop) shows `git-panel-empty` with
  "No file changes in this commit."

**Shared row component.** The interaction to match is GitPanel's
`FileRow`, so that is what gets extracted — a `GitFileRow` owning the
deferred-open accordion + `DiffView` + `FullDiffViewer`, with an
optional `actions?: ReactNode` slot:

- Changes / Staged rows pass their stage / unstage / discard buttons.
- Commit file rows pass **nothing** — no actions, and specifically **no
  open-file button** (non-goal above). RowShell's WorktreeChanges-only
  quirks (untracked static row, hidden action on `D`/`R`) therefore do
  not ride along.
- WorktreeChanges' `RowShell` is left as-is; migrating it is not this
  change.

**Keyboard.** When a commit is expanded, its file rows join the
panel's `↑↓` / `Enter` selection machinery the same way Changes rows
do. The footer hint for this section reads `↑↓ select · Enter expand`.

**Theming.** Any new CSS goes in `git-panel.css` using the existing
theme variables and the existing `.git-file-row` / `.git-diff-row`
class contract. No hardcoded hex.

### 3. Types

`shared/git-types.ts` gains:

```ts
export interface GitCommitDetail {
  /** Full 40-char SHA-1. */
  hash: string
  shortHash: string
  author: string
  /** Committer date, unix ms (same field `/log` shows). */
  date: number
  subject: string
  /** Rest of the commit message, trimmed. Empty string when subject-only. */
  body: string
}

export interface GitCommitResponse {
  commit: GitCommitDetail
  files: GitRangeFile[]
}
```

Also fix `GitCommit.date`'s doc comment: it is committer time (`%ct`),
not author date. `GitCommit`'s wire shape is untouched — `/log` stays
lean.

## Tests

Match how `server/git.test.ts` is actually written: function-level
**and** route-level (`buildApp()` + `app.request`), on the existing
`seedRepo` / `seedShas` fixtures with `it.skipIf(!gitOk)` and
`tempDir`/`rmRf`. For the merge case, `git merge --no-ff other` on a
seed copy (second parent touching only `a.txt`) is enough.

- `getCommitFiles` on a normal commit: right paths / status / counts.
- Root commit: every file `A`, diffed against the empty tree.
- Merge commit: file list reflects the first-parent diff only.
- `getCommitDiffFile` on a deleted file returns the deletion hunk.
- `getCommitDiffFile` on a binary file returns `isBinary: true`.
- `body` parsing: multi-paragraph message and subject-only message.
- `hash` rejects non-hex (`HEAD`, `abc^`, `--foo`) with `HttpError(400)`;
  hex-but-unknown yields `HttpError(404)`.
- `path` still rejects `..` / absolute via `validateRepoRelativePath`.
- `full: true` bypasses the preview budget — same shape as the existing
  `GET /api/git/diff` `full=1` test (which is where the cap is actually
  pinned today, not in the range suite): seed a 700-line file, assert
  the preview is truncated and `full=1` is not.
- Route-level: `GET /api/git/commit` and `/commit-file` 400s and the
  HttpError→JSON mapping.
- Client: `useGitCommitFiles` in the style of `src/hooks/useGitStatus.test.ts`
  (`renderHook` + `vi.mock('./useApi')` + enabled/disabled cases).
- Client: collapse → re-expand of a commit does **not** refetch the file
  list.

## Calls made (builder-level, flag if wrong)

1. **`date` is committer time (`%ct`) everywhere**, and both type docs
   are corrected to say so. Author date would make "2h ago" flip on
   expand for rebased commits.
2. **One `git log -1` with `%P` + `%B`** for parents + metadata + body,
   instead of a separate `rev-list` parent spawn.
3. **`hash` is hex-validated, not `validateRef`,** and unknown-but-hex
   is 404 rather than a leaked 500.
4. **Delegation to `getRangeDiffFiles` / `getRangeDiffFile`** with a
   **resolved parent SHA** (never `hash^` ref syntax) — one truncation
   implementation, one binary detector, one rename parser.
5. **Root commit diffs against `EMPTY_TREE_SHA`** (named constant);
   shallow-clone boundary commits showing all-`A` is accepted, not
   special-cased.
6. **File list cached in a `CommitList`-level `Map<hash, …>`** with
   `AnimatedCollapse unmountOnExit={false}`; per-file diffs still
   refetch on re-expand.
7. **Extract GitPanel's `FileRow` (deferred-open) as the shared
   `GitFileRow`,** not WorktreeChanges' `RowShell` — the former is the
   interaction we're matching. Commit rows pass an empty `actions` slot
   (no open-file button, per the human partner).
8. **Several files may be open at once inside a commit** (Changes
   semantics), while only one commit stays open across the list.
9. **Empty commit copy:** "No file changes in this commit."
10. **File filter box stays Changes-only.**
11. **Route names stay `/api/git/commit` + `/api/git/commit-file`** —
    the noun/verb collision with `POST /api/sessions/:id/git/commit` is
    unambiguous (different routers) and consistent with `/log` / `/diff`
    being nouns here.
