// Task 1 (session-synchronizer): the session command factory.
//
// `createSessionCommands(store)` closes over a real SessionStore and
// dispatches the EXACT actions the hook previously dispatched inline (the
// insert / ack / rollback / clearError / dismissSubagent callbacks that
// lived in `useChatStream`) — no action shapes changed, no new behavior.
// Extracting them lets the future SessionSynchronizer (and any other
// consumer) drive optimistic delivery / error clear / subagent dismiss
// through the same reducer contract without going through the broad
// `useChatStream` hook.
//
// The factory deliberately does NOT own the transcript wipe (the /clear path
// is a direct `CLEAR_TRANSCRIPT` dispatch, owned by the reducer) —
// `SessionCommands` is the 5-action optimistic-delivery surface the React
// layer (useSessionCommands) shares with Chat / SideChatDrawer.
import type { SdkMessage } from '../types'
import { randomId } from '../utils/uuid'
import type { SessionStore } from './store'

export interface SessionCommands {
  /** Optimistically insert the user's message into the transcript so it
   *  appears immediately, before the server echoes it back. Returns the
   *  pendingId so the caller can roll it back if the POST fails. The
   *  real message from the WS stream will replace this placeholder
   *  (matched by id, not by content — works for multimodal too). */
  insertUserMessage(text: string): string
  /** Mark an optimistic user message as accepted by the REST send endpoint.
   *  Clears the local "sending" spinner using the server-side uuid; the
   *  later WS echo/replay/result still performs final reconciliation. */
  ackUserMessage(pendingId: string, serverUuid: string, receivedAt?: number): void
  /** Remove a previously-inserted optimistic user message. Used by the
   *  Composer's send() catch path so a failed POST doesn't leave a
   *  ghost row in the transcript. */
  rollbackUserMessage(pendingId: string): void
  /** Clear the last error surfaced in the chat header (client-owned
   *  lifecycle on intent.error). */
  clearError(): void
  /** Dismiss a `pending` background subagent from the Waiting bubble. */
  dismissSubagent(toolUseId: string): void
}

/** Build a SessionCommands bound to the supplied store. Each method dispatches
 *  the same action the hook did — the reducer is the single owner of state
 *  mutation, so this factory introduces no new state path. */
export function createSessionCommands(store: SessionStore): SessionCommands {
  return {
    insertUserMessage(text: string): string {
      const pendingId = `optimistic:${randomId()}`
      const message: SdkMessage = {
        type: 'user',
        uuid: pendingId,
        message: { role: 'user', content: text },
      }
      // Clear any prompt suggestion when the user sends a new message
      store.dispatch({ type: 'PROMPT_SUGGESTION', suggestion: null })
      store.dispatch({ type: 'OPTIMISTIC_USER_MESSAGE', message })
      return pendingId
    },

    rollbackUserMessage(pendingId: string): void {
      store.dispatch({ type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE', pendingId })
    },

    ackUserMessage(pendingId: string, serverUuid: string, receivedAt?: number): void {
      store.dispatch({ type: 'ACK_USER_MESSAGE', pendingId, serverUuid, receivedAt })
    },

    clearError(): void {
      store.dispatch({ type: 'ERROR', message: null })
    },

    dismissSubagent(toolUseId: string): void {
      store.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId })
    },
  }
}
