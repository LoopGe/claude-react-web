# Git commit diff viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every row in GitPanel's "Recent commits" expands to that commit's changed files, and each file row expands to its unified diff.

**Architecture:** Two new read-only git endpoints resolve a commit's diff base (parent SHA, first parent, or the empty tree) and delegate to the existing range-diff layer. On the client, a shared `GitFileRow` carries the Changes-section deferred-open row interaction; `CommitList` becomes a one-at-a-time accordion whose file rows are read-only and join the panel's keyboard selection.

**Tech Stack:** TypeScript, Hono (server routes), React 19 + Vite (client), vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-git-commit-diff-design.md`

## Global Constraints

- All git execution goes through `runGit()` in `server/git.ts` (`execFile`, fixed argv, no shell).
- User-supplied paths go through `validateRepoRelativePath` and are introduced by `--`.
- Diff previews keep the existing caps: `MAX_DIFF_LINES = 500`, `MAX_DIFF_BYTES = 256 * 1024`, `MAX_DIFF_LINE_CHARS = 2000`; `full=1` bypasses them.
- No hardcoded color hex in CSS — theme variables only, defined in both `:root` and `[data-theme="light"]` if a new color is needed.
- Never `console.*` for diagnostics; `createLogger(scope)` on the server.
- Client must not import `@anthropic-ai/claude-agent-sdk`.
- Typecheck both tsconfigs: `npm run typecheck`.
- Every commit is preceded by a review of that task's diff (self-review is acceptable).

## Review Focus

- **Root commit** — a repo's first commit has no parent; it must diff against the empty tree and list every file as `A`, not 500 or throw. → Task 1 test `root commit diffs against the empty tree`.
- **Unknown-but-hex hash** — `deadbeef…` must be 404, not a leaked git exit-128 500. → Task 1 test `unknown-but-hex hash yields 404`.
- **Option-shaped hash** — `hash=--output=/tmp/x` or `HEAD~1` must 400 before reaching git. → Task 1 test `non-hex hash is rejected`.
- **Collapse → re-expand must not refetch** the commit's file list (the `enabled` hooks drop data when disabled). → Task 2 test `cache survives a disable/enable cycle`.
- **s/u/x must be inert on commit file rows** — a stray `x` on a historical file must not open a discard confirm. → Task 4 test `write keys do not fire on commit file rows`.

---

### Task 1: Server — commit detail + per-commit diff

**Files:**
- Modify: `shared/git-types.ts`
- Modify: `server/git.ts`
- Modify: `server/git-routes.ts`
- Test: `server/git.test.ts`

**Interfaces:**
- Consumes: `getRangeDiffFiles(cwd, from, to)`, `getRangeDiffFile(cwd, from, to, path, mergeBase, opts)`, `runGit`, `ensureGitRepo`, `validateRepoRelativePath`, `HttpError`, `truncateDiff`, `untruncatedResult` (all existing in `server/git.ts`).
- Produces:
  - `EMPTY_TREE_SHA: string` (= `'4b825dc642cb6eb9a060e54bf8d69288fbee4904'`)
  - `validateCommitHash(hash: string): void` — throws `HttpError(400)` unless `/^[0-9a-f]{7,40}$/i`
  - `getCommitFiles(cwd: string, hash: string): Promise<GitCommitResponse>`
  - `getCommitDiffFile(cwd: string, hash: string, path: string, opts?: { full?: boolean }): Promise<GitDiff>`
  - `GET /api/git/commit?cwd=&hash=` → `GitCommitResponse`
  - `GET /api/git/commit-file?cwd=&hash=&path=&full=1` → `GitDiff`

- [ ] **Step 1: Add the types to `shared/git-types.ts`**

```ts
export interface GitCommitDetail {
  /** Full 40-char SHA-1. */
  hash: string
  shortHash: string
  author: string
  /** Committer date, unix ms (same field `/log` shows). */
  date: number
  subject: string
  /** Rest of the commit message (`%b`), trimmed. Empty string when subject-only. */
  body: string
}

