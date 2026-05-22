// Hook bundling all git mutation operations for one session.
//
// Each operation is a thin wrapper around api.post that:
//   - Tracks an op-key in `busyOps` so the UI can disable per-button
//     spinners (e.g. busyOps.has('stage:src/foo.ts') → grey out that
//     row's stage button only).
//   - Re-throws API errors so the caller can pipe them into useErrorToast.
//   - Returns the response payload (not just void) so the caller can
//     consume server-fresh status / branches / stashes WITHOUT waiting
//     for the WS refresh to land. This eliminates the 50-100ms flicker
//     between click and visible update.
//
// The hook itself is UI-agnostic — it doesn't render toasts or spinners.
// That separation lets GitPanel decide where to put error messages
// without the hook making assumptions about layout.

import { useCallback, useState } from 'react'
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
}

interface CheckoutResult extends BranchResult {
  stashed: boolean
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
  createBranch: (name: string, checkout: boolean) => Promise<BranchResult>
  checkout: (branch: string, autoStash: boolean) => Promise<CheckoutResult>
  /** AI commit-message generation. The server runs the gitStartSha…HEAD
   *  diff through Anthropic and returns a conventional-commit message.
   *  Returns `fallback: true` when the API call failed and the server
   *  produced a synthesised `chore:` message instead. */
  generateCommitMessage: () => Promise<{ message: string; fallback?: boolean }>
  /** Set of in-flight op keys. Stable identity per render — caller
   *  passes individual key strings to disable specific buttons. */
  busyOps: ReadonlySet<string>
}

export function useGitWrite(sessionId: string | undefined): UseGitWriteReturn {
  // Plain object → Set so React's identity comparison detects changes.
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

  /** Build the per-session route prefix once. The hook is bound to a
   *  single session for its lifetime so the prefix doesn't change. */
  const base = sessionId ? `/sessions/${encodeURIComponent(sessionId)}/git` : ''

  /** Reject early if the hook was constructed without a session id —
   *  callers shouldn't be invoking it in that state, but a defensive
   *  rejection beats an undefined route. */
  function ensureSession() {
    if (!sessionId) throw new Error('useGitWrite called without a sessionId')
  }

  const stage = useCallback((paths: readonly string[]) => {
    ensureSession()
    return run(
      `stage:${paths.join(',')}`,
      () => api.post<WriteResult>(`${base}/stage`, { paths }),
    )
  // base depends on sessionId; capturing sessionId is enough to refresh
  // the closure when it changes (which only happens with a key remount
  // in practice).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- base is sessionId-derived
  }, [sessionId, run])

  const unstage = useCallback((paths: readonly string[]) => {
    ensureSession()
    return run(
      `unstage:${paths.join(',')}`,
      () => api.post<WriteResult>(`${base}/unstage`, { paths }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- base is sessionId-derived
  }, [sessionId, run])

  const discard = useCallback((paths: readonly string[], untracked: boolean) => {
    ensureSession()
    return run(
      `discard:${paths.join(',')}`,
      () => api.post<WriteResult>(`${base}/discard`, { paths, untracked, confirm: true }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const commit = useCallback((message: string, amend: boolean) => {
    ensureSession()
    return run(
      amend ? 'commit:amend' : 'commit',
      () => api.post<WriteResult>(`${base}/commit`, { message, amend }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const abortMerge = useCallback(() => {
    ensureSession()
    return run(
      'abort-merge',
      () => api.post<WriteResult>(`${base}/abort-merge`, { confirm: true }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const abortRebase = useCallback(() => {
    ensureSession()
    return run(
      'abort-rebase',
      () => api.post<WriteResult>(`${base}/abort-rebase`, { confirm: true }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const stashCreate = useCallback((opts?: { message?: string; includeUntracked?: boolean }) => {
    ensureSession()
    return run(
      'stash-create',
      () => api.post<StashResult>(`${base}/stash`, opts ?? {}),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const stashPop = useCallback((index: number) => {
    ensureSession()
    return run(
      `stash-pop:${index}`,
      () => api.post<StashResult>(`${base}/stash-pop`, { index }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const stashDrop = useCallback((index: number) => {
    ensureSession()
    return run(
      `stash-drop:${index}`,
      () => api.post<DropResult>(`${base}/stash-drop`, { index, confirm: true }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const createBranch = useCallback((name: string, checkout: boolean) => {
    ensureSession()
    return run(
      `branch:${name}`,
      () => api.post<BranchResult>(`${base}/branch`, { name, checkout }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const checkout = useCallback((branch: string, autoStash: boolean) => {
    ensureSession()
    return run(
      `checkout:${branch}`,
      () => api.post<CheckoutResult>(`${base}/checkout`, { branch, autoStash }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

  const generateCommitMessage = useCallback(() => {
    ensureSession()
    return run(
      'commit-message',
      () => api.post<{ message: string; fallback?: boolean }>(`${base}/commit-message`),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, run])

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
    busyOps,
  }
}
