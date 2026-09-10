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

export function useDiagnostics(sessionId: string) {
  const [data, setData] = useState<DiagnosticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<DiagnosticsData>(`/sessions/${sessionId}/diagnostics`)
      if (!cancelledRef.current) setData(res)
    } catch (e) {
      if (!cancelledRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    cancelledRef.current = false
    void refresh()
    return () => { cancelledRef.current = true }
  }, [refresh])

  const setCliDebug = useCallback(async (value: boolean | null) => {
    const res = await api.put<{ cliDebug: DiagnosticsCliDebug }>(`/sessions/${sessionId}/diagnostics`, { cliDebug: value })
    setData((prev) => (prev ? { ...prev, cliDebug: res.cliDebug } : prev))
  }, [sessionId])

  return { data, loading, error, refresh, setCliDebug }
}