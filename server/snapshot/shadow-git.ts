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
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null
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
    // Ignore EPIPE from git exiting early — the execFile callback
    // already reports the real exit code.
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
}

/** Seed alternates + copy source index so first add does not rehash the world. */
export async function initShadowRepo(opts: {
  gitDir: string
  worktree: string
  scope: string
  sourceCommonDir: string
  /** Per-worktree .git dir (may differ from commonDir in linked worktrees). */
  sourceGitDir?: string
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
  // Copy the per-worktree index (sourceGitDir) when available — linked
  // worktrees have their own index that diverges from the common dir.
  // Fall back to the common dir index for the primary worktree.
  const indexSrc = opts.sourceGitDir
    ? join(opts.sourceGitDir, 'index')
    : join(opts.sourceCommonDir, 'index')
  try {
    await fs.copyFile(indexSrc, join(opts.gitDir, 'index'))
  } catch {
    // If sourceGitDir/index doesn't exist (e.g. unborn HEAD), try commonDir
    if (opts.sourceGitDir) {
      try {
        await fs.copyFile(join(opts.sourceCommonDir, 'index'), join(opts.gitDir, 'index'))
      } catch { /* seed index optional */ }
    }
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
    // Track which candidates are untracked (from ls-files --others) vs
    // tracked-but-modified (from diff-files). The size check only applies
    // to untracked files — tracked files are always captured regardless
    // of size.
    const untracked = new Set(others.stdout.split('\0').filter(Boolean))

    // Query the SOURCE repo's tracked set for the scope. Files that are
    // tracked in the source (e.g. committed or git-added mid-session) but
    // untracked in the shadow index should NOT be size-dropped or ignore-
    // dropped — they are real tracked files, just not yet in the shadow.
    let sourceTracked = new Set<string>()
    if (opts?.sourceGitDir && untracked.size > 0) {
      const st = await run(
        repo.worktree,
        ['--git-dir', opts.sourceGitDir, '--work-tree', repo.worktree, 'ls-files', '-z', '--', pathspec],
      ).catch(() => null)
      if (st) {
        sourceTracked = new Set(st.stdout.split('\0').filter(Boolean))
      }
    }

    // Ignore filter against SOURCE repo rules when available.
    // Only check files that are truly untracked in BOTH repos — files
    // tracked in the source (committed/git-added mid-session) bypass
    // both ignore and size checks.
    const trulyUntracked = new Set([...untracked].filter((f) => !sourceTracked.has(f)))
    let ignored = new Set<string>()
    if (opts?.sourceGitDir && trulyUntracked.size > 0) {
      const check = await runStdin(
        repo.worktree,
        ['--git-dir', opts.sourceGitDir, '--work-tree', repo.worktree, 'check-ignore', '--no-index', '--stdin', '-z'],
        [...trulyUntracked].join('\0') + '\0',
      ).catch(() => null)
      if (check && (check.code === 0 || check.code === 1)) {
        ignored = new Set(check.stdout.split('\0').filter(Boolean))
      }
    }
    const max = opts?.maxUntrackedBytes ?? 2 * 1024 * 1024
    const oversized: string[] = []
    for (const c of candidates) {
      // Source-tracked files bypass size checks — they are real tracked
      // files that just haven't been added to the shadow index yet.
      if (ignored.has(c) || !trulyUntracked.has(c)) continue
      try {
        const st = await fs.stat(join(repo.worktree, c))
        if (st.isFile() && st.size > max) oversized.push(c)
      } catch {
        /* ignore */
      }
    }
    // rm --cached: drop ignored files AND oversized truly-untracked files
    // from the shadow index. Source-tracked and diff-files tracked files
    // are never dropped.
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
  const r = await run(repo.worktree, args(repo, ['diff', '--name-only', '-z', '--no-renames', from, to, '--']))
  return r.stdout.split('\0').filter(Boolean)
}

/** Name-status diff: returns a map of file → status code (A/M/D/etc.).
 *  Uses NUL-delimited `-z` output so filenames with special chars work. */
export async function nameStatusDiff(repo: ShadowRepo, from: string, to: string): Promise<Map<string, string>> {
  const r = await run(repo.worktree, args(repo, ['diff', '--name-status', '-z', '--no-renames', from, to, '--']))
  return parseNameStatusZ(r.stdout)
}

export async function treeHasPath(repo: ShadowRepo, tree: string, relPath: string): Promise<boolean> {
  const r = await run(repo.worktree, args(repo, ['ls-tree', '-z', tree, '--', `:(top,literal)${relPath}`]), {
    allowExit: new Set([0, 128]),
  })
  return r.stdout.replace(/\0$/, '').length > 0
}

export async function restorePaths(repo: ShadowRepo, tree: string, relPaths: string[]): Promise<void> {
  if (!relPaths.length) return
  // --force: overwrite untracked files that would otherwise abort the
  // checkout. Batching avoids argv-length limits on large restores.
  const BATCH = 50
  for (let i = 0; i < relPaths.length; i += BATCH) {
    const batch = relPaths.slice(i, i + BATCH)
    await run(
      repo.worktree,
      args(repo, ['checkout', '--force', tree, '--', ...batch.map((p) => `:(top,literal)${p}`)]),
    )
  }
}

export async function deletePaths(_repo: ShadowRepo, absPaths: string[]): Promise<void> {
  for (const p of absPaths) {
    try {
      const st = await fs.lstat(p)
      if (!st.isFile()) {
        log.warn(`deletePaths: skipping non-file ${p} (type=${st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'other'})`)
        continue
      }
    } catch {
      // lstat failed — file already gone; nothing to do.
      continue
    }
    await fs.rm(p, { force: true })
  }
}

/** Max lines per unified-diff patch body. Matches git.ts MAX_DIFF_LINES. */
const MAX_PATCH_LINES = 500

/** Max number of files to process in structuredDiff. Prevents unbounded
 *  per-file patch spawns when the diff is very large. */
const MAX_DIFF_FILES = 200

/** Parse NUL-terminated numstat output (`-z`): each entry is `adds\tdels\tpath\0`
 *  (tabs as field separator, NUL as line terminator — NOT NUL-delimited fields).
 *  Binary files use `-\t-\tpath\0`.  Path may itself contain tabs, so we
 *  parse by finding the first two tab positions rather than splitting. */
function parseNumstatZ(raw: string): Map<string, { a: string; d: string }> {
  const map = new Map<string, { a: string; d: string }>()
  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const i1 = entry.indexOf('\t')
    if (i1 < 0) continue
    const i2 = entry.indexOf('\t', i1 + 1)
    if (i2 < 0) continue
    map.set(entry.slice(i2 + 1), { a: entry.slice(0, i1), d: entry.slice(i1 + 1, i2) })
  }
  return map
}

/** Parse NUL-delimited name-status output (`-z`): STATUS\0FILE\0 pairs. */
function parseNameStatusZ(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  const parts = raw.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    map.set(parts[i + 1], parts[i])
  }
  return map
}

