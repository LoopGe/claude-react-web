// @vitest-environment node
import { execFile as execFileCb } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { promisify } from 'node:util'
import { HttpError } from './errors.js'
import { branchExists, commitExists } from './git.js'
import {
  branchFor, ensureWorktreeForResume, provisionWorktree,
  removeWorktreeForSession, withRepoLock, worktreePathFor, worktreePathOf,
} from './session-worktree.js'
import type { WorktreeInfo } from '../shared/session-info.js'
import {
  cleanupGitFixtures, makeEmptyRepo, makeRepo, mkdtempUnderTmp,
} from './test-git-fixtures.js'

const execGit = async (dir: string, args: string[]): Promise<string> =>
  (await promisify(execFileCb)('git', ['-C', dir, ...args])).stdout.trim()

afterAll(() => cleanupGitFixtures())

/** Provision a worktree for `sessionId` off `repo`'s HEAD and build the
 *  WorktreeInfo the resume/cleanup functions take. */
async function provisioned(repo: string, sessionId: string) {
  const stateDir = await mkdtempUnderTmp('crw-swt-')
  const p = await provisionWorktree(stateDir, sessionId, repo)
  const wt: WorktreeInfo = { mainRepoPath: repo, branch: p.branch, baseSha: p.baseSha }
  return { stateDir, ...p, wt }
}

describe('worktreePathFor / branchFor', () => {
  it('derives the worktree path and branch name from the session id', () => {
    expect(worktreePathFor('/state', 'sess-1234-abcd')).toBe('/state/worktrees/sess-1234-abcd')
    expect(branchFor('sess-1234-abcd')).toBe('crw/sess-123')
  })
})

describe('worktreePathOf', () => {
  it('prefers the recorded path over the id-derived one', () => {
    const wt: WorktreeInfo = { mainRepoPath: '/repo', branch: 'crw/x', baseSha: 'h', path: '/elsewhere/wt' }
    expect(worktreePathOf('/state', 'sess-1', wt)).toBe('/elsewhere/wt')
  })

  it('falls back to the id-derived path for legacy metas (no path)', () => {
    const wt: WorktreeInfo = { mainRepoPath: '/repo', branch: 'crw/x', baseSha: 'h' }
    expect(worktreePathOf('/state', 'sess-1', wt)).toBe(worktreePathFor('/state', 'sess-1'))
  })
})

describe('provisionWorktree', () => {
  it('creates the worktree dir + branch and reports the main-repo HEAD as baseSha', async () => {
    const repo = await makeRepo()
    const head = await execGit(repo, ['rev-parse', 'HEAD'])
    const stateDir = await mkdtempUnderTmp('crw-swt-')

    const p = await provisionWorktree(stateDir, 'prov-aaaa-1', repo)

    expect(p.worktreePath).toBe(worktreePathFor(stateDir, 'prov-aaaa-1'))
    expect(p.branch).toBe('crw/prov-aaa')
    expect(p.baseSha).toBe(head)
    await expect(fsPromises.access(p.worktreePath)).resolves.toBeUndefined()
    expect(await branchExists(repo, p.branch)).toBe(true)
  })

  it('throws HttpError 400 mentioning git for a non-repo cwd', async () => {
    const notARepo = await mkdtempUnderTmp('crw-nogit-')
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    const err = await provisionWorktree(stateDir, 'prov-bbbb-1', notARepo).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).message).toContain('git')
  })

  it('throws HttpError 400 mentioning commit for an empty (unborn HEAD) repo', async () => {
    const repo = await makeEmptyRepo()
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    const err = await provisionWorktree(stateDir, 'prov-cccc-1', repo).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).message).toContain('commit')
  })

  it('surfaces a failed worktree add as HttpError 400 with git stderr', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    // Block the target path: git refuses `worktree add` onto a non-empty dir
    // ("fatal: '<path>' already exists"), a user-input failure — not a server
    // fault, so the spec's error table maps it to 400, not runGit's 500.
    const target = worktreePathFor(stateDir, 'prov-dddd-1')
    await fsPromises.mkdir(target, { recursive: true })
    await fsPromises.writeFile(join(target, 'occupied.txt'), 'x\n')

    const err = await provisionWorktree(stateDir, 'prov-dddd-1', repo).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).message).toContain('already exists')
  })

  it('appends a timestamp suffix when the derived branch name is taken', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    const first = await provisionWorktree(stateDir, 'dup-dddd-1', repo)
    // Same 8-char prefix, different session id → same base branch name.
    const second = await provisionWorktree(stateDir, 'dup-dddd-2', repo)
    expect(second.branch).not.toBe(first.branch)
    expect(second.branch.startsWith('crw/dup-dddd')).toBe(true)
  })
})

