import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { MetricsSnapshot } from '../../shared/metrics.js'

const AUTO_REFRESH_MS = 5000

/** Fetch the server metrics snapshot. Snapshot + refresh interaction,
 *  matching the Diagnostics tab; optional 5s auto-refresh. */
export function useMetrics() {
  const [data, setData] = useState<MetricsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<MetricsSnapshot>('/metrics', { signal: ctrl.signal })
      if (mountedRef.current) setData(res)
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [refresh])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => void refresh(), AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [auto, refresh])

  return { data, loading, error, refresh, auto, setAuto }
}
