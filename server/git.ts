// Git execution + porcelain parsing for the /api/git/* surface.
//
// Two design rules drive this file:
//
//   1. NEVER spawn git through a shell. We use child_process.execFile with
//      a fixed argv; cwd / path / limit values from the request are passed
//      as positional args, never interpolated into a command string. This
//      eliminates the entire shell-injection class even if a caller pulls
//      the cwd from somewhere user-influenced.
//
//   2. Path arguments are double-fenced: callers must already have proven
//      `path` is a relative form with no `..`, AND we always prefix the
//      path with `--` when handing it to git so a path that happens to
//      look like a ref ("HEAD", "main") cannot be reinterpreted.
//
// Output handling: stdout is read into a buffer up to MAX_BUFFER_BYTES;
// individual diff bodies are line-truncated to MAX_DIFF_LINES so the wire
// payload stays manageable even on huge file rewrites.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fsPromises } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import type {
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileEntry,
  GitFileStatus,
  GitLinkedWorktree,
  GitRangeFile,
  GitRepoState,
  GitStashEntry,
  GitStatus,
  GitStatusResponse,
} from '../shared/git-types.js'

const log = createLogger('git')
const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 10_000
import { MAX_BUFFER_BYTES } from './constants.js'
/** Per-file diff line cap. Beyond this we drop the tail and set
 *  `truncated: true` so the UI can show a clipped marker. */
const MAX_DIFF_LINES = 500
/** Server-side log limit ceiling, regardless of what the client asks for. */
const MAX_LOG_LIMIT = 100

// ── Availability probe ──────────────────────────────────────────────

let gitAvailableCache: Promise<boolean> | null = null

/** Probe whether the `git` executable is reachable from PATH. Result is
 *  cached for the lifetime of the process — git doesn't get installed or
 *  uninstalled mid-run in any realistic scenario.
 *
 *  We invoke `git --version` with no cwd dependency; failures (ENOENT,
 *  non-zero exit) are normalised to `false` rather than thrown so callers
 *  can surface a friendly "git not installed" message. */
export function isGitAvailable(): Promise<boolean> {
  if (!gitAvailableCache) {
    gitAvailableCache = execFileAsync('git', ['--version'], { timeout: 5_000 })
      .then(() => true)
      .catch((err) => {
        log.warn('git not available:', err instanceof Error ? err.message : err)
        return false
      })
  }
  return gitAvailableCache
}

// ── Low-level exec wrapper ──────────────────────────────────────────

interface RunGitOpts {
  timeoutMs?: number
  maxBuffer?: number
  /** Allowed non-zero exit codes — we'll resolve normally when git exits
   *  with one of these instead of treating it as an error. Used for
   *  commands like `rev-parse --is-inside-work-tree` where exit 128 is
   *  the documented "no repo" signal. */
  allowExitCodes?: ReadonlySet<number>
}

interface RunGitResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runGit(cwd: string, args: readonly string[], opts: RunGitOpts = {}): Promise<RunGitResult> {
  if (!(await isGitAvailable())) {
    throw new HttpError(503, 'git executable not found in PATH')
  }
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], {
      cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? MAX_BUFFER_BYTES,
      // Force UTF-8 output on Windows; -c core.quotepath=false keeps unicode
      // paths human-readable instead of \nnn-octal-escaped.
      encoding: 'utf8',
      windowsHide: true,
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean }
    // execFile rejection: `code` is a number when git exited non-zero,
    // a string like 'ENOENT' / 'ETIMEDOUT' for spawn-level failures.
    if (typeof e.code === 'number') {
      if (opts.allowExitCodes?.has(e.code)) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code }
      }
      const msg = (e.stderr || e.message || '').trim()
      throw new HttpError(500, `git exited ${e.code}: ${msg.slice(0, 500)}`)
    }
    if (e.code === 'ENOENT') {
      // Reset the availability cache so subsequent calls re-probe.
      gitAvailableCache = null
      throw new HttpError(503, 'git executable not found in PATH')
    }
    if (e.killed) {
      throw new HttpError(504, 'git command timed out')
    }
    throw new HttpError(500, `git failed: ${e.message}`)
  }
}

// ── Repo discovery ──────────────────────────────────────────────────

/** Lightweight check: is `cwd` inside a git work tree? Returns false for
 *  every non-error reason the cwd might not be one (cwd missing, no .git,
 *  exited 128, bare repo without a worktree). Throws only on infrastructure
 *  errors (timeout, executable missing). We don't pre-check existence with
 *  fs.existsSync — git itself returns exit 128 for a non-existent cwd, and
 *  the extra syscall is wasted on the WS-driven refetch hot path. */
export async function isInsideWorkTree(cwd: string): Promise<boolean> {
  if (!isAbsolute(cwd)) return false
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], {
    allowExitCodes: new Set([128]),
  })
  return r.exitCode === 0 && r.stdout.trim() === 'true'
}

/** Throwing variant for routes that require a real repo. */
export async function ensureGitRepo(cwd: string): Promise<void> {
  if (!(await isInsideWorkTree(cwd))) {
    throw new HttpError(404, 'Not a git repository')
  }
}

/** Resolve the repo's .git directory (handles linked worktrees, where
 *  it's not literally `<cwd>/.git`). Returns null if not in a repo. */
async function getGitDir(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--git-dir'], {
    allowExitCodes: new Set([128]),
  })
  if (r.exitCode !== 0) return null
  const raw = r.stdout.trim()
  if (!raw) return null
  // git can return either an absolute path or one relative to cwd.
  return isAbsolute(raw) ? raw : join(cwd, raw)
}

