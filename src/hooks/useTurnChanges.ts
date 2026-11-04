// Per-turn changed-files data.
//
// A turn's summary is persisted in the server's snapshot sidecar and pushed
// as a `turn-changes` frame on the session message-status channel. The hook
// reads the frame when present and otherwise fetches the sidecar once per
// (session, resultUuid); the cache is shared by every card, so history
// scrolling and panel remounts do not refetch.
//
// Live frames can arrive before OR after the card mounts: the result row
// renders as soon as the turn closes, while the server records the summary a
// moment later.
import { useEffect, useState } from 'react'
import type { TurnChangesSummary, TurnDiffPayload } from '../../shared/turn-changes.js'
import { api } from './useApi'
import { useOptionalWsHub } from './useWsHub'

interface TurnChangesResponse {
  available: boolean
  summary?: TurnChangesSummary
}

/** One summary per (session, resultUuid), or 'missing' once the server says it has none. */
const summaryCache = new Map<string, TurnChangesSummary | 'missing'>()
/** Coalesces concurrent readers of the same summary. */
const inflight = new Map<string, Promise<TurnChangesSummary | 'missing'>>()

function cacheKey(sessionId: string, resultUuid: string): string {
  return `${sessionId}:${resultUuid}`
}

function loadSummary(sessionId: string, resultUuid: string): Promise<TurnChangesSummary | 'missing'> {
  const key = cacheKey(sessionId, resultUuid)
  const cached = summaryCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = inflight.get(key)
  if (pending !== undefined) return pending
  const request = api.get<TurnChangesResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/turn-changes?resultUuid=${encodeURIComponent(resultUuid)}`,
  ).then((response) => {
    const value = response.available && response.summary !== undefined ? response.summary : 'missing'
    summaryCache.set(key, value)
    return value
  }).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, request)
  return request
}

/** One turn's summary, or null while it is unknown. */
export interface TurnChangesView {
  summary: TurnChangesSummary | null
  loading: boolean
}

/**
 * Read and subscribe to one turn's changed-file summary.
 * @param sessionId - viewed session.
 * @param resultUuid - the result frame that closed the turn.
 * @returns the summary once known; null for a missing/empty turn.
 */
export function useTurnChanges(sessionId: string | undefined, resultUuid: string | undefined): TurnChangesView {
  const hub = useOptionalWsHub()
  const [view, setView] = useState<TurnChangesView>(() => {
    if (!sessionId || !resultUuid) return { summary: null, loading: false }
    const cached = summaryCache.get(cacheKey(sessionId, resultUuid))
    if (cached === undefined) return { summary: null, loading: true }
    return { summary: cached === 'missing' ? null : cached, loading: false }
  })

  useEffect(() => {
    if (!sessionId || !resultUuid) {
      setView({ summary: null, loading: false })
      return
    }
    const key = cacheKey(sessionId, resultUuid)
    let cancelled = false
    const cached = summaryCache.get(key)
    if (cached !== undefined) {
      setView({ summary: cached === 'missing' ? null : cached, loading: false })
    } else {
      setView({ summary: null, loading: true })
      void loadSummary(sessionId, resultUuid)
        .then((value) => {
          if (!cancelled) setView({ summary: value === 'missing' ? null : value, loading: false })
        })
        .catch(() => {
          // A transport failure is not "no changes": leave the card absent and
          // let a later live frame or remount retry the read.
          if (!cancelled) setView({ summary: null, loading: false })
        })
    }

    // The hook holds the channel for its lifetime; the hub ref-counts it.
    // A transcript rendered outside the app shell still loads over REST.
    const unsubscribe = hub?.subscribe(sessionId)
    const removeListener = hub?.addSessionListener(sessionId, (frame) => {
      if (frame.kind !== 'turn-changes') return
      if (frame.summary.resultUuid !== resultUuid) return
      summaryCache.set(key, frame.summary)
      setView({ summary: frame.summary, loading: false })
    })
    return () => {
      cancelled = true
      unsubscribe?.()
      removeListener?.()
    }
  }, [sessionId, resultUuid, hub?.subscribe, hub?.addSessionListener])

  return view
}

/** One listed file's comparison, fetched on demand. */
export interface TurnDiffView {
  diff: TurnDiffPayload | null
  loading: boolean
}

/**
 * Read one listed file's turn-start / turn-end comparison.
 * @param sessionId - viewed session.
 * @param resultUuid - the result frame that closed the turn.
 * @param index - file index in the summary; null skips the read.
 * @param opts.full - request the unclipped patch body.
 * @returns the comparison state.
 */
export function useTurnDiff(
  sessionId: string | undefined,
  resultUuid: string | undefined,
  index: number | null,
  opts?: { full?: boolean },
): TurnDiffView {
  const [view, setView] = useState<TurnDiffView>({ diff: null, loading: false })
  const full = opts?.full === true

  useEffect(() => {
    if (!sessionId || !resultUuid || index === null) {
      setView({ diff: null, loading: false })
      return
    }
    const controller = new AbortController()
    let cancelled = false
    setView({ diff: null, loading: true })
    const query = new URLSearchParams({ resultUuid, index: String(index) })
    if (full) query.set('full', '1')
    api.get<TurnDiffPayload>(`/sessions/${encodeURIComponent(sessionId)}/turn-diff?${query}`, {
      signal: controller.signal,
    })
      .then((diff) => {
        if (!cancelled) setView({ diff, loading: false })
      })
      .catch(() => {
        if (!cancelled) setView({ diff: null, loading: false })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [sessionId, resultUuid, index, full])

  return view
}