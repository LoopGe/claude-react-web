/** Message pipeline owner: the full `applyMessage` orchestration.
 *
 *  Composes transcript-log (items/messages/activeWorktree append + evict +
 *  trim), live-turn (delta/rate/prune), index-pipeline (tool/sidechain
 *  indexes + pendingResults drain), turn-status (turn-end sweep), and
 *  user-message-lifecycle (clearSendingPlaceholders in the result branch)
 *  in the EXACT order the spec pins (see §7 of the reducer-state-owners
 *  design):
 *
 *    1.  FIFO consume oldest optimistic placeholder (intent)
 *    2.  compute effectiveConsumedAt
 *    3.  route apiRetry / thinkingTokens transient slots
 *    4.  update live-turn
 *    5.  update transcript items/messages + activeWorktree
 *    6.  update tool/sidechain indexes
 *    7.  drain pendingResults (index-pipeline only)
 *    8.  prune finalized live-turn text
 *    9.  supersede draft
 *    10. cleanup pendingConsumedMessages
 *    11. result branch: freeze draft, sweep turn, clear liveTurn,
 *         clearSendingPlaceholders
 *    12. trimFront
 *    13. refusal-fallback / supersedes eviction
 *
 *  Tool/plan/question updates (step 6, via index-pipeline.updateIndexesMirror)
 *  run BEFORE sidechain updates so pendingResults' `resultOwnerKnown` sees a
 *  consistent view. drain (step 7) only replays index-pipeline; it never
 *  calls full applyMessage (the design contract).
 *
 *  The reducer delegates `MESSAGE` here; the WINDOW_* handlers in
 *  transcript-log also call this function via the live ESM binding (the
 *  message-pipeline ↔ transcript-log cycle resolves at runtime — call sites
 *  never fire at module-init). replay-merge (Task 8) will call this directly.
 */

import type { SdkMessage } from '../types'
import {
  type ServerMirror,
  type SessionState,
  withMirror,
} from './types'
import { supersedeDraft } from './draft-state'
import {
  pruneFinalizedLiveTurnText,
  updateLiveTurnMirror,
} from './live-turn'
import {
  drainPendingResults,
  updateIndexesMirror,
} from './index-pipeline'
import { sweepAtTurnEnd } from './turn-status'
import {
  evictMessages,
  trimFront,
  updateTranscriptMirror,
} from './transcript-log'
import { clearSendingPlaceholders } from './user-message-lifecycle'

/** Apply one streamed or replayed message to a session's state.
 *
 *  Order-pinned per the design spec (see module doc). The reducer's MESSAGE
 *  action delegates here; the WINDOW_* handlers in transcript-log call this
 *  via the live ESM binding for freshly-windowed messages; replay-merge
 *  (Task 8) will call this for the newer slice of a replay payload. */