/** Detect in-progress merge/rebase/cherry-pick/etc by looking for the
 *  marker files git drops in $GIT_DIR. The order matters slightly —
 *  rebase markers can coexist with cherry-pick markers, and we surface
 *  whichever the user is most likely to need to abort first.
 *
 *  REBASE_HEAD is deliberately NOT checked: it can linger after a rebase
 *  is aborted or its process is killed, and git itself only reports a
 *  rebase in progress via the rebase-apply/ or rebase-merge/ dirs — a
 *  lone REBASE_HEAD is stale residue, not an active rebase. */
async function detectInProgressState(cwd: string): Promise<GitRepoState | null> {
  const gitDir = await getGitDir(cwd)
  if (!gitDir) return null
  // Use async fs.access instead of sync existsSync to avoid blocking the
  // event loop. Check all markers in parallel for speed.
  const check = async (file: string, state: GitRepoState): Promise<GitRepoState | null> => {
    try { await fsPromises.access(join(gitDir, file)); return state } catch { return null }
  }
  const results = await Promise.all([
    check('rebase-apply', 'rebasing'),
    check('rebase-merge', 'rebasing'),
    check('MERGE_HEAD', 'merging'),
    check('CHERRY_PICK_HEAD', 'cherry-picking'),
    check('REVERT_HEAD', 'reverting'),
    check('BISECT_LOG', 'bisecting'),
  ])
  return results.find((r): r is GitRepoState => r !== null) ?? null
}

// ── Status ──────────────────────────────────────────────────────────

/** Parse the `## branch...upstream [ahead N, behind M]` header line. */
function parseBranchHeader(line: string): {
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
} {
  // Detached: "## HEAD (no branch)"
  if (line.startsWith('## HEAD (no branch)') || line.startsWith('## (no branch)')) {
    return { branch: null, detached: true, upstream: null, ahead: 0, behind: 0 }
  }
  // Strip the leading "## ".
  const body = line.replace(/^##\s*/, '')
  // Split into "<local>...<upstream> [ahead 2, behind 1]" or just "<local>".
  const tracking = body.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/)
  if (!tracking) {
    // Defensive — never seen in practice.
    return { branch: body || null, detached: false, upstream: null, ahead: 0, behind: 0 }
  }
  const branch = (tracking[1] ?? '').trim() || null
  const upstream = tracking[2] ?? null
  const meta = tracking[3] ?? ''
  let ahead = 0
  let behind = 0
  if (meta) {
    const a = meta.match(/ahead\s+(\d+)/)
    const b = meta.match(/behind\s+(\d+)/)
    if (a) ahead = Number(a[1]) || 0
    if (b) behind = Number(b[1]) || 0
  }
  return { branch, detached: false, upstream, ahead, behind }
}

/** Map a single-character porcelain code to our normalised enum. The
 *  `' '` slot in either column means "no change in this column" and is
 *  filtered out before reaching here. */
function statusChar(c: string): GitFileStatus {
  switch (c) {
    case 'M': return 'M'
    case 'A': return 'A'
    case 'D': return 'D'
    case 'R': return 'R'
    case 'C': return 'C'
    case 'U': return 'U'
    case 'T': return 'T' // typechange (e.g. file → symlink)
    case '?': return '?'
    case '!': return '!'
    default: return 'M' // unknown → treat as modified rather than crash
  }
}

/** Build the public API response from a parsed list of file entries.
 *  Each entry can land in one or two of the three buckets (staged,
 *  unstaged, untracked) depending on which columns are non-blank. */
function bucketFiles(entries: GitFileEntry[]): {
  staged: GitFileEntry[]
  unstaged: GitFileEntry[]
  untracked: GitFileEntry[]
} {
  const staged: GitFileEntry[] = []
  const unstaged: GitFileEntry[] = []
  const untracked: GitFileEntry[] = []
  for (const e of entries) {
    if (e.status === '?') untracked.push(e)
    else if (e.status === '!') continue // ignored — never returned
    else {
      if (e.staged) staged.push(e)
      if (e.unstaged) unstaged.push(e)
    }
  }
  return { staged, unstaged, untracked }
}

// ── Numstat helpers ─────────────────────────────────────────────────

interface NumstatEntry {
  insertions: number
  deletions: number
}

/** Parse `git diff --numstat` stdout into a path→counts map.
 *  Binary files produce `-\t-\tpath` which we map to {0, 0}. */
function parseNumstatOutput(stdout: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>()
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const tab1 = line.indexOf('\t')
    if (tab1 === -1) continue
    const tab2 = line.indexOf('\t', tab1 + 1)
    if (tab2 === -1) continue
    const path = line.slice(tab2 + 1)
    map.set(path, {
      insertions: parseInt(line.slice(0, tab1), 10) || 0,
      deletions: parseInt(line.slice(tab1 + 1, tab2), 10) || 0,
    })
  }
  return map
}

/** Run `git diff --numstat [--cached]` and return a map from path to
 *  insertion/deletion counts. */
async function getNumstatMap(
  cwd: string,
  cached: boolean,
): Promise<Map<string, NumstatEntry>> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--numstat']
  if (cached) args.push('--cached')
  const { stdout } = await runGit(cwd, args)
  return parseNumstatOutput(stdout)
}

/** Attach insertion/deletion counts to entries that match a numstat map. */
function applyNumstat(
  entries: GitFileEntry[],
  map: Map<string, NumstatEntry>,
): void {
  for (const e of entries) {
    const stats = map.get(e.path)
    if (stats) {
      e.insertions = stats.insertions
      e.deletions = stats.deletions
    }
  }
}

export async function getStatus(cwd: string): Promise<GitStatusResponse> {
  if (!(await isInsideWorkTree(cwd))) {
    return { isRepo: false }
  }
  return getStatusInRepo(cwd)
}

