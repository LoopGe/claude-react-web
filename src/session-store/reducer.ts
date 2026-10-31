import type { SessionAction, SessionState } from './types'
import {
  createInitialClientIntent,
  createInitialServerMirror,
  withIntent,
  withMirror,
} from './types'
import { bumpGeneration, emptyWindow } from './seq-window'
import { flushLiveTurn } from './live-turn'
import {
  applyTasksSnapshot,
  dismissSubagent,
} from './sidechain-index'
import {
  applyPermissionRequest,
  applyPermissionResolved,
} from './tool-index'
import { sweepAtTurnEnd } from './turn-status'
import { evictMessages } from './transcript-log'
// WINDOW_* handlers live in window-bridge.ts (Task 7 fix round 1). The seam
// breaks the message-pipeline ↔ transcript-log value-import cycle: window-bridge
// imports applyMessage from message-pipeline and prependMessages/evictMessages
// from transcript-log, so neither message-pipeline nor transcript-log needs to
// import the other for the WINDOW path.
import { windowEvict, windowLive, windowPage } from './window-bridge'
// applyMessage moved to message-pipeline.ts (Task 7). The reducer's MESSAGE
// action delegates here. The WINDOW_* handlers in window-bridge.ts import this
// same binding — window-bridge is the seam that breaks the would-be
// message-pipeline ↔ transcript-log value-import cycle.
import { applyMessage } from './message-pipeline'
// Optimistic/ack/consumed/steered intent handlers and clearSendingPlaceholders
// moved to user-message-lifecycle.ts (Task 7). The reducer delegates the four
// user-message actions here; SESSION_TERMINATED uses clearSendingPlaceholders.
import {
  applyOptimisticUserMessage,
  ackUserMessage,
  applyMessageConsumed,
  applyMessageSteered,
  clearSendingPlaceholders,
} from './user-message-lifecycle'
// replayReplace (and its helpers splitReplayAgainstCache / dedupeReplayPayload)
// moved to replay-merge.ts (Task 8). The reducer's REPLAY_REPLACE action
// delegates here. replay-merge calls message-pipeline.applyMessage,
// transcript-log.prependMessages, sidechain-index.reapplyDismissed,
// turn-status.sweepAtTurnEnd, and tool-index.applyPermissionRequest directly
// — it does NOT import the reducer entry (no business module imports reducer.ts).
import { replayReplace } from './replay-merge'
// Re-export the helpers the existing importers (`reducer.test.ts`,
// `active-worktree.test.ts`) keep resolving through the reducer entry, from
// their true owners. These re-exports are a migration seam, not a second
// business layer — see the reducer-state-owners design §10.
export { reapplyDismissed } from './sidechain-index'
export { rebuildIndexesFromMessages } from './index-pipeline'
export { settleStaleLiveSubagents } from './turn-status'
export { MEMORY_ITEM_CAP } from './transcript-log'
export { splitReplayAgainstCache, dedupeReplayPayload } from './replay-merge'


