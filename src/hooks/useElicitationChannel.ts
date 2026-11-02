// MCP elicitation (OAuth auth / server-initiated form) state for one Chat
// session.
//
// Mirrors usePermissionChannel.ts: this hook does NOT open its own
// connection — elicitation events are multiplexed onto the WebSocket hub.
// The caller routes `elicitation-request` / `elicitation-resolved` frames
// (via the SessionSynchronizer's frame switch) into `onRequest()` / `onResolved()`.
// A one-shot REST call seeds the initial pending list, covering the race
// where a request was broadcast before the WebSocket subscription opened.
//
// On reconnect the server re-broadcasts still-pending requests as ordinary
// request frames, which the local merge folds in by id — there is no
// separate replay/replay-done envelope for elicitations.
//
// Session isolation and recovery-race protection are handled by the
// shared core (usePendingRequestChannel). This file is a thin wrapper
// that maps the domain-specific decide method onto the core's generic
// `submit`.

import { useCallback, useMemo } from 'react'

import { usePendingRequestChannel } from './usePendingRequestChannel'
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
  const channel = usePendingRequestChannel<ElicitationRequestUi, ElicitationResolved>(
    sessionId,
    'elicitations',
  )
  // `submit` is stable across pending/error changes (it only depends on
  // sessionId/resource inside the core), so `decide` preserves the same
  // identity semantics as the old optimisticPost-based implementation:
  // it changes only when sessionId changes.
  const { submit } = channel

  const decide = useCallback(
    (eid: string, decision: ElicitationDecision) =>
      submit(eid, 'decide', decision, 'Elicitation decision failed'),
    [submit],
  )

  return useMemo(
    () => ({
      pending: channel.pending,
      error: channel.error,
      decide,
      onRequest: channel.onRequest,
      onResolved: channel.onResolved,
      reset: channel.reset,
      clearError: channel.clearError,
    }),
    [
      channel.pending,
      channel.error,
      decide,
      channel.onRequest,
      channel.onResolved,
      channel.reset,
      channel.clearError,
    ],
  )
}
