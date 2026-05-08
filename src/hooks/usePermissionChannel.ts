// Tool-permission channel for one Chat session.
//
// Subscribes to /api/sessions/:id/permissions/stream, merges new pending
// requests with an initial snapshot fetched over REST (covers the race
// where a request was broadcast before our SSE connected), and exposes
// `decide()` to resolve them.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from './useApi'
import { useNamedEventSource } from './useSSE'
import type { PermissionRequest, PermissionResolved } from '../types'

export type PermissionDecision =
  | { behavior: 'allow'; persistForSession: boolean }
  | { behavior: 'deny'; message?: string }

export interface UsePermissionChannel {
  pending: PermissionRequest[]
  error: string | null
  decide: (pid: string, decision: PermissionDecision) => Promise<void>
  reset: () => void
  clearError: () => void
}

export function usePermissionChannel(sessionId: string): UsePermissionChannel {
  const [pending, setPending] = useState<PermissionRequest[]>([])
  const [error, setError] = useState<string | null>(null)

  // Initial snapshot of pending permission requests — covers the case
  // where the permission SSE subscription hadn't opened yet when the
  // request was broadcast (e.g. after a hard refresh).
  useEffect(() => {
    let cancelled = false
    api
      .get<{ pending: PermissionRequest[] }>(`/sessions/${sessionId}/permissions`)
      .then((res) => {
        if (cancelled) return
        setPending((prev) => mergePending(prev, res.pending))
      })
      .catch(() => {
        /* non-fatal: the SSE subscription will catch subsequent events */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Stable handler map so the EventSource isn't torn down on every render.
  const events = useMemo(
    () => ({
      permission_request: (payload: unknown) => {
        const req = payload as PermissionRequest | null
        if (!req?.id) return
        setPending((prev) => mergePending(prev, [req]))
      },
      permission_resolved: (payload: unknown) => {
        const res = payload as PermissionResolved | null
        if (!res?.id) return
        setPending((prev) => prev.filter((p) => p.id !== res.id))
      },
    }),
    [],
  )
  useNamedEventSource(`/api/sessions/${sessionId}/permissions/stream`, events)

  const decide = useCallback(
    async (pid: string, decision: PermissionDecision) => {
      // Optimistically drop the request so the dialog closes immediately.
      // If the POST fails we still show the error bar and re-fetch pending.
      setPending((prev) => prev.filter((p) => p.id !== pid))
      try {
        await api.post(`/sessions/${sessionId}/permissions/${pid}/decide`, decision)
      } catch (e) {
        setError(`Permission decision failed: ${(e as Error).message}`)
        try {
          const r = await api.get<{ pending: PermissionRequest[] }>(
            `/sessions/${sessionId}/permissions`,
          )
          setPending(r.pending)
        } catch {
          /* ignore */
        }
      }
    },
    [sessionId],
  )

  const reset = useCallback(() => {
    setPending([])
    setError(null)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return useMemo(
    () => ({ pending, error, decide, reset, clearError }),
    [pending, error, decide, reset, clearError],
  )
}

/** Merge a fresh pending array into an existing one, de-duping by id. */
function mergePending(prev: PermissionRequest[], incoming: PermissionRequest[]): PermissionRequest[] {
  const seen = new Set(prev.map((p) => p.id))
  const merged = [...prev]
  for (const p of incoming) {
    if (!seen.has(p.id)) {
      merged.push(p)
      seen.add(p.id)
    }
  }
  return merged
}