/** Lighter diff that returns only aggregate stats (no per-file patches).
 *  Uses 2 bulk spawns (name-status -z + numstat -z) — no per-file patch
 *  spawns. Suitable for dryRun/rewind where patches are not needed. */
export async function diffStats(
  repo: ShadowRepo,
  from: string,
  to: string,
): Promise<{ files: string[]; insertions: number; deletions: number }> {
  const names = await nameOnlyDiff(repo, from, to)
  if (names.length === 0) return { files: [], insertions: 0, deletions: 0 }

  // Only numstat is needed for aggregate stats — the file list comes from
  // nameOnlyDiff and name-status is not used here (unlike structuredDiff
  // which needs per-file status codes for added/deleted/modified).
  const numstatBulk = await run(repo.worktree, args(repo, ['diff', '--numstat', '-z', '--no-renames', from, to, '--']))
  const numstatMap = parseNumstatZ(numstatBulk.stdout)

  let insertions = 0
  let deletions = 0
  for (const file of names) {
    const num = numstatMap.get(file)
    const a = num?.a ?? '0'
    const d = num?.d ?? '0'
    if (a !== '-') insertions += Number(a) || 0
    if (d !== '-') deletions += Number(d) || 0
  }
  return { files: names, insertions, deletions }
}

/** Structured per-file diffs between two trees (Review / GET snapshot-diff).
 *  Uses 2 bulk spawns (name-status -z + numstat -z) plus per-file unified
 *  patch spawns, truncated at MAX_PATCH_LINES. */
export async function structuredDiff(
  repo: ShadowRepo,
  from: string,
  to: string,
): Promise<Array<{ file: string; status: 'added'|'deleted'|'modified'; additions: number; deletions: number; patch?: string }>> {
  const names = await nameOnlyDiff(repo, from, to)
  if (names.length === 0) return []

  // Cap the number of files processed to prevent unbounded per-file patch
  // spawns on very large diffs. Sort for deterministic truncation.
  const capped = names.length > MAX_DIFF_FILES
  const processNames = capped ? names.sort().slice(0, MAX_DIFF_FILES) : names
  if (capped) {
    log.warn(`structuredDiff: ${names.length} files exceeds cap ${MAX_DIFF_FILES}, processing first ${MAX_DIFF_FILES}`)
  }

  // Two bulk passes: name-status and numstat for all files at once.
  const [statusBulk, numstatBulk] = await Promise.all([
    run(repo.worktree, args(repo, ['diff', '--name-status', '-z', '--no-renames', from, to, '--'])),
    run(repo.worktree, args(repo, ['diff', '--numstat', '-z', '--no-renames', from, to, '--'])),
  ])

  const statusMap = parseNameStatusZ(statusBulk.stdout)
  const numstatMap = parseNumstatZ(numstatBulk.stdout)

  const out: Array<{ file: string; status: 'added'|'deleted'|'modified'; additions: number; deletions: number; patch?: string }> = []
  for (const file of processNames) {
    const code = statusMap.get(file) ?? 'M'
    const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
    const num = numstatMap.get(file)
    const a = num?.a ?? '0'
    const d = num?.d ?? '0'
    const binary = a === '-' || d === '-'
    let patch: string | undefined
    if (!binary) {
      const p = await run(
        repo.worktree,
        args(repo, ['diff', '--unified=3', '--no-renames', from, to, '--', `:(top,literal)${file}`]),
      )
      const lines = p.stdout.split('\n')
      if (lines.length > MAX_PATCH_LINES) {
        patch = lines.slice(0, MAX_PATCH_LINES).join('\n') + '\n... (truncated)'
      } else {
        patch = p.stdout
      }
    }
    out.push({
      file,
      status,
      additions: binary ? 0 : Number(a) || 0,
      deletions: binary ? 0 : Number(d) || 0,
      patch,
    })
  }
  return out
}