export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'REPLAY_REPLACE':
      return replayReplace(state, action.messages, action.permissions)
    case 'MESSAGE':
      return applyMessage(state, action.message)
    case 'OPTIMISTIC_USER_MESSAGE':
      return applyOptimisticUserMessage(state, action.message)
    case 'ACK_USER_MESSAGE':
      return ackUserMessage(state, action.pendingId, action.serverUuid, action.receivedAt)
    case 'ROLLBACK_OPTIMISTIC_USER_MESSAGE': {
      // Only roll back if the placeholder is still pending — between the
      // failed POST and this dispatch, the server echo might have already
      // consumed this placeholder (removing it from intent), in which case
      // we'd nuke the real message that landed in mirror.items.
      if (!state.intent.pendingPlaceholders.has(action.pendingId)) return state
      const nextPlaceholders = new Map(state.intent.pendingPlaceholders)
      nextPlaceholders.delete(action.pendingId)
      return withIntent(state, { ...state.intent, pendingPlaceholders: nextPlaceholders })
    }
    case 'PERMISSION_REQUEST':
      // Delegated to tool-index.ts: seeds `pidToToolUseId` from the
      // request's `toolUseID`. No-op (identity-stable) when the request
      // carries no `toolUseID`.
      return applyPermissionRequest(state, action.request)
    case 'PERMISSION_RESOLVED':
      // Delegated to tool-index.ts: clears the `pidToToolUseId` entry for
      // the resolved pid, flips `planStatus` to approved/rejected when the
      // pid maps to a plan, and parses the JSON answers payload from
      // `decision.message` into `questionAnswers` when the pid maps to a
      // question (closing the gap where the SDK does not always echo a
      // follow-up tool_result after a canUseTool deny+message
      // short-circuit). Identity-stable when nothing changed.
      return applyPermissionResolved(state, action.id, action.decision)
    case 'CONTEXT_USAGE':
      return withMirror(state, { ...state.mirror, contextUsage: action.usage })
    case 'PROMPT_SUGGESTION':
      return withMirror(state, { ...state.mirror, promptSuggestion: action.suggestion })
    case 'SESSION_STATE':
      return withMirror(state, { ...state.mirror, sessionState: action.state })
    case 'SESSION_TERMINATED': {
      // Same sweep the `result` frame runs, for the session state in which no
      // result frame can ever arrive. Without it a stranded SYNC subagent
      // record stays `running` forever and its card spins on a dead session —
      // the case TASKS_SNAPSHOT deliberately skips below on the assumption
      // that the result-frame sweep covers it. `liveTurn: null` and the
      // placeholder clear match that branch's reasoning: the SDK is finished,
      // so no echo is expected for anything still marked as sending.
      //
      // Idempotent by design: the dispatcher fires again after each replay (a
      // reload of a terminated session rebuilds the records the sweep must
      // then re-examine), so a no-op re-dispatch must NOT churn every
      // subscriber or dirty a persist. sweepAtTurnEnd returns the same mirror
      // reference when nothing needed sweeping.
      const swept = sweepAtTurnEnd(state.mirror)
      const intent = clearSendingPlaceholders(state.intent)
      // `apiRetry` is transient in exactly the same way as the slots above: it
      // lives outside the transcript because it is "only meaningful while a
      // retry is in flight", and its ONLY clearer is the next non-retry
      // message — which a terminated session never delivers. Without this a
      // "Retrying in Ns…" divider hangs on a session that can never retry.
      // `thinkingTokens` for the same reason: its terminal clearer is the
      // `result` frame, which a terminated session never delivers either.
      const transientCleared = state.mirror.liveTurn !== null
        || state.mirror.apiRetry !== null
        || state.mirror.thinkingTokens != null
      if (swept === state.mirror && !transientCleared && intent === state.intent) return state
      return {
        sessionId: state.sessionId,
        mirror: { ...swept, liveTurn: null, apiRetry: null, thinkingTokens: null },
        intent,
      }
    }
    case 'TASKS_SNAPSHOT': {
      // Delegated to sidechain-index.ts: replaces the whole task list, then
      // enriches matching subagent records (taskId / progressSummary /
      // lastToolName / isAsync / status flips). TASKS_SNAPSHOT is the sole
      // isAsync authority — see applyTasksSnapshot for the full rationale.
      const mirror = applyTasksSnapshot(state.mirror, action.tasks)
      if (mirror === state.mirror) return state
      return withMirror(state, mirror)
    }
    case 'MESSAGE_CONSUMED':
      return applyMessageConsumed(state, action.uuid, action.consumedAt)
    case 'MESSAGE_STEERED':
      return applyMessageSteered(state, action.uuid, action.state)
    case 'ERROR':
      // ERROR straddles the boundary: the WS error frame writes it (server-
      // originated) but the lifecycle (clearError) is client-owned. We park
      // it on the intent layer because that's the layer the client mutates
      // freely — and importantly, a REPLAY_REPLACE rebuilding mirror must
      // NOT incidentally clear a stale error the user hasn't dismissed yet.
      return withIntent(state, { ...state.intent, error: action.message })
    case 'LIVE_TURN_FLUSH':
      // Coalesces unflushed chunks into flushedText (adjacent same-origin
      // merge) and folds the main-thread text into the in-place draft at the
      // 80ms cadence. See live-turn.ts for the full rationale.
      return withMirror(state, flushLiveTurn(state.mirror))
    case 'DISMISS_SUBAGENT': {
      // Delegated to sidechain-index.ts: flips an in-flight subagent
      // (running/background/pending) to `dismissed` and records the id on
      // intent.dismissedSubagents so the dismiss survives mirror rebuilds.
      // No-op for already-settled records.
      return dismissSubagent(state, action.toolUseId)
    }
    case 'CLEAR_TRANSCRIPT': {
      // Same full wipe as RESET, but the post-/clear session is live and
      // empty with no pending replay (the WS subscription persists, the
      // server doesn't re-replay, system/init isn't broadcast). Mark the
      // transcript ready so MessageList shows the empty-state instead of
      // an infinite skeleton.
      // The seq window empties too, but its generation/headSeq cursor is
      // PRESERVED: the window only re-anchors on the server's WINDOW_BUMP
      // (the /clear generation+1 arrives via the attached/cleared frame),
      // so a pre-bump page can't be mistaken for post-clear content.
      const mirror = {
        ...createInitialServerMirror(),
        replayReady: true,
        window: emptyWindow(state.mirror.window.generation, state.mirror.window.headSeq),
      }
      return {
        sessionId: state.sessionId,
        mirror,
        intent: createInitialClientIntent(),
      }
    }
    case 'EVICT_MESSAGES':
      return evictMessages(state, action.uuids)
    case 'WINDOW_PAGE':
      return windowPage(state, action)
    case 'WINDOW_LIVE':
      return windowLive(state, action.seq, action.generation, action.message)
    case 'WINDOW_EVICT':
      return windowEvict(state, action.seqs)
    case 'WINDOW_BUMP':
      return {
        sessionId: state.sessionId,
        mirror: {
          ...createInitialServerMirror(),
          replayReady: true,
          window: bumpGeneration(state.mirror.window, action.generation, action.headSeq),
        },
        intent: createInitialClientIntent(),
      }
    default:
      return state
  }
}

