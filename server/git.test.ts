import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  cpSync,
  rmSync,
} from 'node:fs'
import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildGitRouter } from './git-routes.js'
import {
  validateRepoRelativePath,
  stageFiles,
  unstageFiles,
  discardTracked,
  discardUntracked,
  commitChanges,
  listStashes,
  stashCreate,
  stashPop,
  stashDrop,
  listBranches,
  createBranch,
  checkoutBranch,
  validateBranchName,
  abortMerge,
  getStatus,
  tryCaptureGitHead,
  tryCaptureRepoRoot,
  getStagedDiff,
  listWorktrees,
  getStatusInRepo,
  getRangeDiffFiles,
  getRangeDiffFile,
  trimGitErrorOutput,
  runGit,
} from './git.js'
import { Hono } from 'hono'
import { createErrorHandler } from './errors.js'
import { tempDir, rmRf } from './__test-utils__/index.js'

// Git process startup is noticeably slower on Windows under the full Vitest
// pool, so keep the git integration suite from flaking at the 5s default.
vi.setConfig({ testTimeout: 20_000 })
// Probe git availability synchronously at module load so `it.skipIf(...)`
// ?evaluated at registration time, not run time ?sees the correct value.
// An async beforeAll would set `gitOk` too late; the skip flags would have
// already crystallised at the initial `false` and skipped the whole suite.
const gitOk = ((): boolean => {
  try {
    const v = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
    // applyTestGitEnv() injects identity via GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n
    // env vars, which git only honours since 2.31 — older git silently ignores
    // them, leaving repos without identity (commits fail) and on branch
    // "master" (assertions + `git worktree add ... main` fail). Skip the whole
    // integration suite on unsupported git rather than let every test red.
    const m = /^git version (\d+)\.(\d+)/.exec(v)
    if (!m) return false
    const major = Number(m[1])
    const minor = Number(m[2])
    return major > 2 || (major === 2 && minor >= 31)
  } catch {
    return false
  }
})()

/** git identity + behaviour config, injected as GIT_CONFIG_* environment
 *  variables rather than per-repo `git config` writes.
 *
 *  Every git child process spawned in this worker — both the test's own
 *  execFileSync helpers AND the runGit() spawns under test — inherits
 *  process.env, so setting these once is equivalent to passing
 *  `-c user.email=… -c core.autocrlf=false …` on every command. This
 *  replaces the five `git config` spawns gitInit used to make per test
 *  (~0.5s × ~55 tests on Windows, where each git process costs ~130ms).
 *  Repo-local config is left untouched; env config never persists.
 *
 *  `CRW_TEST_GIT_ENV` guards against re-applying if the module is loaded
 *  more than once in a shared worker. */
function applyTestGitEnv(): void {
  if (process.env.CRW_TEST_GIT_ENV === '1') return
  process.env.CRW_TEST_GIT_ENV = '1'
  const pairs: Array<[string, string]> = [
    ['user.email', 'test@example.com'],
    ['user.name', 'Tester'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['init.defaultBranch', 'main'],
  ]
  process.env.GIT_CONFIG_COUNT = String(pairs.length)
  pairs.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k
    process.env[`GIT_CONFIG_VALUE_${i}`] = v
  })
}

applyTestGitEnv()

/** Initialise an empty git repo. Identity/behaviour config comes from the
 *  GIT_CONFIG_* env injected above, so a single spawn replaces the old
 *  `git init` + four `git config` calls. `init.defaultBranch=main` is part
 *  of the env config, keeping the branch name stable across git versions
 *  (older git defaulted to "master").
 *
 *  Windows autocrlf note: disabling it (env-injected above) keeps checkout
 *  on LF instead of converting to CRLF, so `expect('orig\n')` assertions
 *  don't see '\r\n' and fail. */
function gitInit(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
}

function gitCommitAll(cwd: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd })
  execFileSync('git', ['commit', '-m', message, '--quiet', '--no-gpg-sign'], { cwd })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
}

// ── Seeded-repo template ─────────────────────────────────────────────────
// Building a repo inside each test costs three git spawns — measured on
// Windows: init 205ms + add 121ms + commit 951ms ≈ 1.3s. ~54 tests needed one,
// so ~69s of this file's ~195s was fixture construction before a single
// assertion ran, and that made this file the WHOLE suite's critical path:
// every other test file finished ~25s before it did, so `npm test`'s wall
// clock was simply git.test.ts's runtime.
//
// Instead: build ONE repo once, `git repack` its loose objects into a single
// packfile, drop `.git/hooks` + `.git/logs` (pure copy weight a copied repo
// never reads), then `fs.cpSync` it per test. Measured: 19 files / ~58ms per
// copy — 22x cheaper — and a copy is a fully functional work tree (commit,
// stash, checkout, `worktree add` all verified against one).
//
// Commit SHAs are byte-identical in every copy (a SHA is a function of tree
// content + author + timestamp, all fixed when the template is built), so a
// test needing to reference an older commit reads `seedShas()` instead of
// making commits of its own.

/** Content committed by the template's first commit. Tests assert against
 *  these constants instead of re-committing their own content. */
