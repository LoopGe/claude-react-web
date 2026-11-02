// Tool-permission state for one Chat session.
//
// This hook does NOT open its own connection — permission events are
// multiplexed onto the WebSocket hub (see src/hooks/useWsHub.ts). The
// caller routes `permission_request` / `permission_resolved` frames into
// `onRequest()` / `onResolved()`. A one-shot REST call seeds the initial
// pending list, covering the race where a request was broadcast before
// the WebSocket subscription opened.
//
// Session isolation and recovery-race protection are handled by the
// shared core (usePendingRequestChannel). This file is a thin wrapper
// that maps domain-specific decide / answerQuestion / clarifyQuestion
// methods onto the core's generic `submit`.

import { useCallback, useMemo } from 'react'

import { usePendingRequestChannel } from './usePendingRequestChannel'
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
  clarifyQuestion: (pid: string, feedback: string) => Promise<void>
  /** Push a permission_request event into the local state. */
  onRequest: (req: PermissionRequest) => void
  /** Push a permission_resolved event into the local state. */
  onResolved: (res: PermissionResolved) => void
  reset: () => void
  clearError: () => void
}

export function usePermissionChannel(sessionId: string): UsePermissionChannel {
  const channel = usePendingRequestChannel<PermissionRequest, PermissionResolved>(
    sessionId,
    'permissions',
  )
  // `submit` is stable across pending/error changes (it only depends on
  // sessionId/resource inside the core), so the three action callbacks below
  // preserve the same identity semantics as the old optimisticPost-based
  // implementation: they change only when sessionId changes.
  const { submit } = channel

  const decide = useCallback(
    (pid: string, decision: PermissionDecision) =>
      submit(pid, 'decide', decision, 'Permission decision failed'),
    [submit],
  )

  const answerQuestion = useCallback(
    (pid: string, answers: QuestionAnswer[]) =>
      submit(pid, 'answer-question', { answers }, 'Answer submission failed'),
    [submit],
  )

  const clarifyQuestion = useCallback(
    (pid: string, feedback: string) =>
      submit(pid, 'clarify-question', { feedback }, 'Clarification submission failed'),
    [submit],
  )

  return useMemo(
    () => ({
      pending: channel.pending,
      error: channel.error,
      decide,
      answerQuestion,
      clarifyQuestion,
      onRequest: channel.onRequest,
      onResolved: channel.onResolved,
      reset: channel.reset,
      clearError: channel.clearError,
    }),
    [
      channel.pending,
      channel.error,
      decide,
      answerQuestion,
      clarifyQuestion,
      channel.onRequest,
      channel.onResolved,
      channel.reset,
      channel.clearError,
    ],
  )
}
