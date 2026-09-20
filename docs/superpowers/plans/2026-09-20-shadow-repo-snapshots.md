# Shadow-Repo File Snapshots & Offline Rewind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SDK `rewindFiles` with a shadow git-dir + TreeID sidecar so rewind works offline (dormant/terminated/restart) and restores untracked/new files.

**Architecture:** Per-session shadow `GIT_DIR` under `<stateDir>/snapshots/odb/<sessionId>/` (alternates → source ODB). Capture on user-send (before dispatch) and turn-finish; persist TreeIDs in `<stateDir>/snapshots/meta/<sessionId>.json`. Rewind is host-side (`git checkout <tree> -- path` / delete missing-from-tree paths) and does not require a live SDK subprocess.

**Tech Stack:** TypeScript, Node `execFile` (no shell), vitest (server/node), existing `writeAtomic` sidecar pattern, Hono routes, React ConfirmDialog (minimal client change).

**Spec:** `docs/superpowers/specs/2026-09-20-shadow-repo-snapshots-design.md`

## Global Constraints

- **Never spawn git through a shell** — always `execFile('git', argv)` with fixed argv; user paths go through `--` pathspec fencing and must be worktree-relative with no `..` (mirror `server/git.ts` rules).
- **cwd scope only** — snapshot and rewind touch paths under the session cwd relative to the worktree; never the whole repo by default.
- **Non-git cwd** — no capture, no rewind; capability `available: false`.
- **Sidecar is authority** — rewind reads only `snapshots/meta/<id>.json`; history-ring `snapshot` fields (if any) are display-only.
- **Do not change `HISTORY_CAP`** or build a message DB.
- **Capture failures never block send** — log and continue; missing anchors disable Rewind for that message.
- **Real rewind requires idle or dormant/terminated** (not working) — dry-run is allowed while working.
- **CSS:** never hardcode hex colors; use theme variables (client tasks).
- **Config:** `fileSnapshots` default `true`; `fileSnapshotsMaxUntrackedBytes` default `2 * 1024 * 1024`.
- **Paths on disk:** `odb/<sessionId>` per-session (spec §4.1 first version).
- **TDD:** write failing test → run → implement → pass → commit. Run `npm run typecheck` (both tsconfigs) before merge-level commits on integration tasks.

---

### Task 1: Shadow git runner + path helpers

**Files:**
- Create: `server/snapshot/paths.ts`
- Create: `server/snapshot/shadow-git.ts`
- Test: `server/snapshot/shadow-git.test.ts`

**Interfaces (Produces):**
```ts
// paths.ts
export function snapshotRoot(stateDir: string): string
export function odbDir(stateDir: string, sessionId: string): string
export function metaFile(stateDir: string, sessionId: string): string

// shadow-git.ts
export interface ShadowRepo {
  gitDir: string
  worktree: string
  /** session cwd relative to worktree, posix separators; '.' when cwd === worktree */
  scope: string
}
export async function initShadowRepo(opts: {
  gitDir: string
  worktree: string
  scope: string
  sourceCommonDir: string
}): Promise<void>
export async function captureTree(repo: ShadowRepo, opts?: {
  maxUntrackedBytes?: number
  sourceGitDir?: string
}): Promise<string | null>
export async function nameOnlyDiff(repo: ShadowRepo, from: string, to: string): Promise<string[]>
export async function treeHasPath(repo: ShadowRepo, tree: string, relPath: string): Promise<boolean>
export async function restorePaths(repo: ShadowRepo, tree: string, relPaths: string[]): Promise<void>
export async function deletePaths(repo: ShadowRepo, absPaths: string[]): Promise<void>
export async function structuredDiff(
  repo: ShadowRepo,
  from: string,
  to: string,
): Promise<Array<{ file: string; status: 'added'|'deleted'|'modified'; additions: number; deletions: number; patch?: string }>>
```

**Consumes:** none (leaf module). Uses `node:child_process.execFile` locally — do **not** import private `runGit` from `server/git.ts` (it throws `HttpError` and is not exported). Copy the safe argv/`--` fencing pattern.

- [ ] **Step 1: Write failing tests for paths + capture/restore**

