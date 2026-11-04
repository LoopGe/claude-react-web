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
  const key = sessionId !== undefined && resultUuid !== undefined ? cacheKey(sessionId, resultUuid) : null
  // Result state carries the key it belongs to, so an abandoned request for a
  // previous turn can never paint the current one.
  const [loaded, setLoaded] = useState<{ key: string; value: TurnChangesSummary | 'missing' } | null>(null)

  const cached = key === null ? undefined : summaryCache.get(key)
  const value = cached ?? (loaded !== null && loaded.key === key ? loaded.value : undefined)
  const summary = value === undefined || value === 'missing' ? null : value
  const loading = key !== null && value === undefined

  useEffect(() => {
    if (key === null || sessionId === undefined || resultUuid === undefined) return
    let cancelled = false
    if (summaryCache.get(key) === undefined) {
      void loadSummary(sessionId, resultUuid)
        .then((next) => { if (!cancelled) setLoaded({ key, value: next }) })
        .catch(() => {
          // A transport failure is not "no changes": leave the card absent and
          // let a later live frame or remount retry the read.
          if (!cancelled) setLoaded({ key, value: 'missing' })
        })
    }

    // The hook holds the channel for its lifetime; the hub ref-counts it.
    // A transcript rendered outside the app shell still loads over REST.
    const unsubscribe = hub?.subscribe(sessionId)
    const removeListener = hub?.addSessionListener(sessionId, (frame) => {
      if (frame.kind !== 'turn-changes') return
      if (frame.summary.resultUuid !== resultUuid) return
      summaryCache.set(key, frame.summary)
      setLoaded({ key, value: frame.summary })
    })
    return () => {
      cancelled = true
      unsubscribe?.()
      removeListener?.()
    }
  }, [key, sessionId, resultUuid, hub])

  return { summary, loading }
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
  const full = opts?.full === true
  const key = sessionId !== undefined && resultUuid !== undefined && index !== null
    ? `${sessionId}:${resultUuid}:${index}:${full ? 1 : 0}`
    : null
  const [loaded, setLoaded] = useState<{ key: string; value: TurnDiffPayload | null } | null>(null)

  const diff = loaded !== null && loaded.key === key ? loaded.value : null
  const loading = key !== null && (loaded === null || loaded.key !== key)

  useEffect(() => {
    if (key === null || sessionId === undefined || resultUuid === undefined || index === null) return
    const controller = new AbortController()
    let cancelled = false
    const query = new URLSearchParams({ resultUuid, index: String(index) })
    if (full) query.set('full', '1')
    api.get<TurnDiffPayload>(`/sessions/${encodeURIComponent(sessionId)}/turn-diff?${query}`, {
      signal: controller.signal,
    })
      .then((next) => { if (!cancelled) setLoaded({ key, value: next }) })
      .catch(() => { if (!cancelled) setLoaded({ key, value: null }) })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [key, sessionId, resultUuid, index, full])

  return { diff, loading }
}