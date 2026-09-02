// Git clone / pull helpers for the homegrown marketplace.
//
// These are deliberately separate from the existing `runGit` in server/git.ts:
//   - runGit is module-private and assumes you're already inside a repo
//     (callers go through `ensureGitRepo` before path-validated args).
//   - Marketplace ops happen *outside* any repo: we clone into a fresh dir,
//     pull from inside the cloned dir, and never touch user file paths.
//
// Same shell-safety contract as runGit: every git invocation goes through
// `execFile('git', ...)` with a fixed argv — no shell, no string concat —
// so URLs and paths can carry arbitrary characters without injection risk.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import { MAX_BUFFER_BYTES } from './constants.js'

const log = createLogger('git-clone')

const execFileAsync = promisify(execFile)

/** Clone timeout. Generous because real-world marketplace repos can be a
 *  few hundred MB and clone over slow connections. */
const CLONE_TIMEOUT_MS = 5 * 60 * 1000
/** Full-clone timeout. `gitCloneAtSha` pulls full history (no --depth) so a
 *  pinned commit anywhere in the graph is reachable — give it more headroom
 *  than the shallow marketplace clone. */
const FULL_CLONE_TIMEOUT_MS = 10 * 60 * 1000
/** Pull timeout. Fast-forward fetches against an already-cloned repo are
 *  bounded — we don't need the full clone budget. */
const PULL_TIMEOUT_MS = 60_000

/** Force-disable interactive prompts. Without this, a clone of a private
 *  https URL will hang waiting on stdin (which never gets fed in our
 *  spawn). The 0 value short-circuits git's askpass; the operation fails
 *  fast with a useful "could not read Username" error. */
const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
}

/** Reject everything that isn't a plain `https://` URL. We deliberately
 *  don't allow `git://`, `ssh://`, file paths, or `owner/repo` shorthand
 *  in v1 — the user explicitly scope the source list to https-only.
 *  Callers can normalise / expand other forms before passing in. */
export function assertHttpsUrl(url: string): void {
  if (typeof url !== 'string' || !url) {
    throw new HttpError(400, 'git URL required')
  }
  if (url.length > 4096) {
    throw new HttpError(400, 'git URL too long')
  }
  if (url.includes('\0')) {
    throw new HttpError(400, 'git URL contains NUL byte')
  }
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    throw new HttpError(400, 'only https:// URLs are supported')
  }
}

/** Run a git command outside any repo (or in `cwd` if specified). Any
 *  non-zero exit becomes HttpError(500) with stderr surfaced; ENOENT (no
 *  git binary) becomes 503. */
async function runGitOutside(args: readonly string[], cwd?: string, timeoutMs = PULL_TIMEOUT_MS): Promise<string> {
  const start = Date.now()
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    })
    log.debug(`git ${args[0]} ok in ${Date.now() - start}ms`)
    return stdout
  } catch (err) {
    const elapsed = Date.now() - start
    const e = err as NodeJS.ErrnoException & {
      code?: string | number
      stdout?: string
      stderr?: string
      killed?: boolean
    }
    if (e.code === 'ENOENT') {
      log.error('git executable not found in PATH')
      throw new HttpError(503, 'git executable not found in PATH')
    }
    if (e.killed) {
      log.error(`git ${args[0]} timed out after ${elapsed}ms`)
      throw new HttpError(504, 'git command timed out')
    }
    if (typeof e.code === 'number') {
      // Surface stderr — git's diagnostics are far more useful than the
      // wrapping Node error message, which is just "Command failed: ...".
      const detail = (e.stderr || e.message || '').trim().slice(0, 800)
      log.error(`git ${args[0]} exit=${e.code} elapsed=${elapsed}ms: ${detail.slice(0, 200)}`)
      throw new HttpError(500, `git failed (exit ${e.code}): ${detail}`)
    }
    log.error(`git ${args[0]} failed elapsed=${elapsed}ms: ${(e as Error).message}`)
    throw new HttpError(500, `git failed: ${(e as Error).message}`)
  }
}

/** Clone an https URL into `dest`. The destination must NOT already exist
 *  — we don't want to ever overwrite a user-controlled directory. Uses
 *  `--depth 1` so we don't pull deep history we'll never look at; the
 *  marketplace cache is throwaway state. */
export async function gitClone(
  url: string,
  dest: string,
  opts: { ref?: string } = {},
): Promise<void> {
  assertHttpsUrl(url)
  const args = ['clone', '--depth', '1', '--single-branch']
  if (opts.ref) {
    // Validate ref shape: refs are restricted to a safe charset by git
    // itself, but a malformed value would surface as a non-zero exit
    // anyway. Reject NUL and shell-meta paranoia just in case.
    if (typeof opts.ref !== 'string' || opts.ref.includes('\0') || opts.ref.length > 256) {
      throw new HttpError(400, 'invalid ref')
    }
    args.push('--branch', opts.ref)
  }
  // `--` separates option args from positional URL/path so a URL that
  // happens to start with `-` can't be reinterpreted as an option.
  args.push('--', url, dest)
  log.info(`clone url=${url} ref=${opts.ref ?? '(default)'} dest=${dest}`)
  await runGitOutside(args, undefined, CLONE_TIMEOUT_MS)
}

/** Clone a full repo and check out a specific commit SHA. Used for
 *  `git-subdir` plugins, whose files live in a SEPARATE repo than the
 *  marketplace manifest. We clone full history (no `--depth`) because the
 *  pinned sha can be any commit in the graph, then detach-checkout it for
 *  reproducibility. `dest` must NOT already exist (same contract as
 *  `gitClone` — the caller handles idempotency / re-clone). */
