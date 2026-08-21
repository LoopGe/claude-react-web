// On-demand structured /usage fetch for one session — the data behind the
// CLI's `/usage` command (session cost/token totals + claude.ai plan
// rate-limit windows). Pull-only by design: the rate-limit windows move on
// hour scales, so there is no WS channel and no polling; the UsagePanel
// refreshes when opened and on explicit click.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { SessionUsageData } from '../types'

export interface UseSessionUsageApi {
  data: SessionUsageData | null
  loading: boolean
  error: string | null
  /** Fetch (or re-fetch) usage. No-op while a fetch is in flight or when
   *  no sessionId is bound (panel for a not-yet-spawned session). */
  refresh: () => void
}

export function useSessionUsage(sessionId: string | undefined): UseSessionUsageApi {
  const [data, setData] = useState<SessionUsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  // Session switch: drop stale data so a panel moving to another session
  // never shows the previous one's cost. Reset-during-render (the React
  // docs pattern for adjusting state on prop change) rather than an effect,
  // which would cascade a second render.
  const [prevSessionId, setPrevSessionId] = useState(sessionId)
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId)
    setData(null)
    setError(null)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const refresh = useCallback(() => {
    // Empty-sessionId guard (same pattern as usePermissionChannel): the
    // panel can mount before the session id exists.
    if (!sessionId) return
    // Skip while in flight — double-click on refresh shouldn't stack
    // concurrent requests racing to setData.
    if (abortRef.current) return
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    api
      .get<{ usage: SessionUsageData }>(`/sessions/${sessionId}/usage`, { signal: controller.signal })
      .then((res) => {
        if (!mountedRef.current || controller.signal.aborted) return
        setData(res?.usage ?? null)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!mountedRef.current || controller.signal.aborted) {
          abortRef.current = null
          return
        }
        abortRef.current = null
        setLoading(false)
      })
  }, [sessionId])

  return { data, loading, error, refresh }
}
