// React hooks for the read-only /api/git/* surface.
//
// Three independent hooks cover the three endpoints (status / diff / log)
// because their fetch lifetimes diverge: status is mounted long-running
// alongside the panel header chip, while diff and log only fetch when
// their corresponding accordion is expanded. Sharing one super-hook would
// either over-fetch (always pulling diffs) or under-fetch (lazily pulling
// status when the chip needs it for first paint).
//
// Each hook owns an AbortController so a fast cwd switch / unmount doesn't
// leave a stale response in flight that resolves into a unmounted setter.
//
// useGitStatus subscribes to the per-session `git-status-changed` WS
// frame and bumps its refresh tick whenever one arrives — so the chip
// and panel update automatically after Claude edits files. Diff and log
// hooks have no auto-refresh channel; callers invoke their `refresh()`
// imperatively when they want a re-fetch.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import type {
  GitBranch,
  GitDiff,
  GitFileEntry,
  GitStatusResponse,
  GitCommit,
  GitStashEntry,
} from '../../shared/git-types'

interface BaseFetchState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

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
 *  re-fetch (e.g. from a "⟳" button or a WS-driven event).
 *
 *  When `sessionId` is provided, the hook also subscribes to the
 *  session's `git-status-changed` WS frame and bumps `refresh()`
 *  whenever one lands — that's how Claude's edits or another tab's
 *  stage/commit propagate without polling. */
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
  const hub = useWsHub()

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

  // WS subscription: when a `git-status-changed` frame arrives for this
  // session, bump the tick to refetch. The hub's subscribe() is
  // ref-counted so multiple consumers (chip + open GitPanel) share one
  // server-side stream without duplication.
  useEffect(() => {
    if (!enabled || !sessionId) return
    const offSub = hub.subscribe(sessionId)
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind === 'git-status-changed') refresh()
    })
    return () => {
      offSub()
      offListener()
    }
  }, [enabled, sessionId, hub, refresh])

  return { data, loading, error, refresh }
}

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
// Both hooks follow the same lazy-fetch + WS-refresh pattern as
// useGitStatus: only fetch when `enabled` flips on, then refetch on
// every `git-status-changed` frame so a Claude-driven branch switch
// or a sibling-tab's commit propagates here.

export interface UseGitBranchesReturn extends BaseFetchState<GitBranch[]> {
  refresh: () => void
}

export function useGitBranches(
  sessionId: string | undefined,
  enabled: boolean,
): UseGitBranchesReturn {
  const [data, setData] = useState<GitBranch[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const hub = useWsHub()

  useEffect(() => {
    if (!enabled || !sessionId) {
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
      .get<{ branches: GitBranch[] }>(`/sessions/${encodeURIComponent(sessionId)}/git/branches`, { signal: ctrl.signal })
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
  }, [sessionId, enabled, tick])

  const refresh = useCallback(() => { setTick((n) => n + 1) }, [])

  useEffect(() => {
    if (!enabled || !sessionId) return
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind === 'git-status-changed') refresh()
    })
    return () => { offListener() }
  }, [enabled, sessionId, hub, refresh])

  return { data, loading, error, refresh }
}

export interface UseGitStashesReturn extends BaseFetchState<GitStashEntry[]> {
  refresh: () => void
}

export function useGitStashes(
  sessionId: string | undefined,
  enabled: boolean,
): UseGitStashesReturn {
  const [data, setData] = useState<GitStashEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const hub = useWsHub()

  useEffect(() => {
    if (!enabled || !sessionId) {
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
      .get<{ stashes: GitStashEntry[] }>(`/sessions/${encodeURIComponent(sessionId)}/git/stashes`, { signal: ctrl.signal })
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
  }, [sessionId, enabled, tick])

  const refresh = useCallback(() => { setTick((n) => n + 1) }, [])

  useEffect(() => {
    if (!enabled || !sessionId) return
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind === 'git-status-changed') refresh()
    })
    return () => { offListener() }
  }, [enabled, sessionId, hub, refresh])

  return { data, loading, error, refresh }
}

// ── This-session anchor ───────────────────────────────────────────────
// Lists files changed since session spawn — the input to the
// "This session" view + the AI commit-message generator. `gitStartSha`
// is exposed alongside so the GitPanel can hide the entire section
// when the session was started outside a git repo.

export interface UseSessionFilesReturn extends BaseFetchState<GitFileEntry[]> {
  gitStartSha: string | null
  refresh: () => void
}

export function useSessionFiles(
  sessionId: string | undefined,
  enabled: boolean,
): UseSessionFilesReturn {
  const [data, setData] = useState<GitFileEntry[] | null>(null)
  const [gitStartSha, setGitStartSha] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const hub = useWsHub()

  useEffect(() => {
    if (!enabled || !sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setGitStartSha(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    api
      .get<{ files: GitFileEntry[]; gitStartSha: string | null }>(
        `/sessions/${encodeURIComponent(sessionId)}/git/session-files`,
        { signal: ctrl.signal },
      )
      .then((res) => {
        if (ctrl.signal.aborted) return
        setData(res.files)
        setGitStartSha(res.gitStartSha)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setError(err.message)
        setData(null)
        setGitStartSha(null)
        setLoading(false)
      })
    return () => { ctrl.abort() }
  }, [sessionId, enabled, tick])

  const refresh = useCallback(() => { setTick((n) => n + 1) }, [])

  useEffect(() => {
    if (!enabled || !sessionId) return
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind === 'git-status-changed') refresh()
    })
    return () => { offListener() }
  }, [enabled, sessionId, hub, refresh])

  return { data, loading, error, refresh, gitStartSha }
}