const SEED = {
  a: 'alpha\n',
  b: 'beta\n',
  /** Rename source for the `git mv` status test. */
  old: 'content\n',
  /** Multi-line, so a one-line edit produces a readable unified diff. */
  multi: 'one\ntwo\nthree\n',
  sub: 'sub-alpha\n',
  /** 700 lines — a full rewrite lands past MAX_DIFF_LINES (500). */
  big: Array.from({ length: 700 }, (_, i) => `orig-${i}`).join('\n') + '\n',
  /** NUL bytes guarantee git classifies the blob as binary. */
  bin: Buffer.from([0, 1, 2, 0, 3, 4]),
  /** `a.txt` on the template's second branch — differs from main's copy, so
   *  a local edit to a.txt is enough to make `checkout other` conflict. */
  aOnOther: 'on-other\n',
} as const

/** Template commit subjects on `main`, oldest → newest. Only `log.txt` moves
 *  between them, so every other seed file's content at HEAD equals its SEED
 *  constant regardless of history depth. */
const SEED_SUBJECTS = ['first', 'second', 'third'] as const

/** Second branch shipped by the template (see SEED.aOnOther). */
const SEED_BRANCH = 'other'

let templateDir: string | null = null
const templateShas: string[] = []

/** Build (once) and return the template repo's path. */
function buildTemplate(): string {
  if (templateDir) return templateDir
  const tpl = tempDir('git-template')
  gitInit(tpl)
  writeFileSync(join(tpl, 'a.txt'), SEED.a)
  writeFileSync(join(tpl, 'b.txt'), SEED.b)
  writeFileSync(join(tpl, 'old.txt'), SEED.old)
  writeFileSync(join(tpl, 'multi.txt'), SEED.multi)
  writeFileSync(join(tpl, 'big.txt'), SEED.big)
  writeFileSync(join(tpl, 'blob.bin'), SEED.bin)
  mkdirSync(join(tpl, 'sub'), { recursive: true })
  writeFileSync(join(tpl, 'sub', 'a.txt'), SEED.sub)
  SEED_SUBJECTS.forEach((subject, i) => {
    if (i > 0) writeFileSync(join(tpl, 'log.txt'), `v${i + 1}\n`)
    templateShas.push(gitCommitAll(tpl, subject))
  })
  // A second branch whose a.txt diverges from main's, so the two
  // checkoutBranch conflict tests don't each have to build one (they were the
  // file's two slowest tests at 15.4s + 9.6s).
  execFileSync('git', ['checkout', '--quiet', '-b', SEED_BRANCH], { cwd: tpl })
  writeFileSync(join(tpl, 'a.txt'), SEED.aOnOther)
  gitCommitAll(tpl, 'other-version')
  execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: tpl })
  // Collapse the loose objects into one packfile and drop the two dirs a
  // copy never reads: 32 files → 19, ~73ms → ~58ms per copy.
  execFileSync('git', ['repack', '-adq'], { cwd: tpl })
  rmSync(join(tpl, '.git', 'hooks'), { recursive: true, force: true })
  rmSync(join(tpl, '.git', 'logs'), { recursive: true, force: true })
  templateDir = tpl
  return tpl
}

/** Copy the template repo into `target` (an existing empty dir). Leaves a
 *  clean work tree on `main` with SEED_SUBJECTS.length commits. */
function seedRepo(target: string): void {
  cpSync(buildTemplate(), target, { recursive: true })
}

/** Template commit SHAs on `main`, oldest → newest. Stable across copies. */
function seedShas(): readonly string[] {
  buildTemplate()
  return templateShas
}

// Synchronous on purpose. The per-test dirs below are removed fire-and-forget
// (documented there: awaiting Windows' EPERM window cost ~2s PER test), but the
// template is removed ONCE per file — and an un-awaited rm loses the race with
// worker exit, leaking a template dir into %TEMP% on every run. rmRf is the
// repo's tolerant sync remover: it retries the AV/EPERM window briefly, then
// leaks rather than throwing, so cleanup can never red-green the suite.
afterAll(() => {
  if (templateDir) rmRf(templateDir)
})

/** Build a Hono app wrapping the git router with the same onError hook
 *  the production app uses, so HttpError → JSON conversion is exercised. */
