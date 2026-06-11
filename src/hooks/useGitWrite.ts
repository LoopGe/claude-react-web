// Hook bundling all git mutation operations for one session.
//
// Each operation is a thin wrapper around api.post that:
//   - Tracks an op-key in `busyOps` so the UI can disable per-button
//     spinners, e.g. busyOps.has('stage:src/foo.ts') greys out that
//     row's stage button only.
//   - Re-throws API errors so the caller can pipe them into useToast
//     (or any other notification surface).
//   - Returns the response payload (not just void) so the caller can
//     consume server-fresh status / branches / stashes WITHOUT waiting
//     for the WS refresh to land. This eliminates the 50-100ms flicker
//     between click and visible update.
//
// The hook itself is UI-agnostic: it doesn't render toasts or spinners.
// That separation lets GitPanel decide where to put error messages
// without the hook making assumptions about layout.

import { useCallback, useMemo, useState } from 'react'
import { api } from './useApi'
import type { GitStashEntry, GitStatus, GitBranch } from '../../shared/git-types'

interface WriteResult {
  status: GitStatus
}

interface StashResult extends WriteResult {
  stashes: GitStashEntry[]
}

interface DropResult {
  stashes: GitStashEntry[]
}

interface BranchResult extends WriteResult {
  branches: GitBranch[]
  stashed?: boolean
}

interface CheckoutResult extends BranchResult {
  stashed: boolean
}

interface SyncResult extends WriteResult {
  branches: GitBranch[]
  updated?: boolean
}

export interface UseGitWriteReturn {
  stage: (paths: readonly string[]) => Promise<WriteResult>
  unstage: (paths: readonly string[]) => Promise<WriteResult>
  /** Discard worktree edits. `untracked: true` runs `git clean -f` on
   *  the listed paths instead of `git checkout HEAD --`. */
  discard: (paths: readonly string[], untracked: boolean) => Promise<WriteResult>
  commit: (message: string, amend: boolean) => Promise<WriteResult>
  abortMerge: () => Promise<WriteResult>
  abortRebase: () => Promise<WriteResult>
  stashCreate: (opts?: { message?: string; includeUntracked?: boolean }) => Promise<StashResult>
  stashPop: (index: number) => Promise<StashResult>
  stashDrop: (index: number) => Promise<DropResult>
  createBranch: (name: string, checkout: boolean, autoStash?: boolean) => Promise<BranchResult>
  checkout: (branch: string, autoStash: boolean) => Promise<CheckoutResult>
  /** AI commit-message generation. The server pipes the *staged* diff
   *  (`git diff --cached`) through Anthropic and returns a Conventional
   *  Commit message. Returns `fallback: true` when the API call failed
   *  and the server produced a synthesised `chore:` message instead. */
  generateCommitMessage: () => Promise<{ message: string; fallback?: boolean }>
  pull: () => Promise<SyncResult>
  push: (force?: boolean) => Promise<SyncResult>
  /** Set of in-flight op keys. Stable identity per render; caller
   *  passes individual key strings to disable specific buttons. */
  busyOps: ReadonlySet<string>
}

export function useGitWrite(sessionId: string | undefined): UseGitWriteReturn {
  // Plain object -> Set so React's identity comparison detects changes.
  // Mutating a Set in-place wouldn't trigger a re-render.
  const [busyOps, setBusyOps] = useState<Set<string>>(() => new Set())

  /** Wrap an op so the caller's promise resolves with the API response,
   *  while busyOps stays accurate even if the request rejects. */
  const run = useCallback(<T,>(opKey: string, fn: () => Promise<T>): Promise<T> => {
    setBusyOps((prev) => {
      const next = new Set(prev)
      next.add(opKey)
      return next
    })
    return fn().finally(() => {
      setBusyOps((prev) => {
        if (!prev.has(opKey)) return prev
        const next = new Set(prev)
        next.delete(opKey)
        return next
      })
    })
  }, [])

  /** Build the per-session route prefix once. */
  const base = useMemo(
    () => (sessionId ? `/sessions/${encodeURIComponent(sessionId)}/git` : ''),
    [sessionId],
  )

  /** Reject early if the hook was constructed without a session id. */
  const ensureSession = useCallback(() => {
    if (!sessionId) throw new Error('useGitWrite called without a sessionId')
  }, [sessionId])

  const postGit = useCallback(<T,>(opKey: string, route: string, body?: unknown): Promise<T> => {
    ensureSession()
    return run(opKey, () => api.post<T>(`${base}/${route}`, body))
  }, [base, ensureSession, run])

  const stage = useCallback((paths: readonly string[]) => {
    return postGit<WriteResult>(`stage:${paths.join(',')}`, 'stage', { paths })
  }, [postGit])

  const unstage = useCallback((paths: readonly string[]) => {
    return postGit<WriteResult>(`unstage:${paths.join(',')}`, 'unstage', { paths })
  }, [postGit])

  const discard = useCallback((paths: readonly string[], untracked: boolean) => {
    return postGit<WriteResult>(`discard:${paths.join(',')}`, 'discard', { paths, untracked, confirm: true })
  }, [postGit])

  const commit = useCallback((message: string, amend: boolean) => {
    // Amend rewrites the previous commit's SHA; the server gates it behind
    // confirm:true. GitPanel already confirms before calling this hook.
    const body = amend ? { message, amend, confirm: true } : { message, amend }
    return postGit<WriteResult>(amend ? 'commit:amend' : 'commit', 'commit', body)
  }, [postGit])

  const abortMerge = useCallback(() => {
    return postGit<WriteResult>('abort-merge', 'abort-merge', { confirm: true })
  }, [postGit])

  const abortRebase = useCallback(() => {
    return postGit<WriteResult>('abort-rebase', 'abort-rebase', { confirm: true })
  }, [postGit])

  const stashCreate = useCallback((opts?: { message?: string; includeUntracked?: boolean }) => {
    return postGit<StashResult>('stash-create', 'stash', opts ?? {})
  }, [postGit])

  const stashPop = useCallback((index: number) => {
    return postGit<StashResult>(`stash-pop:${index}`, 'stash-pop', { index })
  }, [postGit])

  const stashDrop = useCallback((index: number) => {
    return postGit<DropResult>(`stash-drop:${index}`, 'stash-drop', { index, confirm: true })
  }, [postGit])

  const createBranch = useCallback((name: string, checkout: boolean, autoStash?: boolean) => {
    return postGit<BranchResult>(`branch:${name}`, 'branch', { name, checkout, autoStash: autoStash ?? false })
  }, [postGit])

  const checkout = useCallback((branch: string, autoStash: boolean) => {
    return postGit<CheckoutResult>(`checkout:${branch}`, 'checkout', { branch, autoStash })
  }, [postGit])

  const generateCommitMessage = useCallback(() => {
    return postGit<{ message: string; fallback?: boolean }>('commit-message', 'commit-message')
  }, [postGit])

  const pull = useCallback(() => {
    return postGit<SyncResult>('pull', 'pull')
  }, [postGit])

  const push = useCallback((force?: boolean) => {
    return postGit<SyncResult>('push', 'push', { force: !!force, confirm: !!force })
  }, [postGit])

  return {
    stage,
    unstage,
    discard,
    commit,
    abortMerge,
    abortRebase,
    stashCreate,
    stashPop,
    stashDrop,
    createBranch,
    checkout,
    generateCommitMessage,
    pull,
    push,
    busyOps,
  }
}
