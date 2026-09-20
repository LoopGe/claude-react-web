import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join, relative, sep, isAbsolute } from 'node:path'
import { createLogger } from '../log.js'

const log = createLogger('snapshot-git')
const execFileAsync = promisify(execFile)

export interface ShadowRepo {
  gitDir: string
  worktree: string
  /** session cwd relative to worktree, posix separators; '.' when cwd === worktree */
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

/** posix-style relative scope; '.' when cwd === worktree. Rejects escapes.
 *  Normalises both paths to forward-slash so `relative()` is not confused
 *  by mixed separators (e.g. git `--show-toplevel` returns `C:/…` while
 *  Node `mkdtemp` returns `C:\…` on Windows). */
export function scopeFromCwd(worktree: string, cwd: string): string | null {
  const normWt = worktree.split(sep).join('/')
  const normCwd = cwd.split(sep).join('/')
  const rel = relative(normWt, normCwd).split(sep).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel || '.'
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
  const exists = await fs
    .access(join(opts.gitDir, 'HEAD'))
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    // Must pass --git-dir and --work-tree to init so git creates the repo
    // at the correct location (not in worktree/.git).
    await execFileAsync('git', ['--git-dir', opts.gitDir, '--work-tree', opts.worktree, 'init'], {
      cwd: opts.worktree,
      windowsHide: true,
    })
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

export async function deletePaths(_repo: ShadowRepo, absPaths: string[]): Promise<void> {
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
