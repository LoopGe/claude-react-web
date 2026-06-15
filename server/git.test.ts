import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
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
  getStagedDiff,
} from './git.js'
import { Hono } from 'hono'
import { createErrorHandler } from './errors.js'
import { tempDir } from './__test-utils__/index.js'

// Git process startup is noticeably slower on Windows under the full Vitest
// pool, so keep the git integration suite from flaking at the 5s default.
vi.setConfig({ testTimeout: 20_000 })
// Probe git availability synchronously at module load so `it.skipIf(...)`
// ?evaluated at registration time, not run time ?sees the correct value.
// An async beforeAll would set `gitOk` too late; the skip flags would have
// already crystallised at the initial `false` and skipped the whole suite.
const gitOk = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Initialise an empty git repo with deterministic identity. We pass
 *  config via -c so the test environment doesn't need a global gitconfig.
 *  `init.defaultBranch=main` keeps the branch name stable across git
 *  versions (older git defaulted to "master"). */
function gitInit(cwd: string): void {
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet'], { cwd })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd })
  // Windows: disable autocrlf so checkout preserves LF instead of
  // converting to CRLF. Otherwise our `expect('orig\n')` assertions
  // get '\r\n' back and fail.
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd })
}

function gitCommitAll(cwd: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd })
  execFileSync('git', ['commit', '-m', message, '--quiet', '--no-gpg-sign'], { cwd })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
}