export async function gitCloneAtSha(
  url: string,
  dest: string,
  opts: { sha: string; ref?: string },
): Promise<void> {
  assertHttpsUrl(url)
  if (typeof opts.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(opts.sha)) {
    throw new HttpError(400, 'invalid sha')
  }
  // Clone without materialising a working tree, then check out the pinned
  // commit. `--` guards a URL that happens to start with `-`.
  log.info(`cloneAtSha url=${url} sha=${opts.sha} ref=${opts.ref ?? '(none)'}`)
  await runGitOutside(['clone', '--no-checkout', '--', url, dest], undefined, FULL_CLONE_TIMEOUT_MS)
  try {
    await runGitOutside(['-C', dest, 'checkout', opts.sha], undefined, CLONE_TIMEOUT_MS)
  } catch (err) {
    // The default clone may not contain a sha that lives only on an
    // unmerged ref. If the manifest name a ref, fetch it and retry once.
    if (opts.ref && typeof opts.ref === 'string' && !opts.ref.includes('\0') && opts.ref.length <= 256) {
      log.warn(`cloneAtSha checkout failed, retrying with ref=${opts.ref}`)
      await runGitOutside(['-C', dest, 'fetch', 'origin', opts.ref], undefined, FULL_CLONE_TIMEOUT_MS)
      await runGitOutside(['-C', dest, 'checkout', opts.sha], undefined, CLONE_TIMEOUT_MS)
    } else {
      throw err
    }
  }
}

/** Pull the latest changes into an existing clone. Returns the new HEAD
 *  SHA and a flag indicating whether anything actually moved. We use
 *  `git pull --ff-only` so a non-fast-forward (e.g. force-pushed remote)
 *  fails loudly rather than silently merging — the user can react with
 *  remove + re-add if their marketplace owner rewrote history.
 *
 *  We compute `updated` by comparing HEAD before/after rather than
 *  scraping pull output, which differs across git versions. */
export async function gitPull(cwd: string): Promise<{ updated: boolean; newSha: string }> {
  const before = await gitGetHeadSha(cwd)
  await runGitOutside(['pull', '--ff-only'], cwd)
  const after = await gitGetHeadSha(cwd)
  return { updated: before !== after, newSha: after }
}

/** Read the current branch name of the clone at `cwd`. Returns '' when the
 *  HEAD is detached (not on any branch) or the dir isn't a usable repo (e.g.
 *  the marketplace cache was wiped). Never throws — callers use the empty
 *  string to mean "no discernible branch". */
export async function gitBranchName(cwd: string): Promise<string> {
  try {
    const out = await runGitOutside(['branch', '--show-current'], cwd)
    return out.trim()
  } catch (err) {
    // runGitOutside already logged the git failure itself; this adds the
    // caller-facing context (which clone dir failed to resolve) so a missing
    // branch chip is diagnosable, not silently swallowed.
    log.warn(`branch resolve failed for ${cwd}: ${(err as Error).message}`)
    return ''
  }
}

/** Read the cwd's HEAD commit SHA. Throws if the cwd isn't a repo, has
 *  no commits, or the SHA can't be parsed. We don't allow the unborn-HEAD
 *  case the way `tryCaptureGitHead` does — a freshly-cloned marketplace
 *  always has at least one commit, and an unborn HEAD here means our
 *  clone is broken. */
export async function gitGetHeadSha(cwd: string): Promise<string> {
  const stdout = await runGitOutside(['rev-parse', 'HEAD'], cwd)
  const sha = stdout.trim()
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new HttpError(500, `unexpected HEAD output: ${sha.slice(0, 80)}`)
  }
  return sha
}

/** Pull the first 40-hex commit SHA out of `git ls-remote` stdout. Output
 *  is one `<sha>\t<refname>` line per advertised ref (plus possible symref
 *  `ref: refs/heads/main` lines on some servers). We scan line-by-line and
 *  return the first token that looks like a full SHA. Returns '' if nothing
 *  matches — the caller decides whether to retry with a broader query. */
function parseLsRemoteSha(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const tok = line.trim().split(/\s+/)[0] ?? ''
    if (/^[0-9a-f]{40}$/i.test(tok)) return tok
  }
  return ''
}

/** Query the remote HEAD SHA of an https repo WITHOUT cloning or mutating
 *  anything on disk. Used by update detection to compare the upstream tip
 *  against a stored `lastSha` and decide whether a marketplace is behind.
 *
 *  Runs `git ls-remote <url> <ref|HEAD>` — no local repo required, so this
 *  works even if the marketplace cache dir was deleted. If `ref` is omitted
 *  we ask for `HEAD`; if the server doesn't advertise HEAD (some don't) the
 *  empty result triggers a fallback `git ls-remote <url>` that takes the
 *  first advertised ref's sha (the default branch). Throws HttpError on git
 *  failure or if no SHA can be parsed — callers isolate per-marketplace. */
export async function gitLsRemoteHead(url: string, ref?: string): Promise<string> {
  assertHttpsUrl(url)
  const refArg = ref && typeof ref === 'string' && !ref.includes('\0') && ref.length <= 256 ? ref : 'HEAD'
  // `--` guards a URL that happens to start with `-` (same contract as gitClone).
  let stdout = await runGitOutside(['ls-remote', '--', url, refArg], undefined, PULL_TIMEOUT_MS)
  let sha = parseLsRemoteSha(stdout)
  if (!sha && refArg === 'HEAD') {
    // HEAD not advertised — fall back to the first advertised ref.
    stdout = await runGitOutside(['ls-remote', '--', url], undefined, PULL_TIMEOUT_MS)
    sha = parseLsRemoteSha(stdout)
  }
  if (!sha) {
    throw new HttpError(500, 'ls-remote returned no parseable SHA')
  }
  return sha
}
