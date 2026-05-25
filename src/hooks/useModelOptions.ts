// Lazy-fetch the merged model options for a session, used by the inline
// chip in ChatPanel (and any other consumer that wants the same dropdown
// list). The list is the union of:
//
//   1. SDK supportedModels (from /api/sessions/:id/models — what the live
//      claude subprocess actually advertises)
//   2. Server-configured modelList from /api/config — important because
//      custom proxy models (ppio/..., xiaomi/...) often aren't reported
//      by the SDK at all but still work end-to-end
//   3. localStorage recent models (whatever the user typed in NewSession
//      previously) — preserved as a fallback so the dropdown isn't empty
//      while the API calls are in flight or if both API calls fail
//
// Fetching is gated on `enabled`. ChatPanel only enables this when the
// user clicks to edit, so we don't fire two requests per open panel on
// every page load. After the first successful fetch the result is kept
// in state for the lifetime of the hook instance.
//
// We intentionally do NOT debounce or share across panels — each panel
// has its own /sessions/:id/models endpoint anyway, and the /config call
// is so cheap (small JSON, same-origin) that one extra hit per opened
// panel isn't worth a global cache.

import { useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { readRecentModels } from '../utils/recent-models'
import type { ModelInfo } from '../types'

export function useModelOptions(sessionId: string, enabled: boolean): string[] {
  /** Server-derived list (SDK ∪ config). Empty until the first fetch
   *  resolves. We tag it with the sessionId it was fetched for so a
   *  parent that swaps sessions without remounting won't briefly show
   *  the previous session's list. */
  const [data, setData] = useState<{ sessionId: string; models: string[] } | null>(null)
  /** Sentinel for "already fetched (or in-flight) for this sessionId".
   *  A ref rather than state so successful fetches don't cascade-render
   *  the component a second time after the data state update. */
  const fetchedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (fetchedRef.current === sessionId) return
    fetchedRef.current = sessionId
    const ac = new AbortController()
    ;(async () => {
      const [sdkRes, cfgRes] = await Promise.allSettled([
        api.get<{ models: ModelInfo[] }>(
          `/sessions/${sessionId}/models`,
          { signal: ac.signal },
        ),
        api.get<{ models?: string[] }>('/config', { signal: ac.signal }),
      ])
      if (ac.signal.aborted) return

      const sdkIds =
        sdkRes.status === 'fulfilled'
          ? sdkRes.value.models.map((m) => m.id)
          : []
      const cfgIds =
        cfgRes.status === 'fulfilled' ? (cfgRes.value.models ?? []) : []

      // SDK first (canonical), then config-only extras. Dedupe by id.
      const seen = new Set<string>()
      const merged: string[] = []
      for (const id of sdkIds) {
        if (id && !seen.has(id)) {
          seen.add(id)
          merged.push(id)
        }
      }
      for (const id of cfgIds) {
        if (id && !seen.has(id)) {
          seen.add(id)
          merged.push(id)
        }
      }

      // If both calls failed, leave fetchedRef cleared so a subsequent
      // open of the chip will retry rather than show only recents forever.
      if (sdkRes.status === 'rejected' && cfgRes.status === 'rejected') {
        fetchedRef.current = null
        return
      }

      setData({ sessionId, models: merged })
    })()
    return () => { ac.abort() }
  }, [sessionId, enabled])

  // Only use server-derived models when they belong to the current
  // session — guards against showing stale data if the parent reuses
  // this hook instance across sessionId changes (ChatPanel doesn't, but
  // other call sites might).
  const serverModels =
    data && data.sessionId === sessionId ? data.models : []

  // Reading localStorage every render is fine — it's synchronous and
  // microsecond-scale, and the chip only re-renders a handful of times
  // per second.
  const recents = readRecentModels()
  const seen = new Set<string>()
  const combined: string[] = []
  for (const id of serverModels) {
    if (!seen.has(id)) {
      seen.add(id)
      combined.push(id)
    }
  }
  for (const id of recents) {
    if (id && !seen.has(id)) {
      seen.add(id)
      combined.push(id)
    }
  }
  return combined
}