/** Build a Hono app wrapping the git router with the same onError hook
 *  the production app uses, so HttpError — JSON conversion is exercised. */
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
      gitInit(dir)
      writeFileSync(join(dir, 'README.md'), '# hi\n')
      gitCommitAll(dir, 'init')
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
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'a-orig\n')
      writeFileSync(join(dir, 'b.txt'), 'b-orig\n')
      gitCommitAll(dir, 'init')

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
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      gitCommitAll(dir, 'init')
      writeFileSync(join(dir, 'a.txt'), 'a-changed\n')
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ state: string }>(res)
      expect(body.state).toBe('dirty')
    })

    it.skipIf(!gitOk)('handles paths with spaces and unicode via -z parsing', async () => {
      gitInit(dir)
      const weird = 'has spaces and 中文 $.txt'
      writeFileSync(join(dir, weird), 'hi')
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ untracked: Array<{ path: string }> }>(res)
      expect(body.untracked).toHaveLength(1)
      expect(body.untracked[0].path).toBe(weird)
    })

    it.skipIf(!gitOk)('detects renames and exposes renamedFrom', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'old.txt'), 'content\n')
      gitCommitAll(dir, 'init')
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
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      const sha1 = gitCommitAll(dir, 'first')
      writeFileSync(join(dir, 'a.txt'), 'b\n')
      gitCommitAll(dir, 'second')
      execFileSync('git', ['checkout', '--quiet', sha1], { cwd: dir })
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ branch: string | null; detached: boolean }>(res)
      expect(body.branch).toBeNull()
      expect(body.detached).toBe(true)
    })

    it.skipIf(!gitOk)('reports rebasing state via .git marker file', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      gitCommitAll(dir, 'init')
      // Manually drop a rebase-merge dir ?simulating an in-progress rebase
      // without having to actually trigger conflict resolution.
      mkdirSync(join(dir, '.git', 'rebase-merge'), { recursive: true })
      const app = buildApp()
      const res = await app.request(`/api/git/status?cwd=${encodeURIComponent(dir)}`)
      const body = await json<{ state: string }>(res)
      expect(body.state).toBe('rebasing')
    })
  })

  describe('GET /api/git/diff', () => {
    it.skipIf(!gitOk)('400 when path is missing', async () => {
      gitInit(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}`)
      expect(res.status).toBe(400)
    })

    it.skipIf(!gitOk)('400 when path tries to escape the repo', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'x\n')
      gitCommitAll(dir, 'init')
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=${encodeURIComponent('../etc/passwd')}`)
      expect(res.status).toBe(400)
      expect((await json(res)).error).toMatch(/\.\./)
    })

    it.skipIf(!gitOk)('400 when path is absolute', async () => {
      gitInit(dir)
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=${encodeURIComponent('/etc/passwd')}`)
      expect(res.status).toBe(400)
    })

    it.skipIf(!gitOk)('returns a unified diff for a worktree change', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
      gitCommitAll(dir, 'init')
      writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
      const app = buildApp()
      const res = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=a.txt`)
      expect(res.status).toBe(200)
      const body = await json<{ text: string; truncated: boolean; isBinary: boolean }>(res)
      expect(body.text).toContain('-two')
      expect(body.text).toContain('+TWO')
      expect(body.truncated).toBe(false)
      expect(body.isBinary).toBe(false)
    })

    it.skipIf(!gitOk)('returns a staged diff when staged=1', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      gitCommitAll(dir, 'init')
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'three\n')
      const app = buildApp()
      const staged = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=a.txt&staged=1`)
      const stagedBody = await json<{ text: string }>(staged)
      const worktree = await app.request(`/api/git/diff?cwd=${encodeURIComponent(dir)}&path=a.txt&staged=0`)
      const worktreeBody = await json<{ text: string }>(worktree)
      // staged: HEAD ?index   (one ?two)
      expect(stagedBody.text).toContain('-one')
      expect(stagedBody.text).toContain('+two')
      // worktree: index ?working tree   (two ?three)
      expect(worktreeBody.text).toContain('-two')
      expect(worktreeBody.text).toContain('+three')
    })

    it.skipIf(!gitOk)('truncates diffs longer than the line cap', async () => {
      gitInit(dir)
      const lines: string[] = []
      for (let i = 0; i < 700; i++) lines.push(`orig-${i}`)
      writeFileSync(join(dir, 'big.txt'), lines.join('\n') + '\n')
      gitCommitAll(dir, 'init')
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
      gitInit(dir)
      // Binary content: a few NUL bytes guarantee git classifies it as binary.
      writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 4]))
      gitCommitAll(dir, 'init')
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
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), '1\n')
      gitCommitAll(dir, 'first')
      writeFileSync(join(dir, 'a.txt'), '2\n')
      gitCommitAll(dir, 'second')
      writeFileSync(join(dir, 'a.txt'), '3\n')
      gitCommitAll(dir, 'third')
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=10`)
      expect(res.status).toBe(200)
      const body = await json<{ commits: Array<{ subject: string; hash: string; shortHash: string; author: string; date: number }> }>(res)
      expect(body.commits).toHaveLength(3)
      expect(body.commits.map((c) => c.subject)).toEqual(['third', 'second', 'first'])
      // Each commit has a 40-char hash and a 7-char short hash.
      for (const c of body.commits) {
        expect(c.hash).toHaveLength(40)
        expect(c.shortHash.length).toBeGreaterThanOrEqual(7)
        expect(c.author).toBe('Tester')
        expect(c.date).toBeGreaterThan(0)
      }
    })

    it.skipIf(!gitOk)('respects the limit parameter', async () => {
      gitInit(dir)
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(dir, 'a.txt'), `v${i}\n`)
        gitCommitAll(dir, `c${i}`)
      }
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=2`)
      const body = await json<{ commits: unknown[] }>(res)
      expect(body.commits).toHaveLength(2)
    })

    it.skipIf(!gitOk)('clamps unreasonable limits server-side', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'x\n')
      gitCommitAll(dir, 'only')
      const app = buildApp()
      const res = await app.request(`/api/git/log?cwd=${encodeURIComponent(dir)}&limit=99999`)
      const body = await json<{ commits: unknown[] }>(res)
      // We have one commit; clamping shouldn't matter for the result count
      // here, but the call must succeed (i.e. didn't try to ask git for
      // 99999 commits literally).
      expect(body.commits).toHaveLength(1)
    })

    it.skipIf(!gitOk)('400 for limit=0 or negative', async () => {
      gitInit(dir)
      writeFileSync(join(dir, 'a.txt'), 'x\n')
      gitCommitAll(dir, 'init')
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
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
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

      it.skipIf(!gitOk)('stageFiles errors on empty paths array', async () => {
        gitInit(dir)
        await expect(stageFiles(dir, [])).rejects.toThrow(/empty/)
      })

      it.skipIf(!gitOk)('rejects path traversal', async () => {
        gitInit(dir)
        await expect(stageFiles(dir, ['../etc/passwd'])).rejects.toThrow(/\.\./)
      })
    })

    describe('discardTracked / discardUntracked', () => {
      it.skipIf(!gitOk)('discardTracked restores file content from HEAD', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'original\n')
        gitCommitAll(dir, 'init')
        writeFileSync(join(dir, 'a.txt'), 'modified\n')

        await discardTracked(dir, ['a.txt'])

        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original\n')
        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.unstaged).toEqual([])
      })

      it.skipIf(!gitOk)('discardUntracked deletes loose untracked files', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'committed\n')
        gitCommitAll(dir, 'init')
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
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'first\n')
        gitCommitAll(dir, 'first')
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
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'orig msg')

        await commitChanges(dir, 'replaced msg', true)

        const log = execFileSync('git', ['log', '--format=%s', '-1'], { cwd: dir, encoding: 'utf8' }).trim()
        expect(log).toBe('replaced msg')
      })

      it.skipIf(!gitOk)('rejects empty messages on non-amend commits', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        await stageFiles(dir, ['a.txt'])
        await expect(commitChanges(dir, '   ', false)).rejects.toThrow(/required/)
      })

      it.skipIf(!gitOk)('rejects oversized commit messages', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        await stageFiles(dir, ['a.txt'])
        const big = 'x'.repeat(8 * 1024 + 1)
        await expect(commitChanges(dir, big, false)).rejects.toThrow(/too long/)
      })
    })

    describe('stash operations', () => {
      it.skipIf(!gitOk)('create / list / pop round-trip preserves work', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
        writeFileSync(join(dir, 'a.txt'), 'wip\n')

        await stashCreate(dir, 'my wip', false)
        // worktree should be back to HEAD
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('orig\n')

        const stashes = await listStashes(dir)
        expect(stashes).toHaveLength(1)
        expect(stashes[0].index).toBe(0)
        expect(stashes[0].message).toContain('my wip')

        await stashPop(dir, 0)
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('wip\n')
        expect(await listStashes(dir)).toEqual([])
      })

      it.skipIf(!gitOk)('drop removes the stash without restoring work', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
        writeFileSync(join(dir, 'a.txt'), 'lost work\n')

        await stashCreate(dir, undefined, false)
        await stashDrop(dir, 0)

        expect(await listStashes(dir)).toEqual([])
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('orig\n')
      })

      it.skipIf(!gitOk)('stashCreate errors when nothing to stash', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        gitCommitAll(dir, 'init')
        await expect(stashCreate(dir, undefined, false)).rejects.toThrow(/No local changes/)
      })

      it.skipIf(!gitOk)('includeUntracked picks up new files', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
        writeFileSync(join(dir, 'new.txt'), 'untracked\n')

        await stashCreate(dir, undefined, true)
        expect(existsSync(join(dir, 'new.txt'))).toBe(false)

        await stashPop(dir, 0)
        expect(existsSync(join(dir, 'new.txt'))).toBe(true)
      })
    })

    describe('branch operations', () => {
      it.skipIf(!gitOk)('createBranch + listBranches round-trip', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        gitCommitAll(dir, 'init')

        await createBranch(dir, 'feat/x', false)
        const branches = await listBranches(dir)
        const names = branches.map((b) => b.name).sort()
        expect(names).toEqual(['feat/x', 'main'])
        const main = branches.find((b) => b.name === 'main')
        expect(main?.current).toBe(true)
      })

      it.skipIf(!gitOk)('checkoutBranch switches HEAD', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        gitCommitAll(dir, 'init')
        await createBranch(dir, 'other', false)

        const result = await checkoutBranch(dir, 'other', false)
        expect(result.stashed).toBe(false)
        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.branch).toBe('other')
      })

      it.skipIf(!gitOk)('checkoutBranch with autoStash:true stashes conflicting changes', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'committed\n')
        gitCommitAll(dir, 'init')
        // Create a branch with a different version of a.txt to set up
        // a conflict scenario.
        await createBranch(dir, 'other', true)
        writeFileSync(join(dir, 'a.txt'), 'on-other\n')
        await stageFiles(dir, ['a.txt'])
        await commitChanges(dir, 'other-version', false)
        // Back to main, modify a.txt locally ?switching to 'other'
        // would now overwrite the local change.
        await checkoutBranch(dir, 'main', false)
        writeFileSync(join(dir, 'a.txt'), 'local-uncommitted\n')

        const result = await checkoutBranch(dir, 'other', true)
        expect(result.stashed).toBe(true)
        const stashes = await listStashes(dir)
        expect(stashes).toHaveLength(1)
        expect(stashes[0].message).toMatch(/auto-stash/)

        const s = await getStatus(dir)
        if (!s.isRepo) throw new Error('expected repo')
        expect(s.branch).toBe('other')
      })

      it.skipIf(!gitOk)('checkoutBranch without autoStash refuses on conflict', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'committed\n')
        gitCommitAll(dir, 'init')
        await createBranch(dir, 'other', true)
        writeFileSync(join(dir, 'a.txt'), 'on-other\n')
        await stageFiles(dir, ['a.txt'])
        await commitChanges(dir, 'other-version', false)
        await checkoutBranch(dir, 'main', false)
        writeFileSync(join(dir, 'a.txt'), 'local-uncommitted\n')

        await expect(checkoutBranch(dir, 'other', false)).rejects.toThrow(/uncommitted changes|local changes/i)
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
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'x\n')
        gitCommitAll(dir, 'init')
        // git merge --abort on a non-merging repo exits non-zero — we
        // surface that as HttpError(500) via runGit's catch path.
        await expect(abortMerge(dir)).rejects.toThrow()
      })
    })

    // ── Session anchor capture (tryCaptureGitHead) + staged-diff helper
    describe('tryCaptureGitHead', () => {
      it.skipIf(!gitOk)('returns the HEAD SHA in a normal repo', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'hi\n')
        const sha = gitCommitAll(dir, 'init')
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBe(sha)
      })

      it.skipIf(!gitOk)('returns undefined for a non-git directory', async () => {
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBeUndefined()
      })

      it.skipIf(!gitOk)('returns undefined for an unborn HEAD', async () => {
        gitInit(dir)
        // No commits yet ?HEAD points at refs/heads/main but it doesn't exist.
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBeUndefined()
      })

      it.skipIf(!gitOk)('returns the SHA when HEAD is detached', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'first\n')
        const sha1 = gitCommitAll(dir, 'first')
        writeFileSync(join(dir, 'a.txt'), 'second\n')
        gitCommitAll(dir, 'second')
        execFileSync('git', ['checkout', '--quiet', sha1], { cwd: dir })
        const captured = await tryCaptureGitHead(dir)
        expect(captured).toBe(sha1)
      })
    })

    describe('getStagedDiff', () => {
      it.skipIf(!gitOk)('returns the staged diff and ignores unstaged changes', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
        // Stage a change to a.txt; leave b.txt as an unstaged new file.
        writeFileSync(join(dir, 'a.txt'), 'staged\n')
        execFileSync('git', ['add', 'a.txt'], { cwd: dir })
        writeFileSync(join(dir, 'b.txt'), 'unstaged\n')

        const r = await getStagedDiff(dir)
        expect(r.truncated).toBe(false)
        expect(r.text).toContain('a.txt')
        // Unstaged b.txt must NOT appear ?Generate runs against `--cached` only.
        expect(r.text).not.toContain('b.txt')
      })

      it.skipIf(!gitOk)('returns an empty string when nothing is staged', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
        writeFileSync(join(dir, 'a.txt'), 'unstaged-only\n')

        const r = await getStagedDiff(dir)
        expect(r.text).toBe('')
        expect(r.truncated).toBe(false)
      })

      it.skipIf(!gitOk)('truncates oversized staged diffs', async () => {
        gitInit(dir)
        writeFileSync(join(dir, 'a.txt'), 'orig\n')
        gitCommitAll(dir, 'init')
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