// ── Read-route status cache / request coalescing ──────────────────────
//
// A single `git-status-changed` broadcast makes EVERY subscribed client
// fire `GET /api/git/status?cwd=X` at almost the same instant, and each
// getStatus() spawns 3-4 git child processes. With N tabs on one session
// that's N×(3-4) processes for identical data. `getStatusCached` collapses
// that: concurrent (or near-back-to-back) calls for the same cwd share one
// in-flight Promise, and the result is reused for a short TTL window.
//
// The cache stores the PROMISE (not the resolved value) so simultaneous
// callers coalesce onto the first request. The window is intentionally
// tiny — long enough to absorb a broadcast's thundering herd, short enough
// that ordinary polling stays fresh. Writes and the auto-detect path both
// route through `broadcastGitStatusChanged`, which calls
// `invalidateStatusCache(cwd)`, so a mutation never serves a stale snapshot.
//
// Only the read route uses this. Tests and write routes call getStatus /
// getStatusInRepo directly for ground truth.
const STATUS_CACHE_TTL_MS = 500
interface StatusCacheEntry { ts: number; promise: Promise<GitStatusResponse> }
const statusCache = new Map<string, StatusCacheEntry>()

export function getStatusCached(cwd: string): Promise<GitStatusResponse> {
  const now = Date.now()
  const hit = statusCache.get(cwd)
  if (hit && now - hit.ts < STATUS_CACHE_TTL_MS) return hit.promise
  const promise = getStatus(cwd).catch((err: unknown) => {
    // Never cache a failure — drop our own entry so the next call retries
    // (guard against clobbering a newer entry that replaced ours).
    if (statusCache.get(cwd)?.promise === promise) statusCache.delete(cwd)
    throw err
  })
  statusCache.set(cwd, { ts: now, promise })
  return promise
}

/** Drop cached status for a cwd (or all cwds when omitted). Called on every
 *  git state change so the next read recomputes from ground truth. */
export function invalidateStatusCache(cwd?: string): void {
  if (cwd === undefined) statusCache.clear()
  else statusCache.delete(cwd)
}

/** Variant of getStatus that skips the inside-work-tree probe. Callers
 *  must have already proven the cwd is a repo (e.g. via the per-route
 *  ensureGitRepo() that ran before the write itself). Saves one git
 *  spawn per write request — measurable when a panel issues bursts of
 *  stage/unstage clicks. */
export async function getStatusInRepo(cwd: string): Promise<GitStatus> {
  // Work-tree top level. Status paths below are relative to THIS, not to
  // `cwd`, so clients that resolve an absolute path (the FileViewer's
  // readFile) need it. getStatusInRepo implies inside a work tree, so the
  // call should always succeed; the cwd fallback is pure defensiveness —
  // worst case the client anchors against cwd, the pre-existing behaviour.
  let repoRoot = cwd
  try {
    const r = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    const trimmed = r.stdout.trim()
    if (trimmed) repoRoot = trimmed
  } catch {
    // keep cwd fallback
  }

  const { stdout } = await runGit(cwd, [
    '-c', 'core.quotepath=false',
    'status', '--porcelain=v1', '--branch', '-z',
  ])

  // With -z, every record (including the branch line) is NUL-terminated.
  // For renames/copies the source path is its OWN NUL-terminated record
  // immediately after the entry, so we walk the array linearly.
  const records = stdout.split('\0')
  // Drop the trailing empty record produced by the final NUL.
  if (records.length && records[records.length - 1] === '') records.pop()

  let branch: string | null = null
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0

  const entries: GitFileEntry[] = []

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.startsWith('##')) {
      const h = parseBranchHeader(rec)
      branch = h.branch
      detached = h.detached
      upstream = h.upstream
      ahead = h.ahead
      behind = h.behind
      continue
    }
    if (rec.length < 3) continue

    const xRaw = rec[0]
    const yRaw = rec[1]
    // Format is "XY path" — bytes 0/1 are status, byte 2 is a literal
    // space, the remainder is the path.
    const path = rec.slice(3)

    // Untracked / ignored files have '??' / '!!' and are never renames.
    if (xRaw === '?') {
      entries.push({ path, status: '?', staged: false, unstaged: true })
      continue
    }
    if (xRaw === '!') {
      // Ignored — drop in bucketFiles, but still consume.
      entries.push({ path, status: '!', staged: false, unstaged: false })
      continue
    }

    // Renames/copies in either column consume the *next* record as the
    // original path. R-in-index is by far the common case.
    let renamedFrom: string | undefined
    if (xRaw === 'R' || xRaw === 'C' || yRaw === 'R' || yRaw === 'C') {
      const next = records[i + 1]
      if (next !== undefined) {
        renamedFrom = next
        i++
      }
    }

    const stagedCol = xRaw !== ' '
    const unstagedCol = yRaw !== ' '
    // Effective single-axis status: prefer the staged column when present.
    const status = statusChar(stagedCol ? xRaw : yRaw)

    entries.push({
      path,
      status,
      staged: stagedCol,
      unstaged: unstagedCol,
      ...(renamedFrom ? { renamedFrom } : {}),
    })
  }

  const buckets = bucketFiles(entries)

  // Fetch per-file line counts in parallel (staged via --cached, unstaged via default).
  // Untracked files have no diff — they get no counts.
  const [stagedNumstat, unstagedNumstat] = await Promise.all([
    buckets.staged.length > 0 ? getNumstatMap(cwd, true) : Promise.resolve(new Map<string, NumstatEntry>()),
    buckets.unstaged.length > 0 ? getNumstatMap(cwd, false) : Promise.resolve(new Map<string, NumstatEntry>()),
  ])
  applyNumstat(buckets.staged, stagedNumstat)
  applyNumstat(buckets.unstaged, unstagedNumstat)

  const inProgress = await detectInProgressState(cwd)
  const dirty =
    buckets.staged.length > 0 ||
    buckets.unstaged.length > 0 ||
    buckets.untracked.length > 0
  const state: GitRepoState = inProgress ?? (dirty ? 'dirty' : 'clean')

  // Only spawn `git worktree list --porcelain` when the repo actually has
  // linked worktrees. The common case (no worktrees) would otherwise pay an
  // extra git subprocess on every status fetch — a debounce-hot path. The
  // main git dir at `<repoRoot>/.git/worktrees/` holds every linked worktree
  // for the whole repo regardless of which worktree `cwd` lives in, so a
  // single stat is enough and is correct from any cwd.
  const hasLinkedWorktrees = await fsPromises
    .access(join(repoRoot, '.git', 'worktrees'))
    .then(() => true)
    .catch(() => false)

  return {
    isRepo: true,
    repoRoot,
    branch,
    detached,
    ahead,
    behind,
    upstream,
    state,
    linkedWorktrees: hasLinkedWorktrees ? await listWorktrees(cwd) : [],
    ...buckets,
  }
}

