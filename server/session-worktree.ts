// Per-session worktree lifecycle: provision at spawn, recreate on resume,
// clean up on delete — all serialized per common git dir.
//
// `worktree add` / `worktree remove` / `worktree prune` race on the COMMON
// dir's lockfiles (worktrees/, packed-refs.lock) — concurrent adds against
// the same repository fail intermittently. All three therefore run inside
// an in-process mutex keyed on `getGitCommonDir(mainRepoCwd)`, so two
// sessions sharing a repo never interleave their git mutations.

import { existsSync, promises as fsPromises } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { HttpError } from './errors.js'
import {
  branchExists, commitExists, createWorktree, getGitCommonDir,
  pruneWorktrees, removeWorktreeDir, runGit, tryCaptureGitHead,
} from './git.js'
import type { WorktreeInfo } from '../shared/session-info.js'

/** worktree add/remove/prune race on the COMMON dir's lockfiles
 *  (worktrees/, packed-refs.lock) — serialize per common dir, in-process. */
const repoLocks = new Map<string, Promise<void>>()

export async function withRepoLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(commonDir) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const next = prev.then(() => gate)
  repoLocks.set(commonDir, next)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (repoLocks.get(commonDir) === next) repoLocks.delete(commonDir)
  }
}

export function worktreePathFor(stateDir: string, sessionId: string): string {
  return join(stateDir, 'worktrees', sessionId)
}

/** The directory a session's worktree actually lives at. Resolution order:
 *
 *  1. the meta's recorded `path` — honored when it is still a direct child
 *     of the CURRENT `<stateDir>/worktrees/` root, or when the dir
 *     physically still exists (state-dir relocation with the session still
 *     living at the old root: recreate never runs then because the cwd
 *     exists, so nothing is rebuilt outside the new root, while the
 *     delete-confirm dirty check and cleanup keep working).
 *  2. `cwdHint` (the session's cwd) when it is a direct child of the
 *     current root — covers legacy /clear inheritance, where the successor
 *     Y (new id) holds a pre-`path` WorktreeInfo while the directory still
 *     lives at the X-named path. Deliberately NOT accepted on existence
 *     alone: the hint must name a managed worktree dir, never an arbitrary
 *     cwd a destructive cleanup could mistake for this session's worktree.
 *  3. the session-id-derived path (identical for every meta persisted
 *     before `path` existed). A recorded path under a foreign root that no
 *     longer EXISTS is treated as absent: recreate must land inside the
 *     NEW root, where the orphan sweep can manage the dir. */
export function worktreePathOf(
  stateDir: string, sessionId: string, wt: WorktreeInfo, cwdHint?: string,
): string {
  const root = resolve(join(stateDir, 'worktrees'))
  if (wt.path) {
    const p = resolve(wt.path)
    if (dirname(p) === root || existsSync(p)) return p
  }
  if (cwdHint) {
    const p = resolve(cwdHint)
    if (dirname(p) === root) return p
  }
  return worktreePathFor(stateDir, sessionId)
}

export function branchFor(sessionId: string): string {
  return `crw/${sessionId.slice(0, 8)}`
}

export interface ProvisionedWorktree { worktreePath: string; branch: string; baseSha: string }

/** Branch-name collision backstop (spec: 时间戳后缀重试). The 8-hex id
 *  prefix can collide across sessions, and deleted sessions KEEP their
 *  branches — so a live collision is possible, not theoretical. */
async function branchForUnique(mainRepoCwd: string, sessionId: string): Promise<string> {
  const base = branchFor(sessionId)
  if (!(await branchExists(mainRepoCwd, base))) return base
  return `${base}-${Date.now()}`
}

/** Create a per-session linked worktree off `mainRepoCwd`'s HEAD.
 *  Throws HttpError(400) for non-repo / unborn HEAD / git failure. */
export async function provisionWorktree(
  stateDir: string, sessionId: string, mainRepoCwd: string,
): Promise<ProvisionedWorktree> {
  const baseSha = await tryCaptureGitHead(mainRepoCwd)
  if (!baseSha) {
    throw new HttpError(400, `worktree isolation needs a git repo with at least one commit: ${mainRepoCwd}`)
  }
  const worktreePath = worktreePathFor(stateDir, sessionId)
  const branch = await branchForUnique(mainRepoCwd, sessionId)
  const commonDir = await getGitCommonDir(mainRepoCwd)
  try {
    await withRepoLock(commonDir, () => createWorktree(mainRepoCwd, worktreePath, branch, baseSha, true))
  } catch (err) {
    // runGit surfaces a git failure as HttpError(500, trimmed stderr). A
    // failed create is a USER-input problem (dirty path, branch collision,
    // repo state) — the spec's error table promises 400 with git stderr, not
    // a 500.
    if (err instanceof HttpError && err.status === 500) {
      throw new HttpError(400, err.message)
    }
    throw err
  }
  return { worktreePath, branch, baseSha }
}

/** Recreate chain for resume: existing dir → existing branch → baseSha →
 *  fall back to the main repo (clearing the worktree metadata). */
