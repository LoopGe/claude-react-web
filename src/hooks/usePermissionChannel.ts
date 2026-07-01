// Tool-permission state for one Chat session.
//
// This hook does NOT open its own connection — permission events are
// multiplexed onto the WebSocket hub (see src/hooks/useWsHub.ts). The
// caller routes `permission_request` / `permission_resolved` frames into
// `onRequest()` / `onResolved()`. A one-shot REST call seeds the initial
// pending list, covering the race where a request was broadcast before
// the WebSocket subscription opened.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from './useApi'
import type { PermissionRequest, PermissionResolved } from '../types'

export type PermissionDecision =
  // `planTargetMode` only applies when approving a plan proposal (ExitPlanMode):
  // the execution mode the session switches to after the plan is approved.
  | { behavior: 'allow'; persistForSession: boolean; planTargetMode?: PlanTargetMode }
  // `interrupt` defaults to false (model re-plans). `interrupt: true` aborts
  // the whole turn — used by the plan dialog's "Stop & take over" action.
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

/** Execution modes a session can switch into when a plan is approved. */
export type PlanTargetMode = 'default' | 'acceptEdits' | 'bypassPermissions'

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

  // Mirrors `pending` so async control flows (decide, answerQuestion) can
  // capture the just-removed request synchronously. Reading from the
  // setPending updater is too late — React batches updaters until the
  // next render, by which time the catch block has already executed.
  // The effect-based sync lags by one render, but decide/answerQuestion
  // are always invoked from a user click that follows a committed render,
  // so the ref is current when read.
  const pendingRef = useRef<PermissionRequest[]>(pending)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // Initial snapshot — the WebSocket connection will re-broadcast any still-open
  // request on connect, but grabbing the REST snapshot makes the modal
  // appear immediately after a hard refresh even before the stream opens.
  useEffect(() => {
    // No session (e.g. ChatPanel's side-chat slot when no side chat exists)
    // → skip the snapshot. The WebSocket subscription is itself a no-op on
    // an empty id (see useChatStream), so there is nothing to seed, and
    // firing `/sessions//permissions` would just 404 on every panel mount.
    if (!sessionId) return
    let cancelled = false
    api
      .get<{ pending: PermissionRequest[] }>(`/sessions/${sessionId}/permissions`)
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

  const onRequest = useCallback((req: PermissionRequest) => {
    if (!req?.id) return
    setPending((prev) => mergePending(prev, [req]))
  }, [])

  const onResolved = useCallback((res: PermissionResolved) => {
    if (!res?.id) return
    setPending((prev) => prev.filter((p) => p.id !== res.id))
  }, [])

  /** Shared optimistic-update-with-rollback pattern: drop the request
   *  locally so the dialog closes immediately; on POST failure, re-fetch
   *  pending to reconcile, and re-insert the removed request if even
   *  the re-fetch fails. */
  const optimisticPost = useCallback(
    async (pid: string, endpoint: string, body: unknown, errorPrefix: string) => {
      const removed = pendingRef.current.find((p) => p.id === pid)
      setPending((prev) => prev.filter((p) => p.id !== pid))
      try {
        await api.post(`/sessions/${sessionId}/permissions/${pid}/${endpoint}`, body)
      } catch (e) {
        setError(`${errorPrefix}: ${(e as Error).message}`)
        try {
          const r = await api.get<{ pending: PermissionRequest[] }>(
            `/sessions/${sessionId}/permissions`,
          )
          setPending((prev) => mergePending(prev, r.pending))
        } catch {
          if (removed) setPending((prev) => mergePending(prev, [removed]))
        }
      }
    },
    [sessionId],
  )

  const decide = useCallback(
    (pid: string, decision: PermissionDecision) =>
      optimisticPost(pid, 'decide', decision, 'Permission decision failed'),
    [optimisticPost],
  )

  const answerQuestion = useCallback(
    (pid: string, answers: QuestionAnswer[]) =>
      optimisticPost(pid, 'answer-question', { answers }, 'Answer submission failed'),
    [optimisticPost],
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

/** Merge a fresh pending array into an existing one.
 *  - Existing entries are updated-in-place when `incoming` has the same id.
 *  - New entries are appended at the end.
 *  - Ordering of existing entries is preserved. */
function mergePending(prev: PermissionRequest[], incoming: PermissionRequest[]): PermissionRequest[] {
  if (!incoming?.length) return prev
  const incomingById = new Map(incoming.map((p) => [p.id, p]))
  // Walk prev: swap to incoming version if present, else keep original.
  const merged = prev.map((p) => incomingById.get(p.id) ?? p)
  // Append any entries in incoming that weren't in prev.
  for (const p of incoming) {
    if (!prev.some((p2) => p2.id === p.id)) {
      merged.push(p)
    }
  }
  return merged
}
