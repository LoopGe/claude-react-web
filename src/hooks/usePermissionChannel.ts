// Tool-permission state for one Chat session.
//
// This hook does NOT open its own SSE connection — permission events are
// multiplexed onto the main /stream channel (see server/routes.ts). The
// caller routes `permission_request` / `permission_resolved` frames into
// `onRequest()` / `onResolved()`. We still keep a one-shot REST fallback
// to seed the initial pending list, covering the race where a request
// was broadcast before our SSE opened.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from './useApi'
import type { PermissionRequest, PermissionResolved } from '../types'

export type PermissionDecision =
  | { behavior: 'allow'; persistForSession: boolean }
  | { behavior: 'deny'; message?: string }

export type QuestionAnswer = string | string[] | null

export interface UsePermissionChannel {
  pending: PermissionRequest[]
  error: string | null
  decide: (pid: string, decision: PermissionDecision) => Promise<void>
  /** Submit answers for a pending AskUserQuestion. Answers align
   *  positionally with the pending request's `questions`. */
  answerQuestion: (pid: string, answers: QuestionAnswer[]) => Promise<void>
  /** Push a permission_request event into the local state. */
  onRequest: (req: PermissionRequest) => void
  /** Push a permission_resolved event into the local state. */
  onResolved: (res: PermissionResolved) => void
  reset: () => void
  clearError: () => void
}

export function usePermissionChannel(sessionId: string): UsePermissionChannel {
  const [pending, setPending] = useState<PermissionRequest[]>([])
  const [error, setError] = useState<string | null>(null)

  // Initial snapshot — the SSE connection will re-broadcast any still-open
  // request on connect, but grabbing the REST snapshot makes the modal
  // appear immediately after a hard refresh even before the stream opens.
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

  const onRequest = useCallback((req: PermissionRequest) => {
    if (!req?.id) return
    setPending((prev) => mergePending(prev, [req]))
  }, [])

  const onResolved = useCallback((res: PermissionResolved) => {
    if (!res?.id) return
    setPending((prev) => prev.filter((p) => p.id !== res.id))
  }, [])

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

  const answerQuestion = useCallback(
    async (pid: string, answers: QuestionAnswer[]) => {
      // Same optimistic pattern as decide(): drop locally first so the
      // dialog closes immediately; re-fetch on failure to reconcile.
      setPending((prev) => prev.filter((p) => p.id !== pid))
      try {
        await api.post(
          `/sessions/${sessionId}/permissions/${pid}/answer-question`,
          { answers },
        )
      } catch (e) {
        setError(`Answer submission failed: ${(e as Error).message}`)
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
    () => ({ pending, error, decide, answerQuestion, onRequest, onResolved, reset, clearError }),
    [pending, error, decide, answerQuestion, onRequest, onResolved, reset, clearError],
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
