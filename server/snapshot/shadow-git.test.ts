import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { odbDir, metaFile, snapshotRoot } from './paths.js'
import {
  initShadowRepo, captureTree, nameOnlyDiff, treeHasPath,
  restorePaths, deletePaths, diffStats, structuredDiff,
  scopeFromCwd,
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
    // Reset scope to baseline so t1 captures the original content
    await writeFile(join(worktree, 'scope', 'a.txt'), 'one\n')
    await rm(join(worktree, 'scope', 'new.txt')).catch(() => {})
    // Re-seed the shadow index from the source so captureTree sees the baseline
    await copyFile(join(sourceGitDir, 'index'), join(gitDir, 'index')).catch(() => {})
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

  it('diffStats returns file list and aggregate line counts without patches', async () => {
    await writeFile(join(worktree, 'scope', 'a.txt'), 'one\n')
    await rm(join(worktree, 'scope', 'new.txt')).catch(() => {})
    await copyFile(join(sourceGitDir, 'index'), join(gitDir, 'index')).catch(() => {})
    const t1 = await captureTree(repo, { sourceGitDir })
    await writeFile(join(worktree, 'scope', 'a.txt'), 'modified\n')
    await writeFile(join(worktree, 'scope', 'extra.txt'), 'new\n')
    const t2 = await captureTree(repo, { sourceGitDir })
    const stats = await diffStats(repo, t1!, t2!)
    expect(stats.files.sort()).toEqual(['scope/a.txt', 'scope/extra.txt'])
    expect(stats.insertions).toBeGreaterThan(0)
    expect(stats.deletions).toBeGreaterThan(0)
  })

  it('structuredDiff and nameOnlyDiff handle non-ASCII filenames', async () => {
    await writeFile(join(worktree, 'scope', 'a.txt'), 'one\n')
    await rm(join(worktree, 'scope', 'new.txt')).catch(() => {})
    await copyFile(join(sourceGitDir, 'index'), join(gitDir, 'index')).catch(() => {})
    const t1 = await captureTree(repo, { sourceGitDir })
    // Create a file with non-ASCII characters in the name
    await writeFile(join(worktree, 'scope', '测试.ts'), 'export const x = 1\n')
    const t2 = await captureTree(repo, { sourceGitDir })
    const files = await nameOnlyDiff(repo, t1!, t2!)
    expect(files).toContain('scope/测试.ts')
    const stats = await diffStats(repo, t1!, t2!)
    expect(stats.files).toContain('scope/测试.ts')
    expect(stats.insertions).toBeGreaterThan(0)
    const diffs = await structuredDiff(repo, t1!, t2!)
    const found = diffs.find((d) => d.file === 'scope/测试.ts')
    expect(found).toBeDefined()
    expect(found!.status).toBe('added')
    expect(found!.additions).toBeGreaterThan(0)
  })

  it('deletePaths skips directories and symlinks (never recursive)', async () => {
    const { mkdir: mk } = await import('node:fs/promises')
    const dirPath = join(worktree, 'scope', 'subdir')
    const filePath = join(worktree, 'scope', 'file.txt')
    await mk(dirPath, { recursive: true })
    await writeFile(join(dirPath, 'inside.txt'), 'x\n')
    await writeFile(filePath, 'y\n')
    // Should skip the directory and delete only the file
    await deletePaths(repo, [dirPath, filePath])
    // Directory and its contents should still exist
    await expect(access(dirPath)).resolves.toBeUndefined()
    await expect(access(join(dirPath, 'inside.txt'))).resolves.toBeUndefined()
    // Regular file should be deleted
    await expect(access(filePath)).rejects.toThrow()
    // Cleanup
    await rm(dirPath, { recursive: true, force: true })
  })

  it('keeps the full diagnostic when a bad rev errors past the old cap', async () => {
    // A corrupt/pruned snapshot surfaces here as `fatal: bad revision '…'`
    // with the offending rev embedded (~430 bytes for a 400-char rev). The
    // old head-only slice(0, 300) beheaded the rev's TAIL, hiding which
    // rev was bad; the whole diagnostic must survive.
    const bogus = 'x'.repeat(400) + 'deadbeef'
    await expect(nameOnlyDiff(repo, bogus, 'HEAD')).rejects.toThrow(/bad revision.*deadbeef/)
  })
})

describe('scopeFromCwd', () => {
  it('returns "." when cwd equals worktree', () => {
    expect(scopeFromCwd('/repo', '/repo')).toBe('.')
  })

  it('returns relative path for subdirectory', () => {
    expect(scopeFromCwd('/repo', '/repo/src')).toBe('src')
  })

  it('rejects paths outside worktree', () => {
    expect(scopeFromCwd('/repo', '/other')).toBeNull()
  })

  it('rejects absolute paths', () => {
    expect(scopeFromCwd('/repo', 'C:\\other')).toBeNull()
  })

  it('allows directory names starting with ".." (not escaping)', () => {
    // A directory literally named "..backup" inside the worktree
    expect(scopeFromCwd('/repo', '/repo/..backup')).toBe('..backup')
  })

  it('rejects actual ".." escape', () => {
    expect(scopeFromCwd('/repo/src', '/repo')).toBeNull()
  })

  it('rejects "../" escape', () => {
    expect(scopeFromCwd('/repo/src', '/repo/other')).toBeNull()
  })
})