// replayReplace, dedupeReplayPayload, splitReplayAgainstCache, and all the
// replay helpers (replaceStaleCachedMessages, applyMidSlice, repairChronology,
// overlapAnchorUuid, partitionNoOverlapByTime, promptSequencesEqual, the
// shape-compare helpers, and the REPAIR_TIME_TOLERANCE_MS / TWIN_TIME_WINDOW_MS
// / REPAIR_MOVES_CAP constants) moved to replay-merge.ts (Task 8 — the
// replay-merge owner). The reducer's REPLAY_REPLACE action delegates there;
// `dedupeReplayPayload` and `splitReplayAgainstCache` are re-exported above so
// existing importers keep resolving.
//
// `applyMessage` moved to message-pipeline.ts (Task 7). applyOptimisticUserMessage,
// ackUserMessage, applyMessageConsumed, applyMessageSteered, and
// clearSendingPlaceholders moved to user-message-lifecycle.ts; the reducer
// delegates the four user-message actions and uses clearSendingPlaceholders in
// the SESSION_TERMINATED branch. rememberPendingConsumed / PENDING_CONSUMED_CAP
// moved to transcript-log.ts (alongside stampMessageConsumed / stampMessageSteered).
//
// `rebuildIndexesFromMessages`, `updateIndexesMirror`, `drainPendingResults`,
// `prunePendingResults`, `pruneMapToLive`, `pruneSettledToLive`,
// `collectLiveToolUseIds`, and the parking helpers (`pendingResultKey`,
// `completionOwnerIds`, `resultOwnerKnown`, `resultIsSidechainChild`,
// `PENDING_RESULTS_CAP`) moved to index-pipeline.ts (the index-pipeline owner).
// `sweepAtTurnEnd` and `settleStaleLiveSubagents` (plus `isStaleLiveSubagent`,
// `PENDING_TIMEOUT_MS`, `EPOCH_PLAUSIBILITY_FLOOR`) moved to turn-status.ts.
// `windowLive` / `windowPage` / `windowEvict` (plus the private
// `freshWindowMessages` helper) moved to window-bridge.ts (Task 7 fix round 1
// — the seam that breaks the message-pipeline ↔ transcript-log value-import
// cycle). `prependMessages` (plus the private `countPromptOverlap` helper),
// `trimFront`, `evictMessages`, `updateTranscriptMirror`, the private
// `seqsForUuids` helper, and `MEMORY_ITEM_CAP` moved to transcript-log.ts
// (the transcript-log owner). The public ones are imported at the top;
// `MEMORY_ITEM_CAP` is re-exported for existing importers.
