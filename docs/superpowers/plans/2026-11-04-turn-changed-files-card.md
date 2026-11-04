# Turn Changed-Files Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every completed top-level turn, show a card listing the files that turn changed (path + added/deleted lines), with a hover diff preview and a click-through per-turn review panel, built on the existing shadow-repo snapshot sidecar.

**Architecture:** At send/consume time the existing `captureAnchorNow` records the turn-start tree. A new `canUseTool` wrapper copies the exact target of every `Edit`/`Write`/`NotebookEdit` call before the tool runs (fallback for gitignored paths). At `result`, `captureWithPrev` already captures the end tree; the service then runs one `name-status + numstat` tree diff, folds in the copied paths the snapshot does not cover, persists a `turns[]` record in the snapshot sidecar, and broadcasts a `turn-changes` frame on the existing per-session message-status channel. The client renders a memoized card inside the `result` row and opens a lazy review overlay on click.

**Tech Stack:** TypeScript, Hono, `@anthropic-ai/claude-agent-sdk`, `diff` (already a dependency), React 19, Vitest, happy-dom.

**Spec:** This plan implements the design agreed in the session of 2026-11-04 (dsh `workspace-changes` research + two scope decisions: include the whole-file capture fallback, and ship the full click-through review panel).

## Global Constraints

- All diagnostic logging goes through `createLogger(scope)`; never bare `console.*`. One logger per module.
- Never hardcode colors: use theme CSS variables; every new color is defined in both `:root` (dark) and `[data-theme="light"]`.
- Every git invocation goes through `runGit()` / the existing shadow-repo helpers; never a shell.
- `npm run typecheck` runs BOTH tsconfigs; both must pass.
- Tests: Vitest. Server tests are Node; `src/**` tests are happy-dom by default. Do not add per-file `afterEach(cleanup)`.
- No speculative fallbacks. A failure that the contract says cannot happen should throw or warn loudly, not silently degrade.
- Comments in source files are written in English, matching the surrounding files.
- Constants fixed by this plan: `TURN_CHANGES_MAX_FILES = 500`, `TURN_CHANGES_MAX_FILE_BYTES = 2 * 1024 * 1024`, diff context `3`, copy-comparison timeout `100ms`, turn-record cap `500`.
- Commit messages use conventional commits and end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **Gitignored file edited by `Edit`/`Write`** — must appear with counts from the before/after copies instead of vanishing (the git tree never stages it).
2. **Session cwd is a subdirectory of the repo; a tool edits a sibling path above cwd** — must appear with a `../` display path and a resolvable per-file diff.
3. **Slow first snapshot** (index seeding on a large repo) racing the first tool mutation — the `canUseTool` barrier must await the turn-start capture so pre-turn content is never attributed as changed.
4. **Two results in sequence (queued/steered turns)** — each summary binds to its own `resultUuid`; a stale turn state must never attach to the next turn.
5. **Dormant/terminated/restarted session** — the card and per-file diff still load from the sidecar with no live Query; deleting the session removes capture copies and turn records.
6. **Filenames with spaces, unicode, or newlines** — `-z` numstat/name-status parsing and the literal pathspec must keep the exact name through the summary and the diff route.

---

### Task 1: Shared turn-changes types and validators

**Files:**
- Create: `shared/turn-changes.ts`
- Test: `shared/turn-changes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TurnChangedFileStatus = 'added' | 'deleted' | 'modified'`
  - `interface TurnChangedFile { path: string; display: string; status: TurnChangedFileStatus; additions: number; deletions: number; binary?: true; oversized?: true }`
  - `interface TurnChangesSummary { resultUuid: string; assistantUuid: string; files: TurnChangedFile[]; total: number; added: number; deleted: number }`
  - `interface TurnChangesPayload { available: boolean; summary?: TurnChangesSummary }`
  - `interface TurnDiffPayload { available: boolean; patch?: string; truncated?: boolean; totalLines?: number; reason?: 'missing' | 'binary' | 'oversized' }`
  - `const TURN_CHANGES_MAX_FILES = 500`
  - `const TURN_CHANGES_MAX_FILE_BYTES = 2 * 1024 * 1024`
  - `function isTurnChangesSummary(value: unknown): value is TurnChangesSummary`
  - `interface WsTurnChanges { kind: 'turn-changes'; sessionId: string; summary: TurnChangesSummary }`
    (defined here so both the server broadcast in Task 7 and the union/re-export in Task 8 consume one definition)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { isTurnChangesSummary } from './turn-changes.js'