export interface GitCommitResponse {
  commit: GitCommitDetail
  files: GitRangeFile[]
}
```

Also fix `GitCommit['date']`'s doc comment: it is committer time (`%ct`), not author date. Do not change the wire shape.

- [ ] **Step 2: Write the failing tests**

Add a `describe('getCommitDiff', …)` block in `server/git.test.ts`, structured like the existing `describe('getRangeDiff', …)` (its own `tempDir` / `rmRf` beforeEach/afterEach, `seedRepo`, `seedShas`, `it.skipIf(!gitOk)`). Function-level first; route-level tests follow the existing `describe('git-routes')` style (`buildApp()` + `app.request` + `json()`).

```ts
it.skipIf(!gitOk)('lists a normal commit\'s files with status + counts', async () => {
  seedRepo(dir)
  // seedShas()[1] = 'second' — the commit that introduced log.txt
  const res = await getCommitFiles(dir, seedShas()[1])
  expect(res.commit.subject).toBe('second')
  expect(res.commit.body).toBe('')
  const log = res.files.find((f) => f.path === 'log.txt')
  expect(log?.status).toBe('A')
  expect(log?.insertions).toBe(1)
})

it.skipIf(!gitOk)('root commit diffs against the empty tree (every file A)', async () => {
  seedRepo(dir)
  const res = await getCommitFiles(dir, seedShas()[0])
  expect(res.commit.subject).toBe('first')
  expect(res.files.every((f) => f.status === 'A')).toBe(true)
  expect(res.files.map((f) => f.path)).toContain('a.txt')
})

it.skipIf(!gitOk)('merge commit diffs against its first parent', async () => {
  seedRepo(dir)
  // side branch off 'first' adds only g.txt; merge back into main.
  execFileSync('git', ['checkout', '--quiet', '-b', 'side', seedShas()[0]], { cwd: dir })
  writeFileSync(join(dir, 'g.txt'), 'g\n')
  gitCommitAll(dir, 'side work')
  execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: dir })
  execFileSync('git', ['merge', '--no-ff', '-m', 'merge side', 'side'], { cwd: dir })
  const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  const res = await getCommitFiles(dir, mergeSha)
  expect(res.files.map((f) => f.path)).toEqual(['g.txt'])
})

it.skipIf(!gitOk)('body is the message minus the subject', async () => {
  seedRepo(dir)
  // gitCommitAll writes a one-line message; make one with a body.
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@t', 'commit', '-m', 'subject line', '-m', 'para one\n\npara two'], { cwd: dir })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  const res = await getCommitFiles(dir, sha)
  expect(res.commit.subject).toBe('subject line')
  expect(res.commit.body).toBe('para one\n\npara two')
})

it.skipIf(!gitOk)('unknown-but-hex hash yields 404', async () => {
  seedRepo(dir)
  await expect(getCommitFiles(dir, 'deadbeef')).rejects.toThrow(HttpError)
  // and the route:
  const app = buildApp()
  const res = await app.request(`/api/git/commit?cwd=${encodeURIComponent(dir)}&hash=deadbeef`)
  expect(res.status).toBe(404)
})

it.skipIf(!gitOk)('non-hex hash is rejected with 400', async () => {
  seedRepo(dir)
  const app = buildApp()
  for (const bad of ['HEAD', 'HEAD~1', 'abc^', '--foo', '']) {
    const res = await app.request(`/api/git/commit?cwd=${encodeURIComponent(dir)}&hash=${encodeURIComponent(bad)}`)
    expect(res.status).toBe(400)
  }
})

it.skipIf(!gitOk)('returns a deletion hunk for a deleted file', async () => {
  seedRepo(dir)
  // 'third' only touches log.txt; delete a.txt in a new commit instead.
  execFileSync('git', ['rm', '--quiet', 'a.txt'], { cwd: dir })
  const sha = gitCommitAll(dir, 'drop a')
  const diff = await getCommitDiffFile(dir, sha, 'a.txt')
  expect(diff.isBinary).toBe(false)
  expect(diff.text).toContain('-alpha')
})