function buildApp(): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/api/git', buildGitRouter())
  return app
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('git-routes', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('git')
  })
  afterEach(() => {
    // On Windows, git briefly holds handles on .git/index or pack files
    // after the command returns, so a synchronous rmSync hits EPERM and
    // its retry/backoff would block the test thread for up to 2s PER test
    // — across the whole suite that added tens of seconds of pure waiting.
    //
    // Each test uses a fresh mkdtemp dir, so a lingering tmpdir never
    // affects another test's correctness. Fire the removal off
    // asynchronously and don't await it: the cleanup still happens (with
    // retries for the EPERM window) but never stalls the run. Any final
    // failure is swallowed — the OS reaps the temp dir eventually.
    const target = dir
    void rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => {},
    )
  })

  describe('GET /api/git/status', () => {
    it.skipIf(!gitOk)('400 when cwd is missing', async () => {
      const app = buildApp()
      const res = await app.request('/api/git/status')
      expect(res.status).toBe(400)
      expect((await json(res)).error).toContain('cwd')
    })

    it.skipIf(!gitOk)('400 for relative cwd', async () => {
      const app = buildApp()
      const res = await app.request('/api/git/status?cwd=relative/path')
      expect(res.status).toBe(400)
      expect((await json(res)).error).toContain('absolute')
    })

    it.skipIf(!gitOk)('returns isRepo:false for a non-git directory', async () => {
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      expect(res.status).toBe(200)
      const body = await json<{ isRepo: boolean }>(res)
      expect(body.isRepo).toBe(false)
    })

    it.skipIf(!gitOk)('reports a clean repo correctly', async () => {
      seedRepo(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      expect(res.status).toBe(200)
      const body = await json<Record<string, unknown>>(res)
      expect(body.isRepo).toBe(true)
      expect(body.branch).toBe('main')
      expect(body.detached).toBe(false)
      expect(body.state).toBe('clean')
      expect(body.staged).toEqual([])
      expect(body.unstaged).toEqual([])
      expect(body.untracked).toEqual([])
    })

    it.skipIf(!gitOk)('buckets staged / unstaged / untracked files separately', async () => {
      // a.txt and b.txt arrive tracked and unmodified from the template, so
      // the three buckets below hold exactly the files this test touches.
      seedRepo(dir)

      // a.txt: staged modification (committed, modified, then `git add`)
      writeFileSync(join(dir, 'a.txt'), 'a-changed\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: dir })

      // b.txt: unstaged modification only
      writeFileSync(join(dir, 'b.txt'), 'b-changed\n')

      // c.txt: untracked
      writeFileSync(join(dir, 'c.txt'), 'c-new\n')

      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<Record<string, Array<{ path: string; status: string }>>>(res)
      expect(body.staged.map((f) => f.path)).toEqual(['a.txt'])
      expect(body.unstaged.map((f) => f.path)).toEqual(['b.txt'])
      expect(body.untracked.map((f) => f.path)).toEqual(['c.txt'])
      expect(body.staged[0].status).toBe('M')
      expect(body.unstaged[0].status).toBe('M')
      expect(body.untracked[0].status).toBe('?')
    })

    it.skipIf(!gitOk)('reports state=dirty when there are uncommitted changes', async () => {
      seedRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a-changed\n')
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ state: string }>(res)
      expect(body.state).toBe('dirty')
    })

    it.skipIf(!gitOk)('reports repoRoot even when queried from a subdirectory', async () => {
      seedRepo(dir) // ships a tracked sub/a.txt
      writeFileSync(join(dir, 'sub', 'a.txt'), 'a-changed\n')
      // Query status from the repo's subdirectory. Porcelain paths stay
      // relative to the work-tree root, and repoRoot must be that root —
      // callers building an absolute path (FileViewer readFile) anchor on it.
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(join(dir, 'sub'))}`)
      const body = await json<{ repoRoot: string; unstaged: Array<{ path: string }> }>(res)
      // Canonicalize BOTH sides with the native realpath: it resolves
      // symlinked components (macOS /var → /private/var) AND, on Windows,
      // expands 8.3 short names (C:\Users\GEZELI~1\… → C:\Users\Ge Zelin\…).
      // The JS realpathSync keeps short names as-is on Windows, so `dir`
      // (short, from os.tmpdir) and git's --show-toplevel (long) would
      // otherwise compare unequal despite being the same directory.
      expect(realpathSync.native(body.repoRoot)).toBe(realpathSync.native(dir))
      expect(body.unstaged.map((f) => f.path)).toEqual(['sub/a.txt'])
    })

    it.skipIf(!gitOk)('handles paths with spaces and unicode via -z parsing', async () => {
      seedRepo(dir)
      const weird = 'has spaces and 中文 $.txt'
      writeFileSync(join(dir, weird), 'hi')
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ untracked: Array<{ path: string }> }>(res)
      expect(body.untracked).toHaveLength(1)
      expect(body.untracked[0].path).toBe(weird)
    })

    it.skipIf(!gitOk)('detects renames and exposes renamedFrom', async () => {
      seedRepo(dir) // ships a tracked old.txt
      // Rename + stage. `git mv` updates the index in one step.
      execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir })
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ staged: Array<{ path: string; status: string; renamedFrom?: string }> }>(res)
      expect(body.staged).toHaveLength(1)
      expect(body.staged[0].path).toBe('new.txt')
      expect(body.staged[0].status).toBe('R')
      expect(body.staged[0].renamedFrom).toBe('old.txt')
    })

    it.skipIf(!gitOk)('reports detached HEAD with branch=null', async () => {
      seedRepo(dir)
      // Detach onto the template's root commit — the SHA is identical in
      // every copy, so no commits of our own are needed.
      execFileSync('git', ['checkout', '--quiet', seedShas()[0]], { cwd: dir })
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ branch: string | null; detached: boolean }>(res)
      expect(body.branch).toBeNull()
      expect(body.detached).toBe(true)
    })

    it.skipIf(!gitOk)('reports rebasing state via .git marker file', async () => {
      seedRepo(dir)
      // Manually drop a rebase-merge dir ?simulating an in-progress rebase
      // without having to actually trigger conflict resolution.
      mkdirSync(join(dir, '.git', 'rebase-merge'), { recursive: true })
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ state: string }>(res)
      expect(body.state).toBe('rebasing')
    })

    it.skipIf(!gitOk)('ignores a stale REBASE_HEAD left behind by an aborted rebase', async () => {
      seedRepo(dir)
      const sha = seedShas().at(-1)!
      // REBASE_HEAD can linger after a rebase is aborted / the process is
      // killed. git itself does not report a rebase in progress from a lone
      // REBASE_HEAD (only rebase-apply/ or rebase-merge/ count), so neither
      // should we.
      writeFileSync(join(dir, '.git', 'REBASE_HEAD'), `${sha}\n`)
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ state: string }>(res)
      expect(body.state).toBe('clean')
    })
  })

  describe('GET /api/git/diff', () => {
    it.skipIf(!gitOk)('400 when path is missing', async () => {
      seedRepo(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}`)
      expect(res.status).toBe(400)
    })

    it.skipIf(!gitOk)('400 when path tries to escape the repo', async () => {
      seedRepo(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=${encodeURIComponent('../etc/passwd')}`)
      expect(res.status).toBe(400)
      expect((await json(res)).error).toMatch(/\.\./)
    })

    it.skipIf(!gitOk)('400 when path is absolute', async () => {
      seedRepo(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=${encodeURIComponent('/etc/passwd')}`)
      expect(res.status).toBe(400)
    })

    it.skipIf(!gitOk)('returns a unified diff for a worktree change', async () => {
      seedRepo(dir) // multi.txt is committed as SEED.multi ('one\ntwo\nthree\n')
      writeFileSync(join(dir, 'multi.txt'), 'one\nTWO\nthree\n')
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=multi.txt`)
      expect(res.status).toBe(200)
      const body = await json<{ text: string; truncated: boolean; isBinary: boolean }>(res)
      expect(body.text).toContain('-two')
      expect(body.text).toContain('+TWO')
      expect(body.truncated).toBe(false)
      expect(body.isBinary).toBe(false)
    })

    it.skipIf(!gitOk)('returns a staged diff when staged=1', async () => {
      seedRepo(dir) // a.txt is committed as SEED.a ('alpha\n')
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'three\n')
      const app = buildApp()
      const staged = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=a.txt&staged=1`)
      const stagedBody = await json<{ text: string }>(staged)
      const worktree = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=a.txt&staged=0`)
      const worktreeBody = await json<{ text: string }>(worktree)
      // staged: HEAD ?index   (alpha ?two)
      expect(stagedBody.text).toContain('-alpha')
      expect(stagedBody.text).toContain('+two')
      // worktree: index ?working tree   (two ?three)
      expect(worktreeBody.text).toContain('-two')
      expect(worktreeBody.text).toContain('+three')
    })

    it.skipIf(!gitOk)('truncates diffs longer than the line cap', async () => {
      seedRepo(dir) // big.txt is committed as SEED.big (700 `orig-N` lines)
      const lines2: string[] = []
      for (let i = 0; i < 700; i++) lines2.push(`new-${i}`)
      writeFileSync(join(dir, 'big.txt'), lines2.join('\n') + '\n')
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=big.txt`)
      const body = await json<{ truncated: boolean; totalLines: number; text: string }>(res)
      expect(body.truncated).toBe(true)
      expect(body.totalLines).toBeGreaterThan(500)
      expect(body.text.split('\n').length).toBeLessThanOrEqual(500)
    })

    it.skipIf(!gitOk)('marks binary files with isBinary=true and empty text', async () => {
      seedRepo(dir) // blob.bin is committed as SEED.bin (contains NUL bytes)
      writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 9, 9, 0, 9, 9]))
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=blob.bin`)
      const body = await json<{ isBinary: boolean; text: string }>(res)
      expect(body.isBinary).toBe(true)
      expect(body.text).toBe('')
    })

    it.skipIf(!gitOk)('404 when cwd is not a git repo', async () => {
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=a.txt`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/git/log', () => {
    it.skipIf(!gitOk)('returns commits in reverse chronological order', async () => {
      seedRepo(dir) // SEED_SUBJECTS committed oldest → newest
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=10`)
      expect(res.status).toBe(200)
      const body = await json<{ commits: Array<{ subject: string; hash: string; shortHash: string; author: string; date: number }> }>(res)
      expect(body.commits).toHaveLength(SEED_SUBJECTS.length)
      expect(body.commits.map((c) => c.subject)).toEqual([...SEED_SUBJECTS].reverse())
      // Each commit has a 40-char hash and a 7-char short hash.
      for (const c of body.commits) {
        expect(c.hash).toHaveLength(40)
        expect(c.shortHash.length).toBeGreaterThanOrEqual(7)
        expect(c.author).toBe('Tester')
        expect(c.date).toBeGreaterThan(0)
      }
    })

    it.skipIf(!gitOk)('respects the limit parameter', async () => {
      seedRepo(dir) // 3 commits; ask for fewer
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=2`)
      const body = await json<{ commits: unknown[] }>(res)
      expect(body.commits).toHaveLength(2)
    })

    it.skipIf(!gitOk)('clamps unreasonable limits server-side', async () => {
      seedRepo(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=99999`)
      const body = await json<{ commits: unknown[] }>(res)
      // Clamping shouldn't change the result count when the repo has fewer
      // commits than the limit, but the call must succeed (i.e. didn't try to
      // ask git for 99999 commits literally).
      expect(body.commits).toHaveLength(SEED_SUBJECTS.length)
    })

    it.skipIf(!gitOk)('400 for limit=0 or negative', async () => {
      seedRepo(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=0`)
      expect(res.status).toBe(400)
    })

    it.skipIf(!gitOk)('404 when cwd is not a git repo', async () => {
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}`)
      expect(res.status).toBe(404)
    })
  })

  // ── Path validation unit tests (no git invocation) ───────────────
  describe('validateRepoRelativePath', () => {
    it('rejects empty', () => {
      expect(() => validateRepoRelativePath('')).toThrow(/required/)
    })
    it('rejects absolute paths', () => {
      expect(() => validateRepoRelativePath('/etc/passwd')).toThrow(/relative/)
    })
    it('rejects paths with .. segments', () => {
      expect(() => validateRepoRelativePath('foo/../../etc/passwd')).toThrow(/\.\./)
      expect(() => validateRepoRelativePath('../etc/passwd')).toThrow(/\.\./)
    })
    it('accepts simple relative paths', () => {
      expect(validateRepoRelativePath('src/foo.ts')).toBe('src/foo.ts')
      expect(validateRepoRelativePath('README.md')).toBe('README.md')
    })
    it('normalises ./ prefixes', () => {
      // normalize() strips the ./, leaving the bare path. Cross-platform
      // assertion: both forward and back slashes should resolve identically.
      const result = validateRepoRelativePath('./src/foo.ts')
      expect(result === 'src/foo.ts' || result === 'src\\foo.ts'.replace(/\\/g, '/')).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Write operations. These test the git.ts functions directly rather
  // than going through the route layer, since the route layer is a thin
  // shell over them and the per-route concerns (param parsing, confirm
  // tokens) are simple enough to spot-check separately.
  // ─────────────────────────────────────────────────────────────────────
  describe('write operations', () => {
    describe('stageFiles / unstageFiles', () => {
      it.skipIf(!gitOk)('moves a file from unstaged to staged and back', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'changed\n')

        // Pre-stage: file is unstaged.
        let s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.staged).toEqual([])
        expect(s.unstaged.map((f) => f.path)).toEqual(['a.txt'])

        await stageFiles(dir, ['a.txt'])
        s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.staged.map((f) => f.path)).toEqual(['a.txt'])
        expect(s.unstaged).toEqual([])

        await unstageFiles(dir, ['a.txt'])
        s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.staged).toEqual([])
        expect(s.unstaged.map((f) => f.path)).toEqual(['a.txt'])
      })

      // stageFiles runs ensureGitRepo() before validating its paths, so these
      // two still need a real repo to reach the validation they assert on.
      it.skipIf(!gitOk)('stageFiles errors on empty paths array', async () => {
        seedRepo(dir)
        await expect(stageFiles(dir, [])).rejects.toThrow(/empty/)
      })

      it.skipIf(!gitOk)('rejects path traversal', async () => {
        seedRepo(dir)
        await expect(stageFiles(dir, ['../etc/passwd'])).rejects.toThrow(/\.\./)
      })
    })

    describe('discardTracked / discardUntracked', () => {
      it.skipIf(!gitOk)('discardTracked restores file content from HEAD', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'modified\n')

        await discardTracked(dir, ['a.txt'])

        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(SEED.a)
        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.unstaged).toEqual([])
      })

      it.skipIf(!gitOk)('discardUntracked deletes loose untracked files', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'new.txt'), 'never tracked\n')

        await discardUntracked(dir, ['new.txt'])

        expect(existsSync(join(dir, 'new.txt'))).toBe(false)
        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.untracked).toEqual([])
      })
    })

    describe('commitChanges', () => {
      it.skipIf(!gitOk)('creates a commit with the given message', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'second\n')
        await stageFiles(dir, ['a.txt'])

        await commitChanges(dir, 'second commit', false)

        const log = execFileSync('git', ['log', '--format=%s', '-1'], { cwd: dir, encoding: 'utf8' }).trim()
        expect(log).toBe('second commit')
        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.staged).toEqual([])
      })

      it.skipIf(!gitOk)('amend rewrites the last commit message', async () => {
        seedRepo(dir) // HEAD subject is SEED_SUBJECTS.at(-1)

        await commitChanges(dir, 'replaced msg', true)

        const log = execFileSync('git', ['log', '--format=%s', '-1'], { cwd: dir, encoding: 'utf8' }).trim()
        expect(log).toBe('replaced msg')
      })

      it.skipIf(!gitOk)('rejects empty messages on non-amend commits', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        await stageFiles(dir, ['a.txt'])
        await expect(commitChanges(dir, '   ', false)).rejects.toThrow(/required/)
      })

      it.skipIf(!gitOk)('rejects oversized commit messages', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        await stageFiles(dir, ['a.txt'])
        const big = 'x'.repeat(8 * 1024 + 1)
        await expect(commitChanges(dir, big, false)).rejects.toThrow(/too long/)
      })
    })

    describe('stash operations', () => {
      it.skipIf(!gitOk)('create / list / pop round-trip preserves work', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'wip\n')

        await stashCreate(dir, 'my wip', false)
        // worktree should be back to HEAD
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(SEED.a)

        const stashes = await listStashes(dir)
        expect(stashes).toHaveLength(1)
        expect(stashes[0].index).toBe(0)
        expect(stashes[0].message).toContain('my wip')

        await stashPop(dir, 0)
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('wip\n')
        expect(await listStashes(dir)).toEqual([])
      })

      it.skipIf(!gitOk)('drop removes the stash without restoring work', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'lost work\n')

        await stashCreate(dir, undefined, false)
        await stashDrop(dir, 0)

        expect(await listStashes(dir)).toEqual([])
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(SEED.a)
      })

      it.skipIf(!gitOk)('stashCreate errors when nothing to stash', async () => {
        seedRepo(dir) // clean work tree
        await expect(stashCreate(dir, undefined, false)).rejects.toThrow(/No local changes/)
      })

      it.skipIf(!gitOk)('includeUntracked picks up new files', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'new.txt'), 'untracked\n')

        await stashCreate(dir, undefined, true)
        expect(existsSync(join(dir, 'new.txt'))).toBe(false)

        await stashPop(dir, 0)
        expect(existsSync(join(dir, 'new.txt'))).toBe(true)
      })
    })

    describe('branch operations', () => {
      it.skipIf(!gitOk)('createBranch + listBranches round-trip', async () => {
        seedRepo(dir)

        await createBranch(dir, 'feat/x', false)
        const branches = await listBranches(dir)
        const names = branches.map((b) => b.name).sort()
        expect(names).toEqual(['feat/x', 'main', SEED_BRANCH].sort())
        const main = branches.find((b) => b.name === 'main')
        expect(main?.current).toBe(true)
      })

      it.skipIf(!gitOk)('checkoutBranch switches HEAD', async () => {
        seedRepo(dir) // ships SEED_BRANCH alongside main

        const result = await checkoutBranch(dir, SEED_BRANCH, false)
        expect(result.stashed).toBe(false)
        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.branch).toBe(SEED_BRANCH)
      })

      // The conflict scenario the next two tests need — two branches holding
      // different versions of a.txt — is baked into the template, so a local
      // edit to a.txt is all it takes to make `checkout SEED_BRANCH` collide.
      // Building it per test (branch + stage + commit + checkout back) was
      // this file's two slowest cases at 15.4s and 9.6s.
      it.skipIf(!gitOk)('checkoutBranch with autoStash:true stashes conflicting changes', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'local-uncommitted\n')

        const result = await checkoutBranch(dir, SEED_BRANCH, true)
        expect(result.stashed).toBe(true)
        const stashes = await listStashes(dir)
        expect(stashes).toHaveLength(1)
        expect(stashes[0].message).toMatch(/auto-stash/)

        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.branch).toBe(SEED_BRANCH)
      })

      it.skipIf(!gitOk)('checkoutBranch without autoStash refuses on conflict', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'local-uncommitted\n')

        await expect(checkoutBranch(dir, SEED_BRANCH, false)).rejects.toThrow(/uncommitted changes|local changes/i)
      })
    })

    describe('validateBranchName', () => {
      it.skipIf(!gitOk)('accepts a normal branch name', async () => {
        await expect(validateBranchName('feat/x-1')).resolves.toBeUndefined()
      })

      it.skipIf(!gitOk)('rejects names with spaces', async () => {
        await expect(validateBranchName('has space')).rejects.toThrow(/invalid/)
      })

      it.skipIf(!gitOk)('rejects names starting with dash', async () => {
        await expect(validateBranchName('-foo')).rejects.toThrow(/invalid/)
      })

      it('rejects empty name', async () => {
        await expect(validateBranchName('')).rejects.toThrow(/required/)
      })
    })

    describe('abortMerge', () => {
      it.skipIf(!gitOk)('errors out when no merge is in progress', async () => {
        seedRepo(dir)
        // git merge --abort on a non-merging repo exits non-zero — we
        // surface that as HttpError(500) via runGit's catch path.
        await expect(abortMerge(dir)).rejects.toThrow()
      })
    })

    // ── Session anchor capture (tryCaptureGitHead) + staged-diff helper
    describe('tryCaptureGitHead', () => {
      it.skipIf(!gitOk)('returns the HEAD SHA in a normal repo', async () => {
        seedRepo(dir)
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBe(seedShas().at(-1))
      })

      it.skipIf(!gitOk)('returns undefined for a non-git directory', async () => {
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBeUndefined()
      })

      // The one case the template can't serve: it has commits by construction.
      it.skipIf(!gitOk)('returns undefined for an unborn HEAD', async () => {
        gitInit(dir)
        // No commits yet ?HEAD points at refs/heads/main but it doesn't exist.
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBeUndefined()
      })

      it.skipIf(!gitOk)('returns the SHA when HEAD is detached', async () => {
        seedRepo(dir)
        const root = seedShas()[0]
        execFileSync('git', ['checkout', '--quiet', root], { cwd: dir })
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBe(root)
      })
    })

    describe('tryCaptureRepoRoot', () => {
      it.skipIf(!gitOk)('returns the work-tree top level inside a repo', async () => {
        seedRepo(dir)
        const root = await tryCaptureRepoRoot(dir)
        // git rev-parse --show-toplevel returns forward slashes on Windows;
        // use realpathSync.native to resolve 8.3 short paths (GEZELI~1 → Ge Zelin)
        // so the comparison works regardless of how the OS canonicalises.
        expect(root).toBe(realpathSync.native(dir).replace(/\\/g, '/'))
      })

      it.skipIf(!gitOk)('resolves subdirectory cwd to the repo root', async () => {
        seedRepo(dir)
        const sub = join(dir, 'packages', 'app')
        await mkdir(sub, { recursive: true })
        const root = await tryCaptureRepoRoot(sub)
        expect(root).toBe(realpathSync.native(dir).replace(/\\/g, '/'))
      })

      it('returns undefined for a non-repo directory', async () => {
        // `dir` is a bare temp dir until a test seeds it.
        expect(await tryCaptureRepoRoot(dir)).toBeUndefined()
      })

      it('returns undefined for a nonexistent directory', async () => {
        expect(await tryCaptureRepoRoot(join(tmpdir(), 'crw-does-not-exist-' + Math.random()))).toBeUndefined()
      })
    })

    describe('getStagedDiff', () => {
      it.skipIf(!gitOk)('returns the staged diff and ignores unstaged changes', async () => {
        seedRepo(dir)
        // Stage a change to a.txt; leave loose.txt as an unstaged new file.
        writeFileSync(join(dir, 'a.txt'), 'staged\n')
        execFileSync('git', ['add', 'a.txt'], { cwd: dir })
        writeFileSync(join(dir, 'loose.txt'), 'unstaged\n')

        const r = await getStagedDiff(dir)
        expect(r.truncated).toBe(false)
        expect(r.text).toContain('a.txt')
        // Unstaged loose.txt must NOT appear ?Generate runs against `--cached` only.
        expect(r.text).not.toContain('loose.txt')
      })

      it.skipIf(!gitOk)('returns an empty string when nothing is staged', async () => {
        seedRepo(dir)
        writeFileSync(join(dir, 'a.txt'), 'unstaged-only\n')

        const r = await getStagedDiff(dir)
        expect(r.text).toBe('')
        expect(r.truncated).toBe(false)
      })

      it.skipIf(!gitOk)('truncates oversized staged diffs', async () => {
        seedRepo(dir)
        // Make a large change (~30 KB) so we're past MAX_AI_DIFF_BYTES (16 KB).
        const big = Array.from({ length: 1500 }, (_, i) => `new line ${i}`).join('\n') + '\n'
        writeFileSync(join(dir, 'a.txt'), big)
        execFileSync('git', ['add', 'a.txt'], { cwd: dir })

        const r = await getStagedDiff(dir)
        expect(r.text).toContain('diff --git')
        expect(r.truncated).toBe(true)
        expect(r.text).toContain('[diff truncated')
      })
    })
  })
})

describe('listWorktrees', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('git-wt')
  })
  afterEach(() => {
    void rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  })

  // git reports worktree paths as their resolvable realpath, whereas
  // tempDir() sits under os.tmpdir() (a symlink like /var → /private/var
  // on macOS). Normalise the expected path the same way existing tests do
  // (realpathSync.native) before matching against git's output.
  // git reports worktree paths as their resolvable realpath, whereas
  // tempDir() sits under os.tmpdir() (a symlink like /var → /private/var
  // on macOS). Normalise dir (exists) to its realpath and build the
  // worktree path off that, so it matches what git prints.
  const wtPath = (name: string): string => join(realpathSync.native(dir), '.claude', 'worktrees', name)

  it.skipIf(!gitOk)('lists the primary worktree plus a linked worktree', async () => {
    seedRepo(dir)
    execFileSync('git', ['worktree', 'add', wtPath('feature-auth'), '-b', 'worktree-feature-auth', 'main'], { cwd: dir })

    const wts = await listWorktrees(dir)
    const primary = wts.find((w) => realpathSync.native(w.path) === realpathSync.native(dir))
    const linked = wts.find((w) => realpathSync.native(w.path) === realpathSync.native(wtPath('feature-auth')))
    expect(primary?.branch).toBe('main')
    expect(primary?.locked).toBe(false)
    expect(linked?.branch).toBe('worktree-feature-auth')
    expect(linked?.locked).toBe(false)
  })

  it.skipIf(!gitOk)('reports a locked linked worktree with its lock message', async () => {
    seedRepo(dir)
    execFileSync('git', ['worktree', 'add', wtPath('feature-auth'), '-b', 'worktree-feature-auth', 'main'], { cwd: dir })
    execFileSync('git', ['worktree', 'lock', wtPath('feature-auth'), '--reason', 'claude session feature-auth (pid 123)'], { cwd: dir })

    const wts = await listWorktrees(dir)
    const linked = wts.find((w) => realpathSync.native(w.path) === realpathSync.native(wtPath('feature-auth')))
    expect(linked?.locked).toBe(true)
    expect(linked?.lockMessage).toContain('claude session feature-auth')
  })

  it.skipIf(!gitOk)('detects a lock even when no --reason was given (bare `locked` line)', async () => {
    seedRepo(dir)
    execFileSync('git', ['worktree', 'add', wtPath('feature-auth'), '-b', 'worktree-feature-auth', 'main'], { cwd: dir })
    execFileSync('git', ['worktree', 'lock', wtPath('feature-auth')], { cwd: dir })

    const wts = await listWorktrees(dir)
    const linked = wts.find((w) => realpathSync.native(w.path) === realpathSync.native(wtPath('feature-auth')))
    expect(linked?.locked).toBe(true)
    expect(linked?.lockMessage).toBeNull()
  })

  it.skipIf(!gitOk)('exposes linked worktrees through getStatusInRepo', async () => {
    seedRepo(dir)
    execFileSync('git', ['worktree', 'add', wtPath('feature-auth'), '-b', 'worktree-feature-auth', 'main'], { cwd: dir })

    const status = await getStatusInRepo(dir)
    expect(status.linkedWorktrees.some((w) => w.branch === 'worktree-feature-auth')).toBe(true)
  })
})

describe('getRangeDiff', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('git-range')
  })
  afterEach(() => {
    void rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  })

  /** Add a linked worktree on a new branch off main. Returns its path. */
  function addWorktree(cwd: string): string {
    const wt = join(realpathSync.native(cwd), '.claude', 'worktrees', 'feature-auth')
    execFileSync('git', ['worktree', 'add', wt, '-b', 'worktree-feature-auth', 'main'], { cwd })
    return wt
  }

  // Seeded repo + a linked worktree whose branch commits two changes atop a
  // main that stays put: a.txt modified, added.txt added. `added.txt` is
  // deliberately NOT a template file — the A-status assertion needs a path
  // that main has never tracked.
  function seed(cwd: string): { wt: string } {
    seedRepo(cwd)
    const wt = addWorktree(cwd)
    writeFileSync(join(wt, 'a.txt'), 'alpha2\n')
    writeFileSync(join(wt, 'added.txt'), 'beta\n')
    gitCommitAll(wt, 'feature work')
    return { wt }
  }

  it.skipIf(!gitOk)('lists files changed between refs with status + +/- counts', async () => {
    seed(dir)
    const files = await getRangeDiffFiles(dir, 'main', 'worktree-feature-auth')
    const a = files.find((f) => f.path === 'a.txt')
    const added = files.find((f) => f.path === 'added.txt')
    expect(a?.status).toBe('M')
    expect(a?.insertions).toBe(1)
    expect(a?.deletions).toBe(1)
    expect(added?.status).toBe('A')
    expect(added?.insertions).toBe(1)
    expect(added?.deletions).toBe(0)
  })

  it.skipIf(!gitOk)('returns an empty list when the two refs are identical', async () => {
    // Comparing main to itself needs no branch at all.
    seedRepo(dir)
    const files = await getRangeDiffFiles(dir, 'main', 'main')
    expect(files).toEqual([])
  })

  it.skipIf(!gitOk)('parses a renamed file on the branch (numstat -z rename encoding)', async () => {
    seedRepo(dir)
    const wt = addWorktree(dir)
    // Pure rename on the branch: a.txt → c.txt (R100).
    execFileSync('git', ['mv', 'a.txt', 'c.txt'], { cwd: wt })
    gitCommitAll(wt, 'rename')
    const files = await getRangeDiffFiles(dir, 'main', 'worktree-feature-auth')
    const renamed = files.find((f) => f.path === 'c.txt')
    expect(renamed?.status).toBe('R')
    expect(renamed?.renamedFrom).toBe('a.txt')
    // The renamed-from source is not a separate entry.
    expect(files.some((f) => f.path === 'a.txt')).toBe(false)
  })

  it.skipIf(!gitOk)('mergeBase (three-dot) reports the branch work; tip (two-dot) also shows main-only changes', async () => {
    seedRepo(dir)
    const wt = addWorktree(dir)
    // branch adds added.txt (its own work)…
    writeFileSync(join(wt, 'added.txt'), 'beta\n')
    gitCommitAll(wt, 'branch work')
    // …while main moves ahead after the fork (a change NOT on the branch).
    writeFileSync(join(dir, 'a.txt'), 'a1-main\n')
    gitCommitAll(dir, 'main moved')

    const threeDot = await getRangeDiffFiles(dir, 'main', 'worktree-feature-auth', true)
    expect(threeDot.some((f) => f.path === 'added.txt')).toBe(true)
    expect(threeDot.some((f) => f.path === 'a.txt')).toBe(false)

    const twoDot = await getRangeDiffFiles(dir, 'main', 'worktree-feature-auth', false)
    expect(twoDot.some((f) => f.path === 'a.txt')).toBe(true)
  })

  it.skipIf(!gitOk)('returns the unified diff body for a single file (clipped at the cap)', async () => {
    seed(dir)
    const d = await getRangeDiffFile(dir, 'main', 'worktree-feature-auth', 'a.txt')
    expect(d.text).toContain('-alpha')
    expect(d.text).toContain('+alpha2')
    expect(d.isBinary).toBe(false)
    expect(d.truncated).toBe(false)
  })
})

describe('trimGitErrorOutput', () => {
  // Pure formatter — no git spawn, so no gitOk gate.
  it('keeps a tail-anchored hook verdict when output exceeds the cap', () => {
    // Exact layout of the diagnosed commitlint failure: the commit-msg hook
    // LEADS with a full echo of the commit message and prints the verdict
    // LAST. The old head-only slice(0, 500) kept the echo and discarded the
    // verdict — the surfaced tool error then explained nothing.
    const raw =
      `--- input ---\n${'m'.repeat(700)}\n` +
      '✖ subject may not be empty [subject-empty]\n' +
      '✖ type may not be empty [type-empty]'
    const out = trimGitErrorOutput(raw)
    expect(out).toContain('subject may not be empty')
    expect(out).toContain('type may not be empty')
    expect(out).toContain('[stderr truncated]')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(500)
  })

  it('strips the SGR colour codes hooks keep even when piped', () => {
    const ESC = String.fromCharCode(27);
    expect(trimGitErrorOutput(`${ESC}[31m✖ subject may not be empty${ESC}[39m`)).toBe(
      '✖ subject may not be empty',
    )
  })

  it('passes output within the cap through unchanged', () => {
    expect(trimGitErrorOutput('nothing to commit, working tree clean')).toBe(
      'nothing to commit, working tree clean',
    )
  })
})

describe('runGit maxBuffer overflow', () => {
  it('surfaces the partial stderr instead of Node\'s bare overflow message', async () => {
    const dir = tempDir('git-maxbuf')
    seedRepo(dir)
    // `fsck --progress` always writes its progress lines to stderr (~170
    // bytes in the seeded repo), so a 64-byte maxBuffer makes execFile kill
    // the child before it finishes. Node attaches the partial stderr it
    // collected; the error must surface it (trimmed) rather than only
    // Node's own "stderr maxBuffer length exceeded" — and on Node < 20.12,
    // where the same rejection carries killed=true, it must NOT be
    // misreported as the 504 "git command timed out". The partial stderr is
    // fsck's first progress phase, which starts with "Checking" on every
    // git we support (the exact phase wording varies by git version).
    await expect(runGit(dir, ['fsck', '--progress'], { maxBuffer: 64 })).rejects.toMatchObject({
      status: 500,
      message: expect.stringMatching(/maxBuffer: Checking/),
    })
  })
})
