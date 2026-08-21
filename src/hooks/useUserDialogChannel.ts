// User-dialog (blocking CLI prompt, e.g. refusal fallback) state for one
// Chat session.
//
// Mirrors useElicitationChannel.ts: this hook does NOT open its own
// connection — dialog events are multiplexed onto the WebSocket hub. The
// caller routes `dialog-request` / `dialog-resolved` frames (via
// useChatStream's frame switch) into `onRequest()` / `onResolved()`. A
// one-shot REST call seeds the initial pending list, covering the race where
// a request was broadcast before the WebSocket subscription opened.
// Reconnects are covered by the server's replay snapshot (the `replay` /
// `replay-done` frames carry `dialogs`), not by a REST re-seed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from './useApi'
import type { UserDialogDecision, UserDialogRequestUi, DialogResolved } from '../types'

export interface UseUserDialogChannel {
  pending: UserDialogRequestUi[]
  error: string | null
  decide: (did: string, decision: UserDialogDecision) => Promise<void>
  /** Push a dialog-request event into local state. */
  onRequest: (req: UserDialogRequestUi) => void
  /** Push a dialog-resolved event into local state. */
  onResolved: (res: DialogResolved) => void
  reset: () => void
  clearError: () => void
}

export function useUserDialogChannel(sessionId: string): UseUserDialogChannel {
  const [pending, setPending] = useState<UserDialogRequestUi[]>([])
  const [error, setError] = useState<string | null>(null)

  // Mirrors `pending` so async control flows (decide) can capture the
  // just-removed request synchronously — see usePermissionChannel for the
  // React batching rationale.
  const pendingRef = useRef<UserDialogRequestUi[]>(pending)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // Initial snapshot — same rationale as useElicitationChannel: the WS
  // subscription re-broadcasts still-open dialogs on connect, but the REST
  // snapshot makes the dialog appear immediately after a hard refresh.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api
      .get<{ pending: UserDialogRequestUi[] }>(`/sessions/${sessionId}/dialogs`)
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

  const onRequest = useCallback((req: UserDialogRequestUi) => {
    if (!req?.id) return
    setPending((prev) => mergePending(prev, [req]))
  }, [])

  const onResolved = useCallback((res: DialogResolved) => {
    if (!res?.id) return
    setPending((prev) => prev.filter((p) => p.id !== res.id))
  }, [])

  /** Optimistic-update-with-rollback, mirroring useElicitationChannel:
   *  drop the request locally so the dialog closes immediately; on POST
   *  failure, re-fetch pending to reconcile, and re-insert the removed
   *  request if even the re-fetch fails. */
  const decide = useCallback(
    async (did: string, decision: UserDialogDecision) => {
      const removed = pendingRef.current.find((p) => p.id === did)
      setPending((prev) => prev.filter((p) => p.id !== did))
      try {
        await api.post(`/sessions/${sessionId}/dialogs/${did}/decide`, decision)
      } catch (e) {
        setError(`Dialog decision failed: ${(e as Error).message}`)
        try {
          const r = await api.get<{ pending: UserDialogRequestUi[] }>(
            `/sessions/${sessionId}/dialogs`,
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
  prev: UserDialogRequestUi[],
  incoming: UserDialogRequestUi[],
): UserDialogRequestUi[] {
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
