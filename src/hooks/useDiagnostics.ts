import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'

export interface DiagnosticsCliDebug {
  global: boolean
  perSession?: boolean
  effective: boolean
}
export interface DiagnosticsData {
  cliDebug: DiagnosticsCliDebug
  stderrTail: string[]
  debugLog: { exists: boolean; path?: string; size?: number }
}

export function useDiagnostics(sessionId: string, enabled = true) {
  const [data, setData] = useState<DiagnosticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    if (!enabled) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<DiagnosticsData>(`/sessions/${sessionId}/diagnostics`, { signal: ctrl.signal })
      if (!ctrl.signal.aborted && mountedRef.current) setData(res)
    } catch (e) {
      if (!ctrl.signal.aborted && mountedRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!ctrl.signal.aborted && mountedRef.current) setLoading(false)
    }
  }, [sessionId, enabled])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [refresh])

  const setCliDebug = useCallback(async (value: boolean | null) => {
    const res = await api.put<{ cliDebug: DiagnosticsCliDebug }>(`/sessions/${sessionId}/diagnostics`, { cliDebug: value })
    if (mountedRef.current) {
      setData((prev) => (prev ? { ...prev, cliDebug: res.cliDebug } : prev))
    }
  }, [sessionId])

  return { data, loading, error, refresh, setCliDebug }
}
