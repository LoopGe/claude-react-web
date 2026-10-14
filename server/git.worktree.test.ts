// @vitest-environment node
import { execFile as execFileCb } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupGitFixtures, makeRepo, worktreePathUnder } from './test-git-fixtures.js'
import {
  branchExists, commitExists, createWorktree, getGitCommonDir,
  listWorktrees, removeWorktreeDir, worktreeIsDirty,
} from './git.js'

const execFile = promisify(execFileCb)

afterAll(async () => {
  await cleanupGitFixtures()
})

describe('worktree primitives', () => {
  it('creates a linked worktree on a new branch and reports it', async () => {
    const repo = await makeRepo()
    const wt = await worktreePathUnder(repo, 'wt-a')
    await createWorktree(repo, wt, 'crw/test1', 'HEAD', true)
    expect(await branchExists(repo, 'crw/test1')).toBe(true)
    const listed = await listWorktrees(repo)
    const realWt = await fsPromises.realpath(wt)
    expect(listed.some((w) => w.path === realWt)).toBe(true)
  })

  it('recreates a worktree on an existing branch (newBranch=false)', async () => {
    const repo = await makeRepo()
    const wt = await worktreePathUnder(repo, 'wt-b')
    await createWorktree(repo, wt, 'crw/test2', 'HEAD', true)
    await removeWorktreeDir(repo, wt)
    expect(await branchExists(repo, 'crw/test2')).toBe(true) // branch survives removal
    await createWorktree(repo, wt, 'crw/test2', '', false)   // baseRef unused — checkout by branch name
    expect(await branchExists(repo, 'crw/test2')).toBe(true)
  })

  it('worktreeIsDirty reflects uncommitted changes', async () => {
    const repo = await makeRepo()
    const wt = await worktreePathUnder(repo, 'wt-c')
    await createWorktree(repo, wt, 'crw/test3', 'HEAD', true)
    expect(await worktreeIsDirty(wt)).toBe(false)
    await fsPromises.writeFile(join(wt, 'b.txt'), 'x\n')
    expect(await worktreeIsDirty(wt)).toBe(true)
  })

  it('getGitCommonDir resolves to the shared object store', async () => {
    const repo = await makeRepo()
    const wt = await worktreePathUnder(repo, 'wt-d')
    await createWorktree(repo, wt, 'crw/test4', 'HEAD', true)
    const common = await getGitCommonDir(wt)
    const repoCommon = await getGitCommonDir(repo)
    expect(await fsPromises.realpath(common)).toBe(await fsPromises.realpath(repoCommon))
  })

  it('commitExists verifies sha and rejects junk', async () => {
    const repo = await makeRepo()
    const head = (await execFile('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
    expect(await commitExists(repo, head)).toBe(true)
    expect(await commitExists(repo, '0'.repeat(40))).toBe(false)
  })

  it('listWorktrees sees worktrees when queried FROM a linked worktree cwd (regression)', async () => {
    const repo = await makeRepo()
    const wt = await worktreePathUnder(repo, 'wt-e')
    await createWorktree(repo, wt, 'crw/test5', 'HEAD', true)
    // Before the common-dir probe fix: probing <toplevel>/.git/worktrees from
    // a worktree cwd (where .git is a FILE) always came up empty.
    const listed = await listWorktrees(wt)
    expect(listed.length).toBeGreaterThanOrEqual(1)
  })
})
