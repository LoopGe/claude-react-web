// Per-session worktree lifecycle: provision at spawn, recreate on resume,
// clean up on delete — all serialized per common git dir.
//
// `worktree add` / `worktree remove` / `worktree prune` race on the COMMON
// dir's lockfiles (worktrees/, packed-refs.lock) — concurrent adds against
// the same repository fail intermittently. All three therefore run inside
// an in-process mutex keyed on `getGitCommonDir(mainRepoCwd)`, so two
// sessions sharing a repo never interleave their git mutations.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './errors.js'
import {
  branchExists, commitExists, createWorktree, getGitCommonDir,
  pruneWorktrees, removeWorktreeDir, tryCaptureGitHead,
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

/** The directory a session's worktree actually lives at: the meta's
 *  recorded `path` when present, else the session-id-derived path
 *  (identical for every meta persisted before `path` existed). The
 *  recorded path matters for /clear-inherited worktrees — the replacement
 *  session has a NEW id while the directory still lives at the old one. */
export function worktreePathOf(stateDir: string, sessionId: string, wt: WorktreeInfo): string {
  return wt.path ?? worktreePathFor(stateDir, sessionId)
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
  stateDir: string, sessionId: string, wt: WorktreeInfo,
): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
  const worktreePath = worktreePathOf(stateDir, sessionId, wt)
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
): Promise<void> {
  const worktreePath = worktreePathOf(stateDir, sessionId, wt)
  if (!existsSync(worktreePath)) return
  try {
    const commonDir = await getGitCommonDir(wt.mainRepoPath)
    await withRepoLock(commonDir, () => removeWorktreeDir(wt.mainRepoPath, worktreePath))
  } catch (err) {
    log.warn(`[${sessionId}] worktree cleanup failed (branch ${wt.branch} kept): ${err instanceof Error ? err.message : String(err)}`)
  }
}