// ── Worktrees ────────────────────────────────────────────────────────

/** Resolve `git worktree list --porcelain` into structured entries. The
 *  first entry is always the primary checkout; linked worktrees (e.g.
 *  `.claude/worktrees/<name>` created by EnterWorktree) follow. Parsed so
 *  callers can reconcile an agent EnterWorktree intent against the git
 *  fact (does the branch exist? is it locked, and by whom?). */
export async function listWorktrees(cwd: string): Promise<GitLinkedWorktree[]> {
  const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  const out: GitLinkedWorktree[] = []
  for (const record of stdout.split('\n\n')) {
    if (!record.trim()) continue
    let path = ''
    let branch: string | null = null
    let detached = false
    let locked = false
    let lockMessage: string | null = null
    for (const line of record.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch refs/heads/'.length)
      else if (line === 'detached') detached = true
      // `git worktree lock` prints a bare `locked` when no --reason was
      // given, or `locked <reason>` when one was — match both.
      else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true
        lockMessage = line === 'locked' ? null : line.slice('locked '.length)
      }
      // `bare` and `prunable` records are ignored for the UI's purposes.
    }
    out.push({ path, branch: detached ? null : branch, locked, lockMessage })
  }
  return out
}

// ── Diff ────────────────────────────────────────────────────────────

/** Validate a path argument coming from the request. Rejects absolute
 *  paths, anything with `..` segments, and anything that resolves outside
 *  the cwd. The repo-relative form is what git expects after `--`. */
export function validateRepoRelativePath(path: string): string {
  if (!path) throw new HttpError(400, 'path required')
  if (isAbsolute(path)) throw new HttpError(400, 'path must be relative to repo root')
  // Normalize handles ./ and collapses //, but leaves ../ in place so we
  // can reject it explicitly. Use posix-style separator for the check
  // since git always emits forward slashes.
  const normalized = normalize(path).split(sep).join('/')
  if (normalized.split('/').some((seg) => seg === '..')) {
    throw new HttpError(400, 'path may not contain ".." segments')
  }
  if (normalized.startsWith('/')) throw new HttpError(400, 'path must be relative')
  return normalized
}

/** Truncate a unified-diff body at MAX_DIFF_LINES, preserving the header
 *  and reporting the original line count. */
function truncateDiff(text: string): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split('\n')
  const totalLines = lines.length
  if (totalLines <= MAX_DIFF_LINES) {
    return { text, truncated: false, totalLines }
  }
  return {
    text: lines.slice(0, MAX_DIFF_LINES).join('\n'),
    truncated: true,
    totalLines,
  }
}

export async function getDiff(cwd: string, path: string, staged: boolean): Promise<GitDiff> {
  await ensureGitRepo(cwd)
  const safePath = validateRepoRelativePath(path)

  // First peek at numstat: a binary file produces "-\t-\t<path>".
  const numArgs = ['-c', 'core.quotepath=false', 'diff', '--numstat']
  if (staged) numArgs.push('--cached')
  numArgs.push('--', safePath)
  const numRes = await runGit(cwd, numArgs)
  const isBinary = /^-\s+-\s+/.test(numRes.stdout.trim())

  if (isBinary) {
    return { path: safePath, staged, truncated: false, totalLines: 0, text: '', isBinary: true }
  }

  const diffArgs = ['-c', 'core.quotepath=false', 'diff', '--no-color']
  if (staged) diffArgs.push('--cached')
  diffArgs.push('--', safePath)
  const { stdout } = await runGit(cwd, diffArgs)
  const trunc = truncateDiff(stdout)
  return { path: safePath, staged, ...trunc, isBinary: false }
}

// ── Branch range diff ────────────────────────────────────────────────
// Used by the Worktree-changes view to answer "what did the isolated
// worktree branch do": the per-file list (numstat + name-status) and a
// lazily-fetched per-file unified body. `from`/`to` are refs resolved
// inside the worktree's repo (the confining `.claude/worktrees/<name>`
// worktree or `main`), passed as positional execFile args — never a shell.

/** Parse `git diff --numstat -z` into a path→{ins,del} map keyed by the
 *  destination path. The -z encoding differs for a single file vs a
 *  rename/copy (verified against real git output):
 *
 *    modified  a.txt →  `<adds>\t<dels>\ta.txt\0`          (one NUL token)
 *    renamed   a→b   →  `<adds>\t<dels>\t\0a\0b\0`        (empty path slot,
 *                          then each path as its own NUL token)
 *
 *  So the record spans the counts token plus any following tokens that
 *  hold no tab (the path components). The destination is always the last
 *  path component. Binary files show `-\t-` → 0/0. */
function parseNumstatZ(stdout: string): Map<string, { ins: number; del: number }> {
  const toks = stdout.split('\0')
  const out = new Map<string, { ins: number; del: number }>()
  let i = 0
  while (i < toks.length && toks[i] !== '') {
    const parts = toks[i].split('\t')
    i++
    const ins = Number(parts[0]) || 0
    const del = Number(parts[1]) || 0
    // Path component(s) of this record: the tail of the counts token
    // (empty for a rename's old-path slot) plus any following NUL tokens
    // that contain no tab (the rename's paths).
    const pathParts = parts.slice(2)
    while (i < toks.length && toks[i] !== '' && !toks[i].includes('\t')) {
      pathParts.push(toks[i])
      i++
    }
    const dest = pathParts[pathParts.length - 1]
    if (dest) out.set(dest, { ins, del })
  }
  return out
}

