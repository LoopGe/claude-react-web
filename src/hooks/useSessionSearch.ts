import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'
import { useDebouncedValue } from './useDebouncedValue'
import type { SessionSearchHit, SessionSearchResponse } from '../../shared/session-search'

export interface SessionSearchState {
  hits: SessionSearchHit[]
  totalHits: number
  truncated: boolean
  indexStatus: 'ok' | 'degraded'
  loading: boolean
  error: boolean
  retry: () => void
}

const IDLE = {
  hits: [] as SessionSearchHit[],
  totalHits: 0,
  truncated: false,
  indexStatus: 'ok' as const,
  loading: false,
  error: false,
}

/**
 * Debounced session-scoped transcript search. A new query clears the previous
 * hits immediately (stale snippets would describe a different query); an
 * out-of-order response is dropped by the sequence guard, and the request is
 * aborted on query change/unmount.
 */
export function useSessionSearch(
  sessionId: string,
  query: string,
  opts: { enabled?: boolean } = {},
): SessionSearchState {
  const enabled = opts.enabled ?? true
  const debounced = useDebouncedValue(query.trim(), 180)
  const [state, setState] = useState<SessionSearchState>({ ...IDLE, retry: () => {} })
  const [retryNonce, setRetryNonce] = useState(0)
  const retry = useCallback(() => setRetryNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled || !debounced) return

    let cancelled = false
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new query starts a request; clearing the stale hits and entering the loading state is the request lifecycle, not derivable state
    setState({ ...IDLE, loading: true, retry })

    api
      .get<SessionSearchResponse>(
        `/sessions/${sessionId}/search?q=${encodeURIComponent(debounced)}&limit=100`,
        { signal: controller.signal, timeoutMs: 10_000 },
      )
      .then((res) => {
        if (cancelled || controller.signal.aborted) return
        setState({
          hits: res.hits,
          totalHits: res.totalHits,
          truncated: res.truncated,
          indexStatus: res.indexStatus,
          loading: false,
          error: false,
          retry,
        })
      })
      .catch(() => {
        if (cancelled || controller.signal.aborted) return
        setState({ ...IDLE, error: true, retry })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [sessionId, debounced, enabled, retryNonce, retry])

  return !enabled || !debounced ? { ...IDLE, retry } : state
}