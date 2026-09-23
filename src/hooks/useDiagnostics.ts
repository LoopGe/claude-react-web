import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'
import { snapshotFailed, snapshotLoaded, snapshotView, type RequestSnapshot } from '../utils/request-snapshot'
import { formatError } from '../utils/format-error'

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

// The request key identifies one load: the session it reads plus a manual-refresh
// epoch. `snapshotView` turns the settled result into data/loading/error (see
// src/utils/request-snapshot.ts for the model and why nothing sets state from
// the effect body).
const requestKey = (sessionId: string, epoch: number) => `${sessionId}#${epoch}`

export function useDiagnostics(sessionId: string, enabled = true) {
  const [epoch, setEpoch] = useState(0)
  const [snapshot, setSnapshot] = useState<RequestSnapshot<DiagnosticsData> | null>(null)
  const key = enabled ? requestKey(sessionId, epoch) : null

  useEffect(() => {
    if (key === null) return
    const ctrl = new AbortController()
    api
      .get<DiagnosticsData>(`/sessions/${sessionId}/diagnostics`, { signal: ctrl.signal })
      .then((res) => {
        if (!ctrl.signal.aborted) setSnapshot(snapshotLoaded(key, res))
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) {
          setSnapshot((prev) => snapshotFailed(prev, key, formatError(e)))
        }
      })
    return () => ctrl.abort()
  }, [key, sessionId])

  // Manual refresh only re-keys the request; the effect above owns the fetch and
  // its AbortController, so the superseded one is cancelled by the cleanup.
  const refresh = useCallback(() => setEpoch((n) => n + 1), [])

  const setCliDebug = useCallback(
    async (value: boolean | null) => {
      const res = await api.put<{ cliDebug: DiagnosticsCliDebug }>(`/sessions/${sessionId}/diagnostics`, {
        cliDebug: value,
      })
      // Optimistic patch of what's on screen: the write lands on the snapshot
      // `data` currently reads from, whatever key it carries.
      setSnapshot((prev) => (prev?.data ? { ...prev, data: { ...prev.data, cliDebug: res.cliDebug } } : prev))
    },
    [sessionId],
  )

  return { ...snapshotView(snapshot, key), refresh, setCliDebug }
}
