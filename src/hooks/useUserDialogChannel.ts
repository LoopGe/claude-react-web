// User-dialog (blocking CLI prompt, e.g. refusal fallback) state for one
// Chat session.
//
// Mirrors usePermissionChannel.ts: this hook does NOT open its own
// connection — dialog events are multiplexed onto the WebSocket hub. The
// caller routes `dialog-request` / `dialog-resolved` frames (via
// the SessionSynchronizer's frame switch) into `onRequest()` / `onResolved()`. A
// one-shot REST call seeds the initial pending list, covering the race where
// a request was broadcast before the WebSocket subscription opened.
//
// On reconnect the server re-broadcasts still-pending dialogs as ordinary
// request frames, which the local merge folds in by id — there is no
// separate replay/replay-done envelope for dialogs.
//
// Session isolation and recovery-race protection are handled by the
// shared core (usePendingRequestChannel). This file is a thin wrapper
// that maps the domain-specific decide method onto the core's generic
// `submit`.

import { useCallback, useMemo } from 'react'

import { usePendingRequestChannel } from './usePendingRequestChannel'
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
  const channel = usePendingRequestChannel<UserDialogRequestUi, DialogResolved>(
    sessionId,
    'dialogs',
  )
  // `submit` is stable across pending/error changes (it only depends on
  // sessionId/resource inside the core), so `decide` preserves the same
  // identity semantics as the old optimisticPost-based implementation:
  // it changes only when sessionId changes.
  const { submit } = channel

  const decide = useCallback(
    (did: string, decision: UserDialogDecision) =>
      submit(did, 'decide', decision, 'Dialog decision failed'),
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
