// server/providers/native-worktree-port.test.ts
//
// Integration pin for the host worktree port (real git, temp repositories):
// the managed layout `<repo>/.claude/worktrees/<name>` on `worktree-<name>`,
// the adopt boundary, the dirty/unmerged inspection ExitWorktree refuses on,
// and the remove path that also drops the branch.
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../git.js'
import { createWorktreePort } from './native-host-adapters.js'

const roots: string[] = []

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'crw-worktree-port-')))
  roots.push(dir)
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 'test@example.com'])
  await runGit(dir, ['config', 'user.name', 'Test'])
  await fs.writeFile(join(dir, 'README.md'), 'hello\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10 })))
})

describe('host worktree port', () => {
  it('reports null outside a repository and lists entries inside one', async () => {
    const port = createWorktreePort()
    const outside = await fs.mkdtemp(join(tmpdir(), 'crw-not-a-repo-'))
    roots.push(outside)

    await expect(port.list(outside)).resolves.toBeNull()

    const repo = await makeRepo()
    const entries = await port.list(repo)
    expect(entries).toEqual([{ path: repo, branch: 'main' }])
  })

  it('creates the managed path on branch worktree-<name> from the current HEAD', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()

    const created = await port.create(repo, 'p0-fixes')

    expect(created).toEqual({ path: join(repo, '.claude', 'worktrees', 'p0-fixes'), branch: 'worktree-p0-fixes' })
    // A real checkout, not just a registration.
    await expect(fs.readFile(join(created.path, 'README.md'), 'utf8')).resolves.toBe('hello\n')
    const branch = await runGit(created.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(branch.stdout.trim()).toBe('worktree-p0-fixes')
    const listed = await port.list(repo)
    expect(listed?.map((entry) => entry.path)).toContain(created.path)
  })

  it('routes nested names into nested directories and flattens the branch', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()

    const created = await port.create(repo, 'p0/one')

    expect(created.path).toBe(join(repo, '.claude', 'worktrees', 'p0', 'one'))
    expect(created.branch).toBe('worktree-p0-one')
  })

  it('refuses to create over an existing directory', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()
    await port.create(repo, 'dup')

    await expect(port.create(repo, 'dup')).rejects.toThrow('already exists')
  })

  it('never reuses an occupied branch name (e.g. left by a kept ExitWorktree)', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()
    // `git worktree add -b` fails hard when the branch exists.
    await runGit(repo, ['branch', 'worktree-taken'])

    const created = await port.create(repo, 'taken')
    expect(created.branch).toMatch(/^worktree-taken-\d+$/)
  })

  it('adopts only worktrees this repo manages', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()
    const created = await port.create(repo, 'adopt-me')
    const stray = await makeRepo()

    await expect(port.adopt(repo, created.path)).resolves.toEqual(created)
    await expect(port.adopt(repo, stray)).rejects.toThrow('switching is limited to worktrees this repository manages')
    await expect(port.adopt(repo, join(repo, '.claude', 'worktrees', 'missing'))).rejects.toThrow('git lists no worktree')
  })

  it('inspects uncommitted files and commits missing from the launch checkout', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()
    const created = await port.create(repo, 'inspect-me')

    await fs.writeFile(join(created.path, 'README.md'), 'edited\n')
    await fs.writeFile(join(created.path, 'new.txt'), 'new\n')
    await expect(port.inspect(created.path, repo)).resolves.toMatchObject({ dirtyFiles: [' M README.md', '?? new.txt'], unmergedCommits: 0 })

    await runGit(created.path, ['add', '.'])
    await runGit(created.path, ['commit', '-q', '-m', 'work'])
    await expect(port.inspect(created.path, repo)).resolves.toMatchObject({ dirtyFiles: [], unmergedCommits: 1 })
  })

  it('removes a clean worktree and its branch', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()
    const created = await port.create(repo, 'clean')

    await port.remove(repo, created.path, created.branch, false)

    await expect(fs.stat(created.path)).rejects.toThrow()
    const branch = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`], { allowAnyExitCode: true })
    expect(branch.exitCode).not.toBe(0)
    await expect(port.list(repo)).resolves.toEqual([{ path: repo, branch: 'main' }])
  })

  it('force-removes a dirty worktree', async () => {
    const port = createWorktreePort()
    const repo = await makeRepo()
    const created = await port.create(repo, 'dirty')
    await fs.writeFile(join(created.path, 'README.md'), 'edited\n')

    await port.remove(repo, created.path, created.branch, true)

    await expect(fs.stat(created.path)).rejects.toThrow()
    const branch = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`], { allowAnyExitCode: true })
    expect(branch.exitCode).not.toBe(0)
  })
})
