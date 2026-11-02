// Generic pending-request channel core.
//
// Shared internal hook that backs usePermissionChannel,
// useElicitationChannel, and useUserDialogChannel. Each wrapper calls this
// core once and adapts its domain-specific decide/answer/clarify methods.
//
// This hook does NOT open its own connection — request/resolved events are
// forwarded by the SessionSynchronizer. A one-shot REST call seeds the
// initial pending list, covering the race where a request was broadcast
// before the WebSocket subscription opened.
//
// Session isolation: when sessionId changes, a render-time state adjustment
// replaces the state with an empty one for the new session. All async
// callbacks (seed .then, onRequest/onResolved, submit POST/recovery) capture
// the sessionId at creation time and check it inside a functional state
// update, so stale results from the previous session never write back.
//
// Token invalidation: each submit registers a Symbol token for the target
// id. A newer onRequest/onResolved for the same id deletes that token, so
// a stale recovery (still in flight) becomes a no-op when it resolves. A
// second submit for the same id replaces the token, invalidating the first
// submit's recovery.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from './useApi'

export type PendingResource = 'permissions' | 'elicitations' | 'dialogs'
export type PendingAction = 'decide' | 'answer-question' | 'clarify-question'

export interface PendingRequestChannel<
  Req extends { id: string },
  Res extends { id: string },
> {
  pending: Req[]
  error: string | null
  onRequest: (req: Req) => void
  onResolved: (res: Res) => void
  reset: () => void
  clearError: () => void
  submit: (
    id: string,
    action: PendingAction,
    body: unknown,
    errorPrefix: string,
  ) => Promise<void>
}

// ── Internal state ──────────────────────────────────────────────────

interface ChannelState<Req> {
  sessionId: string
  pending: Req[]
  error: string | null
  recoveryTokens: ReadonlyMap<string, symbol>
}

function emptyState<Req>(sessionId: string): ChannelState<Req> {
  return { sessionId, pending: [], error: null, recoveryTokens: new Map() }
}

/** Merge a fresh pending array into an existing one.
 *  - Existing entries are updated-in-place when `incoming` has the same id.
 *  - New entries are appended at the end.
 *  - Ordering of existing entries is preserved.
 *  - Empty incoming returns the original array reference (no change). */