/** Guard a ref (branch name or SHA) passed as a positional execFile arg.
 *  Since args never hit a shell, injection isn't the concern — we only
 *  reject refs that git would misread as options (leading `-`) or that
 *  contain whitespace/control (which would split args or hang us). Real
 *  checked-out branch names (`@`, unicode, dots, slashes) are all legal. */
export function validateRef(ref: string): void {
  if (!ref || ref.startsWith('-') || /\s/.test(ref)) {
    throw new HttpError(400, `invalid ref: ${ref.slice(0, 64)}`)
  }
}

/** Build the git ref-arg pair. `mergeBase` selects three-dot semantics
 *  (`A...B` = changes on B since it diverged from A — "what the worktree
 *  branch did"); tip uses two-dot (`A..B` = full head-to-head diff). */
function rangeRefArgs(from: string, to: string, mergeBase: boolean): string[] {
  if (mergeBase) return [`${from}...${to}`]
  return [from, to]
}

/** Per-file change summary between two refs (`git diff <from> <to>`).
 *  Mirrors the status/diff surface but across a commit range, so the
 *  Worktree-changes view can list what the worktree branch introduced. */
export async function getRangeDiffFiles(cwd: string, from: string, to: string, mergeBase = false): Promise<GitRangeFile[]> {
  validateRef(from)
  validateRef(to)
  await ensureGitRepo(cwd)

  const refs = rangeRefArgs(from, to, mergeBase)
  const [numRes, stRes] = await Promise.all([
    runGit(cwd, ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', ...refs]),
    runGit(cwd, ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', ...refs]),
  ])
  const counts = parseNumstatZ(numRes.stdout)

  const out: GitRangeFile[] = []
  const toks = stRes.stdout.split('\0')
  let i = 0
  while (i < toks.length && toks[i] !== '') {
    const field = toks[i].trim()
    i++
    const status = (field[0] || 'M') as GitFileStatus
    const isRename = field[0] === 'R' || field[0] === 'C'
    const p1 = toks[i]
    i++
    const renamedFrom = isRename ? p1 : undefined
    const path = isRename ? toks[i++] : p1
    const c = counts.get(path) ?? { ins: 0, del: 0 }
    out.push({ path, status, insertions: c.ins, deletions: c.del, ...(renamedFrom ? { renamedFrom } : {}) })
  }
  return out
}

/** Unified diff body for ONE file across a range, clipped at MAX_DIFF_LINES.
 *  Returns an empty body with isBinary when git flags the file binary. */
export async function getRangeDiffFile(cwd: string, from: string, to: string, path: string, mergeBase = false): Promise<GitDiff> {
  validateRef(from)
  validateRef(to)
  await ensureGitRepo(cwd)
  const safePath = validateRepoRelativePath(path)
  const refs = rangeRefArgs(from, to, mergeBase)

  const numRes = await runGit(cwd, ['-c', 'core.quotepath=false', 'diff', '--numstat', ...refs, '--', safePath])
  const isBinary = /^-\s+-\s+/.test(numRes.stdout.trim())
  if (isBinary) {
    return { path: safePath, staged: false, truncated: false, totalLines: 0, text: '', isBinary: true }
  }

  const { stdout } = await runGit(cwd, ['-c', 'core.quotepath=false', 'diff', '--no-color', ...refs, '--', safePath])
  const trunc = truncateDiff(stdout)
  return { path: safePath, staged: false, ...trunc, isBinary: false }
}

// ── Log ─────────────────────────────────────────────────────────────

/** Use 0x1f (ASCII Unit Separator) between fields and 0x1e (Record
 *  Separator) between commits. Both characters cannot appear in commit
 *  metadata (git rejects them in author names; subjects are the first
 *  message line, which has no newline-or-control-char surprises beyond
 *  what we'd already mishandle with simpler delimiters). */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ct%x1f%s'

export async function getLog(cwd: string, limitRaw: number): Promise<GitCommit[]> {
  await ensureGitRepo(cwd)
  const limit = Math.max(1, Math.min(MAX_LOG_LIMIT, Math.floor(limitRaw)))
  const { stdout } = await runGit(cwd, [
    '-c', 'core.quotepath=false',
    'log', `-${limit}`, `--pretty=format:${LOG_FORMAT}%x1e`, '--no-color',
  ], {
    // log can be repo-shaped: 30 commits with full SHAs is well under our
    // buffer, but keep the timeout snug to defend against pathological
    // cases (e.g. shallow-converting a huge repo on demand).
    timeoutMs: 8_000,
  })

  const out: GitCommit[] = []
  // Split on RS, drop trailing empty chunk, and split each on US.
  // git's `format:` adds separator newlines between commits, so the
  // chunk following the first %x1e starts with `\n` — strip leading
  // newlines before parsing.
  for (const rawChunk of stdout.split('\x1e')) {
    const chunk = rawChunk.replace(/^[\r\n]+/, '')
    if (!chunk) continue
    const fields = chunk.split('\x1f')
    if (fields.length < 5) continue
    const [hash, shortHash, author, ctSec, subject] = fields
    const seconds = Number(ctSec)
    out.push({
      hash,
      shortHash,
      author,
      date: Number.isFinite(seconds) ? seconds * 1000 : 0,
      subject,
    })
  }
  return out
}

// ── Write operations ──────────────────────────────────────────────────
//
// Every write function:
//   1. ensures the cwd is a real git work tree
//   2. validates each path argument through validateRepoRelativePath
//   3. invokes git via runGit (no shell, fixed argv) with path args
//      always introduced by `--` so a path can never be reinterpreted
//      as a refspec
//   4. throws HttpError for user-fixable failures (4xx) or 500 for
//      internal git errors. Never silently swallows.
//
// The route layer is responsible for confirm-token validation; these
// functions trust their callers to have authorised the action.

const MAX_COMMIT_MESSAGE_BYTES = 8_192

function joinPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new HttpError(400, 'paths must not be empty')
  return paths.map(validateRepoRelativePath)
}

export async function stageFiles(cwd: string, paths: readonly string[]): Promise<void> {
  await ensureGitRepo(cwd)
  const safe = joinPaths(paths)
  // `git add --` works for both new files and modifications. We don't
  // pass -A or -u so a path that resolves to nothing fails with a clear
  // message rather than silently affecting unrelated files.
  await runGit(cwd, ['-c', 'core.quotepath=false', 'add', '--', ...safe])
}

export async function unstageFiles(cwd: string, paths: readonly string[]): Promise<void> {
  await ensureGitRepo(cwd)
  const safe = joinPaths(paths)
  // `git restore --staged` is the modern equivalent of `git reset HEAD --`
  // and works the same on empty repos (where HEAD might not exist).
  // Use exit-code-aware runGit so an unborn HEAD doesn't throw.
  await runGit(cwd, ['-c', 'core.quotepath=false', 'restore', '--staged', '--', ...safe])
}

export async function discardTracked(cwd: string, paths: readonly string[]): Promise<void> {
  await ensureGitRepo(cwd)
  const safe = joinPaths(paths)
  // `git checkout HEAD -- <paths>` resets the worktree to HEAD's version
  // for tracked paths only. Untracked paths produce a warning on stderr
  // ("did not match any file") but git doesn't fail — the caller should
  // route untracked discard through discardUntracked() instead.
  await runGit(cwd, ['-c', 'core.quotepath=false', 'checkout', 'HEAD', '--', ...safe])
}

export async function discardUntracked(cwd: string, paths: readonly string[]): Promise<void> {
  await ensureGitRepo(cwd)
  const safe = joinPaths(paths)
  // `git clean -f -- <paths>` removes untracked files. We deliberately
  // do NOT pass -d (no directories) or -x (don't ignore .gitignore) so
  // the blast radius stays minimal: only loose untracked files in the
  // listed paths get removed. This still honours .gitignore boundaries.
  await runGit(cwd, ['-c', 'core.quotepath=false', 'clean', '-f', '--', ...safe])
}

export async function commitChanges(cwd: string, message: string, amend: boolean): Promise<void> {
  await ensureGitRepo(cwd)
  if (typeof message !== 'string') throw new HttpError(400, 'commit message required')
  const trimmed = message.trim()
  if (!trimmed && !amend) throw new HttpError(400, 'commit message required')
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    throw new HttpError(400, `commit message too long (max ${MAX_COMMIT_MESSAGE_BYTES} bytes)`)
  }
  const args = ['-c', 'core.quotepath=false', 'commit', '-m', trimmed]
  if (amend) args.push('--amend')
  // --no-verify is intentionally NOT set — we want hooks to fire. If
  // the hook fails, runGit translates the non-zero exit into an
  // HttpError(500) the route layer will surface as a JSON error.
  // --allow-empty stays off; an empty commit with --amend would silently
  // overwrite the prior message with itself, which is rarely desired.
  await runGit(cwd, args)
}

