import { describe, expect, it, vi } from 'vitest'
import type { GitStatus, GitStatusResponse } from '../../shared/git-types.js'

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatusResponse {
  return {
    isRepo: true,
    repoRoot: '/repo',
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    state: 'clean',
    linkedWorktrees: [],
    staged: [],
    unstaged: [],
    untracked: [],
    ...overrides,
  }
}

// Mock the git helpers so handlers run without a real repo.
const git = vi.hoisted(() => ({
  getStatus: vi.fn(async (): Promise<GitStatusResponse> => ({
    isRepo: true,
    repoRoot: '/repo',
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    state: 'clean',
    linkedWorktrees: [],
    staged: [],
    unstaged: [],
    untracked: [],
  })),
  getLog: vi.fn(async () => [{ hash: 'abc', shortHash: 'abc', author: 'a', date: 1, subject: 'm' }]),
  listBranches: vi.fn(async () => [{ name: 'main', current: true, upstream: null }]),
  listStashes: vi.fn(async () => []),
  stageFiles: vi.fn(async () => {}),
  unstageFiles: vi.fn(async () => {}),
  discardTracked: vi.fn(async () => {}),
  discardUntracked: vi.fn(async () => {}),
  commitChanges: vi.fn(async () => {}),
  abortMerge: vi.fn(async () => {}),
  abortRebase: vi.fn(async () => {}),
  stashCreate: vi.fn(async () => {}),
  stashPop: vi.fn(async () => {}),
  stashDrop: vi.fn(async () => {}),
  createBranch: vi.fn(async () => ({ stashed: false })),
  checkoutBranch: vi.fn(async () => ({ stashed: false })),
  validateRepoRelativePath: vi.fn((p: string) => p),
  validateBranchName: vi.fn(async () => {}),
}))

vi.mock('../git.js', () => git)

import { buildAppToolsTools, buildAppToolsServer, APP_TOOLS_SERVER_NAME } from './app-tools.js'

const CWD = '/repo'

function byName(name: string) {
  const def = buildAppToolsTools(CWD).find((t) => t.name === name)
  if (!def) throw new Error(`tool ${name} not found`)
  return def
}

describe('app-tools in-process git server', () => {
  it('names the server apptools', () => {
    expect(APP_TOOLS_SERVER_NAME).toBe('apptools')
    expect(buildAppToolsServer(CWD).name).toBe('apptools')
  })

  it('exposes the expected git tool set', () => {
    const names = buildAppToolsTools(CWD).map((t) => t.name)
    for (const want of [
      'git_status', 'git_branches', 'git_stashes', 'git_log',
      'git_stage', 'git_unstage', 'git_discard', 'git_commit',
      'git_stash_create', 'git_stash_pop', 'git_stash_drop',
      'git_abort_merge', 'git_abort_rebase',
      'git_branch_create', 'git_checkout',
    ]) {
      expect(names).toContain(want)
    }
  })

  it('marks read-only tools with readOnlyHint and leaves writes unannotated', () => {
    const tools = buildAppToolsTools(CWD)
    for (const readOnlyName of ['git_status', 'git_branches', 'git_stashes', 'git_log']) {
      const def = tools.find((t) => t.name === readOnlyName)!
      expect(def.annotations?.readOnlyHint).toBe(true)
    }
    for (const writeName of ['git_stage', 'git_discard', 'git_commit', 'git_checkout']) {
      const def = tools.find((t) => t.name === writeName)!
      expect(def.annotations?.readOnlyHint ?? false).toBe(false)
    }
  })

  it('git_status surfaces the repo status text', async () => {
    const res = await byName('git_status').handler({}, undefined)
    expect(res.isError ?? false).toBe(false)
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    expect(text).toContain('"branch": "main"')
    expect(git.getStatus).toHaveBeenCalledWith(CWD)
  })

  it('git_stage validates paths then stages them', async () => {
    const res = await byName('git_stage').handler({ paths: ['a.txt', '../escape'] }, undefined)
    expect(git.validateRepoRelativePath).toHaveBeenCalledWith('a.txt')
    expect(git.stageFiles).toHaveBeenCalledWith(CWD, ['a.txt', '../escape'])
    expect(res.isError ?? false).toBe(false)
  })

  it('git_discard routes untracked paths to discardUntracked and tracked to discardTracked', async () => {
    git.getStatus.mockResolvedValueOnce(makeStatus({
      untracked: [{ path: 'new.txt', status: '?', staged: false, unstaged: true }],
    }))
    const res = await byName('git_discard').handler({ paths: ['new.txt', 'tracked.txt'] }, undefined)
    expect(git.discardTracked).toHaveBeenCalledWith(CWD, ['tracked.txt'])
    expect(git.discardUntracked).toHaveBeenCalledWith(CWD, ['new.txt'])
    expect(res.isError ?? false).toBe(false)
  })

  it('git_discard answers isError when the cwd is not a repo', async () => {
    git.getStatus.mockResolvedValueOnce({ isRepo: false })
    const res = await byName('git_discard').handler({ paths: ['a.txt'] }, undefined)
    expect(res.isError).toBe(true)
    expect(res.content[0].type === 'text' ? res.content[0].text : '').toMatch(/not a git repository/i)
  })

  it('surfaces a rejected git helper as isError instead of rejecting', async () => {
    git.stageFiles.mockRejectedValueOnce(new Error('not a git repository'))
    const res = await byName('git_stage').handler({ paths: ['a.txt'] }, undefined)
    expect(res.isError).toBe(true)
    expect(res.content[0].type === 'text' ? res.content[0].text : '').toContain('not a git repository')
  })

  it('git_commit passes the message through', async () => {
    await byName('git_commit').handler({ message: 'fix: thing' }, undefined)
    expect(git.commitChanges).toHaveBeenCalledWith(CWD, 'fix: thing', false)
  })

  it('git_checkout creates the branch when create is true', async () => {
    await byName('git_checkout').handler({ branch: 'feat/x', create: true }, undefined)
    expect(git.createBranch).toHaveBeenCalledWith(CWD, 'feat/x', true)
    expect(git.checkoutBranch).not.toHaveBeenCalled()
  })
})