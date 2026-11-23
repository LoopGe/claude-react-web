// Debounced, abortable client for the session-scoped file-search endpoint
// (GET /sessions/:id/file-search). Feeds the composer's lazy @file/@folder
// picker. Each keystroke restarts a ~150ms debounce; a query change aborts the
// previous in-flight request so a slow earlier search can never overwrite the
// candidates for what the user is typing now.

import { useEffect, useState } from 'react'
import { api } from './useApi'

export interface FileSearchResult {
  path: string
  dir: boolean
}

/** Keystroke debounce before a search fires (design: ~150ms). */
const FILE_SEARCH_DEBOUNCE_MS = 150
/** Matches the endpoint's hard cap; the server clamps regardless. */
const FILE_SEARCH_LIMIT = 20

/**
 * Search `sessionId`'s cwd for `query`. Returns `{results, loading,
 * settledQuery}`; results/loading are empty/false unless `enabled` with a
 * session and a non-empty query. Stale results are kept visible during the
 * debounce window (no flicker between keystrokes) and replaced when the new
 * search lands.
 *
 * `settledQuery` is the query that produced `results` (null until the first
 * search settles; a failed search settles too — empty candidates). During a
 * debounce/in-flight window it still names the PREVIOUS query, so comparing
 * it against the live query tells "settled for what's typed now" apart from
 * "pending, showing older results" — the composer's Enter fall-through reads
 * exactly that distinction.
 */
export function useFileSearch(
  sessionId: string | null,
  query: string,
  enabled: boolean,
): { results: FileSearchResult[]; loading: boolean; settledQuery: string | null } {
  const [results, setResults] = useState<FileSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [settledQuery, setSettledQuery] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || sessionId == null || query === '') return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      api
        .get<{ results: FileSearchResult[] }>(
          `/sessions/${encodeURIComponent(sessionId)}/file-search?q=${encodeURIComponent(query)}&limit=${FILE_SEARCH_LIMIT}`,
          { signal: controller.signal },
        )
        .then((r) => {
          if (controller.signal.aborted) return
          setResults(r.results)
          setLoading(false)
          setSettledQuery(query)
        })
        .catch(() => {
          // An abort is intentional cancellation (a newer query superseded this
          // one) — leave state to the newer request. A genuine failure yields no
          // candidates; the picker shows its empty state rather than crashing
          // the composer.
          if (controller.signal.aborted) return
          setResults([])
          setLoading(false)
          setSettledQuery(query)
        })
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, query, enabled])

  const active = enabled && sessionId != null && query !== ''
  return {
    results: active ? results : [],
    loading: active && loading,
    settledQuery: active ? settledQuery : null,
  }
}