```ts
// server/snapshot/shadow-git.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { odbDir, metaFile, snapshotRoot } from './paths.js'
import {
  initShadowRepo, captureTree, nameOnlyDiff, treeHasPath,
  restorePaths, deletePaths,
} from './shadow-git.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd })
}

describe('paths', () => {
  it('nests odb and meta under stateDir/snapshots', () => {
    const root = '/state'
    expect(snapshotRoot(root)).toBe(join(root, 'snapshots'))
    expect(odbDir(root, 'abc')).toBe(join(root, 'snapshots', 'odb', 'abc'))
    expect(metaFile(root, 'abc')).toBe(join(root, 'snapshots', 'meta', 'abc.json'))
  })
})

describe('shadow-git capture/restore', () => {
  let worktree: string
  let sourceGitDir: string
  let gitDir: string
  let repo: { gitDir: string; worktree: string; scope: string }

  beforeAll(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'snap-wt-'))
    await git(worktree, ['init'])
    await git(worktree, ['config', 'user.email', 't@t.test'])
    await git(worktree, ['config', 'user.name', 'T'])
    await git(worktree, ['config', 'commit.gpgsign', 'false'])
    await mkdir(join(worktree, 'scope'), { recursive: true })
    await writeFile(join(worktree, 'scope', 'a.txt'), 'one\n')
    await writeFile(join(worktree, 'outside.txt'), 'out\n')
    await git(worktree, ['add', '.'])
    await git(worktree, ['commit', '-m', 'init'])
    const common = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    sourceGitDir = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'])).stdout.trim()
    gitDir = join(worktree, '.snap-odb')
    await initShadowRepo({
      gitDir,
      worktree,
      scope: 'scope',
      sourceCommonDir: common,
    })
    repo = { gitDir, worktree, scope: 'scope' }
  })

  afterAll(async () => {
    await rm(worktree, { recursive: true, force: true }).catch(() => {})
  })

  it('captures only the cwd scope and ignores outside changes', async () => {
    const t1 = await captureTree(repo, { sourceGitDir })
    expect(t1).toBeTruthy()
    await writeFile(join(worktree, 'scope', 'a.txt'), 'two\n')
    await writeFile(join(worktree, 'scope', 'new.txt'), 'n\n')
    await writeFile(join(worktree, 'outside.txt'), 'changed\n')
    const t2 = await captureTree(repo, { sourceGitDir })
    const files = await nameOnlyDiff(repo, t1!, t2!)
    expect(files.sort()).toEqual(['scope/a.txt', 'scope/new.txt'])
  })

  it('restores tracked content and deletes paths absent from the start tree', async () => {
    const t1 = await captureTree(repo, { sourceGitDir })
    await writeFile(join(worktree, 'scope', 'a.txt'), 'three\n')
    await writeFile(join(worktree, 'scope', 'born.txt'), 'x\n')
    const hasBorn = await treeHasPath(repo, t1!, 'scope/born.txt')
    expect(hasBorn).toBe(false)
    await restorePaths(repo, t1!, ['scope/a.txt'])
    await deletePaths(repo, [join(worktree, 'scope', 'born.txt')])
    expect(await readFile(join(worktree, 'scope', 'a.txt'), 'utf8')).toBe('one\n')
    await expect(access(join(worktree, 'scope', 'born.txt'))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/snapshot/shadow-git.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement paths.ts and shadow-git.ts**

```ts
// server/snapshot/paths.ts
import { join } from 'node:path'

export function snapshotRoot(stateDir: string): string {
  return join(stateDir, 'snapshots')
}
export function odbDir(stateDir: string, sessionId: string): string {
  return join(snapshotRoot(stateDir), 'odb', sessionId)
}
export function metaFile(stateDir: string, sessionId: string): string {
  return join(snapshotRoot(stateDir), 'meta', `${sessionId}.json`)
}
```

```ts
// server/snapshot/shadow-git.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join, relative, sep, isAbsolute, normalize } from 'node:path'
import { createLogger } from '../log.js'

const log = createLogger('snapshot-git')
const execFileAsync = promisify(execFile)

export interface ShadowRepo {
  gitDir: string
  worktree: string
  scope: string
}

const BASE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.autocrlf', 'false'],
  ['core.longpaths', 'true'],
  ['core.symlinks', 'true'],
  ['core.fsmonitor', 'false'],
  ['feature.manyFiles', 'true'],
  ['index.version', '4'],
  ['index.threads', 'true'],
  ['core.untrackedCache', 'true'],
]

/** posix-style relative scope; '.' when cwd === worktree. Rejects escapes. */
export function scopeFromCwd(worktree: string, cwd: string): string | null {
  const rel = relative(worktree, cwd)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/') || '.'
}

function args(repo: ShadowRepo, cmd: string[]): string[] {
  return ['--git-dir', repo.gitDir, '--work-tree', repo.worktree, ...cmd]
}

async function run(cwd: string, argv: string[], opts?: { stdin?: string; allowExit?: ReadonlySet<number> }) {
  try {
    const { stdout, stderr } = await execFileAsync('git', argv, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(opts?.stdin != null ? {} : {}),
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string }
    if (typeof e.code === 'number') {
      if (opts?.allowExit?.has(e.code)) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code }
      throw new Error(`git ${argv[argv.length - 1]} exited ${e.code}: ${(e.stderr || e.message).slice(0, 300)}`)
    }
    throw err
  }
}