export async function ensureWorktreeForResume(
  stateDir: string, sessionId: string, wt: WorktreeInfo, cwdHint?: string,
): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
  const worktreePath = worktreePathOf(stateDir, sessionId, wt, cwdHint)
  if (existsSync(worktreePath)) return { cwd: worktreePath, worktree: wt }
  if (!existsSync(wt.mainRepoPath)) return { cwd: wt.mainRepoPath, worktree: undefined }
  const commonDir = await getGitCommonDir(wt.mainRepoPath)
  if (await branchExists(wt.mainRepoPath, wt.branch)) {
    // The dir was deleted out-of-band, so a stale registration likely
    // blocks re-adding at the same path — prune first.
    await withRepoLock(commonDir, async () => {
      await pruneWorktrees(wt.mainRepoPath)
      await createWorktree(wt.mainRepoPath, worktreePath, wt.branch, '', false)
    })
    return { cwd: worktreePath, worktree: wt }
  }
  if (await commitExists(wt.mainRepoPath, wt.baseSha)) {
    await withRepoLock(commonDir, async () => {
      await pruneWorktrees(wt.mainRepoPath)
      await createWorktree(wt.mainRepoPath, worktreePath, wt.branch, wt.baseSha, true)
    })
    return { cwd: worktreePath, worktree: wt }
  }
  return { cwd: wt.mainRepoPath, worktree: undefined }
}

/** Delete-session cleanup: remove the worktree dir, keep the branch.
 *  Best-effort per spec — a failure logs and does NOT block deletion. */
export async function removeWorktreeForSession(
  stateDir: string, sessionId: string, wt: WorktreeInfo, log: { warn(msg: string): void },
  cwdHint?: string,
): Promise<void> {
  const worktreePath = worktreePathOf(stateDir, sessionId, wt, cwdHint)
  if (!existsSync(worktreePath)) return
  try {
    const commonDir = await getGitCommonDir(wt.mainRepoPath)
    await withRepoLock(commonDir, () => removeWorktreeDir(wt.mainRepoPath, worktreePath))
  } catch (err) {
    log.warn(`[${sessionId}] worktree cleanup failed (branch ${wt.branch} kept): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Grace window before the sweep considers an unclaimed dir orphaned:
 *  provisionWorktree mkdirs first and the WorktreeInfo lands in the store
 *  seconds later — mtime grace protects that window. */
const SWEEP_GRACE_MS = 10 * 60_000

const SWEEP_GIT_TIMEOUT_MS = 30_000

/** Sweep orphaned worktree dirs: directories under <stateDir>/worktrees/
 *  that no session claims, older than the grace window (provision lands in
 *  the store seconds after mkdir — mtime grace protects that window). The
 *  caller snapshots the claimed set ONCE per tick (`claimedDirs`: every
 *  session's worktree.path and cwd — persisted metas and live sessions
 *  alike), so legacy metas of any shape can never be swept out from under
 *  their session and no per-directory store scans run. A dir is also
 *  claimed when a claimed path lives INSIDE it (a session re-pointed to a
 *  subdirectory of its worktree still keeps the workspace alive). Branches
 *  are NEVER touched (delete-keeps-branch rule). Best-effort per directory;
 *  never throws. Returns the number of removed dirs. */
export async function sweepOrphanWorktrees(
  stateDir: string,
  opts: { claimedDirs: ReadonlySet<string>; log: { warn(msg: string): void; info(msg: string): void } },
): Promise<number> {
  const root = join(stateDir, 'worktrees')
  let names: string[]
  try {
    names = await fsPromises.readdir(root)
  } catch {
    // Missing (or unreadable) root — nothing was ever provisioned here.
    return 0
  }
  const claimed = [...opts.claimedDirs].map((p) => resolve(p))
  const isClaimed = (dir: string) =>
    claimed.includes(dir) || claimed.some((p) => p.startsWith(dir + sep))
  let removed = 0
  for (const name of names) {
    const dir = join(root, name)
    try {
      const st = await fsPromises.stat(dir)
      if (!st.isDirectory()) continue
      if (Date.now() - st.mtimeMs < SWEEP_GRACE_MS) continue
      if (isClaimed(resolve(dir))) continue
      await removeOrphanWorktree(dir, opts.log)
      removed++
    } catch (err) {
      opts.log.warn(`worktree sweep: failed handling ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return removed
}

/** Teardown for ONE orphan dir. A valid `.git` registration → clean
 *  `git worktree remove --force` (clears the registration in the common
 *  dir); anything else → plain rm + best-effort `worktree prune`.
 *  Branches are never touched. Never throws. */
async function removeOrphanWorktree(
  dir: string, log: { warn(msg: string): void; info(msg: string): void },
): Promise<void> {
  const commonDir = await worktreeCommonDir(dir)
  if (!commonDir) {
    log.warn(`worktree sweep: ${dir} has no valid .git registration; removing the directory directly`)
  } else {
    try {
      await withRepoLock(commonDir, () =>
        runGit(commonDir, ['worktree', 'remove', '--force', dir], { timeoutMs: SWEEP_GIT_TIMEOUT_MS }))
      return
    } catch (err) {
      log.warn(`worktree sweep: git worktree remove failed for ${dir}, removing the directory directly: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await fsPromises.rm(dir, { recursive: true, force: true })
  if (commonDir) {
    try {
      // Locked like every other prune call site — prune races concurrent
      // worktree add/remove on the common dir's lockfiles.
      await withRepoLock(commonDir, () => pruneWorktrees(commonDir, { timeoutMs: SWEEP_GIT_TIMEOUT_MS }))
    } catch {
      // Best-effort — a stale registration is harmless once the dir is gone.
    }
  }
}

/** The common git dir the worktree registers against — authoritative
 *  `rev-parse --git-common-dir` run INSIDE the worktree. Null when the dir
 *  is missing or its registration is corrupt (rev-parse fails). */
async function worktreeCommonDir(dir: string): Promise<string | null> {
  try {
    return await getGitCommonDir(dir)
  } catch {
    return null
  }
}
