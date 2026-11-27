// Behavior pin for the host-side CLAUDE.md chain reader (the native memory
// port). Every test builds real fixture dirs and injects configDir, so the
// developer's own ~/.claude is never read. The ancestor walks reach the real
// filesystem root above tmpdir; the fixtures place no memory files there.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createMemoryReader } from './native-host-memory.js'

const dirs: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-memory-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Write a fixture file, creating parent dirs as needed. */
function write(dir: string, rel: string, content: string): string {
  const path = join(dir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** A normal repo root: a real `.git` DIRECTORY. */
function repoRoot(base: string, name = 'repo'): string {
  const root = join(base, name)
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

/** A linked worktree at `wtDir` whose `.git` is a POINTER FILE naming
 *  `<origin>/.git/worktrees/<name>` (created as a real dir, like git does). */
function worktree(origin: string, wtDir: string, name = 'wt'): string {
  const gitdir = join(origin, '.git', 'worktrees', name)
  mkdirSync(gitdir, { recursive: true })
  mkdirSync(wtDir, { recursive: true })
  writeFileSync(join(wtDir, '.git'), `gitdir: ${gitdir}\n`)
  return wtDir
}

describe('createMemoryReader', () => {
  it('loads user file first, then ancestors root-to-cwd', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    write(configDir, 'CLAUDE.md', 'U')
    const root = repoRoot(base)
    write(root, 'CLAUDE.md', 'R')
    const cwd = join(root, 'sub')
    write(cwd, 'CLAUDE.md', 'S')

    const result = await createMemoryReader({ configDir }).read(cwd)

    expect(result.files.map((f) => f.content)).toEqual(['U', 'R', 'S'])
    expect(result.files.map((f) => f.scope)).toEqual(['user', 'project', 'project'])
    expect(result.isGitRepo).toBe(true)
    for (const f of result.files) expect(isAbsolute(f.path)).toBe(true)
  })

  it('loads .claude/CLAUDE.md and CLAUDE.local.md variants', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    const root = repoRoot(base)
    write(root, 'CLAUDE.md', 'A')
    write(root, '.claude/CLAUDE.md', 'B')
    write(root, 'CLAUDE.local.md', 'C')

    const result = await createMemoryReader({ configDir }).read(root)

    expect(result.files.map((f) => f.content)).toEqual(['A', 'B', 'C'])
    expect(result.files.map((f) => f.scope)).toEqual(['project', 'project', 'local'])
    expect(result.files.map((f) => f.path)).toEqual([
      join(root, 'CLAUDE.md'),
      join(root, '.claude', 'CLAUDE.md'),
      join(root, 'CLAUDE.local.md'),
    ])
  })

  it('non-git cwd loads only the user file', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    write(configDir, 'CLAUDE.md', 'U')
    const cwd = join(base, 'plain')
    mkdirSync(cwd, { recursive: true })

    const result = await createMemoryReader({ configDir }).read(cwd)

    expect(result.files.map((f) => f.content)).toEqual(['U'])
    expect(result.files.map((f) => f.scope)).toEqual(['user'])
    expect(result.isGitRepo).toBe(false)
  })

  it('missing candidates are skipped silently', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    const root = repoRoot(base)

    const result = await createMemoryReader({ configDir }).read(root)

    expect(result.files).toEqual([])
    expect(result.isGitRepo).toBe(true)
  })

  it('over-cap file is skipped, siblings load', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    const root = repoRoot(base)
    write(root, 'CLAUDE.md', 'x'.repeat(1_048_577))
    write(root, 'CLAUDE.local.md', 'L')

    const result = await createMemoryReader({ configDir }).read(root)

    expect(result.files.map((f) => f.content)).toEqual(['L'])
    expect(result.files.map((f) => f.scope)).toEqual(['local'])
  })

  it('in-repo worktree: worktree version wins, origin local file loads, no double injection', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    const origin = repoRoot(base, 'origin')
    write(origin, 'CLAUDE.md', 'ORIGIN')
    write(origin, 'CLAUDE.local.md', 'LOCAL')
    const wt = worktree(origin, join(origin, '.claude', 'worktrees', 'wt'))
    write(wt, 'CLAUDE.md', 'WT')

    const result = await createMemoryReader({ configDir }).read(wt)

    expect(result.files.map((f) => f.content)).toEqual(['WT', 'LOCAL'])
    expect(result.files.filter((f) => basename(f.path) === 'CLAUDE.md')).toHaveLength(1)
    expect(result.isGitRepo).toBe(true)
  })

  it('out-of-repo worktree: full origin chain loads', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    const origin = repoRoot(base, 'origin')
    write(origin, 'CLAUDE.md', 'ORIGIN')
    write(origin, 'CLAUDE.local.md', 'LOCAL')
    write(base, 'CLAUDE.md', 'ABOVE')
    const wt = worktree(origin, join(base, 'wt'))
    write(wt, 'CLAUDE.md', 'WT')

    const result = await createMemoryReader({ configDir }).read(wt)

    expect(result.files.map((f) => f.content)).toEqual(['WT', 'LOCAL', 'ABOVE'])
    expect(result.isGitRepo).toBe(true)
  })

  it('nested subdirectory cwd keeps repo-relative dedup', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    const origin = repoRoot(base, 'origin')
    write(origin, 'CLAUDE.md', 'ORIGIN')
    write(origin, 'src/CLAUDE.md', 'OSUB')
    const wt = worktree(origin, join(base, 'wt'))
    write(wt, 'CLAUDE.md', 'WT')
    const cwd = join(wt, 'src')
    write(cwd, 'CLAUDE.md', 'SUB')

    const result = await createMemoryReader({ configDir }).read(cwd)

    expect(result.files.map((f) => f.content)).toEqual(['WT', 'SUB'])
  })

  it('mtime change invalidates the cache', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    const userFile = write(configDir, 'CLAUDE.md', 'V1')
    const cwd = join(base, 'plain')
    mkdirSync(cwd, { recursive: true })
    const reader = createMemoryReader({ configDir })

    expect((await reader.read(cwd)).files.map((f) => f.content)).toEqual(['V1'])
    writeFileSync(userFile, 'V2')
    // Same-size rewrite: the mtime bump is what must invalidate the cache.
    const bumped = new Date(Date.now() + 5_000)
    utimesSync(userFile, bumped, bumped)

    expect((await reader.read(cwd)).files.map((f) => f.content)).toEqual(['V2'])
  })

  it('malformed pointer degrades to boundary stop', async () => {
    const base = tmp()
    const configDir = join(base, 'config')
    mkdirSync(configDir, { recursive: true })
    // A parent memory file that must NOT load: the broken pointer stops the
    // walk at the worktree instead of continuing upward or jumping anywhere.
    write(base, 'CLAUDE.md', 'PARENT')
    const wt = join(base, 'wt')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), 'garbage, not a gitdir pointer\n')
    write(wt, 'CLAUDE.md', 'WT')

    const result = await createMemoryReader({ configDir }).read(wt)

    expect(result.files.map((f) => f.content)).toEqual(['WT'])
  })
})