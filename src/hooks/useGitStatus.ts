// React hooks for the read-only /api/git/* surface.
//
// Three families of hooks cover status, branches/stashes, and diff/log.
//
// Status, branches, and stashes are **git-snapshot sinks**: the server
// pushes complete `WsGitSnapshot` frames (status + branches + stashes)
// fanned out by repo group. Each hook fetches once on mount (or cwd
// change) for ground truth, then applies incoming frames directly —
// zero refetch. Manual refresh() still hits HTTP.
//
// Diff, range-diff, range-diff-file, and log hooks have no WS channel;
// callers invoke their `refresh()` imperatively when they want a
// re-fetch (e.g. accordion expand).
//
// Each hook owns an AbortController so a fast cwd switch / unmount
// doesn't leave a stale response in flight that resolves into an
// unmounted setter.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import type {
  GitBranch,
  GitDiff,
  GitStatusResponse,
  GitCommit,
  GitStashEntry,
  GitRangeDiffResponse,
} from '../../shared/git-types'
import type { WsGitSnapshot } from '../../shared/ws-protocol'

interface BaseFetchState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

// ── WS git-snapshot listener ────────────────────────────────────────
//
// Subscribes to a session's channel and invokes `onFrame` for each
// `git-snapshot` frame (server pushes these fanned out by repo group).
// The onFrame ref pattern keeps the effect independent of callback
// identity so per-render closures don't churn the subscription.

function useGitSnapshotListener(
  sessionId: string | undefined,
  enabled: boolean,
  onFrame: (frame: WsGitSnapshot) => void,
): void {
  const hub = useWsHub()
  const onFrameRef = useRef(onFrame)
  useEffect(() => {
    onFrameRef.current = onFrame
  })
  useEffect(() => {
    if (!enabled || !sessionId) return
    const offSub = hub.subscribe(sessionId)
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind === 'git-snapshot') onFrameRef.current(frame)
    })
    return () => {
      offSub()
      offListener()
    }
  }, [enabled, sessionId, hub])
}

// ── useGitStatus ──────────────────────────────────────────────────────

/** Cheap structural equality for GitStatusResponse. Used to short-circuit
 *  setData on WS-triggered refetches when nothing actually changed —
 *  most Edit/Write tool runs land in node_modules / non-tracked files
 *  and produce identical status snapshots. JSON.stringify is fine here:
 *  the payload tops out at ~hundreds of file entries, and serialising
 *  it is orders of magnitude cheaper than the React render cascade we
 *  avoid (GitPanel + every open DiffView). */
function sameStatus(a: GitStatusResponse | null, b: GitStatusResponse): boolean {
  if (a === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface UseGitStatusReturn extends BaseFetchState<GitStatusResponse> {
  refresh: () => void
}

/** Fetch /api/git/status for the given cwd. The hook is a no-op when
 *  `cwd` is undefined (no session cwd configured) or when `enabled` is
 *  false (e.g. session not yet running). The returned `refresh()` is
 *  stable and bumps an internal counter so callers can imperatively
 *  re-fetch (e.g. from a "⟳" button).
 *
 *  The hook is a git-snapshot sink: it fetches once on mount for
 *  ground truth, then applies `git-snapshot` WS frames directly —
 *  zero refetch. A repoRoot guard ensures frames from a different
 *  repo (e.g. a linked worktree) are dropped once the data is
 *  authoritative. */
export function useGitStatus(
  cwd: string | undefined,
  sessionId: string | undefined,
  opts?: { enabled?: boolean },
): UseGitStatusReturn {
  const enabled = opts?.enabled !== false
  const [data, setData] = useState<GitStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd) {
      // Reset state when disabled or no cwd, so the chip falls back to
      // a hidden state instead of showing stale data from a prior repo.
      // The set-state-in-effect rule flags this as a cascading-render
      // hazard, but here it's the *correct* way to invalidate a cache
      // keyed on a changing input — same pattern useChatStream uses.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    api
      .get<GitStatusResponse>(`/git/status?cwd=${encodeURIComponent(cwd)}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        // Skip the setData when the response is identical to the current
        // state — most WS-triggered refetches see no change (Claude edited
        // a file outside the repo, the watcher coalesced bursts, etc.) and
        // we don't want to cascade a render through the panel + every
        // open DiffView for nothing. A JSON-string compare is cheaper than
        // the avoided React work.
        setData((prev) => (sameStatus(prev, res) ? prev : res))
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        // 503 (git missing) and 5xx surface the message; 4xx shouldn't
        // happen for status (we just need a valid cwd) but pass through.
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
  }, [cwd, enabled, tick])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  // Sink: apply pushed snapshots directly — zero refetch. Guard once the
  // data is authoritative (isRepo with repoRoot, from mount fetch): only
  // same-repo frames apply, so a WorktreeChanges overlay (hook cwd =
  // worktree path, subscribed to the main session's channel) never
  // receives main-repo state. Pre-authoritative (first frame beats the
  // mount fetch, or isRepo:false): match on cwd/repoRoot equality; a
  // mismatched frame is dropped in favor of the in-flight HTTP truth.
  useGitSnapshotListener(sessionId, enabled, (frame) => {
    setData((prev) => {
      if (prev && prev.isRepo) {
        if (prev.repoRoot !== frame.repoRoot) return prev
        return sameStatus(prev, frame.status) ? prev : frame.status
      }
      if (frame.cwd !== cwd && frame.repoRoot !== cwd) return prev
      return sameStatus(prev, frame.status) ? prev : frame.status
    })
    setLoading(false)
    setError(null)
  })

  return { data, loading, error, refresh }
}

// ── useGitDiff ────────────────────────────────────────────────────────

export interface UseGitDiffReturn extends BaseFetchState<GitDiff> {
  refresh: () => void
}

/** Fetch a single file's diff. Pass `enabled: false` to keep the hook
 *  inert until the caller (e.g. an accordion row) flips it on. The diff
 *  endpoint is comparatively expensive — one git invocation per file —
 *  so we don't even spend the request unless the user has expanded the
 *  row. */
export function useGitDiff(
  cwd: string | undefined,
  path: string | undefined,
  staged: boolean,
  enabled: boolean,
): UseGitDiffReturn {
  const [data, setData] = useState<GitDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd || !path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ cwd, path, staged: staged ? '1' : '0' })
    api
      .get<GitDiff>(`/git/diff?${qs.toString()}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
  }, [cwd, path, staged, enabled, tick])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  return { data, loading, error, refresh }
}

// ── useGitRangeDiff ───────────────────────────────────────────────────

export interface UseGitRangeDiffReturn extends BaseFetchState<GitRangeDiffResponse> {
  refresh: () => void
}

/** Fetch the per-file change list between two refs (`/git/diff-range`).
 *  Used by the Worktree-changes view to show what an isolated worktree
 *  branch did. Lazy via `enabled`, like useGitDiff — only fetched once
 *  the branch-range tab is actually opened. */
export function useGitRangeDiff(
  cwd: string | undefined,
  from: string | undefined,
  to: string | undefined,
  mergeBase: boolean,
  enabled: boolean,
): UseGitRangeDiffReturn {
  const [data, setData] = useState<GitRangeDiffResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd || !from || !to) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ cwd, from, to, ...(mergeBase ? { mode: 'mergeBase' } : {}) })
    api
      .get<GitRangeDiffResponse>(`/git/diff-range?${qs.toString()}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
  }, [cwd, from, to, mergeBase, enabled, tick])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  return { data, loading, error, refresh }
}

export interface UseGitRangeDiffFileReturn extends BaseFetchState<GitDiff> {
  refresh: () => void
}

/** Fetch ONE file's unified diff across a ref range, lazily on row expand.
 *  Mirrors useGitDiff but with `from`/`to` refs instead of staged/unstaged. */
export function useGitRangeDiffFile(
  cwd: string | undefined,
  from: string | undefined,
  to: string | undefined,
  mergeBase: boolean,
  path: string | undefined,
  enabled: boolean,
): UseGitRangeDiffFileReturn {
  const [data, setData] = useState<GitDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd || !from || !to || !path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ cwd, from, to, path, ...(mergeBase ? { mode: 'mergeBase' } : {}) })
    api
      .get<GitDiff>(`/git/diff-range-file?${qs.toString()}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
  }, [cwd, from, to, mergeBase, path, enabled, tick])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  return { data, loading, error, refresh }
}