export async function abortMerge(cwd: string): Promise<void> {
  await ensureGitRepo(cwd)
  await runGit(cwd, ['merge', '--abort'])
}

export async function abortRebase(cwd: string): Promise<void> {
  await ensureGitRepo(cwd)
  await runGit(cwd, ['rebase', '--abort'])
}

// ── Stash ────────────────────────────────────────────────────────────

export async function listStashes(cwd: string): Promise<GitStashEntry[]> {
  await ensureGitRepo(cwd)
  // Output one stash per record, NUL-separated. Field separator is the
  // ASCII Unit Separator (0x1f) — git's stash messages don't contain
  // control chars, so this round-trips cleanly.
  const fmt = '%gd%x1f%gs%x1f%ct'
  const { stdout } = await runGit(cwd, [
    '-c', 'core.quotepath=false',
    'stash', 'list', `--format=${fmt}%x00`,
  ])
  const entries: GitStashEntry[] = []
  const records = stdout.split('\0')
  if (records.length && records[records.length - 1] === '') records.pop()
  for (const rec of records) {
    if (!rec) continue
    const fields = rec.split('\x1f')
    if (fields.length < 3) continue
    const [ref, message, ctSec] = fields
    // ref looks like `stash@{N}` — pull N out for the index.
    const idxMatch = ref.match(/^stash@\{(\d+)\}$/)
    const index = idxMatch ? Number(idxMatch[1]) : NaN
    if (!Number.isFinite(index)) continue
    const seconds = Number(ctSec)
    entries.push({
      index,
      ref,
      message,
      date: Number.isFinite(seconds) ? seconds * 1000 : 0,
    })
  }
  return entries
}

export async function stashCreate(cwd: string, message?: string, includeUntracked?: boolean): Promise<void> {
  await ensureGitRepo(cwd)
  const args = ['stash', 'push']
  if (includeUntracked) args.push('-u')
  if (message && message.trim()) {
    args.push('-m', message.trim())
  }
  // git stash push exits 0 even when there's nothing to stash; it just
  // prints "No local changes to save" to stdout. We surface that as
  // HttpError(400) so the UI can prompt the user appropriately.
  const r = await runGit(cwd, args)
  if (/No local changes to save/i.test(r.stdout + r.stderr)) {
    throw new HttpError(400, 'No local changes to stash')
  }
}

export async function stashPop(cwd: string, index: number): Promise<void> {
  await ensureGitRepo(cwd)
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'index must be a non-negative integer')
  await runGit(cwd, ['stash', 'pop', `stash@{${index}}`])
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await ensureGitRepo(cwd)
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'index must be a non-negative integer')
  await runGit(cwd, ['stash', 'drop', `stash@{${index}}`])
}