it.skipIf(!gitOk)('reports binary files without a body', async () => {
  seedRepo(dir)
  // root commit introduced blob.bin
  const diff = await getCommitDiffFile(dir, seedShas()[0], 'blob.bin')
  expect(diff.isBinary).toBe(true)
  expect(diff.text).toBe('')
})

it.skipIf(!gitOk)('full: true bypasses the preview budget', async () => {
  seedRepo(dir)
  // big.txt (700 lines) was introduced in the root commit.
  const preview = await getCommitDiffFile(dir, seedShas()[0], 'big.txt')
  expect(preview.truncated).toBe(true)
  const full = await getCommitDiffFile(dir, seedShas()[0], 'big.txt', { full: true })
  expect(full.truncated).toBe(false)
  expect(full.totalLines).toBeGreaterThan(500)
})
```

Plus these route cases inside `describe('git-routes')`:

```ts
describe('GET /api/git/commit', () => {
  it.skipIf(!gitOk)('400 when hash is missing', …)
  it.skipIf(!gitOk)('400 when hash is non-hex', …)          // hash=HEAD
  it.skipIf(!gitOk)('404 when the commit does not exist', …) // hash=deadbeef
  it.skipIf(!gitOk)('404 when cwd is not a git repo', …)
  it.skipIf(!gitOk)('returns commit + files', …)             // seedShas()[1], status 200, body.files[0].path === 'log.txt'
})