describe('ensureWorktreeForResume', () => {
  it('returns the worktree as-is when the directory still exists', async () => {
    const repo = await makeRepo()
    const { stateDir, worktreePath, wt } = await provisioned(repo, 'res-aaaa-1')
    const r = await ensureWorktreeForResume(stateDir, 'res-aaaa-1', wt)
    expect(r.cwd).toBe(worktreePath)
    expect(r.worktree).toBe(wt)
  })

  it('recreates the worktree from the surviving branch when the dir was deleted', async () => {
    const repo = await makeRepo()
    const { stateDir, worktreePath, wt } = await provisioned(repo, 'res-bbbb-1')
    // Realistic manual deletion: plain rm leaves a stale worktree
    // registration behind — recreate must survive it.
    await fsPromises.rm(worktreePath, { recursive: true, force: true })
    expect(await branchExists(repo, wt.branch)).toBe(true)

    const r = await ensureWorktreeForResume(stateDir, 'res-bbbb-1', wt)

    expect(r.cwd).toBe(worktreePath)
    expect(r.worktree).toBe(wt)
    await expect(fsPromises.access(worktreePath)).resolves.toBeUndefined()
    expect(await branchExists(repo, wt.branch)).toBe(true)
  })

  it('recreates the same-named branch from baseSha when the branch was deleted too', async () => {
    const repo = await makeRepo()
    const { stateDir, worktreePath, wt } = await provisioned(repo, 'res-cccc-1')
    await fsPromises.rm(worktreePath, { recursive: true, force: true })
    // Clear the stale registration first — git refuses to delete a branch
    // that a registered worktree still references.
    await execGit(repo, ['worktree', 'prune'])
    await execGit(repo, ['branch', '-D', wt.branch])
    expect(await branchExists(repo, wt.branch)).toBe(false)
    expect(await commitExists(repo, wt.baseSha)).toBe(true) // still reachable from main HEAD

    const r = await ensureWorktreeForResume(stateDir, 'res-cccc-1', wt)

    expect(r.cwd).toBe(worktreePath)
    expect(r.worktree).toBe(wt)
    expect(await branchExists(repo, wt.branch)).toBe(true)
  })

  it('recreates at the recorded path when the session id differs (/clear inheritance)', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    // X provisioned at a dir named after X; Y (new id) inherits X's meta —
    // the recreate must rebuild at the RECORDED dir, not the id-derived one.
    const p = await provisionWorktree(stateDir, 'inh-aaaa-x', repo)
    const wt: WorktreeInfo = { mainRepoPath: repo, branch: p.branch, baseSha: p.baseSha, path: p.worktreePath }
    await fsPromises.rm(p.worktreePath, { recursive: true, force: true })

    const r = await ensureWorktreeForResume(stateDir, 'inh-aaaa-y', wt)

    expect(r.cwd).toBe(p.worktreePath)
    expect(r.worktree).toBe(wt)
    await expect(fsPromises.access(p.worktreePath)).resolves.toBeUndefined()
  })

  it('falls back to the main repo when the branch and baseSha are both gone', async () => {
    const repo = await makeRepo()
    const { stateDir, worktreePath } = await provisioned(repo, 'res-dddd-1')
    await fsPromises.rm(worktreePath, { recursive: true, force: true })
    // Hand-built metadata pointing at a branch and commit that never existed.
    const wt: WorktreeInfo = { mainRepoPath: repo, branch: 'crw/nonexistent', baseSha: '0'.repeat(40) }

    const r = await ensureWorktreeForResume(stateDir, 'res-dddd-1', wt)

    expect(r).toEqual({ cwd: repo, worktree: undefined })
  })

  it('falls back to the main repo when the main repo directory is gone', async () => {
    const repo = await makeRepo()
    const { stateDir, worktreePath, wt } = await provisioned(repo, 'res-eeee-1')
    await fsPromises.rm(worktreePath, { recursive: true, force: true })
    await fsPromises.rm(repo, { recursive: true, force: true })

    const r = await ensureWorktreeForResume(stateDir, 'res-eeee-1', wt)

    expect(r).toEqual({ cwd: wt.mainRepoPath, worktree: undefined })
  })
})

