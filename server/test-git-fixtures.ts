// Shared git test fixtures: temp main repos + linked-worktree path helpers.
//
// Extracted from server/git.worktree.test.ts so the session-worktree tests
// (and any later worktree-adjacent tests) reuse the exact same setup instead
// of growing a third copy. Every temp dir created through this module is
// registered and removed by cleanupGitFixtures() — call it in afterAll.
//
// Notes carried over from the original fixture:
// - macOS hands out /var/folders/... paths that are symlinks of
//   /private/var/... and git canonicalizes worktree paths in its output, so
//   callers comparing git-reported paths must go through realpath.
// - Worktrees should live OUTSIDE the main repo (sibling dir) to avoid
//   nested-repo confusion.

import { execFile as execFileCb } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/** Temp dirs (main repos AND worktrees) registered by this module. */
const dirs: string[] = []

/** mkdtemp under the OS tmpdir, registered for cleanup. */
export async function mkdtempUnderTmp(prefix = 'crw-wt-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A temp git repo with one commit on `main` (user identity pinned, gpgsign
 *  off). Returns the repo root. */
export async function makeRepo(): Promise<string> {
  const dir = await mkdtempUnderTmp()
  await execFile('git', ['-C', dir, 'init', '-b', 'main'])
  await execFile('git', ['-C', dir, 'config', 'user.email', 't@t.test'], { cwd: dir })
  await execFile('git', ['-C', dir, 'config', 'user.name', 't'], { cwd: dir })
  await execFile('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { cwd: dir })
  await fsPromises.writeFile(join(dir, 'a.txt'), 'hello\n')
  await execFile('git', ['-C', dir, 'add', '.'], { cwd: dir })
  await execFile('git', ['-C', dir, 'commit', '-m', 'init'], { cwd: dir })
  return dir
}

/** A temp git repo with NO commits — unborn HEAD. */
export async function makeEmptyRepo(): Promise<string> {
  const dir = await mkdtempUnderTmp()
  await execFile('git', ['-C', dir, 'init', '-b', 'main'])
  await execFile('git', ['-C', dir, 'config', 'user.email', 't@t.test'], { cwd: dir })
  await execFile('git', ['-C', dir, 'config', 'user.name', 't'], { cwd: dir })
  return dir
}

/** Worktree path OUTSIDE the main repo (sibling dir), registered for cleanup. */
export async function worktreePathUnder(repo: string, name: string): Promise<string> {
  const p = join(repo, '..', name)
  dirs.push(p)
  return p
}

/** Remove every temp dir registered by this module. */
export async function cleanupGitFixtures(): Promise<void> {
  for (const d of dirs) await fsPromises.rm(d, { recursive: true, force: true }).catch(() => {})
  dirs.length = 0
}