describe('GET /api/git/commit-file', () => {
  it.skipIf(!gitOk)('400 when path is missing', …)
  it.skipIf(!gitOk)('400 when path is absolute', …)
  it.skipIf(!gitOk)('400 when path escapes the repo', …)     // path=../x
  it.skipIf(!gitOk)('returns a unified diff', …)              // seedShas()[0], 'a.txt', text contains '+alpha'
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/git.test.ts`
Expected: FAIL — `getCommitFiles` is not exported / does not exist.

- [ ] **Step 4: Implement in `server/git.ts`**

Add `EMPTY_TREE_SHA` (a module-level const with a comment: git's well-known empty tree object, SHA-1). Add `validateCommitHash`.

Add one private helper and two exports. The helper parses a single `git log -1` and is the only place parent/base resolution lives:

```ts
/** One commit's metadata + parents, via a single `git log -1`.
 *  `date` is committer time (%ct), matching getLog. */
function getCommitMeta(cwd: string, hash: string): Promise<{
  hash: string; shortHash: string; author: string; date: number;
  subject: string; body: string; parents: string[]
}>
```

Format string (reuse the `\x1f`/`\x1e` convention of `LOG_FORMAT`):
`%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1f%P%x1f%b`
— `%P` is space-separated parent SHAs (empty for a root commit), `%b` is the body without the subject.

Unknown commit: before reading metadata, probe existence with
`runGit(cwd, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`])`;
when it exits non-zero, throw `HttpError(404, 'unknown commit')`. This
is one extra spawn and keeps the route from ever surfacing git's exit
128 as a 500.

```ts
/** Changed-file list for one commit. Diff base = first parent, or
 *  EMPTY_TREE_SHA for a root commit. */
export async function getCommitFiles(cwd: string, hash: string): Promise<GitCommitResponse>
```
Resolves base, then `return { commit, files: await getRangeDiffFiles(cwd, base, hash) }` (base and hash are both raw SHAs — `rangeRefArgs`' two-dot path handles them).

```ts
/** One file's unified body for one commit. Same contract as getRangeDiffFile. */
export async function getCommitDiffFile(
  cwd: string, hash: string, path: string, opts?: { full?: boolean },
): Promise<GitDiff>
```
Same base resolution, then delegates to `getRangeDiffFile(cwd, base, hash, path, false, opts)`.

Both functions call `validateCommitHash(hash)` then `ensureGitRepo(cwd)`.

- [ ] **Step 5: Implement the routes in `server/git-routes.ts`**

```
GET /commit      — requireCwd; hash required (400); validateCommitHash; getCommitFiles
GET /commit-file — requireCwd; hash + path required (400); validateCommitHash;
                   getCommitDiffFile with full = query('full') === '1'
```
Follow the file's existing inline-validation comment style. Export nothing new from the router file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/git.test.ts`
Expected: PASS (all new cases green, no regressions in the existing suite).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/git-types.ts server/git.ts server/git-routes.ts server/git.test.ts
git commit -m "feat(git): per-commit file list and diff API"
```

---

### Task 2: Client hooks

**Files:**
- Modify: `src/hooks/useGitStatus.ts`
- Test: `src/hooks/useGitStatus.test.ts`

**Interfaces:**
- Consumes: `GitCommitResponse`, `GitDiff` from `shared/git-types.ts`; `api.get` from `useApi`.
- Produces:
  - `gitCommitDiffFileQuery(cwd: string, hash: string, path: string, opts?: { full?: boolean }): string`
  - `useGitCommitFiles(cwd: string | undefined, hash: string | undefined, enabled: boolean): { data: GitCommitResponse | null; loading: boolean; error: string | null; refresh: () => void }`
  - `useGitCommitDiffFile(cwd: string | undefined, hash: string | undefined, path: string | undefined, enabled: boolean): { data: GitDiff | null; loading: boolean; error: string | null; refresh: () => void }`
  - `useCachedCommitFiles(cwd: string | undefined, hash: string | undefined, expanded: boolean, cache: Map<string, GitCommitResponse>): { data: GitCommitResponse | null; loading: boolean; error: string | null }`

- [ ] **Step 1: Write the failing tests**

Extend `src/hooks/useGitStatus.test.ts` (same `vi.mock('./useApi')` + `renderHook` style).

```ts
describe('useGitCommitFiles', () => {
  it('fetches when enabled, resets when disabled', async () => {
    const payload = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 's', body: '' }, files: [] }
    mockGet.mockResolvedValue(payload)
    const { result, rerender } = renderHook(({ e }) => useGitCommitFiles('/repo', 'a'.repeat(40), e), { initialProps: { e: true } })
    await waitFor(() => expect(result.current.data).toEqual(payload))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    rerender({ e: true })
    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useGitCommitFiles('/repo', 'a'.repeat(40), false))
    expect(result.current.data).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('useCachedCommitFiles', () => {
  it('cache survives a disable/enable cycle', async () => {
    const cache = new Map()
    const payload = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 's', body: '' }, files: [] }
    mockGet.mockResolvedValue(payload)
    const { result, rerender } = renderHook(({ e }) => useCachedCommitFiles('/repo', 'a'.repeat(40), e, cache), { initialProps: { e: true } })
    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(cache.size).toBe(1)
    rerender({ e: false })   // collapse
    expect(result.current.data).toEqual(payload)  // served from cache
    rerender({ e: true })    // re-expand
    expect(result.current.data).toEqual(payload)
    expect(mockGet).toHaveBeenCalledTimes(1)        // no refetch
  })
})

describe('gitCommitDiffFileQuery', () => {
  it('builds the query string, including full=1', () => {
    expect(gitCommitDiffFileQuery('/repo', 'a'.repeat(40), 'src/x.ts'))
      .toBe(`/git/commit-file?cwd=%2Frepo&hash=${'a'.repeat(40)}&path=src%2Fx.ts`)
    expect(gitCommitDiffFileQuery('/repo', 'a'.repeat(40), 'src/x.ts', { full: true })).toContain('full=1')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/hooks/useGitStatus.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement the hooks in `src/hooks/useGitStatus.ts`**

Copy the `useGitRangeDiff` / `useGitRangeDiffFile` skeleton exactly (AbortController per effect, `tick` refresh, `setData(null)` on disable). Only the URL and the types change.

`useCachedCommitFiles` wraps `useGitCommitFiles`:
- `enabled = expanded && !cache.has(hash)`
- when the inner hook yields `data`, write it into `cache` (skip if already present)
- return `{ data: cache.get(hash) ?? inner.data, loading: cache.has(hash) ? false : inner.loading, error: cache.has(hash) ? null : inner.error }`
- when `hash` is undefined, return all-null and skip the inner fetch

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useGitStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/hooks/useGitStatus.ts src/hooks/useGitStatus.test.ts
git commit -m "feat(git): commit-diff client hooks"
```

---

### Task 3: Extract `GitFileRow`

**Files:**
- Create: `src/components/GitFileRow.tsx`
- Modify: `src/components/GitPanel.tsx` (FileRow becomes a wrapper)

**Interfaces:**
- Consumes: `DiffView`, `FullDiffViewer`, `AnimatedCollapse`, `Tooltip`, `IconChevronDown`, `IconChevronRight`, `gitStatusTitle`.
- Produces:

```ts
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
  diff: { data: GitDiff | null; loading: boolean; error: string | null }
  fetchFullText: (signal?: AbortSignal) => Promise<string>
  /** Stage/unstage/discard buttons. Omit for read-only rows. */
  actions?: React.ReactNode
}

export const GitFileRow: React.MemoExoticComponent<(props: GitFileRowProps) => JSX.Element>
```

- [ ] **Step 1: Extract the component**

Move from `GitPanel`'s `FileRow` into `src/components/GitFileRow.tsx` everything that is row-interaction, not write-actions:

- state: `open`, `pendingOpen`, `showFull`
- `handleToggle` (the two-stage deferred open, including the "second click opens now" case)
- the two `useEffect`s that resolve `pendingOpen` → `open` (fetch verdict + 600 ms safety timer)
- the full `git-file-row` DOM: `.git-file-row-line`, `.git-file-row-toggle`, status chip, path (with `renamedFrom`), +/- counts, chevron, `.git-file-diff-wrap` body, `FullDiffViewer`
- `aria-busy={pendingOpen || undefined}`, `aria-expanded={open}` on the toggle

What stays out: the `useGitDiff` call, `writeOps`, `askConfirm`, `onOpenFile`. The parent supplies `diff`, `fetchFullText`, and an `actions` node rendered inside `.git-file-actions` (omit the whole `.git-file-actions` div when `actions` is undefined).

The row-line `onClick` calls `onSelect?.()`. `status` is the raw letter (the component applies `` `git-file-status status-${status}` `` and `gitStatusTitle(status)`).

Note the R-status quirk from the current code: the open-file action is hidden for `D` and `R`. That logic moves to the **parent's** `actions` node (it is a write/view concern, not a row concern).

- [ ] **Step 2: Rewire `FileRow` in `GitPanel.tsx` as a thin wrapper**

`FileRow` keeps its existing props and:
- owns `fetchStarted` state
- calls `useGitDiff(cwd, file.path, staged, fetchStarted)` and passes the result as `diff`
- builds `fetchFullText` (the `gitDiffQuery(…, { full: true })` callback, already present)
- builds `actions` = the existing stage/unstage/discard + open-file buttons, with the existing `anyBusy` disable and the D/R hide rule
- renders `<GitFileRow … />`

No behavior change. Keyboard `selected` / `onSelect(selectIndex)` wiring is unchanged.

- [ ] **Step 3: Run the existing tests to verify no regression**

Run: `npx vitest run src/hooks/useGitStatus.test.ts server/git.test.ts && npm run typecheck`
Expected: PASS. (There is no existing FileRow component test; the safety net is typecheck + manual review that `FileRow`'s body is a straight lift.)

- [ ] **Step 4: Commit**

```bash
git add src/components/GitFileRow.tsx src/components/GitPanel.tsx
git commit -m "refactor(git-panel): extract GitFileRow row shell"
```

---

### Task 4: Commit accordion + keyboard

**Files:**
- Modify: `src/components/GitPanel.tsx`
- Modify: `src/styles/git-panel.css`
- Test: `src/components/GitPanel.commit-diff.test.tsx` (new)

**Interfaces:**
- Consumes: `GitFileRow` (Task 3), `useCachedCommitFiles` / `useGitCommitDiffFile` / `gitCommitDiffFileQuery` (Task 2), `GitCommitResponse` / `GitRangeFile`.
- Produces:
  - Create: `src/components/GitCommitRows.tsx` — `CommitRow` (accordion row + body + file list) and `CommitFileRow` (a `GitFileRow` with no `actions`). Extracted rather than inlined so they are mountable in isolation.
  - `CommitRow` props: `{ cwd: string; hash: string; subject: string; author: string; date: number; body: string; expanded: boolean; onToggle: () => void; cache: Map<string, GitCommitResponse>; selectedPath: string | null; onSelectFile: (path: string) => void }`
  - `CommitFileRow` props: `{ cwd: string; hash: string; file: GitRangeFile; selected: boolean; onSelect: () => void }`
  - `isWriteKeyInert(kind: 'unstaged' | 'staged' | 'untracked' | 'commit-file'): boolean` — exported from `src/components/GitPanel.tsx`, used as the `s`/`u`/`x` guard in `handleKeyDown`

- [ ] **Step 1: Write the failing tests**

New file `src/components/GitCommitRows.test.tsx`, jsdom via `environmentMatchGlobs`, `render` + `screen` + `userEvent` from `@testing-library/react`, `vi.mock('../hooks/useApi')`. Mount `CommitRow` directly with a stubbed `api.get` that returns a fixture `GitCommitResponse` (do not mount `GitPanel` — it needs a session, status and write ops).

```ts
it('expands a commit to its file rows and expands a file to its diff', async () => {
  // api.get: /git/commit?… → fixture with one file 'a.txt'
  //          /git/commit-file?… → { path, staged: false, truncated: false, totalLines: 3, text: '@@ -1 +1 @@\n-alpha\n+beta\n', isBinary: false }
  render(<CommitRow cwd="/repo" hash={'a'.repeat(40)} subject="second" author="T" date={1} body=""
    expanded={false} onToggle={() => {}} cache={new Map()} selectedPath={null} onSelectFile={() => {}} />)
  await userEvent.click(screen.getByText('second'))
  expect(await screen.findByText('a.txt')).toBeInTheDocument()
  await userEvent.click(screen.getByText('a.txt'))
  expect(await screen.findByText('+beta')).toBeInTheDocument()
})

it('write keys do not fire on commit file rows', () => {
  expect(isWriteKeyInert('commit-file')).toBe(true)
  expect(isWriteKeyInert('unstaged')).toBe(false)
  expect(isWriteKeyInert('staged')).toBe(false)
  expect(isWriteKeyInert('untracked')).toBe(false)
})
```

Export `isWriteKeyInert(kind: 'unstaged' | 'staged' | 'untracked' | 'commit-file'): boolean`
from `GitPanel.tsx` (or a tiny `src/components/git-keyboard.ts`) and use it as the
`s`/`u`/`x` guard in `handleKeyDown`. The pure helper is the test surface — do not
mount `GitPanel` to test a one-line guard.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/GitCommitRows.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the accordion**

State lives in `GitPanel` (the keyboard owner), not in `CommitList`:

```ts
const [expandedCommit, setExpandedCommit] = useState<string | null>(null)   // one at a time
const commitFileCache = useRef(new Map<string, GitCommitResponse>())
```

`CommitList` receives `{ cwd, expandedCommit, onToggleCommit, commitFileCache, selectedIdx, onSelect }` (or whatever minimal prop set wires selection). Each commit row:

- collapsed: exactly today's markup (`git-commit` li, `git-commit-hash`, `git-commit-subject`, `git-commit-meta`) — clicking the row toggles
- expanded (`expandedCommit === c.hash`): `git-commit-body` (the `body` string, `white-space: pre-wrap`, clamped via `max-height` + overflow, small type; omitted when empty) followed by one `CommitFileRow` per `files[]` entry
- empty `files[]` → `git-panel-empty` "No file changes in this commit."
- file list comes from `useCachedCommitFiles(cwd, hash, expanded, commitFileCache)` — that is what makes collapse→re-expand free

`CommitFileRow` is a `GitFileRow` with **no `actions`**:

```tsx
function CommitFileRow({ cwd, hash, file, selected, onSelect, selectIndex }) {
  const [fetchStarted, setFetchStarted] = useState(false)
  const { data, loading, error } = useGitCommitDiffFile(cwd, hash, file.path, fetchStarted)
  const fetchFullText = useCallback((signal?: AbortSignal) =>
    api.get<GitDiff>(gitCommitDiffFileQuery(cwd, hash, file.path, { full: true }), { signal }).then((d) => d.text),
    [cwd, hash, file.path])
  return <GitFileRow status={file.status} path={file.path} renamedFrom={file.renamedFrom}
    insertions={file.insertions} deletions={file.deletions}
    selected={selected} onSelect={onSelect}
    fetchStarted={fetchStarted} onFetchStart={() => setFetchStarted(true)}
    diff={{ data, loading, error }} fetchFullText={fetchFullText} />
}
```

The expanded body unmounts on collapse (default `AnimatedCollapse`). The `Map` is what survives — do not pass `unmountOnExit={false}`; keeping collapsed bodies mounted would leave stale file rows in the keyboard's `selectable` list.

- [ ] **Step 4: Wire keyboard selection**

Extend `Selectable` in `GitPanel`:

```ts
type Selectable =
  | { kind: 'unstaged' | 'staged' | 'untracked'; file: GitFileEntry }
  | { kind: 'commit-file'; file: GitRangeFile; commitHash: string }
```

Append the open commit's `files[]` (from `commitFileCache.get(expandedCommit)`) to `selectable`. In `handleKeyDown`:

- `s` / `u` / `x`: early-return when `selected.kind === 'commit-file'` (inert — no stage, no discard confirm)
- `Enter`: unchanged — it clicks `.git-file-row.selected .git-file-row-toggle`, which `GitFileRow` already provides
- the footer hint becomes `↑↓ select · Enter expand` when `selected.kind === 'commit-file'`, and keeps the existing `↑↓ select · s stage · u unstage · x discard · Enter expand` otherwise

- [ ] **Step 5: CSS**

In `src/styles/git-panel.css`, style the commit accordion with existing theme variables and the existing `.git-file-row` / `.git-diff-row` contract:

- `.git-commit` row: clickable, hover affordance (reuse a `--btn-hover-bg`-class variable — no new hex)
- `.git-commit-body`: small, muted, `pre-wrap`, clamped
- indent the file rows under the expanded commit so the hierarchy reads (a left padding or border — pick what already exists in the file for nested rows)
- if a new color is genuinely needed, add it to **both** `:root` and `[data-theme="light"]`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/GitCommitRows.test.tsx && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/GitPanel.tsx src/components/GitCommitRows.tsx src/styles/git-panel.css src/components/GitCommitRows.test.tsx
git commit -m "feat(git-panel): expand commits to their file diffs"
```

---

### Task 5: Whole-feature review

**Files:** none new — review the branch.

- [ ] **Step 1: Run the full suite**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 2: Review the full diff**

Run: `git diff main...HEAD` (or `git diff HEAD` if uncommitted) and review it as a whole. Check the Review Focus list above. Fix anything confirmed; re-run the suite.

- [ ] **Step 3: Commit any fixes**

(Only if the review produced fixes.)