// ── Branches ─────────────────────────────────────────────────────────

/** Validate a branch name by deferring to git's own ref-format checker.
 *  This catches the long list of forbidden characters / shapes (../, @{,
 *  trailing dot, leading dash, etc.) without us re-implementing them. */
export async function validateBranchName(name: string): Promise<void> {
  if (typeof name !== 'string' || !name.trim()) {
    throw new HttpError(400, 'branch name required')
  }
  if (name.length > 200) {
    throw new HttpError(400, 'branch name too long')
  }
  // No cwd needed: this command doesn't touch a repo.
  // It exits non-zero on invalid names, which runGit translates to HttpError.
  // Run via execFile directly so we're not bound to a cwd.
  try {
    await execFileAsync('git', ['check-ref-format', '--branch', name], {
      timeout: 5_000,
      windowsHide: true,
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stderr?: string }
    if (typeof e.code === 'number') {
      throw new HttpError(400, `invalid branch name: ${(e.stderr ?? '').trim() || name}`)
    }
    throw new HttpError(500, `branch name validation failed: ${e.message}`)
  }
}

export async function listBranches(cwd: string): Promise<GitBranch[]> {
  await ensureGitRepo(cwd)
  // for-each-ref with custom format is more reliable than parsing
  // `git branch` output (which has presentation noise like the leading
  // asterisk for current branch). %(HEAD) is '*' for HEAD's branch and
  // ' ' otherwise; %(upstream:short) is empty when no upstream.
  const fmt = '%(refname:short)%00%(HEAD)%00%(upstream:short)'
  const { stdout } = await runGit(cwd, [
    'for-each-ref',
    `--format=${fmt}`,
    'refs/heads',
  ])
  const branches: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [name, headFlag, upstream] = line.split('\0')
    if (!name) continue
    branches.push({
      name,
      current: headFlag === '*',
      upstream: upstream || null,
    })
  }
  // Stable order: current first, then alphabetical. Easier to scan in a
  // dropdown than the for-each-ref default order.
  branches.sort((a, b) => {
    if (a.current && !b.current) return -1
    if (!a.current && b.current) return 1
    return a.name.localeCompare(b.name)
  })
  return branches
}

export async function createBranch(
  cwd: string,
  name: string,
  checkout: boolean,
  autoStash = false,
): Promise<{ stashed: boolean }> {
  await ensureGitRepo(cwd)
  await validateBranchName(name)
  if (!checkout) {
    await runGit(cwd, ['branch', name])
    return { stashed: false }
  }
  // Mirror checkoutBranch's conflict handling: when the user has
  // uncommitted changes, git checkout -b exits 1 with a "would be
  // overwritten" message. Surface as 409 so the client can offer
  // auto-stash instead of showing a raw error toast.
  const first = await runGit(cwd, ['checkout', '-b', name], { allowExitCodes: new Set([1, 128]) })
  if (first.exitCode === 0) return { stashed: false }
  const msg = (first.stderr || first.stdout || '').trim()
  if (!/would be overwritten|local changes/i.test(msg)) {
    throw new HttpError(500, `git checkout -b failed: ${msg.slice(0, 500)}`)
  }
  if (!autoStash) {
    throw new HttpError(409, 'uncommitted changes block checkout — commit, stash, or pass autoStash')
  }
  // Auto-stash, retry. If checkout still fails, keep the stash so
  // the user's work isn't lost (same safety net as checkoutBranch).
  await runGit(cwd, ['stash', 'push', '-u', '-m', `auto-stash before creating ${name}`])
  const second = await runGit(cwd, ['checkout', '-b', name], { allowExitCodes: new Set([1, 128]) })
  if (second.exitCode !== 0) {
    throw new HttpError(
      500,
      `branch creation still failed after auto-stash — your changes are saved as stash@{0}, ` +
      `pop manually with stash-pop. Underlying error: ${(second.stderr || second.stdout).trim().slice(0, 300)}`,
    )
  }
  return { stashed: true }
}

export async function checkoutBranch(
  cwd: string,
  name: string,
  autoStash: boolean,
): Promise<{ stashed: boolean }> {
  await ensureGitRepo(cwd)
  await validateBranchName(name)
  // First attempt — exit 1 on uncommitted-changes conflict, which
  // we'll handle below. Other non-zero exits are real errors.
  const first = await runGit(cwd, ['checkout', name], { allowExitCodes: new Set([1, 128]) })
  if (first.exitCode === 0) return { stashed: false }
  // git's stderr for the conflict case mentions "would be overwritten"
  // or "Your local changes". Anything else is a different kind of
  // failure (unknown branch, etc.) and shouldn't trigger auto-stash.
  const conflict = /would be overwritten|local changes/i.test(first.stderr || first.stdout)
  if (!conflict) {
    throw new HttpError(409, `git checkout failed: ${(first.stderr || first.stdout).trim().slice(0, 500)}`)
  }
  if (!autoStash) {
    throw new HttpError(409, 'uncommitted changes block checkout — commit, stash, or pass autoStash:true')
  }
  // Stash including untracked. If stash itself fails (rare), bail out
  // BEFORE attempting checkout so we don't half-state.
  const stashMsg = `auto-stash before switching to ${name}`
  await runGit(cwd, ['stash', 'push', '-u', '-m', stashMsg])
  // Retry checkout. If this still fails, the stash succeeded but the
  // checkout didn't — keep the stash so the user's work isn't lost.
  // Surface a 500 with explicit guidance.
  const second = await runGit(cwd, ['checkout', name], { allowExitCodes: new Set([1, 128]) })
  if (second.exitCode !== 0) {
    throw new HttpError(
      500,
      `checkout still failed after auto-stash — your changes are saved as stash@{0}, ` +
      `pop manually with stash-pop. Underlying error: ${(second.stderr || second.stdout).trim().slice(0, 300)}`,
    )
  }
  return { stashed: true }
}