async function runStdin(cwd: string, argv: string[], stdin: string) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = execFile(
      'git',
      argv,
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 })
        const e = err as NodeJS.ErrnoException & { code?: string | number }
        if (typeof e.code === 'number') return resolve({ stdout, stderr, code: e.code })
        reject(err)
      },
    )
    child.stdin?.end(stdin)
  })
}

/** Seed alternates + copy source index so first add does not rehash the world. */
export async function initShadowRepo(opts: {
  gitDir: string
  worktree: string
  scope: string
  sourceCommonDir: string
}): Promise<void> {
  await fs.mkdir(opts.gitDir, { recursive: true })
  const repo: ShadowRepo = { gitDir: opts.gitDir, worktree: opts.worktree, scope: opts.scope }
  const exists = await fs
    .access(join(opts.gitDir, 'HEAD'))
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    await run(opts.worktree, ['init'], {})
    // Point GIT_DIR via env on init already used path; subsequent ops use --git-dir
    for (const [k, v] of BASE_CONFIG) {
      await run(opts.worktree, ['--git-dir', opts.gitDir, 'config', k, v]).catch(() => {})
    }
  }
  const objectsInfo = join(opts.gitDir, 'objects', 'info')
  await fs.mkdir(objectsInfo, { recursive: true })
  const alternates: string[] = []
  const sourceObjects = join(opts.sourceCommonDir, 'objects')
  alternates.push(sourceObjects)
  try {
    const chained = await fs.readFile(join(sourceObjects, 'info', 'alternates'), 'utf8')
    for (const line of chained.split('\n')) {
      const t = line.trim()
      if (!t) continue
      await fs
        .access(t)
        .then(() => alternates.push(t))
        .catch(() => {})
    }
  } catch {
    /* no chained alternates */
  }
  await fs.writeFile(join(objectsInfo, 'alternates'), alternates.join('\n') + '\n', 'utf8')
  try {
    await fs.copyFile(join(opts.sourceCommonDir, 'index'), join(opts.gitDir, 'index'))
  } catch {
    /* seed index optional */
  }
  log.debug(`shadow repo ready gitDir=${opts.gitDir} scope=${opts.scope}`)
}