const summary = {
  resultUuid: 'r1', assistantUuid: 'a1', total: 1, added: 2, deleted: 1,
  files: [{ path: 'src/a.ts', display: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
}

describe('isTurnChangesSummary', () => {
  it('accepts a well-formed summary', () => {
    expect(isTurnChangesSummary(summary)).toBe(true)
  })
  it('rejects a bad status, negative/invalid counts, or missing ids', () => {
    expect(isTurnChangesSummary({ ...summary, files: [{ ...summary.files[0], status: 'changed' }] })).toBe(false)
    expect(isTurnChangesSummary({ ...summary, added: -1 })).toBe(false)
    expect(isTurnChangesSummary({ ...summary, resultUuid: '' })).toBe(false)
    expect(isTurnChangesSummary({ ...summary, files: 'nope' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/turn-changes.test.ts`
Expected: FAIL — cannot resolve `./turn-changes.js`.

- [ ] **Step 3: Implement `shared/turn-changes.ts`**

Use a `isRecord` guard; require non-empty strings for `path`, `display`, `resultUuid`, `assistantUuid`; `status` in the three-value set; `additions`/`deletions`/`total`/`added`/`deleted` safe integers `>= 0`; `binary`/`oversized` either absent or exactly `true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/turn-changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/turn-changes.ts shared/turn-changes.test.ts
git commit -m "feat(shared): add turn-changes wire types

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Whole-file capture store

**Files:**
- Create: `server/snapshot/capture.ts`
- Modify: `server/snapshot/paths.ts` (add `capturesDir`)
- Test: `server/snapshot/capture.test.ts`

**Interfaces:**
- Consumes: `node:crypto`, `node:fs/promises`.
- Produces:
  - `type FileCopy = { kind: 'absent' } | { kind: 'oversized' } | { kind: 'file'; file: string; binary: boolean }`
  - `function capturesDir(stateDir: string, sessionId: string): string`
  - `async function captureCopy(absPath: string, directory: string, maxBytes: number): Promise<FileCopy>`
    - Returns `{kind:'absent'}` for ENOENT.
    - Returns `{kind:'oversized'}` when the file is larger than `maxBytes` (read at most `maxBytes + 1`).
    - Otherwise writes the bytes to `<directory>/<sha1>` with `flag: 'wx'` (EEXIST tolerated) and reports `binary` when a NUL appears in the first 8000 bytes.
    - Throws for any other open/read/write error.
  - `function sameCopy(a: FileCopy, b: FileCopy): boolean`
  - `async function canonicalTargetPath(absPath: string): Promise<string>`
    - `realpath` the path when it exists; when it does not (a `Write`-created file), `realpath` the parent and rejoin the basename; return the resolved path otherwise.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureCopy, canonicalTargetPath, sameCopy } from './capture.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crw-capture-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('captureCopy', () => {
  it('stores identical content once and reports binary', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello\n')
    const a = await captureCopy(file, join(dir, 'store'), 1024)
    const b = await captureCopy(file, join(dir, 'store'), 1024)
    expect(a.kind).toBe('file')
    expect(sameCopy(a, b)).toBe(true)
    const bin = join(dir, 'b.bin')
    await writeFile(bin, Buffer.from([0x00, 0x01]))
    expect(await captureCopy(bin, join(dir, 'store'), 1024)).toMatchObject({ kind: 'file', binary: true })
  })
  it('reports absent and oversized', async () => {
    expect(await captureCopy(join(dir, 'missing'), join(dir, 'store'), 1024)).toEqual({ kind: 'absent' })
    const big = join(dir, 'big')
    await writeFile(big, 'x'.repeat(2048))
    expect(await captureCopy(big, join(dir, 'store'), 1024)).toEqual({ kind: 'oversized' })
  })
  it('canonicalizes a not-yet-created path through its parent', async () => {
    const target = join(dir, 'new-file.txt')
    expect(await canonicalTargetPath(target)).toBe(target)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot/capture.test.ts`
Expected: FAIL — `./capture.js` does not exist.

- [ ] **Step 3: Implement `server/snapshot/capture.ts` and extend `paths.ts`**

`capturesDir(stateDir, sessionId) => join(snapshotRoot(stateDir), 'captures', sessionId)`.

Port the read loop from `packages/deliverables/workspace-changes/src/capture.ts` logic (read up to `maxBytes + 1`, sha1-name the copy, `wx` write). Do not cap reads with a `stat` only — read bytes so a growing file cannot exceed the cap in memory.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/capture.ts server/snapshot/capture.test.ts server/snapshot/paths.ts
git commit -m "feat(snapshot): add content-addressed file captures

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Copy comparison (counts + unified patch)

**Files:**
- Create: `server/snapshot/copy-diff.ts`
- Test: `server/snapshot/copy-diff.test.ts`

**Interfaces:**
- Consumes: `FileCopy` from Task 2; `structuredPatch` from `diff`; `MAX_DIFF_LINES` from `server/constants.ts`.
- Produces:
  - `interface CopyComparison { added: number; deleted: number; binary: boolean; oversized: boolean; patch?: string; truncated: boolean; totalLines: number }`
  - `async function compareCopies(before: FileCopy, after: FileCopy, display: string, maxBytes: number, timeoutMs = 100): Promise<CopyComparison>`

Behavior:
- Both `absent` → `{ added: 0, deleted: 0, binary: false, oversized: false, truncated: false, totalLines: 0 }` (caller treats as unchanged).
- Either `oversized` → `oversized: true`, counts `0`, no patch.
- Either `binary` → `binary: true`, counts `0`, no patch.
- One side absent → counts = line count of the other side (0 additions/deletions on the absent side), patch built from `''` for the absent side.
- Two text sides → `structuredPatch('', '', beforeText, afterText, undefined, undefined, { context: 3, timeout: timeoutMs })`; when it returns `undefined` (timeout), emit one coarse hunk replacing every line and set `truncated` only if the clip below drops lines.
- Patch header format: `--- a/<display>\n+++ b/<display>\n` then the hunks.
- Clip at `MAX_DIFF_LINES`: `patch` keeps the first `MAX_DIFF_LINES` lines; `totalLines` is the UNCLIPPED line count; `truncated = kept < totalLines`.
- A missing final newline must compare as unchanged (terminate both texts with `\n` before diffing; empty text is zero lines).

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureCopy } from './capture.js'
import { compareCopies } from './copy-diff.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crw-copydiff-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const copyOf = async (name: string, text: string | null) => {
  if (text === null) return { kind: 'absent' } as const
  const p = join(dir, name)
  await writeFile(p, text)
  return captureCopy(p, join(dir, 'store'), 4096)
}

describe('compareCopies', () => {
  it('counts an added line and emits a git-style patch', async () => {
    const before = await copyOf('before', 'start\n')
    const after = await copyOf('after', 'start\ndone\n')
    const r = await compareCopies(before, after, 'notes.txt', 4096)
    expect(r).toMatchObject({ added: 1, deleted: 0, binary: false, oversized: false })
    expect(r.patch).toContain('+++ b/notes.txt')
    expect(r.patch).toContain('+done')
  })
  it('treats a missing final newline as unchanged', async () => {
    const before = await copyOf('b', 'same')
    const after = await copyOf('a', 'same\n')
    expect(await compareCopies(before, after, 'x', 4096)).toMatchObject({ added: 0, deleted: 0 })
  })
  it('handles a created file and a binary side', async () => {
    const created = await compareCopies({ kind: 'absent' }, await copyOf('new', 'a\nb\n'), 'new.txt', 4096)
    expect(created).toMatchObject({ added: 2, deleted: 0 })
    const bin = await copyOf('bin', 'x')
    expect(await compareCopies({ kind: 'file', file: bin.file, binary: true }, await copyOf('bin2', 'y'), 'b.bin', 4096))
      .toMatchObject({ binary: true, additions: undefined })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot/copy-diff.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `server/snapshot/copy-diff.ts`**

Read `FileCopy.file` paths as UTF-8. Keep the line-count helper local. Build the patch by formatting `structuredPatch`'s `hunks` as `@@ -oldStart,oldLines +newStart,newLines @@` followed by `hunk.lines`. Clip with the same `split('\n')` yardstick as `DiffView`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot/copy-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/copy-diff.ts server/snapshot/copy-diff.test.ts
git commit -m "feat(snapshot): compare captured file copies

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Turn records in the snapshot sidecar

**Files:**
- Modify: `server/snapshot/snapshot-store.ts`
- Test: `server/snapshot/snapshot-store.test.ts`

**Interfaces:**
- Consumes: `TurnChangedFileStatus` from `shared/turn-changes.ts`.
- Produces (exported from `snapshot-store.ts`):

```ts
export interface TurnChangesFileRecord {
  path: string
  display: string
  status: TurnChangedFileStatus
  additions: number
  deletions: number
  binary?: true
  oversized?: true
  /** How the on-demand diff is produced. */
  source:
    | { kind: 'tree'; repoPath: string }
    | { kind: 'copy'; before: string | null; after: string | null }
}

export interface TurnChangesRecord {
  resultUuid: string
  assistantUuid: string
  start: string
  end: string
  at: number
  files: TurnChangesFileRecord[]
  total: number
  added: number
  deleted: number
}
```

- `SessionSnapshotMeta` gains `turns?: TurnChangesRecord[]`.
- Loader: a missing `turns` is accepted as `[]`; a present non-array makes `load()` return null.
- `capAnchors`: cap `turns` to the newest `MAX_ANCHORS` entries.
- `copyForFork`: keep `turns` whose `assistantUuid` is in `keepPatchMessageIds`; also `cp` `capturesDir(fromId)` to `capturesDir(toId)` alongside the odb copy (ENOENT tolerated; a non-ENOENT failure clears `turns` like the odb failure path).
- New `update` callers pass `turns: []` in both fresh-meta sites in `snapshot-service.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
it('round-trips turns and tolerates meta without them', async () => {
  const store = new SnapshotStore(dir)
  await store.save('s1', { version: 1, gitDir: 'g', worktree: 'w', scope: '.', byMessage: {}, patches: [], last: { tree: 't', at: 1 } })
  expect((await store.load('s1'))?.turns ?? []).toEqual([])

  const turn: TurnChangesRecord = {
    resultUuid: 'r1', assistantUuid: 'a1', start: 't0', end: 't1', at: 2, total: 1, added: 1, deleted: 0,
    files: [{ path: 'a.ts', display: 'a.ts', status: 'added', additions: 1, deletions: 0, source: { kind: 'tree', repoPath: 'a.ts' } }],
  }
  await store.update('s1', (prev) => prev && { ...prev, turns: [turn] })
  expect((await store.load('s1'))?.turns?.[0]?.resultUuid).toBe('r1')
})

it('rejects a non-array turns field', async () => {
  await writeFile(metaFile(dir, 's2'), JSON.stringify({ version: 1, gitDir: 'g', worktree: 'w', scope: '.', byMessage: {}, patches: [], turns: 'bad' }))
  expect(await store.load('s2')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot/snapshot-store.test.ts`
Expected: FAIL — `turns` is not tolerated/returned.

- [ ] **Step 3: Implement the schema change**

Update the `SessionSnapshotMeta` interface, the `load()` validation, `capAnchors`, and `copyForFork`. Do not touch `patches` semantics (rewind clears them; `turns` must survive rewind).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot/snapshot-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/snapshot-store.ts server/snapshot/snapshot-store.test.ts
git commit -m "feat(snapshot): persist per-turn change records

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Tree diff and per-file patch helpers

**Files:**
- Modify: `server/snapshot/shadow-git.ts`
- Test: `server/snapshot/shadow-git.test.ts`

**Interfaces:**
- Consumes: existing `ShadowRepo`, `run()`.
- Produces:

```ts
export interface TreeDiffEntry {
  path: string            // repo-root-relative, posix
  status: 'added' | 'deleted' | 'modified'
  additions: number
  deletions: number
  binary: boolean
}

export async function treeDiff(repo: ShadowRepo, from: string, to: string): Promise<TreeDiffEntry[]>

/** Clip to MAX_DIFF_LINES; totalLines is the unclipped line count. */
export async function filePatch(
  repo: ShadowRepo, from: string, to: string, repoPath: string, full?: boolean,
): Promise<{ patch: string; truncated: boolean; totalLines: number }>
```

- `treeDiff` runs exactly two bulk spawns: `git diff --name-status -z --no-renames <from> <to> --` and `git diff --numstat -z --no-renames <from> <to> --`. Return `[]` when `from === to`.
- Binary entries are those whose numstat fields are `-`; counts become 0.
- `filePatch` runs `git diff --unified=3 --no-renames <from> <to> -- :(top,literal)<repoPath>`; `full: true` skips clipping.
- Export the existing private `parseNameStatusZ` (or add a small exported parser) so the new function can share it.

- [ ] **Step 1: Write the failing test**

Seed a temp git worktree (the existing test file already has helpers), commit `a.txt`, then write `a.txt`, create `b.txt`, and compare the two `captureTree` results:

```ts
const entries = await treeDiff(repo, before, after)
expect(entries.map((e) => [e.path, e.status])).toEqual([
  ['a.txt', 'modified'],
  ['b.txt', 'added'],
])
expect(entries.find((e) => e.path === 'b.txt')).toMatchObject({ additions: 1, deletions: 0, binary: false })

const patch = await filePatch(repo, before, after, 'a.txt')
expect(patch.patch).toContain('@@')
expect(patch.truncated).toBe(false)
```

Add a binary test: write a NUL byte file and assert `binary: true, additions: 0`.
Add a filename test: create `a b.txt` (space) and `ü.txt`, capture two trees, and assert both appear with their exact names in `treeDiff` and `filePatch` resolves — this pins the `-z` parsing and the `:(top,literal)` pathspec.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot/shadow-git.test.ts`
Expected: FAIL — `treeDiff` is not exported.

- [ ] **Step 3: Implement both helpers**

Place them next to `nameOnlyDiff` / `structuredDiff`. Reuse `MAX_DIFF_LINES`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot/shadow-git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/shadow-git.ts server/snapshot/shadow-git.test.ts
git commit -m "feat(snapshot): tree numstat diff and per-file patch

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: SnapshotService — record, read, and diff a turn

**Files:**
- Modify: `server/snapshot/snapshot-service.ts`
- Test: `server/snapshot/snapshot-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:

```ts
export interface SnapshotServiceOptions {
  // …existing fields…
  /** Inclusive byte cap for a captured copy and for reading a copy back. Default: TURN_CHANGES_MAX_FILE_BYTES. */
  maxTurnFileBytes?: number
}

export interface TurnRecordInput {
  sessionId: string
  cwd: string
  resultUuid: string
  assistantUuid: string
  /** Turn-start tree from the send-time anchor; null falls back to `meta.last.tree`. */
  startTree: string | null
  /** Before-copies captured around file-tool calls in this turn, keyed by canonical absolute path. */
  captures: ReadonlyMap<string, FileCopy>
}

async recordTurn(input: TurnRecordInput): Promise<TurnChangesSummary | null>
async turnChanges(sessionId: string, resultUuid: string): Promise<TurnChangesSummary | undefined>
async turnDiff(sessionId: string, resultUuid: string, index: number, opts?: { full?: boolean }): Promise<TurnDiffPayload>
```

Also:
- `captureToolTarget(sessionId: string, absPath: string): Promise<FileCopy>` — writes into `capturesDir(stateDir, sessionId)`.
- `delete(sessionId)` additionally removes `capturesDir`.
- `captureWithPrev` / `capture` fresh-meta branches add `turns: []`.

`recordTurn` algorithm (inside the existing per-session lock):
1. `captureWithPrev` → `{ tree: end, prev }`; `start = input.startTree ?? prev`. If either is missing, return null.
2. `treeDiff(repo, start, end)` → entries. Build `changed = new Set(entries.map(e => e.path))`.
3. For each `[absPath, before]` in `input.captures`:
   - `repoPath = toPosix(relative(worktree, absPath))` (on Windows compare case-insensitively when deciding coverage).
   - If `repoPath` does not start with `../` and `changed` has it (exactly or case-insensitively), skip — the tree covers it.
   - Skip any path inside `capturesDir` (our own store).
   - `after = await captureCopy(absPath, capturesDir, maxBytes)`; `if (sameCopy(before, after)) continue`.
   - `comparison = await compareCopies(before, after, display, maxBytes)`.
   - push a file record with `source: { kind: 'copy', before: before.kind === 'file' ? before.file : null, after: after.kind === 'file' ? after.file : null }`, status from absence (`before absent → added`, `after absent → deleted`, else modified).
4. Map tree entries to records with `source: { kind: 'tree', repoPath: entry.path }`.
5. `path = durablePathOf(absPath, cwd)` equivalent: `toPosix(relative(cwd, abs))` when inside cwd, else absolute. `display` = posix relative from cwd when the path is inside the worktree (may start with `../`), else the absolute path.
6. Sort by `display` (code-unit), cap `TURN_CHANGES_MAX_FILES`; totals sum over ALL sorted entries; persist `turns` (replace by `resultUuid`, cap 500, `at: Date.now()`); return the summary.

`turnChanges` returns the wire summary (strip `source`).
`turnDiff`:
- `binary`/`oversized` record → `{ available: true, reason }`.
- `source.kind === 'tree'` → `filePatch(repo, start, end, repoPath, full)`; `available: true`.
- `source.kind === 'copy'` → rebuild `FileCopy`s (`{kind:'absent'}` when the stored path is null, else `{kind:'file', file, binary:false}` — re-detect binary by reading the first 8000 bytes) and call `compareCopies`; if `binary`/`oversized`, return the reason; else return its patch fields.
- Unknown result/index → `{ available: false }`.

- [ ] **Step 1: Write the failing test**

Extend the existing temp-repo test setup (commit `a.txt`, write `.gitignore` = `*.local`, write the ignored file `notes.local` = `start\n`):

```ts
it('records tree changes and captured ignored files in one summary', async () => {
  const wt = await seedRepo()
  const start = await svc.capture({ sessionId: 's', cwd: wt })
  const before = await svc.captureToolTarget('s', join(wt, 'notes.local'))
  await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(wt, 'notes.local'), 'start\ndone\n')
  const summary = await svc.recordTurn({
    sessionId: 's', cwd: wt, resultUuid: 'r', assistantUuid: 'a', startTree: start,
    captures: new Map([[join(wt, 'notes.local'), before]]),
  })
  expect(summary?.files.map((f) => [f.display, f.status, f.additions])).toEqual([
    ['a.txt', 'modified', 1],
    ['notes.local', 'modified', 1],
  ])
  expect(summary?.total).toBe(2)
  expect((await svc.turnDiff('s', 'r', 1)).patch).toContain('+done')
})

it('lists a captured path above the session cwd as ../<path>', async () => {
  const repo = await seedRepo()          // a.txt at the repo root
  await mkdir(join(repo, 'sub'))
  const svc = new SnapshotService({ stateDir: dir })
  const start = await svc.capture({ sessionId: 's2', cwd: join(repo, 'sub') })
  const before = await svc.captureToolTarget('s2', join(repo, 'a.txt'))
  await writeFile(join(repo, 'a.txt'), 'changed\n')
  const summary = await svc.recordTurn({
    sessionId: 's2', cwd: join(repo, 'sub'), resultUuid: 'r2', assistantUuid: 'a2',
    startTree: start, captures: new Map([[join(repo, 'a.txt'), before]]),
  })
  expect(summary?.files[0]?.display).toBe('../a.txt')
  expect((await svc.turnDiff('s2', 'r2', 0)).patch).toContain('+changed')
})

it('returns null for a no-change turn', async () => {
  const start = await svc.capture({ sessionId: 'n', cwd: wt })
  expect(await svc.recordTurn({
    sessionId: 'n', cwd: wt, resultUuid: 'rn', assistantUuid: 'an', startTree: start, captures: new Map(),
  })).toBeNull()
})

it('survives a restart and replaces by resultUuid', async () => {
  // `wt`/`start`/the first record come from the shared beforeEach + first test setup.
  const fresh = new SnapshotService({ stateDir: dir })   // restart simulation
  expect((await fresh.turnChanges('s', 'r'))?.resultUuid).toBe('r')
  await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n')
  await svc.recordTurn({ sessionId: 's', cwd: wt, resultUuid: 'r', assistantUuid: 'a', startTree: start, captures: new Map() })
  expect((await fresh.turnChanges('s', 'r'))?.files).toHaveLength(1) // replaced, not duplicated
  expect((await fresh.turnChanges('s', 'r'))?.files[0]?.additions).toBe(2)
})

it('removes capture copies on delete but keeps turns on rewind', async () => {
  // Seed a rewindable anchor + a later paste-since edit, then run a REAL rewind:
  // rewind clears `patches` (rewind safety) but must leave `turns` intact.
  await svc.recordAnchor('s', wt, 'u1', start)
  await svc.rewind('s', 'u1')
  expect((await svc.turnChanges('s', 'r'))?.resultUuid).toBe('r')

  await svc.delete('s')
  expect(await readdir(capturesDir(dir, 's')).catch(() => null)).toBeNull()
})
```

Make `wt` and `start` module-scoped variables assigned in `beforeEach` so the second/third tests can reuse them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot/snapshot-service.test.ts`
Expected: FAIL — `recordTurn`/`turnChanges`/`turnDiff`/`captureToolTarget` are missing.

- [ ] **Step 3: Implement**

Keep all git work under the existing `lock()`. Import `homedir`/`tmpdir` only if needed for exclusions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot/snapshot-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/snapshot-service.ts server/snapshot/snapshot-service.test.ts
git commit -m "feat(snapshot): record and serve per-turn file changes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: SessionManager — turn state, pre-tool capture barrier, broadcast

**Files:**
- Create: `server/snapshot/tool-targets.ts` (pure path extraction)
- Modify: `server/session-types.ts` (`Session.turnSnapshot`)
- Modify: `server/session-manager.ts` (`captureAnchorNow`, canUseTool wrapper, `recordTurnSnapshot`, broadcast)
- Modify: `server/providers/types.ts` only if the canUseTool wrapper type needs exporting (prefer not)
- Test: `server/snapshot/tool-targets.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Produces:

```ts
// server/snapshot/tool-targets.ts
/** Absolute-or-relative targets named by a mutating file tool; [] for every other tool. */
export function toolTargetPaths(toolName: string, toolInput: unknown, cwd: string): string[]

// server/session-types.ts
export interface SessionTurnSnapshot {
  messageId: string
  startTree: string | null
  anchorReady: Promise<void>
  captures: Map<string, FileCopy>
}
// Session gains: turnSnapshot?: SessionTurnSnapshot
```

- `captureAnchorNow(id, s, userUuid)` builds `s.turnSnapshot` BEFORE starting the async work, assigns `anchorReady` to the async IIFE, and sets `startTree` when the capture resolves.
- The canUseTool wrapper (in `spawn`, around `permBroker.buildCanUseTool`):
  1. `await state.anchorReady.catch(() => undefined)` when `state` exists.
  2. For each `toolTargetPaths(toolName, toolInput, s.cwd)` not already in `state.captures`, `await this.snapshots.captureToolTarget(s.id, absPath)` and store it.
  3. Return `broker(toolName, toolInput, ctx)`.
  4. Capture errors are logged (`log.warn`) and never block the tool.
- `recordTurnSnapshot(sessionId, resultUuid, assistantUuid)`:
  - capture the current `state = s.turnSnapshot`.
  - `const summary = await this.snapshots.recordTurn({ ..., startTree: state?.startTree ?? null, captures: state?.captures ?? new Map() })`
  - if `summary` and `s.turnSnapshot === state`, clear `s.turnSnapshot`; broadcast `{ kind: 'turn-changes', sessionId, summary }` through `pushMessageStatus`.
- `pushMessageStatus`'s parameter union gains `WsTurnChanges` (imported from `shared/turn-changes.ts`).
- `recordTurnSnapshot` dep signature becomes `(sessionId: string, resultUuid: string, assistantUuid: string) => void`; update the pump call at `server/session-pump.ts:1705` to pass `resultUuid` captured at line 1649 (declare `resultUuid` outside the `if (!emptyResult)` block so it is in scope).
- Keep the `recordTurnSnapshot` call BEFORE `onTurnSettling` at `session-pump.ts:1711`. The SDK emits `result` before it calls `iter.next()` for the next turn, so the end-tree capture starts before the next turn can issue its first tool call; moving the call after `onTurnSettling` would let a queued next turn mutate before the end snapshot.
- When `captureAnchorNow` is NOT called for a turn (e.g. a resumed session receiving a CLI-driven turn), `turnSnapshot` is absent and `recordTurn` falls back to `meta.last.tree`; the card still works.

- [ ] **Step 1: Write the failing tests**

`tool-targets.test.ts`:

```ts
expect(toolTargetPaths('Edit', { file_path: 'a.ts' }, 'D:/w')).toEqual(['D:/w/a.ts'])
expect(toolTargetPaths('Write', { file_path: 'D:/w/sub/a.ts' }, 'D:/w')).toEqual(['D:/w/sub/a.ts'])
expect(toolTargetPaths('NotebookEdit', { notebook_path: 'n.ipynb' }, 'D:/w')).toEqual(['D:/w/n.ipynb'])
expect(toolTargetPaths('Read', { file_path: 'a.ts' }, 'D:/w')).toEqual([])
expect(toolTargetPaths('Edit', {}, 'D:/w')).toEqual([])
```

`session-manager.test.ts` — two behavioral tests:
1. **Barrier:** mock `snapshots.capture` with a deferred promise; call `captureAnchorNow`; invoke the registered canUseTool for `Edit`; assert it has not resolved until the deferred capture resolves, then assert `captureToolTarget` was called with the resolved absolute path and the broker ran.
2. **Turn binding:** two consecutive `recordTurnSnapshot('s','r1','a1')` / `('s','r2','a2')` calls record two distinct `resultUuid`s and each uses the start tree belonging to its own `turnSnapshot`; a stale state from turn 1 is never passed to turn 2.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/snapshot/tool-targets.test.ts server/session-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Read the existing `captureAnchorNow` before editing; preserve `raceWithFallback` and the deferred-anchor logic. The wrapper must be installed on `session.canUseTool` so resume/fork reuse it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/snapshot/tool-targets.test.ts server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/tool-targets.ts server/snapshot/tool-targets.test.ts server/session-types.ts server/session-manager.ts server/session-pump.ts server/session-manager.test.ts
git commit -m "feat(session): capture tool targets and record turn changes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Wire the frame and REST routes

**Files:**
- Modify: `shared/ws-protocol.ts` (add `WsTurnChanges`, add to `WsServerFrame`)
- Modify: `server/ws-protocol.ts` (import the new frame type)
- Modify: `src/ws-types.ts` (re-export)
- Modify: `server/routes/sessions.ts` (`GET /sessions/:id/turn-changes`, `GET /sessions/:id/turn-diff`)
- Modify: `server/session-manager.ts` (`turnChanges`, `turnDiff` methods)
- Test: `server/routes/index.test.ts` or a new `server/routes/turn-changes.test.ts` following the existing route-test setup

**Interfaces:**
- Consumes: `WsTurnChanges` from `shared/turn-changes.ts` (defined in Task 1).
- Produces: the frame is now part of `WsServerFrame`, and the two routes below.

Routes:
- `GET /sessions/:id/turn-changes?resultUuid=<uuid>` → `TurnChangesPayload`. 400 without `resultUuid`; 404 unknown session; `{ available: false }` for a missing record. No live Query required.
- `GET /sessions/:id/turn-diff?resultUuid=<uuid>&index=<n>&full=1?` → `TurnDiffPayload`. 400 for a missing `resultUuid` or a non-integer/negative `index`; 404 unknown session; `{ available: false }` when unknown.

- [ ] **Step 1: Write the failing test**

Follow the existing route test pattern (build the router with a stub `sm`):

```ts
const ok = await app.request('/sessions/s1/turn-changes?resultUuid=r1')
expect(ok.status).toBe(200)
expect(await ok.json()).toMatchObject({ available: true, summary: { resultUuid: 'r1' } })

expect((await app.request('/sessions/s1/turn-changes')).status).toBe(400)
expect((await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=-1')).status).toBe(400)

const missing = await app.request('/sessions/s1/turn-diff?resultUuid=missing&index=0')
expect(missing.status).toBe(200)
expect(await missing.json()).toEqual({ available: false })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/turn-changes.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement**

Add the type to the `WsServerFrame` union (no new generic parameter; the summary is a concrete shared type). In `src/ws-types.ts`, re-export it from `../shared/ws-protocol.js`. In `server/ws-protocol.ts`, verify the alias still compiles.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/routes/turn-changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-protocol.ts src/ws-types.ts server/routes/sessions.ts server/session-manager.ts server/routes/turn-changes.test.ts
git commit -m "feat(api): serve turn changes and their diffs

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: Client data hooks

**Files:**
- Create: `src/hooks/useTurnChanges.ts`
- Test: `src/hooks/useTurnChanges.test.tsx`

**Interfaces:**
- Consumes: `api` (`src/hooks/useApi.ts`), `useWsHub`, `TurnChangesSummary`/`TurnDiffPayload` from `shared/turn-changes.ts`.
- Produces:

```ts
export interface TurnChangesView {
  summary: TurnChangesSummary | null
  loading: boolean
}
export function useTurnChanges(sessionId: string | undefined, resultUuid: string | undefined): TurnChangesView

export interface TurnDiffView {
  diff: TurnDiffPayload | null
  loading: boolean
}
export function useTurnDiff(
  sessionId: string | undefined,
  resultUuid: string | undefined,
  index: number | null,
  opts?: { full?: boolean },
): TurnDiffView
```

Behavior:
- Module-level `Map<string, TurnChangesSummary | 'missing'>` and a `Map<string, Promise<...>>` in-flight dedupe, keyed `` `${sessionId}:${resultUuid}` ``.
- On mount: return the cache hit immediately; otherwise GET `/sessions/:id/turn-changes?resultUuid=...` and write the cache (both the summary and `available:false` → `'missing'`). Abort on unmount.
- Subscribe with `hub.subscribe(sessionId)` + `hub.addSessionListener(sessionId, ...)`; on a `turn-changes` frame whose `summary.resultUuid` matches, write the cache and update.
- `useTurnDiff` fetches `/turn-diff?...` (append `&full=1` when `opts.full`), aborts on key change/unmount, and caches nothing (hover previews are cheap; a per-session Map is optional).
- Never throws; a non-OK response yields `null`.

- [ ] **Step 1: Write the failing tests**

Use `renderHook` with a mocked `useApi` module and a fake hub:

```ts
it('loads a summary once and applies a matching live frame', async () => {
  api.get.mockResolvedValue({ available: true, summary: SUMMARY })
  const { result } = renderHook(() => useTurnChanges('s1', 'r1'))
  await waitFor(() => expect(result.current.summary?.resultUuid).toBe('r1'))
  expect(api.get).toHaveBeenCalledTimes(1)

  act(() => listener({ kind: 'turn-changes', sessionId: 's1', summary: { ...SUMMARY, total: 2 } }))
  expect(result.current.summary?.total).toBe(2)
})

it('treats an unavailable response as missing and does not render', async () => {
  api.get.mockResolvedValue({ available: false })
  const { result } = renderHook(() => useTurnChanges('s1', 'r2'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.summary).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/useTurnChanges.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Use `useState` + `useEffect`, an `AbortController`, and a ref for the live frame handler (same pattern as `useGitStatus`'s `useGitSnapshotListener`). Clear the module cache on session switch? No — the key includes the session id.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useTurnChanges.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTurnChanges.ts src/hooks/useTurnChanges.test.tsx
git commit -m "feat(client): load and subscribe to turn changes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: Card, context, and the result-row mount

**Files:**
- Create: `src/components/message-list/turn-changes-context.ts`
- Create: `src/components/message-list/TurnChangesCard.tsx`
- Modify: `src/components/message-list/MessageView.tsx` (result branch)
- Modify: `src/components/MessageList.tsx` (provide the context; `openTurnReview` prop)
- Modify: `src/components/Chat.tsx` (own `turnReview` state, pass the opener down)
- Modify: `src/styles/index.css` (+ import)
- Create: `src/styles/turn-changes.css`
- Test: `src/components/message-list/TurnChangesCard.test.tsx`

**Interfaces:**
- Produces:

```ts
// turn-changes-context.ts
export interface TurnChangesContextValue {
  openTurnReview: (resultUuid: string, index: number) => void
}
export const TurnChangesProvider: FC<{ value: TurnChangesContextValue; children: ReactNode }>
export function useTurnChangesContext(): TurnChangesContextValue
// default: { openTurnReview: () => {} }

// TurnChangesCard.tsx
export function TurnChangesCard(
  { sessionId, resultUuid }: { sessionId?: string; resultUuid: string },
): ReactNode
```

Card behavior:
- `useTurnChanges(sessionId, resultUuid)`; render `null` while loading, when missing, or when `summary.total === 0`.
- Header: a tile + `Edited N files` + aggregate `+X −Y` (colored via theme vars). Clicking opens index 0.
- Rows: up to 4; each row shows `display` + per-file counts (`binary`/`oversized` labels instead of counts). More than 4 rows adds a toggle showing all.
- Single-file turns render the header only (no list).
- Hover: after a 400ms timer, mount a `TurnFilePreview` (calls `useTurnDiff(..., index)`) inside `AnchoredPopover placement="above"`; cancel on leave/unmount. The preview renders `<DiffView text={patch} truncated totalLines />` or a short `binary`/`oversized` note.
- Row/header are real `<button>`s with `aria-label`.

- [ ] **Step 1: Write the failing tests**

Mock `useTurnChanges` / `useTurnDiff` (or the `api` module) and assert:

```tsx
it('renders nothing when the turn changed no files', () => {
  mockSummary(null)
  const { container } = render(<TurnChangesCard resultUuid="r1" />)
  expect(container.firstChild).toBeNull()
})

it('lists the files, folds past four, and opens the clicked index', async () => {
  mockSummary({ ...SUMMARY, total: 6, files: sixFiles })
  const open = vi.fn()
  render(<TurnChangesProvider value={{ openTurnReview: open }}><TurnChangesCard resultUuid="r1" /></TurnChangesProvider>)
  expect(screen.getByText('Edited 6 files')).toBeTruthy()
  expect(screen.getAllByRole('listitem')).toHaveLength(4)
  await userEvent.click(screen.getByRole('button', { name: /View changes to src\/b\.ts/i }))
  expect(open).toHaveBeenCalledWith('r1', 1)
  await userEvent.click(screen.getByRole('button', { name: /Show all 6/i }))
  expect(screen.getAllByRole('listitem')).toHaveLength(6)
})
```

Also: a binary row renders the binary label; a single-file turn renders no list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/message-list/TurnChangesCard.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement**

In `MessageView`'s `type === 'result'` branch, after the existing footer markup, render `<TurnChangesCard sessionId={sessionId} resultUuid={String(msg.uuid)} />`. `MessageView` already has `sessionId` as an optional prop; the card renders null when it is absent.

Wire `Chat` → `MessageList` → provider:
- `Chat` adds `const [turnReview, setTurnReview] = useState<{ resultUuid: string; index: number } | null>(null)`.
- Pass `onOpenTurnReview={(resultUuid, index) => setTurnReview({ resultUuid, index })}` into `MessageList`; `MessageList` renders `<TurnChangesProvider value={{ openTurnReview }}>` around the Virtuoso list. Keep the provider value identity stable with `useMemo`.

CSS: `.turn-changes-card`, `.turn-changes-row`, `.turn-changes-counts-added`, `.turn-changes-counts-deleted`, `.turn-changes-tile`; all colors via `var(--…)`. Add both themes' tokens to `src/styles/tokens.css` if a needed token does not exist. Import the file from `src/styles/index.css`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/message-list/TurnChangesCard.test.tsx src/components/MessageList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/message-list/TurnChangesCard.tsx src/components/message-list/turn-changes-context.ts src/components/message-list/MessageView.tsx src/components/MessageList.tsx src/components/Chat.tsx src/styles/turn-changes.css src/styles/index.css src/components/message-list/TurnChangesCard.test.tsx
git commit -m "feat(client): render the turn changed-files card

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: Turn review panel

**Files:**
- Create: `src/components/TurnChangesPanel.tsx`
- Modify: `src/components/Chat.tsx` (lazy import + `Overlay` mount)
- Modify: `src/styles/turn-changes.css`
- Test: `src/components/TurnChangesPanel.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface TurnChangesPanelProps {
  sessionId: string
  resultUuid: string
  initialIndex: number
  onClose: () => void
}
export function TurnChangesPanel(props: TurnChangesPanelProps): ReactNode
```

Behavior:
- Header: `Turn changes` + total files/counts + close button.
- Left: the file list from `useTurnChanges`; the selected index is local state seeded from `initialIndex`; clicking a row selects it.
- Right: `<DiffView text={diff.patch ?? ''} truncated={diff.truncated ?? false} totalLines={diff.totalLines ?? 0} onShowFull={...} />`.
- `onShowFull` opens the existing `FullDiffViewer` with props `{ open, onClose, name: display, fetchText: async () => (await api.get<TurnDiffPayload>(`/sessions/${sessionId}/turn-diff?...&full=1`)).patch ?? '' }` (the same pattern `GitFileRow` uses).
- `binary` / `oversized` / missing → a short note instead of a diff body.
- While loading, render a fixed-height placeholder so the overlay does not jump.

Chat mount (next to the Git overlay, same chrome):

```tsx
<Overlay variant="git" ariaLabel="Turn changes" open={turnReview !== null}
  onClose={() => setTurnReview(null)} renderCard={false}
  trapRefTarget="backdrop" focusEscapeSelector=".chat-panel">
  <Suspense fallback={null}>
    <ErrorBoundary resetKey={session.id}>
      {turnReview && (
        <TurnChangesPanel key={`${turnReview.resultUuid}:${turnReview.index}`}
          sessionId={session.id} resultUuid={turnReview.resultUuid}
          initialIndex={turnReview.index} onClose={() => setTurnReview(null)} />
      )}
    </ErrorBoundary>
  </Suspense>
</Overlay>
```

Add `const TurnChangesPanel = lazy(() => import('./TurnChangesPanel').then((m) => ({ default: m.TurnChangesPanel })))` beside the GitPanel lazy import.

- [ ] **Step 1: Write the failing test**

```tsx
it('selects the clicked file and renders its diff', async () => {
  mockSummary({ files: [fileA, fileB], total: 2 })
  mockDiff({ available: true, patch: '@@ -1 +1 @@\n-old\n+new\n', truncated: false, totalLines: 3 })
  render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={1} onClose={vi.fn()} />)
  await screen.findByText('src/b.ts')
  expect(await screen.findByText('+new')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
  expect(mockDiff).toHaveBeenLastCalledWith('s', 'r', 0, undefined)
})

it('shows a note for a binary file instead of a diff', async () => {
  mockSummary({ files: [{ ...fileA, binary: true }], total: 1 })
  render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={vi.fn()} />)
  expect(await screen.findByText('Binary file')).toBeTruthy()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/TurnChangesPanel.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Reuse `DiffView`, `FullDiffViewer`, and the existing overlay classes (`git-overlay` etc.). No new overlay variant.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/TurnChangesPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TurnChangesPanel.tsx src/components/TurnChangesPanel.test.tsx src/components/Chat.tsx src/styles/turn-changes.css
git commit -m "feat(client): open a per-turn change review panel

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: Full verification and review

**Files:** none (verification only).

- [ ] **Step 1: Typecheck both projects**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: exit 0, no new failures.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 4: Manual smoke test**

Run `npm run dev`, open a session in a git repo, ask the model to edit one tracked file, create one new file, and edit one gitignored file (e.g. `foo.local` with `*.local` in `.gitignore`). Confirm:
- the card appears after the turn with all three files and correct counts;
- hovering a row shows a diff;
- clicking a row opens the review panel on that file;
- the same card still renders after a page reload (sidecar path);
- a no-change turn renders no card.

- [ ] **Step 5: Code review**

Run the `code-review` skill against `git diff HEAD` (per CLAUDE.md: unreviewed changes must be reviewed before commit). Fix confirmed findings and re-run the review on non-trivial fixes.

- [ ] **Step 6: Commit any review fixes**

```bash
git add -A
git commit -m "fix: address turn-changes review findings

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```