describe('removeWorktreeForSession', () => {
  it('removes the worktree dir but keeps the branch', async () => {
    const repo = await makeRepo()
    const { stateDir, worktreePath, wt } = await provisioned(repo, 'rm-aaaa-1')
    const warnings: string[] = []
    await removeWorktreeForSession(stateDir, 'rm-aaaa-1', wt, { warn: (m) => warnings.push(m) })
    await expect(fsPromises.access(worktreePath)).rejects.toThrow()
    expect(await branchExists(repo, wt.branch)).toBe(true)
    expect(warnings).toEqual([])
  })

  it('removes the dir recorded in meta.path even when named after another session', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    // /clear inheritance: the meta was created under X but is held by Y —
    // cleanup must remove the RECORDED dir, not the id-derived one.
    const p = await provisionWorktree(stateDir, 'inh-bbbb-x', repo)
    const wt: WorktreeInfo = { mainRepoPath: repo, branch: p.branch, baseSha: p.baseSha, path: p.worktreePath }
    const warnings: string[] = []

    await removeWorktreeForSession(stateDir, 'inh-bbbb-y', wt, { warn: (m) => warnings.push(m) })

    await expect(fsPromises.access(p.worktreePath)).rejects.toThrow()
    expect(await branchExists(repo, wt.branch)).toBe(true)
    expect(warnings).toEqual([])
  })

  it('is a no-op when the worktree dir is already gone', async () => {
    const repo = await makeRepo()
    const { stateDir, wt } = await provisioned(repo, 'rm-bbbb-1')
    const warnings: string[] = []
    await removeWorktreeForSession(stateDir, 'rm-bbbb-1', wt, { warn: (m) => warnings.push(m) })
    // Nothing removed (dir already absent) — no warning either.
    expect(warnings).toEqual([])
    expect(await branchExists(repo, wt.branch)).toBe(true)
  })

  it('logs a warning instead of throwing when the main repo is gone', async () => {
    const repo = await makeRepo()
    const { stateDir, wt } = await provisioned(repo, 'rm-cccc-1')
    await fsPromises.rm(repo, { recursive: true, force: true })
    const warnings: string[] = []
    await expect(
      removeWorktreeForSession(stateDir, 'rm-cccc-1', wt, { warn: (m) => warnings.push(m) }),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('rm-cccc-1')
  })
})

describe('withRepoLock', () => {
  it('serializes concurrent sections under the same key', async () => {
    let inside = 0
    let maxInside = 0
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withRepoLock('lock-key-a', async () => {
          inside++
          maxInside = Math.max(maxInside, inside)
          await new Promise((r) => setTimeout(r, 5))
          inside--
        })),
    )
    expect(maxInside).toBe(1)
  })

  it('does not serialize sections under different keys', async () => {
    let inside = 0
    let sawOverlap = false
    await Promise.all([
      withRepoLock('lock-key-x', async () => {
        inside++
        await new Promise((r) => setTimeout(r, 20))
        inside--
      }),
      withRepoLock('lock-key-y', async () => {
        // Enters while the other key's section is still inside.
        await new Promise((r) => setTimeout(r, 5))
        if (inside > 0) sawOverlap = true
      }),
    ])
    expect(sawOverlap).toBe(true)
  })

  it('provisions three sessions against the same repo concurrently, all succeed', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtempUnderTmp('crw-swt-')
    const results = await Promise.all([
      provisionWorktree(stateDir, 'mtx-aaaa-1', repo),
      provisionWorktree(stateDir, 'mtx-bbbb-1', repo),
      provisionWorktree(stateDir, 'mtx-cccc-1', repo),
    ])
    for (const p of results) {
      await expect(fsPromises.access(p.worktreePath)).resolves.toBeUndefined()
      expect(await branchExists(repo, p.branch)).toBe(true)
    }
    expect(new Set(results.map((p) => p.worktreePath)).size).toBe(3)
    expect(new Set(results.map((p) => p.branch)).size).toBe(3)
  })
})
