// MCP elicitation (OAuth auth / server-initiated form) state for one Chat
// session.
//
// Mirrors usePermissionChannel.ts: this hook does NOT open its own
// connection — elicitation events are multiplexed onto the WebSocket hub.
// The caller routes `elicitation-request` / `elicitation-resolved` frames
// (via useChatStream's frame switch) into `onRequest()` / `onResolved()`.
// A one-shot REST call seeds the initial pending list, covering the race
// where a request was broadcast before the WebSocket subscription opened.
// Reconnects are covered by the server's replay snapshot (the `replay` /
// `replay-done` frames carry `elicitations`), not by a REST re-seed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from './useApi'
import type { ElicitationDecision, ElicitationRequestUi, ElicitationResolved } from '../types'

export interface UseElicitationChannel {
  pending: ElicitationRequestUi[]
  error: string | null
  decide: (eid: string, decision: ElicitationDecision) => Promise<void>
  /** Push an elicitation-request event into local state. */
  onRequest: (req: ElicitationRequestUi) => void
  /** Push an elicitation-resolved event into local state. */
  onResolved: (res: ElicitationResolved) => void
  reset: () => void
  clearError: () => void
}

export function useElicitationChannel(sessionId: string): UseElicitationChannel {
  const [pending, setPending] = useState<ElicitationRequestUi[]>([])
  const [error, setError] = useState<string | null>(null)

  // Mirrors `pending` so async control flows (decide) can capture the
  // just-removed request synchronously — see usePermissionChannel for the
  // React batching rationale.
  const pendingRef = useRef<ElicitationRequestUi[]>(pending)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // Initial snapshot — same rationale as usePermissionChannel: the WS
  // subscription re-broadcasts still-open requests on connect, but the REST
  // snapshot makes the dialog appear immediately after a hard refresh.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api
      .get<{ pending: ElicitationRequestUi[] }>(`/sessions/${sessionId}/elicitations`)
      .then((res) => {
        if (cancelled) return
        setPending((prev) => mergePending(prev, res.pending))
      })
      .catch(() => {
        /* non-fatal: the WebSocket subscription will catch subsequent events */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const onRequest = useCallback((req: ElicitationRequestUi) => {
    if (!req?.id) return
    setPending((prev) => mergePending(prev, [req]))
  }, [])

  const onResolved = useCallback((res: ElicitationResolved) => {
    if (!res?.id) return
    setPending((prev) => prev.filter((p) => p.id !== res.id))
  }, [])

  /** Optimistic-update-with-rollback, mirroring usePermissionChannel:
   *  drop the request locally so the dialog closes immediately; on POST
   *  failure, re-fetch pending to reconcile, and re-insert the removed
   *  request if even the re-fetch fails. */
  const decide = useCallback(
    async (eid: string, decision: ElicitationDecision) => {
      const removed = pendingRef.current.find((p) => p.id === eid)
      setPending((prev) => prev.filter((p) => p.id !== eid))
      try {
        await api.post(`/sessions/${sessionId}/elicitations/${eid}/decide`, decision)
      } catch (e) {
        setError(`Elicitation decision failed: ${(e as Error).message}`)
        try {
          const r = await api.get<{ pending: ElicitationRequestUi[] }>(
            `/sessions/${sessionId}/elicitations`,
          )
          setPending((prev) => mergePending(prev, r.pending))
        } catch {
          if (removed) setPending((prev) => mergePending(prev, [removed]))
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
    () => ({ pending, error, decide, onRequest, onResolved, reset, clearError }),
    [pending, error, decide, onRequest, onResolved, reset, clearError],
  )
}

/** Merge a fresh pending array into an existing one.
 *  - Existing entries are updated-in-place when `incoming` has the same id.
 *  - New entries are appended at the end.
 *  - Ordering of existing entries is preserved. */
function mergePending(
  prev: ElicitationRequestUi[],
  incoming: ElicitationRequestUi[],
): ElicitationRequestUi[] {
  if (!incoming?.length) return prev
  const incomingById = new Map(incoming.map((p) => [p.id, p]))
  const merged = prev.map((p) => incomingById.get(p.id) ?? p)
  for (const p of incoming) {
    if (!prev.some((p2) => p2.id === p.id)) {
      merged.push(p)
    }
  }
  return merged
}