/** Stage scope changes into the shadow index and write-tree. Returns TreeID or null. */
export async function captureTree(
  repo: ShadowRepo,
  opts?: { maxUntrackedBytes?: number; sourceGitDir?: string },
): Promise<string | null> {
  const pathspec = repo.scope === '.' ? '.' : repo.scope
  const lit = `:(top,literal)${pathspec}`
  // List candidates
  const [diffFiles, others] = await Promise.all([
    run(repo.worktree, args(repo, ['diff-files', '--name-only', '-z', '--', pathspec])),
    run(repo.worktree, args(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec])),
  ])
  const candidates = Array.from(
    new Set(
      [...diffFiles.stdout.split('\0'), ...others.stdout.split('\0')].filter(Boolean),
    ),
  )
  if (candidates.length > 0) {
    // Ignore filter against SOURCE repo rules when available
    let ignored = new Set<string>()
    if (opts?.sourceGitDir) {
      const check = await runStdin(
        repo.worktree,
        ['--git-dir', opts.sourceGitDir, '--work-tree', repo.worktree, 'check-ignore', '--no-index', '--stdin', '-z'],
        candidates.join('\0') + '\0',
      ).catch(() => null)
      if (check && (check.code === 0 || check.code === 1)) {
        ignored = new Set(check.stdout.split('\0').filter(Boolean))
      }
    }
    const max = opts?.maxUntrackedBytes ?? 2 * 1024 * 1024
    const oversized: string[] = []
    for (const c of candidates) {
      if (ignored.has(c)) continue
      try {
        const st = await fs.stat(join(repo.worktree, c))
        if (st.isFile() && st.size > max) oversized.push(c)
      } catch {
        /* ignore */
      }
    }
    const drop = [...ignored, ...oversized]
    if (drop.length) {
      await runStdin(
        repo.worktree,
        args(repo, ['rm', '--cached', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul']),
        drop.join('\0') + '\0',
      ).catch(() => {})
    }
    const allow = candidates.filter((c) => !ignored.has(c) && !oversized.includes(c))
    if (allow.length) {
      await runStdin(
        repo.worktree,
        args(repo, ['add', '--all', '--sparse', '--pathspec-from-file=-', '--pathspec-file-nul']),
        allow.map((f) => `:(top,literal)${f}`).join('\0') + '\0',
      )
    }
  } else {
    // Still ensure scope pathspec is refreshed when nothing listed — no-op ok
    void lit
  }
  const wt = await run(repo.worktree, args(repo, ['write-tree']))
  const tree = wt.stdout.trim()
  return tree || null
}

export async function nameOnlyDiff(repo: ShadowRepo, from: string, to: string): Promise<string[]> {
  const r = await run(repo.worktree, args(repo, ['diff', '--name-only', '-z', from, to, '--']))
  return r.stdout.split('\0').filter(Boolean)
}

export async function treeHasPath(repo: ShadowRepo, tree: string, relPath: string): Promise<boolean> {
  const r = await run(repo.worktree, args(repo, ['ls-tree', '-z', tree, '--', `:(top,literal)${relPath}`]), {
    allowExit: new Set([0, 128]),
  })
  return r.stdout.replace(/\0$/, '').length > 0
}

export async function restorePaths(repo: ShadowRepo, tree: string, relPaths: string[]): Promise<void> {
  if (!relPaths.length) return
  await run(
    repo.worktree,
    args(repo, ['checkout', tree, '--', ...relPaths.map((p) => `:(top,literal)${p}`)]),
  )
}

export async function deletePaths(repo: ShadowRepo, absPaths: string[]): Promise<void> {
  for (const p of absPaths) {
    await fs.rm(p, { recursive: true, force: true })
  }
}

/** Structured per-file diffs between two trees (Review / dry-run). */
export async function structuredDiff(
  repo: ShadowRepo,
  from: string,
  to: string,
): Promise<Array<{ file: string; status: 'added'|'deleted'|'modified'; additions: number; deletions: number; patch?: string }>> {
  const names = await nameOnlyDiff(repo, from, to)
  const out: Array<{ file: string; status: 'added'|'deleted'|'modified'; additions: number; deletions: number; patch?: string }> = []
  for (const file of names) {
    const statusR = await run(
      repo.worktree,
      args(repo, ['diff', '--name-status', '--no-renames', from, to, '--', `:(top,literal)${file}`]),
    )
    const code = statusR.stdout.trim().charAt(0)
    const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
    const num = await run(
      repo.worktree,
      args(repo, ['diff', '--numstat', '--no-renames', from, to, '--', `:(top,literal)${file}`]),
    )
    const [a, d] = num.stdout.split('\t')
    const binary = a === '-' || d === '-'
    let patch: string | undefined
    if (!binary) {
      const p = await run(
        repo.worktree,
        args(repo, ['diff', '--unified=3', '--no-renames', from, to, '--', `:(top,literal)${file}`]),
      )
      patch = p.stdout
    }
    out.push({
      file,
      status,
      additions: binary ? 0 : Number(a ?? 0) || 0,
      deletions: binary ? 0 : Number(d ?? 0) || 0,
      patch,
    })
  }
  return out
}
```

**Note for implementer:** `initShadowRepo` must run `git init` **with env `GIT_DIR`/`GIT_WORK_TREE`** or `git --git-dir <dir> --work-tree <wt> init` — prefer:

```ts
await execFileAsync('git', ['--git-dir', opts.gitDir, '--work-tree', opts.worktree, 'init'], {
  cwd: opts.worktree,
  windowsHide: true,
})
```

Fix the test if scope-relative paths differ; do not weaken `scopeFromCwd` escape checks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/snapshot/shadow-git.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/snapshot/paths.ts server/snapshot/shadow-git.ts server/snapshot/shadow-git.test.ts
git commit -m "feat(snapshot): shadow git runner and path helpers"
```

---

### Task 2: Snapshot sidecar store

**Files:**
- Create: `server/snapshot/snapshot-store.ts`
- Test: `server/snapshot/snapshot-store.test.ts`

**Interfaces (Produces):**
```ts
export interface SessionSnapshotMeta {
  version: 1
  gitDir: string
  worktree: string
  scope: string
  byMessage: Record<string, { start: string }>
  patches: Array<{ messageId: string; hash: string; files: string[] }>
  last?: { tree: string; at: number }
}
export class SnapshotStore {
  constructor(stateDir: string | undefined)
  load(sessionId: string): Promise<SessionSnapshotMeta | null>
  save(sessionId: string, meta: SessionSnapshotMeta): Promise<void>
  remove(sessionId: string): Promise<void>
  /** Mutate-and-save under the per-session write chain. */
  update(sessionId: string, fn: (prev: SessionSnapshotMeta | null) => SessionSnapshotMeta | null): Promise<void>
  copyForFork(fromId: string, toId: string, keepMessageIds: Set<string>, keepPatchMessageIds: Set<string>): Promise<void>
}
```

**Consumes:** `writeAtomic` from `../json-file-store.js`.

- [ ] **Step 1: Write failing tests**

```ts
// server/snapshot/snapshot-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore, type SessionSnapshotMeta } from './snapshot-store.js'

let dir: string
let store: SnapshotStore

function empty(over: Partial<SessionSnapshotMeta> = {}): SessionSnapshotMeta {
  return {
    version: 1,
    gitDir: '/g',
    worktree: '/w',
    scope: '.',
    byMessage: {},
    patches: [],
    ...over,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snap-meta-'))
  store = new SnapshotStore(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SnapshotStore', () => {
  it('returns null when missing; save/load roundtrips', async () => {
    expect(await store.load('s1')).toBeNull()
    const meta = empty({ byMessage: { U1: { start: 'tree1' } } })
    await store.save('s1', meta)
    expect(await store.load('s1')).toEqual(meta)
  })

  it('treats corrupt JSON as null', async () => {
    await store.save('s1', empty())
    const file = join(dir, 'snapshots', 'meta', 's1.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json', 'utf8')
    expect(await store.load('s1')).toBeNull()
  })

  it('update chains writes and filters fork copy', async () => {
    await store.update('x', () =>
      empty({
        byMessage: { U1: { start: 'a' }, U2: { start: 'b' } },
        patches: [
          { messageId: 'A1', hash: 'a', files: ['/w/f1'] },
          { messageId: 'A2', hash: 'b', files: ['/w/f2'] },
        ],
      }),
    )
    await store.copyForFork('x', 'y', new Set(['U1']), new Set(['A1']))
    const y = await store.load('y')
    expect(y?.byMessage).toEqual({ U1: { start: 'a' } })
    expect(y?.patches).toEqual([{ messageId: 'A1', hash: 'a', files: ['/w/f1'] }])
    await store.remove('y')
    expect(await store.load('y')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run server/snapshot/snapshot-store.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement store**

```ts
// server/snapshot/snapshot-store.ts
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../log.js'
import { writeAtomic } from '../json-file-store.js'
import { metaFile, snapshotRoot } from './paths.js'

const log = createLogger('snapshots')

export interface SessionSnapshotMeta {
  version: 1
  gitDir: string
  worktree: string
  scope: string
  byMessage: Record<string, { start: string }>
  patches: Array<{ messageId: string; hash: string; files: string[] }>
  last?: { tree: string; at: number }
}

export class SnapshotStore {
  private readonly dir: string | null
  private readonly writing = new Map<string, Promise<void>>()

  constructor(stateDir: string | undefined) {
    this.dir = stateDir ?? null
  }

  private file(sessionId: string): string | null {
    return this.dir ? metaFile(this.dir, sessionId) : null
  }

  async load(sessionId: string): Promise<SessionSnapshotMeta | null> {
    const file = this.file(sessionId)
    if (!file) return null
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as SessionSnapshotMeta
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null
      if (typeof parsed.byMessage !== 'object' || parsed.byMessage == null) return null
      if (!Array.isArray(parsed.patches)) return null
      return parsed
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      log.warn(`load failed for ${sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  private chain(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writing.get(sessionId) ?? Promise.resolve()
    const next = prev.then(fn).catch((err) => {
      log.warn(`write chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.writing.set(sessionId, next)
    return next
  }

  async save(sessionId: string, meta: SessionSnapshotMeta): Promise<void> {
    if (!this.dir) return
    const file = this.file(sessionId)!
    await this.chain(sessionId, () => writeAtomic(join(snapshotRoot(this.dir!), 'meta'), file, meta))
  }

  async update(
    sessionId: string,
    fn: (prev: SessionSnapshotMeta | null) => SessionSnapshotMeta | null,
  ): Promise<void> {
    await this.chain(sessionId, async () => {
      const prev = await this.load(sessionId)
      const next = fn(prev)
      if (!next) return
      const file = this.file(sessionId)
      if (!file || !this.dir) return
      await writeAtomic(join(snapshotRoot(this.dir), 'meta'), file, next)
    })
  }

  async copyForFork(
    fromId: string,
    toId: string,
    keepMessageIds: Set<string>,
    keepPatchMessageIds: Set<string>,
  ): Promise<void> {
    const src = await this.load(fromId)
    if (!src) return
    const byMessage: SessionSnapshotMeta['byMessage'] = {}
    for (const [k, v] of Object.entries(src.byMessage)) {
      if (keepMessageIds.has(k)) byMessage[k] = v
    }
    const patches = src.patches.filter((p) => keepPatchMessageIds.has(p.messageId))
    await this.save(toId, { ...src, byMessage, patches, last: undefined })
  }

  async remove(sessionId: string): Promise<void> {
    const file = this.file(sessionId)
    if (!file) return
    try {
      await unlink(file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.warn(`remove failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/snapshot/snapshot-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/snapshot-store.ts server/snapshot/snapshot-store.test.ts
git commit -m "feat(snapshot): per-session snapshot sidecar store"
```

---

### Task 3: SnapshotService (capture / dry-run / rewind)

**Files:**
- Create: `server/snapshot/snapshot-service.ts`
- Test: `server/snapshot/snapshot-service.test.ts`

**Interfaces (Produces):**
```ts
export interface SnapshotServiceOptions {
  stateDir: string
  fileSnapshots?: boolean
  maxUntrackedBytes?: number
}
export class SnapshotService {
  constructor(opts: SnapshotServiceOptions)
  /** Capture current worktree state into the session shadow repo. Null if disabled/non-git/error. */
  capture(input: { sessionId: string; cwd: string }): Promise<string | null>
  /** Anchors for capability API (newest-first messageId list). */
  listAnchors(sessionId: string): Promise<Array<{ messageId: string }>>
  dryRun(sessionId: string, messageId: string): Promise<RewindPreview>
  rewind(sessionId: string, messageId: string): Promise<RewindPreview>
}
export interface RewindPreview {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  diffs?: Array<{ file: string; status: 'added'|'deleted'|'modified'; additions: number; deletions: number; patch?: string }>
}
```

**Consumes:** Task 1 `shadow-git`, Task 2 `SnapshotStore`, `isInsideWorkTree` from `../git.js`.

**Rewind algorithm (spec §7.2 simplified):**
1. Load meta; missing `byMessage[messageId]` → `{ canRewind: false, error: 'no snapshot for message' }`.
2. `current = captureTree(...)` (refresh index).
3. `files = nameOnlyDiff(start, current)`.
4. dryRun: `structuredDiff(start, current)` → preview (never touches worktree files except shadow index).
5. real: for each file, if `treeHasPath(start, file)` → `restorePaths`; else `deletePaths([join(worktree, file)])`.

- [ ] **Step 1: Write failing integration test (temp git repo)**

```ts
// server/snapshot/snapshot-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotService } from './snapshot-service.js'

const execFileAsync = promisify(execFile)
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true })

let wt: string
let state: string
let svc: SnapshotService

beforeEach(async () => {
  wt = await mkdtemp(join(tmpdir(), 'svc-wt-'))
  state = await mkdtemp(join(tmpdir(), 'svc-state-'))
  await git(wt, ['init'])
  await git(wt, ['config', 'user.email', 't@t.test'])
  await git(wt, ['config', 'user.name', 'T'])
  await git(wt, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(wt, 'a.txt'), 'one\n')
  await git(wt, ['add', '.'])
  await git(wt, ['commit', '-m', 'i'])
  svc = new SnapshotService({ stateDir: state })
})
afterEach(async () => {
  await rm(wt, { recursive: true, force: true }).catch(() => {})
  await rm(state, { recursive: true, force: true }).catch(() => {})
})

describe('SnapshotService', () => {
  it('captures, dry-runs, and rewinds including deleting new files', async () => {
    const start = await svc.capture({ sessionId: 's1', cwd: wt })
    expect(start).toBeTruthy()
    await svc // update meta as send() would
      ;(svc as unknown as { store: { update: Function } }).store.update('s1', () => ({
        version: 1 as const,
        gitDir: join(state, 'snapshots', 'odb', 's1'),
        worktree: wt,
        scope: '.',
        byMessage: { U1: { start: start! } },
        patches: [],
      }))

    await writeFile(join(wt, 'a.txt'), 'two\n')
    await writeFile(join(wt, 'new.txt'), 'n\n')

    const dry = await svc.dryRun('s1', 'U1')
    expect(dry.canRewind).toBe(true)
    expect(dry.filesChanged?.sort()).toEqual(['a.txt', 'new.txt'])
    // dry-run must not restore
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('two\n')

    const real = await svc.rewind('s1', 'U1')
    expect(real.canRewind).toBe(true)
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\n')
    await expect(access(join(wt, 'new.txt'))).rejects.toThrow()
  })

  it('reports unavailable for non-git cwd', async () => {
    const t = await mkdtemp(join(tmpdir(), 'nogit-'))
    try {
      const tree = await svc.capture({ sessionId: 's2', cwd: t })
      expect(tree).toBeNull()
    } finally {
      await rm(t, { recursive: true, force: true })
    }
  })
})
```

**Note:** Prefer a public `recordAnchor(sessionId, cwd, messageId, tree)` on the service instead of poking private `store` — add that method in the implementation and use it in the test:

```ts
await svc.recordAnchor('s1', wt, 'U1', start!)
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run server/snapshot/snapshot-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement SnapshotService**

Wire `initShadowRepo` on first capture using `rev-parse --git-common-dir` from the **source** repo; persist `gitDir/worktree/scope` in meta on first capture. Keep an in-process lock map keyed by `sessionId` so concurrent capture/rewind serialize.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/snapshot/snapshot-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/snapshot/snapshot-service.ts server/snapshot/snapshot-service.test.ts
git commit -m "feat(snapshot): SnapshotService capture dry-run rewind"
```

---

### Task 4: Config flags

**Files:**
- Modify: `server/config.ts` (ConfigFile + AppConfig + defaults + merge + frozen key list if present)
- Modify: `src/types/config.ts` if the client mirrors config fields
- Modify: `config.example.json` (optional fields)
- Test: extend `server/config.test.ts`

**Interfaces (Produces):**
```ts
fileSnapshots: boolean            // default true
fileSnapshotsMaxUntrackedBytes: number  // default 2 * 1024 * 1024
```

- [ ] **Step 1: Add failing config test**

```ts
it('defaults fileSnapshots on and 2MiB untracked cap', () => {
  expect(defaultConfig.fileSnapshots).toBe(true)
  expect(defaultConfig.fileSnapshotsMaxUntrackedBytes).toBe(2 * 1024 * 1024)
})
```

- [ ] **Step 2: Run test (fail)**
- [ ] **Step 3: Add fields to ConfigFile, defaultConfig, loadConfig merge, and CONFIG_KEYS allowlist (same list that includes `historyCap`)**
- [ ] **Step 4: Run config tests + typecheck**
- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts config.example.json
git commit -m "feat(config): fileSnapshots and max untracked bytes"
```

---

### Task 5: SessionManager + pump integration

**Files:**
- Modify: `server/session-manager.ts` (construct SnapshotStore/Service; send/sendContent capture; rewindFiles rewrite; fork/discard/delete lifecycle; pump deps)
- Modify: `server/session-pump.ts` (turn-finish capture + patches; optional interrupt cleanup)
- Modify: `server/session-types.ts` (PumpDeps if needed)
- Test: extend `server/session-manager.test.ts` and/or new `server/snapshot/snapshot-integration.test.ts`

**Interfaces:**
- Consumes: `SnapshotService`, `SnapshotStore`
- Produces: `sm.rewindFiles(id, messageId, { dryRun })` host implementation; sidecar lifecycle

- [ ] **Step 1: Write failing tests**

Key cases (manager-level, may use a thin test double for SnapshotService if full git is heavy):

1. `send()` calls capture before dispatch (spy).
2. `rewindFiles` on session without live Query but with meta → succeeds (no `requireLive`).
3. `rewindFiles` while `phase === 'working'` + dryRun → allowed; real → 409.
4. `deleteSession` / discard `deleteOriginal` removes snapshots sidecar.
5. fork `copyForFork` invoked with kept message ids.

- [ ] **Step 2: Run tests fail**
- [ ] **Step 3: Implement**

**send / sendContent:** after minting `userMsg.uuid`, fire-and-forget:

```ts
void this.snapshots
  .capture({ sessionId: id, cwd: s.cwd ?? this.cwd })
  .then((tree) => {
    if (tree && userMsg.uuid) void this.snapshots.recordAnchor(id, s.cwd ?? this.cwd, userMsg.uuid, tree)
  })
  .catch((err) => log.warn(`[session ${id}] snapshot capture failed: ${err}`))
```

Do **not** await before `dispatchUserMessage` if that would block the HTTP send path more than a few ms — awaiting is OK if capture is typically <100ms; prefer **await** so the anchor exists before the turn mutates files (spec: capture before tools run). If await is too slow for UX, await with a 2s timeout then continue.

**Pump `recordResultFrame` neighbor:** add `recordTurnSnapshot(sessionId, assistantUuid)`:

```ts
recordTurnSnapshot: (sessionId, assistantUuid) => {
  void (async () => {
    const cwd = this.sessions.get(sessionId)?.cwd ?? this.cwd
    const end = await this.snapshots.capture({ sessionId, cwd })
    if (!end) return
    await this.snapshots.appendPatch(sessionId, assistantUuid, end)
  })().catch((err) => log.warn(`turn snapshot failed ${sessionId}: ${err}`))
}
```

Add `appendPatch` on SnapshotService: capture is the end tree; compute `nameOnlyDiff(prevLastOrUserStart, end)` using `meta.last?.tree` as prev start; if files non-empty, push patch `{ messageId: assistantUuid, hash: prev, files }` and set `last`.

**rewindFiles rewrite:**

```ts
async rewindFiles(id: string, messageId: string, opts?: { dryRun?: boolean }): Promise<RewindFilesResult> {
  const s = this.get(id) // live or meta — do NOT requireLive
  if (!s) throw new HttpError(404, `session ${id} not found`)
  if (this.phaseOf(s) === 'working' && !opts?.dryRun) {
    throw new HttpError(409, `session ${id} is working; wait for the turn to finish before rewinding`)
  }
  const result = opts?.dryRun
    ? await this.snapshots.dryRun(id, messageId)
    : await this.snapshots.rewind(id, messageId)
  if (result.canRewind && !opts?.dryRun) this.broadcastGitStatusChanged(id)
  return result
}
```

Remove `promptUuids` SDK-uuid mapping from this path (anchor keys are already server `U`).

**Lifecycle:** next to existing `promptUuidStore.remove` / fork copy:

```ts
await this.snapshotStore.remove(id)           // delete
await this.snapshotStore.copyForFork(...)     // discard/fork — keep ids = messages ≤ cut
```

- [ ] **Step 4: Run tests + `npm run typecheck`**
- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/session-pump.ts server/session-types.ts
git commit -m "feat(snapshot): wire capture and offline rewind into session manager"
```

---

### Task 6: REST capability + snapshot-diff routes

**Files:**
- Modify: `server/routes/sessions.ts`
- Test: route-level test if an existing pattern exists; else cover via manager tests and add thin route tests

**Routes:**

```
GET  /sessions/:id/file-snapshots
→ { available: boolean, reason?: string, anchors: Array<{ messageId: string }> }

GET  /sessions/:id/snapshot-diff?from=<messageId>
→ { diffs: FileDiff[] }   // from start tree → current capture
```

Keep `POST /sessions/:id/rewind-files` path (already rewritten in Task 5).

- [ ] **Step 1: Failing tests for 404 unknown session, 400 missing from, 200 empty anchors**
- [ ] **Step 2: Implement routes calling SnapshotService**
- [ ] **Step 3: Tests pass + typecheck**
- [ ] **Step 4: Commit**

```bash
git add server/routes/sessions.ts
git commit -m "feat(api): file-snapshots capability and snapshot-diff routes"
```

---

### Task 7: Retire SDK rewind surface

**Files:**
- Modify: `server/providers/types.ts` — delete `rewindFiles?` from handle
- Modify: `server/providers/claude/claude-provider.ts` — delete `supportsRewindFiles`, `rewindFiles`, and `enableFileCheckpointing` defaulting
- Modify: `server/providers/claude/claude-session.ts` — delete rewind implementation if present
- Modify: `shared/rewind.ts` — keep `RewindFilesResult` shape; `coerceRewindResult` may remain for defensive parse or be simplified to identity for host results
- Modify: `server/session-manager.ts` — remove `requireHandleMethod(..., 'rewindFiles')` leftovers
- Test: update any provider tests asserting checkpointing

- [ ] **Step 1: `rg rewindFiles|enableFileCheckpointing|supportsRewindFiles` and list all hits**
- [ ] **Step 2: Delete/replace each hit; fix tests**
- [ ] **Step 3: `npm run typecheck` and `npm run test`**
- [ ] **Step 4: Commit**

```bash
git add -A server/providers shared/rewind.ts server/session-manager.ts
git commit -m "refactor: retire SDK file-checkpoint rewind path"
```

---

### Task 8: Client menu + dialog copy

**Files:**
- Modify: `src/components/Chat.tsx`
- Modify: `src/types.ts` if RewindFilesResult gains `diffs`

**Behavior:**
1. On context menu open (or mount), `GET /sessions/:id/file-snapshots`; store `available` + anchor set.
2. Enable "Rewind files to this message" when: message is top-level user AND `available` AND `anchors` includes id. **Remove** `session.phase !== 'idle'` gate.
3. Dialog copy: files created after the message will be deleted; conversation not truncated.
4. dry-run error path unchanged.

- [ ] **Step 1: Update enable condition + copy (no new design system)**
- [ ] **Step 2: Manual smoke: idle rewind, dry-run**
- [ ] **Step 3: `npm run typecheck`**
- [ ] **Step 4: Commit**

```bash
git add src/components/Chat.tsx src/types.ts
git commit -m "feat(ui): offline rewind menu gating and copy"
```

---

### Task 9: Docs + CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md` (rewind-files bullet — offline, untracked, no live Query)
- Modify: `CONFIG.md` (`fileSnapshots`, `fileSnapshotsMaxUntrackedBytes`)

- [ ] **Step 1: Update both docs accurately**
- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md CONFIG.md
git commit -m "docs: shadow-repo file snapshots"
```

---

### Task 10: Full suite + review

- [ ] **Step 1: `npm run test` and `npm run typecheck`**
- [ ] **Step 2: Run `code-review` skill on `git diff main` (or uncommitted full diff) per CLAUDE.md**
- [ ] **Step 3: Fix confirmed findings; re-run review on non-trivial fixes**
- [ ] **Step 4: Final commit**

---

## Self-Review Notes (plan author)

- Spec §7.2 first version uses start-vs-current for user-anchor rewind; patches still recorded for future tool-level work — covered in Task 3/5.
- Per-session odb (`key = sessionId`) — Task 1/3.
- Working+real rewind → 409; working+dryRun allowed — Task 5.
- Non-git → capture null, available false — Task 3/6.
- No HISTORY_CAP change; no message DB — out of scope.
- `runGit` in `server/git.ts` is private — Task 1 uses its own execFile wrapper.
- Fork keep-set: implementer must intersect `byMessage` keys with user-message uuids at/before discard cut (same pattern as turnAnchor/resultFrame copy in `session-manager.ts` ~1868).
