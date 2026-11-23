// Session-scoped file search for composer @file/@folder mentions.
//
// Git-first: `ls-files -z --cached --others --exclude-standard` lists tracked
// + untracked-non-ignored paths (respects .gitignore — the improvement over a
// plain fs walk). Non-repo or git failure falls back to a bounded fs walk with
// a basename exclusion list. Directory candidates are derived from file-path
// parents; a directory-scoped query (`a/b/`) lists LIVE directory state via
// readdir. Fuzzy rank: exact > prefix > substring > subsequence, with a
// directory bonus inside each tier.
//
// Hard rules: never read file contents (path strings only), every result is
// containment-checked against the session cwd, and `..`-segment / absolute
// queries are rejected outright (root-escape guard).

import { promises as fs, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { runGit } from './git.js'
import { isPathInside } from '../shared/app-plugins/path-security.js'
import { createLogger } from './log.js'

const log = createLogger('file-search')

export interface FileSearchResult {
  path: string
  dir: boolean
}

/** Hard result cap regardless of the requested limit. */
const MAX_RESULTS = 20
/** Entry budget for the non-repo fs walk (files + directories visited). */
const WALK_ENTRY_CAP = 50_000
/** Basenames the walk never descends into. */
const WALK_EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', 'target', '__pycache__', '.venv', 'venv',
])
const IS_WINDOWS = process.platform === 'win32'

/** Search `cwd` for paths matching `q`. Results are `/`-normalized, relative
 *  to `cwd`, containment-checked, and ranked (≤ `limit`, hard-capped at 20).
 *  A trailing `/` on `q` switches to live directory listing of that dir. */
export async function searchFiles(cwd: string, q: string, limit = MAX_RESULTS): Promise<FileSearchResult[]> {
  const query = q.trim().replace(/\\/g, '/')
  if (!query) return []
  // Root-escape guard: reject traversal and absolute queries before any
  // filesystem or git work. Candidates themselves are cwd-relative, so this
  // is the only place an escape could enter.
  if (query.startsWith('/') || query.split('/').includes('..')) return []
  const cap = Math.max(1, Math.min(limit, MAX_RESULTS))

  const results = query.endsWith('/')
    ? await listDir(cwd, query.slice(0, -1), cap)
    : rank(await listFiles(cwd), query, cap)
  // Spec-mandated containment fence on the way out (cheap: ≤ cap entries).
  return results.filter((r) => isPathInside(resolve(cwd, r.path), cwd, { isWindows: IS_WINDOWS }))
}

/** Git-first file listing; non-repo (exit 128) or any git failure falls back
 *  to the bounded fs walk. */
async function listFiles(cwd: string): Promise<string[]> {
  try {
    const r = await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      allowExitCodes: new Set([128]),
    })
    if (r.exitCode === 0) return r.stdout.split('\0').filter((p) => p.length > 0)
    log.debug(`ls-files exited ${r.exitCode} in ${cwd}; falling back to fs walk`)
  } catch (err) {
    log.debug(`ls-files failed in ${cwd} (${(err as Error).message}); falling back to fs walk`)
  }
  return walkFiles(cwd)
}

/** Bounded depth-first walk. Unreadable subdirectories are skipped (real on
 *  locked-down trees); a failure at the ROOT propagates — a vanished cwd is
 *  an error worth surfacing, not an empty result. Symlinked dirs are not
 *  descended (dirent.isDirectory() is false for them), so cycles are impossible. */
async function walkFiles(cwd: string): Promise<string[]> {
  const files: string[] = []
  let entries = 0
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(join(cwd, rel), { withFileTypes: true })
    } catch (err) {
      if (rel === '') throw err
      log.debug(`walk: skipping unreadable dir ${rel} in ${cwd}: ${(err as Error).message}`)
      continue
    }
    for (const d of dirents) {
      if (++entries > WALK_ENTRY_CAP) {
        log.debug(`walk: entry cap ${WALK_ENTRY_CAP} reached in ${cwd}; returning partial list`)
        return files
      }
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (!WALK_EXCLUDED_DIRS.has(d.name)) stack.push(childRel)
      } else {
        files.push(childRel)
      }
    }
  }
  return files
}

/** Live listing of one directory (the `a/b/` drill state). The resolved dir
 *  must stay inside cwd; a missing dir is the ordinary typing state → []. */
async function listDir(cwd: string, relDir: string, cap: number): Promise<FileSearchResult[]> {
  const abs = resolve(cwd, relDir)
  if (!isPathInside(abs, cwd, { isWindows: IS_WINDOWS })) return []
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return dirents
    .map((d) => ({ path: relDir ? `${relDir}/${d.name}` : d.name, dir: d.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || cmp(a.path, b.path))
    .slice(0, cap)
}

/** Fuzzy rank over files + their parent directories. Tiers: exact (basename
 *  or full path) > prefix > substring > subsequence; inside a tier directories
 *  come first, then shorter paths, then lexicographic for determinism. */
function rank(files: string[], query: string, cap: number): FileSearchResult[] {
  const q = query.toLowerCase()
  const dirs = new Set<string>()
  for (const f of files) {
    let i = f.lastIndexOf('/')
    while (i > 0) {
      const d = f.slice(0, i)
      if (dirs.has(d)) break // parents were added when d was first seen
      dirs.add(d)
      i = d.lastIndexOf('/')
    }
  }

  const scored: Array<{ path: string; dir: boolean; tier: number }> = []
  const consider = (path: string, dir: boolean): void => {
    const p = path.toLowerCase()
    const base = p.slice(p.lastIndexOf('/') + 1)
    let tier: number
    if (base === q || p === q) tier = 0
    else if (base.startsWith(q) || p.startsWith(q)) tier = 1
    else if (p.includes(q)) tier = 2
    else if (isSubsequence(q, p)) tier = 3
    else return
    scored.push({ path, dir, tier })
  }
  for (const f of files) consider(f, false)
  for (const d of dirs) consider(d, true)

  scored.sort((a, b) => a.tier - b.tier || Number(b.dir) - Number(a.dir) || a.path.length - b.path.length || cmp(a.path, b.path))
  return scored.slice(0, cap).map(({ path, dir }) => ({ path, dir }))
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