function mergePending<Req extends { id: string }>(
  prev: Req[],
  incoming: Req[],
): Req[] {
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

// ── Hook ────────────────────────────────────────────────────────────

export function usePendingRequestChannel<
  Req extends { id: string },
  Res extends { id: string },
>(sessionId: string, resource: PendingResource): PendingRequestChannel<Req, Res> {
  type State = ChannelState<Req>

  const [state, setState] = useState<State>(() => emptyState<Req>(sessionId))

  // Render-time state adjustment: if the sessionId prop changed, replace
  // the entire state with an empty one for the new session. React retries
  // the render with the updated state before committing, so callers never
  // observe "new sessionId + old pending/error" in a single frame.
  if (state.sessionId !== sessionId) {
    setState(emptyState<Req>(sessionId))
  }

  // Mirrors `pending` so submit can synchronously capture the just-removed
  // request. Reading from the setState updater is too late — React batches
  // updaters until the next render, by which time the catch block has
  // already executed. The effect-based sync lags by one render, but
  // submit is always invoked from a user click that follows a committed
  // render, so the ref is current when read.
  const pendingRef = useRef<Req[]>(state.pending)
  useEffect(() => {
    pendingRef.current = state.pending
  }, [state.pending])

  // Initial snapshot — cancellation + functional session check. The
  // WebSocket subscription re-broadcasts still-open requests on connect,
  // but the REST snapshot makes the dialog appear immediately after a
  // hard refresh.
  useEffect(() => {
    if (!sessionId) return
    const captured = sessionId
    let cancelled = false
    api
      .get<{ pending: Req[] }>(`/sessions/${captured}/${resource}`)
      .then((res) => {
        if (cancelled) return
        setState((prev) => {
          if (prev.sessionId !== captured) return prev
          return { ...prev, pending: mergePending(prev.pending, res.pending) }
        })
      })
      .catch(() => {
        /* non-fatal: the WebSocket subscription will catch subsequent events */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, resource])

  const onRequest = useCallback(
    (req: Req) => {
      if (!req?.id) return
      const captured = sessionId
      setState((prev) => {
        if (prev.sessionId !== captured) return prev
        // Invalidate any outstanding recovery token for this id so a
        // stale recovery cannot overwrite or resurrect the live request.
        const newTokens = new Map(prev.recoveryTokens)
        newTokens.delete(req.id)
        return {
          ...prev,
          recoveryTokens: newTokens,
          pending: mergePending(prev.pending, [req]),
        }
      })
    },
    [sessionId],
  )

  const onResolved = useCallback(
    (res: Res) => {
      if (!res?.id) return
      const captured = sessionId
      setState((prev) => {
        if (prev.sessionId !== captured) return prev
        // Invalidate any outstanding recovery token for this id so a
        // stale recovery cannot resurrect the resolved request.
        const newTokens = new Map(prev.recoveryTokens)
        newTokens.delete(res.id)
        return {
          ...prev,
          recoveryTokens: newTokens,
          pending: prev.pending.filter((p) => p.id !== res.id),
        }
      })
    },
    [sessionId],
  )

  const submit = useCallback(
    async (id: string, action: PendingAction, body: unknown, errorPrefix: string) => {
      const captured = sessionId
      // 1. Capture the removed item from the ref (sync read).
      const removed = pendingRef.current.find((p) => p.id === id)
      // 2. Register a new token + optimistically remove the pending item.
      //    A newer submit for the same id replaces the token, invalidating
      //    the first submit's recovery.
      const token = Symbol()
      setState((prev) => {
        if (prev.sessionId !== captured) return prev
        const newTokens = new Map(prev.recoveryTokens)
        newTokens.set(id, token)
        return {
          ...prev,
          recoveryTokens: newTokens,
          pending: prev.pending.filter((p) => p.id !== id),
        }
      })
      // 3. POST.
      try {
        await api.post(`/sessions/${captured}/${resource}/${id}/${action}`, body)
        // POST success: clean up the token only if it is still current.
        setState((prev) => {
          if (prev.sessionId !== captured) return prev
          if (prev.recoveryTokens.get(id) !== token) return prev
          const newTokens = new Map(prev.recoveryTokens)
          newTokens.delete(id)
          return { ...prev, recoveryTokens: newTokens }
        })
      } catch (e) {
        // 4. POST failure: set error only if the session is still the same.
        setState((prev) => {
          if (prev.sessionId !== captured) return prev
          return { ...prev, error: `${errorPrefix}: ${(e as Error).message}` }
        })
        // 5/6. Recovery GET — reconcile with the server.
        try {
          const r = await api.get<{ pending: Req[] }>(`/sessions/${captured}/${resource}`)
          // Recovery success: restore ONLY the target id from the response.
          // A late full-list response must not overwrite or insert other ids.
          setState((prev) => {
            if (prev.sessionId !== captured) return prev
            if (prev.recoveryTokens.get(id) !== token) return prev
            const target = r.pending.find((p) => p.id === id)
            if (!target) return prev
            const newTokens = new Map(prev.recoveryTokens)
            newTokens.delete(id)
            return {
              ...prev,
              recoveryTokens: newTokens,
              pending: mergePending(prev.pending, [target]),
            }
          })
        } catch {
          // Recovery failure: re-insert the captured item only if the
          // session and token are still current.
          setState((prev) => {
            if (prev.sessionId !== captured) return prev
            if (prev.recoveryTokens.get(id) !== token) return prev
            const newTokens = new Map(prev.recoveryTokens)
            newTokens.delete(id)
            if (!removed) return { ...prev, recoveryTokens: newTokens }
            return {
              ...prev,
              recoveryTokens: newTokens,
              pending: mergePending(prev.pending, [removed]),
            }
          })
        }
      }
    },
    [sessionId, resource],
  )

  const reset = useCallback(() => {
    // Clear pending/error and all recovery tokens — outstanding recoveries
    // become no-ops because their tokens are gone.
    setState((prev) => ({
      ...prev,
      pending: [],
      error: null,
      recoveryTokens: new Map(),
    }))
  }, [])

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }))
  }, [])

  return useMemo(
    () => ({
      pending: state.pending,
      error: state.error,
      onRequest,
      onResolved,
      reset,
      clearError,
      submit,
    }),
    [state.pending, state.error, onRequest, onResolved, reset, clearError, submit],
  )
}