// ── useGitLog ─────────────────────────────────────────────────────────

export interface UseGitLogReturn extends BaseFetchState<GitCommit[]> {
  refresh: () => void
}

/** Fetch the most recent N commits. Like useGitDiff, the lazy `enabled`
 *  flag exists so we don't spend a `git log` call unless the user has
 *  the Recent commits section open. */
export function useGitLog(
  cwd: string | undefined,
  limit: number,
  enabled: boolean,
): UseGitLogReturn {
  const [data, setData] = useState<GitCommit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    api
      .get<{ commits: GitCommit[] }>(`/git/log?cwd=${encodeURIComponent(cwd)}&limit=${limit}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res.commits)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
  }, [cwd, limit, enabled, tick])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  return { data, loading, error, refresh }
}

// ── Branches & stashes ────────────────────────────────────────────────
//
// Both hooks are git-snapshot sinks: they fetch once on enable via the
// cwd-scoped read routes, then apply incoming `git-snapshot` WS frames
// directly (no guard — branches/stashes only run inside GitPanel where
// hook cwd == session cwd, and the server only fans out same-group
// frames).

export interface UseGitBranchesReturn extends BaseFetchState<GitBranch[]> {
  refresh: () => void
}

export function useGitBranches(
  cwd: string | undefined,
  sessionId: string | undefined,
  enabled: boolean,
): UseGitBranchesReturn {
  const [data, setData] = useState<GitBranch[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    api
      .get<{ branches: GitBranch[] }>(`/git/branches?cwd=${encodeURIComponent(cwd)}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res.branches)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => { ctrl.abort() }
  }, [cwd, enabled, tick])

  const refresh = useCallback(() => { setTick((n) => n + 1) }, [])

  // No guard: branches/stashes only run inside GitPanel where hook cwd ==
  // session cwd, and the server only fans out same-group frames.
  useGitSnapshotListener(sessionId, enabled, (frame) => {
    setData((prev) => {
      const next = frame.branches
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    })
    setLoading(false)
    setError(null)
  })

  return { data, loading, error, refresh }
}

export interface UseGitStashesReturn extends BaseFetchState<GitStashEntry[]> {
  refresh: () => void
}

export function useGitStashes(
  cwd: string | undefined,
  sessionId: string | undefined,
  enabled: boolean,
): UseGitStashesReturn {
  const [data, setData] = useState<GitStashEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled || !cwd) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    api
      .get<{ stashes: GitStashEntry[] }>(`/git/stashes?cwd=${encodeURIComponent(cwd)}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res.stashes)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setLoading(false)
      })
    return () => { ctrl.abort() }
  }, [cwd, enabled, tick])

  const refresh = useCallback(() => { setTick((n) => n + 1) }, [])

  // No guard: branches/stashes only run inside GitPanel where hook cwd ==
  // session cwd, and the server only fans out same-group frames.
  useGitSnapshotListener(sessionId, enabled, (frame) => {
    setData((prev) => {
      const next = frame.stashes
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    })
    setLoading(false)
    setError(null)
  })

  return { data, loading, error, refresh }
}

