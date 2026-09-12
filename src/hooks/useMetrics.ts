import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { MetricsSnapshot } from '../../shared/metrics.js'

const AUTO_REFRESH_MS = 5000
/** Sparkline window: at most this many successful fetches (auto-refresh
 *  appends every AUTO_REFRESH_MS; manual refreshes append too, so the
 *  wall-clock span depends on how often samples land). */
const HISTORY_CAP = 60

/** Fetch the server metrics snapshot. Snapshot + refresh interaction,
 *  matching the Diagnostics tab; optional 5s auto-refresh. Successful
 *  fetches also append to a capped history ring so the panel can draw
 *  p95 sparklines. */
export function useMetrics() {
  const [data, setData] = useState<MetricsSnapshot | null>(null)
  const [history, setHistory] = useState<MetricsSnapshot[]>([])
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
      if (!ctrl.signal.aborted && mountedRef.current) {
        setData(res)
        // Append-only ring: failed fetches never enter, oldest evicted at
        // the cap. New array each time so React sees a changed reference.
        setHistory((prev) => [...prev.slice(-(HISTORY_CAP - 1)), res])
      }
    } catch (e) {
      // A superseded (aborted) request must not clobber the newer call's
      // in-flight state — aborting is not an unmount, so mountedRef alone
      // is not enough here.
      if (!ctrl.signal.aborted && mountedRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!ctrl.signal.aborted && mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    // Defer to a microtask so the effect body performs no synchronous
    // setState (react-hooks/set-state-in-effect) — the first fetch's
    // loading flip happens one microtask later, which is unobservable.
    void Promise.resolve().then(() => refresh())
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

  return { data, loading, error, refresh, auto, setAuto, history }
}