export function applyMessage(state: SessionState, message: SdkMessage): SessionState {
  const mirror = state.mirror
  const messageUuid = typeof message.uuid === 'string' ? message.uuid : null
  const existingConsumedAt = messageUuid
    ? mirror.items.find((it) => it.id === messageUuid)?.msg.consumedAt
    : undefined
  const pendingConsumedAt = messageUuid ? mirror.pendingConsumedMessages.get(messageUuid) : undefined
  // Echo-merge: when the server's broadcast lands for a user message we sent
  // optimistically, drop the matching placeholder from intent. The server's
  // clean item then appends to mirror.items normally via updateTranscript
  // below — no in-place swap necessary now that placeholders don't live in
  // mirror.items.
  //
  // Guard: only match when the incoming message is a top-level user
  // message (parent_tool_use_id === null/undefined). Subagent tool_result
  // frames are also `type: 'user'` but should never consume a placeholder.
  const incomingParent = message.parent_tool_use_id
  let workingIntent = state.intent
  let placeholderConsumedAt: number | undefined
  if (
    message.type === 'user' &&
    workingIntent.pendingPlaceholders.size > 0 &&
    incomingParent == null
  ) {
    // Find the oldest placeholder — Maps preserve insertion order, so the
    // first key is the oldest send. Echoes arrive in send order, so this is
    // the correct match. If a multi-content match (e.g. by signature) is
    // ever needed, this is the place to add it; for now, order-based
    // matching mirrors the pre-refactor behaviour without the brittleness
    // of looking up by id in mirror.items.
    const oldestKey = workingIntent.pendingPlaceholders.keys().next().value
    if (typeof oldestKey === 'string') {
      // Forward any consumedAt previously stamped on the placeholder (via a
      // MESSAGE_CONSUMED frame that landed before this echo). The placeholder
      // is the only carrier of that state when it's been ack'd before the
      // server echo — pendingConsumedMessages was already cleared on ack.
      const placeholder = workingIntent.pendingPlaceholders.get(oldestKey)
      if (placeholder && typeof placeholder.msg.consumedAt === 'number') {
        placeholderConsumedAt = placeholder.msg.consumedAt
      }
      const nextPlaceholders = new Map(workingIntent.pendingPlaceholders)
      nextPlaceholders.delete(oldestKey)
      workingIntent = { ...workingIntent, pendingPlaceholders: nextPlaceholders }
    }
  }
  const effectiveConsumedAt = typeof pendingConsumedAt === 'number'
    ? pendingConsumedAt
    : (typeof placeholderConsumedAt === 'number' ? placeholderConsumedAt : existingConsumedAt)
  const incomingMessage: SdkMessage = typeof effectiveConsumedAt === 'number'
    ? { ...message, consumedAt: effectiveConsumedAt }
    : message

  // `api_retry` is a TRANSIENT rate-limit-retry indicator: it never enters
  // items/messages/IDB (keeping the transcript append-only). It is routed to
  // a dedicated slot here, and cleared by the next non-retry message.
  // updateTranscriptMirror is a no-op for api_retry (toTranscriptItem
  // returns null), so it neither appends nor needs the old in-place
  // replace/strip logic.
  //
  // No parent_tool_use_id check is needed (verified against the CLI binary's
  // own emitter, 2.1.x): the host loop converts an internal `api_error` into
  // `{type:'system', subtype:'api_retry', attempt, max_retries, …}` with NO
  // parent field, and the subagent-stream forwarding loop explicitly SKIPS
  // the child's api_retry frames — a subagent's retry instead rides a
  // `tool_progress` frame (data.type 'agent_api_retry', subagent_retry
  // payload), which our pump drops with every other tool_progress. So every
  // `system/api_retry` that reaches this reducer is a MAIN-thread retry.
  const isApiRetry = message.type === 'system' && message.subtype === 'api_retry'
  // `thinking_tokens` is a transient live estimate of the current thinking
  // block's token count (see toTranscriptItem — never a TranscriptItem). It
  // routes to `mirror.thinkingTokens` for the WorkingBubble, exactly like
  // api_retry routes to its slot. Unlike api_retry it is NOT cleared by every
  // other message: stream_event deltas interleave with thinking_tokens frames
  // during the same thinking phase, and clearing on them would flicker the
  // display off between estimates. It clears when the thinking block it
  // describes ends (any main-thread block-boundary frame — content_block_start
  // or the per-block `assistant` finalize) and on `result` (turn end).
  const isThinkingTokens = message.type === 'system' && message.subtype === 'thinking_tokens'
  // `stream_event` is a live-streaming delta (one per content chunk — hundreds
  // per heavy turn). It never enters items/messages (toTranscriptItem returns
  // null), but it drives the live-turn accumulator and the WorkingBubble phase.
  const isStreamEvent = message.type === 'stream_event'

  let thinkingTokens: number | null = mirror.thinkingTokens
  if (isThinkingTokens) {
    // NOTE: SDKThinkingTokensMessage carries no parent_tool_use_id — the
    // estimate is origin-blind at this layer (and the pump forwards every
    // frame). There is nothing to gate on; see the lifecycle note above.
    const estimate = (incomingMessage as { estimated_tokens?: unknown }).estimated_tokens
    thinkingTokens = typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null
  } else if (incomingMessage.type === 'result') {
    thinkingTokens = null
  } else if (incomingParent == null && incomingMessage.type === 'assistant') {
    // Durable per-block finalize ("one assistant message per completed content
    // block" — SDKAssistantMessage). Clears the estimate when its thinking
    // block completes, and — unlike the stream_event boundary below — this
    // frame is ring-persisted, so it also runs on a reconnect replay (missed
    // stream_events are never re-served) and in includePartialMessages:false
    // sessions. Without it a stale "~N tok" could ride a whole tool call.
    thinkingTokens = null
  } else if (incomingParent == null && isStreamEvent) {
    // Live block boundary: ANY content_block_start means the thinking block
    // the estimate described ("running total for the current thinking block"
    // — SDKThinkingTokensMessage) is over. Any block type clears, including
    // another thinking/redacted_thinking start — that is a NEW block whose own
    // estimates repaint within ms, while keeping the old count would let one
    // block's total ride the next (and never be overwritten if the new block
    // streams no estimates at all). Deliberately NO `user` clear: steer echoes,
    // queued-input echoes and <task-notification> injections are parentless
    // `user` frames that arrive mid-block and would wipe a live estimate, and
    // real turn changes are already covered by `result` (turn end) plus these
    // block boundaries (the new turn's first block).
    const ev = (incomingMessage as { event?: { type?: string } }).event
    if (ev?.type === 'content_block_start') thinkingTokens = null
  }

  const workingMirror: ServerMirror = {
    ...mirror,
    eventCount: mirror.eventCount + 1,
    apiRetry: isApiRetry ? incomingMessage : null,
    thinkingTokens,
  }

  let working: SessionState = {
    sessionId: state.sessionId,
    mirror: workingMirror,
    intent: workingIntent,
  }

  working = withMirror(working, updateLiveTurnMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateTranscriptMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateIndexesMirror(working.mirror, incomingMessage))
  // Live path: a tool_use that just seeded may have an orphan result parked
  // from an earlier out-of-order ingress — settle it now (see pendingResults).
  working = withMirror(working, drainPendingResults(working.mirror))
  // A finalized main-thread assistant message means its text now lives in the
  // transcript above — drop the duplicate from the live accumulator (see
  // pruneFinalizedLiveTurnText for the serial-response invariant this leans on).
  working = withMirror(working, pruneFinalizedLiveTurnText(working.mirror, incomingMessage))

  // A finalized main-thread assistant takes over the in-place draft row: the
  // row keeps its draft key (alias) so the hand-off updates in place instead
  // of remounting a fresh row.
  if (
    incomingMessage.type === 'assistant'
    && incomingMessage.parent_tool_use_id == null
    && working.mirror.draft
    && messageUuid
  ) {
    const { cleared, aliasEntry } = supersedeDraft(working.mirror.draft, messageUuid)
    working = withMirror(working, {
      ...working.mirror,
      draft: cleared,
      draftRowKeys: { ...working.mirror.draftRowKeys, [aliasEntry[0]]: aliasEntry[1] },
    })
  }

  if (messageUuid && working.mirror.pendingConsumedMessages.has(messageUuid)) {
    const pendingConsumedMessages = new Map(working.mirror.pendingConsumedMessages)
    pendingConsumedMessages.delete(messageUuid)
    working = withMirror(working, { ...working.mirror, pendingConsumedMessages })
  }

  if (incomingMessage.type === 'result') {
    // A draft still live at the turn's end is an interrupted half-card ("no
    // roll back"): freeze it as a session-memory partial row. A salvaged
    // partial response would have superseded the draft already (the MESSAGE
    // above), so this fires exactly when nothing salvaged it.
    const m = working.mirror
    const frozen = m.draft
      ? { ...m, frozenDrafts: [...m.frozenDrafts, m.draft], draft: null }
      : m
    // Turn-end sweep via the shared helper. The live-only concerns
    // (liveTurn=null, clearSendingPlaceholders) are applied on top.
    working = {
      sessionId: working.sessionId,
      mirror: { ...sweepAtTurnEnd(frozen), liveTurn: null },
      // Clear any lingering optimistic placeholders — the result frame means
      // the SDK has finished processing, so no server echo is expected anymore.
      intent: clearSendingPlaceholders(working.intent),
    }
  }

  // Bound in-memory growth. No-op until the transcript exceeds CAP + SLACK,
  // so the common append path stays allocation-free.
  working = trimFront(working)

  // Refusal-fallback retraction: evict the refused leg's already-streamed
  // partial messages. Two carriers, both idempotent (evictMessages no-ops on
  // unknown uuids):
  //   - assistant `supersedes` — evict-on-arrival for the replacement frame
  //     the CLI streams mid-turn;
  //   - system `model_refusal_fallback.retracted_message_uuids` — the
  //     end-of-turn audit record (this frame itself stays: it renders as the
  //     fallback notice and is the canonical replacement).
  // Runs through applyMessage so replay/disk-loaded transcripts evict too.
  const supersedes = incomingMessage.type === 'assistant'
    ? (incomingMessage as { supersedes?: unknown }).supersedes
    : undefined
  const retracted = incomingMessage.type === 'system' && incomingMessage.subtype === 'model_refusal_fallback'
    ? (incomingMessage as { retracted_message_uuids?: unknown }).retracted_message_uuids
    : undefined
  const evictUuids = [...(Array.isArray(supersedes) ? supersedes : []), ...(Array.isArray(retracted) ? retracted : [])]
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
  if (evictUuids.length > 0) {
    working = evictMessages(working, evictUuids)
  }

  return working
}