// ── Remote operations ─────────────────────────────────────────────────

/** Pull from the tracked remote using fast-forward only. Returns
 *  `{ updated: true }` when HEAD moved (new commits were fetched and
 *  applied). If the local branch has diverged from upstream, `--ff-only`
 *  causes git to exit non-zero instead of creating a merge commit. */
export async function pullFromRemote(cwd: string): Promise<{ updated: boolean }> {
  await ensureGitRepo(cwd)
  const before = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  await runGit(cwd, ['pull', '--ff-only'], { timeoutMs: 60_000 })
  const after = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  return { updated: before !== after }
}

/** Push to the tracked remote. When `force` is true the caller MUST have
 *  obtained explicit user confirmation (the route enforces `confirm:true`).
 *  Uses `--force-with-lease` which is safer than bare `--force`: it
 *  refuses to push when the remote branch has commits we haven't seen. */
export async function pushToRemote(cwd: string, force?: boolean): Promise<void> {
  await ensureGitRepo(cwd)
  const args = ['push']
  if (force) args.push('--force-with-lease')
  await runGit(cwd, args, { timeoutMs: 60_000 })
}

// ── Session anchor + session-scope diff ──────────────────────────────

/** Hard cap on diff bytes we feed to the AI commit-message model. The
 *  diff is base64-free plain text; the limit is set well below typical
 *  Anthropic input token windows so even a lavishly-priced model gets a
 *  bounded request. Beyond this we head+tail-trim with an elided marker. */
const MAX_AI_DIFF_BYTES = 16 * 1024

/** Best-effort HEAD SHA capture — used at session spawn to anchor the
 *  "This session" view. Returns undefined for every reason a session
 *  might not have a valid HEAD: cwd isn't a repo, HEAD is unborn (no
 *  commits yet), git isn't installed, the rev-parse process times out,
 *  etc. Never throws; the caller always gets `string | undefined` and
 *  treats undefined as "no anchor — hide the section". */
export async function tryCaptureGitHead(cwd: string): Promise<string | undefined> {
  try {
    if (!(await isInsideWorkTree(cwd))) return undefined
    const r = await runGit(cwd, ['rev-parse', 'HEAD'], {
      // 128 = unborn HEAD (fresh `git init` with no commits yet). Treat
      // as a soft no — there's nothing to anchor to but it's not an error.
      allowExitCodes: new Set([128]),
      timeoutMs: 5_000,
    })
    if (r.exitCode !== 0) return undefined
    const sha = r.stdout.trim()
    // Sanity check: HEAD must be a 40-char hex SHA. Defensive against an
    // unexpected git output format on some platforms / CRLF issues.
    if (!/^[0-9a-f]{40}$/i.test(sha)) return undefined
    return sha
  } catch {
    // runGit's HttpError, timeout, ENOENT — all collapse to "no anchor".
    return undefined
  }
}

/** Unified diff of the staged area (`git diff --cached`), capped at
 *  MAX_AI_DIFF_BYTES with the same head+tail trim used elsewhere.
 *  Feeds the Generate-commit-message flow in the Commit section. Returns
 *  an empty string when nothing is staged — callers should refuse to
 *  generate a message in that case. */
export async function getStagedDiff(cwd: string): Promise<{ text: string; truncated: boolean }> {
  await ensureGitRepo(cwd)
  const { stdout } = await runGit(cwd, [
    '-c', 'core.quotepath=false',
    'diff', '--no-color', '--cached',
  ])
  return trimDiffToCap(stdout)
}

/** Cap a diff string at MAX_AI_DIFF_BYTES with a head+tail trim. Reserve
 *  ~60% of the cap for the head (more useful — function signatures,
 *  types, top-of-file changes); the rest for the tail. The middle gets
 *  an elision marker so the model knows there's content it can't see. */
function trimDiffToCap(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_AI_DIFF_BYTES) {
    return { text, truncated: false }
  }
  const ELISION = '\n\n... [diff truncated to keep request size bounded] ...\n\n'
  const headBytes = Math.floor(MAX_AI_DIFF_BYTES * 0.6)
  const tailBytes = MAX_AI_DIFF_BYTES - headBytes - ELISION.length
  const buf = Buffer.from(text, 'utf8')
  // Slice on UTF-8 codepoint boundaries — a raw byte slice in the
  // middle of a multi-byte sequence (CJK, emoji, accented chars) would
  // emit U+FFFD replacement chars at the seam, garbling the context
  // we send to the LLM. snapToCodepoint walks back/forward to a leading
  // byte (a byte whose top bits are NOT 10).
  const headEnd = snapDownToCodepoint(buf, headBytes)
  const tailStart = snapUpToCodepoint(buf, bytes - tailBytes)
  const head = buf.subarray(0, headEnd).toString('utf8')
  const tail = buf.subarray(tailStart).toString('utf8')
  return { text: head + ELISION + tail, truncated: true }
}

/** Snap a byte offset down to the nearest UTF-8 codepoint boundary
 *  (i.e. a byte that is NOT a continuation byte 10xxxxxx). Used as the
 *  exclusive end of a head slice. */
function snapDownToCodepoint(buf: Buffer, offset: number): number {
  let i = Math.min(offset, buf.length)
  // A continuation byte has its top two bits = 10 (0x80..=0xBF). Walk
  // backward until we land on a leading byte (or the start).
  while (i > 0 && (buf[i] & 0xc0) === 0x80) i--
  return i
}

/** Snap a byte offset up to the nearest UTF-8 codepoint boundary. Used
 *  as the inclusive start of a tail slice. */
function snapUpToCodepoint(buf: Buffer, offset: number): number {
  let i = Math.max(0, Math.min(offset, buf.length))
  while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++
  return i
}

