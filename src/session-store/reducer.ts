import type { PermissionRequest, SdkMessage } from '../types'
import { createInitialSessionState, type SessionAction, type SessionState } from './types'
import {
  extractPlanContent,
  getPlanResultDecisions,
  getPlanToolUseIds,
  getSubagentStarts,
  getToolResultEntries,
  getToolResultIds,
  getToolResultOutcomes,
  getToolUseStarts,
  isTrimBoundary,
  toTranscriptItem,
  topLevelUserPromptSignature,
} from './normalize'
import {
  extractQuestionAnswers,
  getQuestionToolUseIds,
  parseQuestionAnswersMessage,
} from '../utils/question-answers'
import { toolDebug, toolDebugEnabled } from './debug'

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'REPLAY_REPLACE':
      return replayReplace(state, action.messages, action.permissions)
    case 'PREPEND_MESSAGES':
      return prependMessages(state, action.messages)
    case 'MESSAGE':
      return applyMessage(state, action.message)
    case 'OPTIMISTIC_USER_MESSAGE':
      return applyOptimisticUserMessage(state, action.message)
    case 'ROLLBACK_OPTIMISTIC_USER_MESSAGE': {
      // Only roll back if the pendingId is still tracked — between the
      // failed POST and this dispatch, the server echo might have
      // already replaced this placeholder (removing it from the set),
      // in which case we'd nuke the real message.
      if (!state.pendingUserMessageIds.has(action.pendingId)) return state
      const next = new Set(state.pendingUserMessageIds)
      next.delete(action.pendingId)
      return {
        ...state,
        items: state.items.filter((it) => it.id !== action.pendingId),
        messages: state.messages.filter(
          (m) => (typeof m.uuid === 'string' ? m.uuid : null) !== action.pendingId,
        ),
        pendingUserMessageIds: next,
      }
    }
    case 'PERMISSION_REQUEST': {
      const permissionPending = new Map(state.permissionPending)
      permissionPending.set(action.request.id, action.request)
      const pidToToolUseId = new Map(state.pidToToolUseId)
      if (action.request.toolUseID) pidToToolUseId.set(action.request.id, action.request.toolUseID)
      return { ...state, permissionPending, pidToToolUseId }
    }
    case 'PERMISSION_RESOLVED': {
      // Allocate fresh Maps lazily — most PERMISSION_RESOLVED frames
      // arrive for permissions we already cleaned up locally (the user
      // optimistically decided), so cloning four Maps unconditionally
      // burns CPU and breaks reference equality for selectors that
      // depend on stable Map identity (e.g. PlanCard memoization).
      let permissionPending = state.permissionPending
      let pidToToolUseId = state.pidToToolUseId
      let permissionDecisions = state.permissionDecisions
      let planStatus = state.planStatus
      let questionAnswers = state.questionAnswers
      let changed = false
      if (permissionPending.has(action.id)) {
        permissionPending = new Map(permissionPending)
        permissionPending.delete(action.id)
        changed = true
      }
      const toolUseId = pidToToolUseId.get(action.id)
      if (toolUseId) {
        permissionDecisions = new Map(permissionDecisions)
        permissionDecisions.set(toolUseId, action.decision.behavior)
        // Cap entries — a session with thousands of approved tool runs
        // (long autonomous agent loops) would otherwise grow this Map
        // forever. Keys are tool_use_ids that have already been
        // surfaced in the UI; evicting the oldest just means a
        // (typically already-scrolled-out-of-view) plan/tool card no
        // longer flips its badge from "pending" to "approved/rejected"
        // on a future scroll-back. Maps preserve insertion order, so
        // keys().next() is the oldest.
        const PERMISSION_DECISIONS_CAP = 1024
        while (permissionDecisions.size > PERMISSION_DECISIONS_CAP) {
          const oldest = permissionDecisions.keys().next().value
          if (oldest === undefined) break
          permissionDecisions.delete(oldest)
        }
        changed = true
        if (planStatus.has(toolUseId)) {
          planStatus = new Map(planStatus)
          planStatus.set(toolUseId, action.decision.behavior === 'allow' ? 'approved' : 'rejected')
        }
        // AskUserQuestion answers ride on the resolution `message` field
        // (built by server/permission-helpers.ts:formatQuestionAnswers).
        // Normally the JSON answers payload also lands as a tool_result
        // block on a follow-up user message — extractQuestionAnswers in
        // updateIndexes() parses that and replaces the pending entry.
        // But the SDK does not always echo a corresponding tool_result
        // through the Query stream after a canUseTool deny+message
        // short-circuit, which leaves the inline QuestionCard rendering
        // 'pending' forever even though the user already answered.
        // Decoding the same JSON here closes that gap — questionAnswers
        // flips from [] to the parsed entries the moment the resolution
        // frame lands, independent of whether tool_result follows.
        // Scope: only when we previously seeded a pending entry for
        // this toolUseId (i.e. it really was an AskUserQuestion call).
        if (questionAnswers.has(toolUseId) && action.decision.message) {
          const parsed = parseQuestionAnswersMessage(action.decision.message)
          if (parsed.length > 0) {
            questionAnswers = new Map(questionAnswers)
            questionAnswers.set(toolUseId, parsed)
          }
        }
      }
      if (pidToToolUseId.has(action.id)) {
        pidToToolUseId = new Map(pidToToolUseId)
        pidToToolUseId.delete(action.id)
        changed = true
      }
      if (!changed) return state
      return { ...state, permissionPending, pidToToolUseId, permissionDecisions, planStatus, questionAnswers }
    }
    case 'CONTEXT_USAGE':
      return { ...state, contextUsage: action.usage }
    case 'MESSAGE_CONSUMED':
      return applyMessageConsumed(state, action.uuid, action.consumedAt)
    case 'ERROR':
      return { ...state, error: action.message }
    case 'TRACK_SENT_TURN':
      return { ...state, queuedAhead: state.queuedAhead + 1 }
    case 'LIVE_TURN_FLUSH':
      if (!state.liveTurn || !state.liveTurn.dirty) return state
      return {
        ...state,
        liveTurn: {
          ...state.liveTurn,
          flushedText: state.liveTurn.flushedText + state.liveTurn.textChunks.join(''),
          textChunks: [],
          dirty: false,
        },
      }
    case 'RESET':
      return createInitialSessionState(state.sessionId)
    default:
      return state
  }
}

function replayReplace(
  prevState: SessionState,
  messages: SdkMessage[],
  permissions: PermissionRequest[],
): SessionState {
  // If the server replay is empty but we already have cached messages
  // (from localStorage), keep the cache as a fallback. This prevents
  // blank screens when the server's history ring has been trimmed or
  // the session was garbage collected.
  if (messages.length === 0 && prevState.items.length > 0) {
    return { ...prevState, replayReady: true }
  }
  // Incremental replay: the server sent only messages after the client's
  // lastUuid (sinceUuid). Append them to the existing transcript instead
  // of replacing it — otherwise the entire pre-reconnect history vanishes.
  if (messages.length > 0 && prevState.items.length > 0) {
    let state: SessionState = { ...prevState, liveTurn: null, replayReady: true }
    for (const permission of permissions) {
      state = reduceSessionState(state, { type: 'PERMISSION_REQUEST', request: permission })
    }
    for (const message of messages) {
      state = applyMessage(state, message)
    }
    return state
  }
  let state = createInitialSessionState(prevState.sessionId)
  // queuedAhead is a client-only counter that tracks user messages waiting
  // in the server-side queue. It must survive replayReplace() — otherwise
  // a WebSocket reconnect (which triggers a replay) wipes the queue bar.
  state = { ...state, queuedAhead: prevState.queuedAhead }
  for (const permission of permissions) {
    state = reduceSessionState(state, { type: 'PERMISSION_REQUEST', request: permission })
  }
  for (const message of messages) {
    state = applyMessage(state, message)
  }
  return { ...state, replayReady: true }
}

/** Prepend a chronological batch of older messages (loaded from disk on
 *  scroll-up) ahead of the current transcript.
 *
 *  Correctness notes:
 *   - Dedup by uuid: a message already present (e.g. the boundary message
 *     the frontend used as its paging cursor, or overlap after a reconnect)
 *     is skipped so we never render it twice.
 *   - Content dedup for TOP-LEVEL USER PROMPTS: these can't be deduped by
 *     uuid because the server mints a fresh uuid for the in-memory copy
 *     while the pump drops the SDK's echo, so the on-disk copy carries a
 *     different (SDK) uuid (see topLevelUserPromptSignature). Paging anchors
 *     on the first disk-stable item (assistant/system) and reads strictly
 *     before it, so the disk page's TRAILING prompt run is exactly the
 *     on-screen LEADING prompt run — the same logical messages. We match
 *     those two runs element-wise from the boundary inward and drop the
 *     overlap, so a genuinely-older but textually-identical prompt further
 *     back is still preserved.
 *   - We build TranscriptItems for the older batch in order, threading the
 *     `prev` item so compact-summary detection (which looks at the previous
 *     item) works within the batch. The last older item becomes `prev` for
 *     the FIRST existing item — but we deliberately do NOT recompute the
 *     existing items: their isCompactSummary was already settled when they
 *     first arrived, and the only cross-boundary case (an existing first
 *     item that is a user message immediately after a compact_boundary we
 *     just prepended) is vanishingly rare and self-heals on next replay.
 *   - Indexes (toolStatus/planStatus/…) are updated by running ONLY the
 *     older batch through updateIndexes — NOT a full rebuild. A full rebuild
 *     would clobber statuses that were set out-of-band (e.g. an ExitPlanMode
 *     plan flipped to 'approved' via PERMISSION_RESOLVED without a
 *     tool_result). The older batch's ids are disjoint from the live tail,
 *     so additive indexing is both sufficient and non-destructive. */
function prependMessages(state: SessionState, older: SdkMessage[]): SessionState {
  if (older.length === 0) return state

  const existingIds = new Set<string>()
  for (const it of state.items) existingIds.add(it.id)

  // How many trailing prompts of the incoming disk batch are the SAME
  // logical messages as the leading prompts already on screen (the uuid
  // boundary that uuid-dedup can't bridge — see the doc comment). Match the
  // batch's trailing prompt run against the on-screen leading prompt run
  // element-wise, from the boundary inward, by content signature.
  const overlap = countPromptOverlap(older, state.items)
  const batch = overlap > 0 ? older.slice(0, older.length - overlap) : older

  const newItems: typeof state.items = []
  const newMessages: SdkMessage[] = []
  let prev = undefined as (typeof state.items)[number] | undefined
  for (const msg of batch) {
    const uuid = typeof msg.uuid === 'string' ? msg.uuid : null
    if (uuid && existingIds.has(uuid)) continue
    const item = toTranscriptItem(msg, prev)
    if (!item) continue
    newItems.push(item)
    newMessages.push(item.msg)
    existingIds.add(item.id)
    prev = item
  }

  if (newItems.length === 0) return state

  let next: SessionState = {
    ...state,
    items: [...newItems, ...state.items],
    messages: [...newMessages, ...state.messages],
  }
  // Additive index update over just the prepended batch.
  next = rebuildIndexesFromMessages(next, newMessages)
  return next
}

/** Count how many trailing top-level user prompts of an incoming disk page
 *  (`older`) are the same logical messages as the leading top-level prompts
 *  already on screen (`items`).
 *
 *  Paging anchors on the first disk-stable message (assistant/system) and
 *  reads strictly before it, so the user prompts shown ABOVE that anchor are
 *  re-returned at the END of the disk page — the prompt closest to the
 *  anchor is `older[last]` on disk and the last item of the on-screen
 *  leading run in memory. Those prompts carry different uuids on disk vs in
 *  memory (server-minted vs SDK), so we compare by content signature.
 *
 *  Both runs are anchored at the boundary and grow AWAY from it in opposite
 *  array directions, so we must align them boundary-first: find the length
 *  of the on-screen leading prompt run, then walk inward from the anchor —
 *  `older[last-n]` against `items[K-1-n]`. Stop at the first mismatch (or a
 *  non-prompt on the batch side), so an older but textually-identical prompt
 *  further back in history is never falsely dropped. */
function countPromptOverlap(older: SdkMessage[], items: SessionState['items']): number {
  // Length of the contiguous top-level-prompt run at the START of the
  // on-screen transcript (i.e. the prompts sitting above the paging anchor).
  let leadRun = 0
  while (leadRun < items.length && topLevelUserPromptSignature(items[leadRun].msg) != null) {
    leadRun++
  }
  let n = 0
  while (n < older.length && n < leadRun) {
    const batchSig = topLevelUserPromptSignature(older[older.length - 1 - n])
    if (batchSig == null) break // batch tail is no longer a top-level prompt
    // items[leadRun - 1 - n] is within the leading run, so its signature is
    // guaranteed non-null — only the content needs to match.
    if (batchSig !== topLevelUserPromptSignature(items[leadRun - 1 - n].msg)) break
    n++
  }
  return n
}

function applyOptimisticUserMessage(state: SessionState, message: SdkMessage): SessionState {
  const item = toTranscriptItem(message, state.items[state.items.length - 1])
  if (!item) return state

  // If the server's WS echo already arrived and was appended to the
  // transcript before this optimistic insert ran, don't add a duplicate.
  // Just add its id to the pending set so applyMessage can match it.
  // NOTE: This uses shallow === on `content`. For plain text strings
  // this works correctly. For multimodal messages (arrays), the ref
  // comparison always returns false — the safe direction (no false dedup).
  const last = state.items[state.items.length - 1]
  if (last && last.msg.type === 'user' && last.msg.message?.content === message.message?.content) {
    const next = new Set(state.pendingUserMessageIds)
    next.add(last.id)
    return { ...state, pendingUserMessageIds: next }
  }

  // Mark the optimistic item as 'sending' so the user bubble can render
  // a spinner. The flag clears automatically when the server's broadcast
  // arrives and applyMessage swaps this item out for the real one (the
  // replaced TranscriptItem has no `sending` field). Stamp receivedAt
  // locally so the timestamp shows immediately; when the server echo
  // replaces this item it carries the authoritative server time.
  const optimisticItem = {
    ...item,
    sending: true,
    receivedAt: item.receivedAt ?? Date.now(),
  }
  const next = new Set(state.pendingUserMessageIds)
  next.add(optimisticItem.id)
  return {
    ...state,
    items: [...state.items, optimisticItem],
    messages: [...state.messages, optimisticItem.msg],
    pendingUserMessageIds: next,
  }
}

/** Flip a queued user message to 'consumed' when the live message-consumed
 *  frame arrives. Matches by uuid. No-op when the message isn't present yet
 *  (the frame raced ahead of the message broadcast) or is already consumed —
 *  in the race case the message will carry consumedAt on its own broadcast /
 *  the next replay, so we self-heal without tracking pending uuids. Mutates
 *  the message object's consumedAt in place (consistent with the server,
 *  where history and the live frame share one reference) and rebuilds just
 *  the affected TranscriptItem so deliveryStatus re-derives. */
function applyMessageConsumed(state: SessionState, uuid: string, consumedAt: number): SessionState {
  const idx = state.items.findIndex((it) => it.id === uuid)
  if (idx < 0) return state
  const item = state.items[idx]
  if (item.deliveryStatus === 'consumed') return state
  // Stamp the underlying message so a later re-derivation (and any code
  // reading msg.consumedAt directly) agrees. Build a new msg object rather
  // than mutating the cached one, keeping the store's items immutable.
  const nextMsg: SdkMessage = { ...item.msg, consumedAt }
  const items = state.items.slice()
  items[idx] = { ...item, msg: nextMsg, deliveryStatus: 'consumed' }
  // Keep the parallel `messages` array's object reference in sync so a
  // later REPLAY/PREPEND that reads msg.consumedAt is consistent.
  const mIdx = state.messages.findIndex(
    (m) => (typeof m.uuid === 'string' ? m.uuid : null) === uuid,
  )
  const messages = mIdx >= 0 ? state.messages.slice() : state.messages
  if (mIdx >= 0) messages[mIdx] = nextMsg
  return { ...state, items, messages }
}

// --- Memory bound: front-trim the in-memory transcript -----------------
// The server's history ring is capped (historyCap = 500), but the client's
// items/messages arrays grow unbounded as long as the WS keeps pushing — a
// long autonomous-agent session can accumulate tens of thousands of frames.
// We keep at most MEMORY_ITEM_CAP items in memory; trimmed messages remain
// recoverable by scrolling up (loadOlder re-reads them from disk).
const MEMORY_ITEM_CAP = 1000
// Hysteresis: only trim once we exceed CAP + SLACK, then drop back to CAP. So
// trimming runs once every SLACK appends (not every message), keeping the
// common append path allocation-free.
const MEMORY_TRIM_SLACK = 256

/** Union of every tool_use_id referenced by `items` — both the tool_use
 *  (assistant) and tool_result (user) sides. Used to prune the toolUseId-keyed
 *  lifecycle maps to live keys after a front-trim. */
function collectLiveToolUseIds(items: SessionState['items']): Set<string> {
  const live = new Set<string>()
  for (const it of items) {
    const m = it.msg
    for (const id of getToolUseStarts(m)) live.add(id)
    for (const id of getPlanToolUseIds(m)) live.add(id)
    for (const id of getQuestionToolUseIds(m)) live.add(id)
    for (const id of getToolResultIds(m)) live.add(id)
  }
  return live
}

/** Return a Map filtered to keys present in `live`, reusing the original
 *  reference when nothing is dropped (keeps selector identity stable). */
function pruneMapToLive<V>(map: Map<string, V>, live: Set<string>): Map<string, V> {
  let dropped = false
  for (const key of map.keys()) {
    if (!live.has(key)) { dropped = true; break }
  }
  if (!dropped) return map
  const next = new Map<string, V>()
  for (const [key, value] of map) {
    if (live.has(key)) next.set(key, value)
  }
  return next
}

/** Drop the oldest items/messages once the in-memory transcript exceeds
 *  MEMORY_ITEM_CAP + MEMORY_TRIM_SLACK, bringing it back down to ~CAP.
 *
 *  The cut point is snapped FORWARD to the first isTrimBoundary message so the
 *  new items[0] is both on-disk AND not a plain top-level user prompt. This
 *  matters for two downstream consumers:
 *    - loadOlder()'s first page anchors `beforeUuid` on items[0]. That uuid
 *      MUST exist on disk, or the server falls back to the newest page and
 *      reverse-paging silently stalls. isTrimBoundary (not the looser
 *      isDiskStableMsg) guarantees a persisted frame — see its doc comment.
 *    - countPromptOverlap() dedups the leading user-prompt run against an
 *      incoming disk page by content signature (uuids differ disk vs memory).
 *      A non-empty leading prompt run after a trim could resurface as
 *      duplicates on the next loadOlder; an empty run (overlap 0) cannot.
 *
 *  Snapping past a long sidechain (subagent) run can keep somewhat fewer than
 *  CAP — acceptable, and bounded because every real turn ends with a
 *  main-thread assistant frame.
 *
 *  The five toolUseId-keyed lifecycle maps (toolStatus, toolResults,
 *  planStatus, planContent, questionAnswers) are pruned to ids still
 *  referenced by the retained items so they don't leak. permissionDecisions
 *  self-caps at 1024 and activeSubagents clears each result frame, so neither
 *  is touched. */
function trimFront(state: SessionState): SessionState {
  if (state.items.length <= MEMORY_ITEM_CAP + MEMORY_TRIM_SLACK) return state
  let cut = state.items.length - MEMORY_ITEM_CAP
  // Snap forward to the first disk-persisted boundary at or after `cut`.
  while (cut < state.items.length && !isTrimBoundary(state.items[cut].msg)) cut++
  // No safe boundary in the trim zone (pathological — e.g. an unbroken run of
  // plain prompts / sidechain frames). Skip this round rather than cut at an
  // unsafe point that would break reverse-paging.
  if (cut >= state.items.length) return state

  const items = state.items.slice(cut)
  const messages = state.messages.slice(cut)
  const live = collectLiveToolUseIds(items)
  return {
    ...state,
    items,
    messages,
    toolStatus: pruneMapToLive(state.toolStatus, live),
    toolResults: pruneMapToLive(state.toolResults, live),
    planStatus: pruneMapToLive(state.planStatus, live),
    planContent: pruneMapToLive(state.planContent, live),
    questionAnswers: pruneMapToLive(state.questionAnswers, live),
  }
}

function applyMessage(state: SessionState, message: SdkMessage): SessionState {
  // When the server echoes back the user message we sent, replace the
  // optimistic placeholder IN PLACE and return early. Falling through
  // to updateTranscript below would append the real message a second
  // time — that was the "every message shows twice" regression
  // introduced when we moved insertUserMessage to run before the POST.
  //
  // Guard: only match when the incoming message is a top-level user
  // message (parent_tool_use_id === null/undefined). Subagent
  // tool_result frames are also `type: 'user'` but should never clobber
  // the optimistic — without this guard, a tool_result that lands while
  // pendingUserMessageIds is still populated would replace the typed text
  // with a JSON tool result and silently drop what the user wrote.
  const incomingParent = (message as Record<string, unknown>).parent_tool_use_id
  if (
    message.type === 'user' &&
    state.pendingUserMessageIds.size > 0 &&
    incomingParent == null
  ) {
    const real = toTranscriptItem(message, undefined)
    if (real) {
      // Find the first optimistic placeholder that still exists in items.
      // Echoes arrive in the same order the user sent, so the oldest
      // pending ID is the correct match.
      let matchedId: string | null = null
      for (const pid of state.pendingUserMessageIds) {
        if (state.items.some((it) => it.id === pid)) {
          matchedId = pid
          break
        }
      }
      if (matchedId) {
        const idx = state.items.findIndex((it) => it.id === matchedId)
        const items = state.items.slice()
        items[idx] = real
        const msgIdx = state.messages.findIndex(
          (m) => (typeof m.uuid === 'string' ? m.uuid : null) === matchedId,
        )
        const messages = msgIdx >= 0 ? state.messages.slice() : state.messages
        if (msgIdx >= 0) messages[msgIdx] = real.msg
        const nextIds = new Set(state.pendingUserMessageIds)
        nextIds.delete(matchedId)
        return {
          ...state,
          items,
          messages,
          eventCount: state.eventCount + 1,
          lastMessageUuid: typeof message.uuid === 'string' ? message.uuid : state.lastMessageUuid,
          pendingUserMessageIds: nextIds,
        }
      }
      // All pending IDs pointed at rows that are no longer in items
      // (rollback ran, replay rebuilt, etc.). Clear dangling pointers
      // and let the message flow through updateTranscript normally.
      state = { ...state, pendingUserMessageIds: new Set<string>() }
    }
  }

  let next: SessionState = {
    ...state,
    eventCount: state.eventCount + 1,
  }

  if (typeof message.uuid === 'string') {
    next.lastMessageUuid = message.uuid
  }

  // If this is a TOP-LEVEL user message that wasn't matched above
  // (e.g. arrived but all optimistic placeholders were already gone),
  // clear pendingUserMessageIds to be safe. Don't clear on
  // tool_result/subagent user frames (parent_tool_use_id != null) —
  // those are unrelated to the user's typed input and the real echo
  // may still be on its way.
  if (message.type === 'user' && next.pendingUserMessageIds.size > 0 && incomingParent == null) {
    next = { ...next, pendingUserMessageIds: new Set<string>() }
  }

  next = updateLiveTurn(next, message)
  next = updateTranscript(next, message)
  next = updateIndexes(next, message)

  if (message.type === 'result') {
    // Reconcile any tool still marked 'running' at turn end. A `result`
    // frame means the turn is definitively over — within a normal turn
    // every tool_result lands BEFORE the result, so anything still
    // 'running' here is orphaned: its tool_result will never arrive
    // (the user interrupted, or the SDK aborted the turn after emitting
    // the tool_use). Without this sweep the card's status badge spins on
    // 'running' forever, since useToolStatus() defaults unknown/lingering
    // ids to 'running'. Mirror the activeSubagents reset below. Only
    // clone the Map when there's actually a running entry to flip so
    // result frames for tool-free turns stay identity-stable.
    let sweptToolStatus = next.toolStatus
    const swept = toolDebugEnabled() ? [] as string[] : null
    for (const [id, status] of next.toolStatus) {
      if (status !== 'running') continue
      if (sweptToolStatus === next.toolStatus) sweptToolStatus = new Map(next.toolStatus)
      sweptToolStatus.set(id, 'error')
      if (swept) swept.push(id)
    }
    if (swept && swept.length > 0) {
      toolDebug('SWEEP running→error at turn end (result frame)', { ids: swept })
    } else {
      toolDebug('result frame — no running tools to sweep', {})
    }

    // Prune only the STILL-running subagent entries at turn end. Completed
    // records (status 'done'/'interrupted', with their result payload
    // captured) MUST survive: SubagentCard reads them from the index to
    // render the merged result inline, and MessageList derives
    // subagentResultIds from `record.result` to suppress the standalone
    // orphan tool_result bubble. Wiping the whole Map here (the old
    // `new Map()`) stranded both — the card fell back to a bare "running"
    // placeholder and the orphan bubble reappeared below it. A still-running
    // entry at result time is genuinely stale (its tool_result never matched),
    // so flip it to 'interrupted' rather than drop it, mirroring the
    // toolStatus sweep above. Identity-stable when nothing is running.
    let prunedSubagents = next.activeSubagents
    for (const [id, sub] of next.activeSubagents) {
      if (sub.status !== 'running') continue
      if (prunedSubagents === next.activeSubagents) prunedSubagents = new Map(next.activeSubagents)
      prunedSubagents.set(id, { ...sub, status: 'interrupted', endedAt: sub.endedAt ?? sub.startedAt })
    }
    next = {
      ...next,
      toolStatus: sweptToolStatus,
      // Reset to 0 (not decrement). The SDK can merge multiple queued
      // user messages into a single assistant turn, so N sends might
      // produce M < N result frames — decrementing per-result then
      // permanently strands queuedAhead at N - M, and the queue bar
      // becomes stuck on. Mirror the server's pendingTurns reset
      // (server/session-pump.ts:174 — "each result represents exactly
      // one completed turn"). If more messages are still queued after
      // this turn we briefly under-report, but the next turn's working
      // state covers the visual "still busy" cue via WorkingBubble.
      queuedAhead: 0,
      liveTurn: null,
      // Clear any lingering optimistic placeholders — the result frame
      // means the SDK has finished processing, so no server echo for
      // the user message is expected anymore.
      pendingUserMessageIds: new Set<string>(),
      // Prune stale 'running' subagents (see prunedSubagents above) while
      // KEEPING completed records so their merged card + orphan-bubble
      // suppression survive across turns and replay.
      activeSubagents: prunedSubagents,
    }
  }

  // Bound in-memory growth. No-op until the transcript exceeds CAP + SLACK,
  // so the common append path stays allocation-free.
  next = trimFront(next)

  return next
}

function updateTranscript(state: SessionState, message: SdkMessage): SessionState {
  const prev = state.items[state.items.length - 1]
  const item = toTranscriptItem(message, prev)
  if (!item) return state

  if (
    item.msg.type === 'system' &&
    item.msg.subtype === 'api_retry' &&
    prev?.msg.type === 'system' &&
    prev.msg.subtype === 'api_retry'
  ) {
    const items = state.items.slice(0, -1).concat(item)
    const messages = state.messages.slice(0, -1).concat(item.msg)
    return { ...state, items, messages }
  }

  return {
    ...state,
    items: [...state.items, item],
    messages: [...state.messages, item.msg],
  }
}

/** Replay a list of cached messages through `updateIndexes()` to
 *  reconstruct the lifecycle index maps (`toolStatus`, `planStatus`,
 *  `planContent`, `questionAnswers`, `activeSubagents`).
 *
 *  Used by `SessionStore` on hydration: only `messages`/`items` are
 *  persisted to localStorage (the indexes are derived state). Without
 *  this rebuild, every cached tool_use card would render the default
 *  "running" badge forever — `useToolStatus` falls back to 'running'
 *  for any toolUseId not in the map, and the seeding step that puts it
 *  there only runs on live `MESSAGE` actions, not on hydrate. The
 *  symptom we hit was older Read/Grep/Bash cards stuck on the spinner
 *  after a page reload even though the conversation had moved on.
 *
 *  We deliberately bypass `updateTranscript` — the items array is
 *  already populated from the cache; we only need the index side
 *  effects. Calling `applyMessage` here would double-append items.
 *
 *  Note: skips `liveTurn` and `pendingUserMessageIds` work too, which is
 *  fine — those are ephemeral and re-derived from the live stream. */
export function rebuildIndexesFromMessages(
  state: SessionState,
  messages: readonly SdkMessage[],
): SessionState {
  let next = state
  for (const message of messages) {
    next = updateIndexes(next, message)
  }
  return next
}

function updateIndexes(state: SessionState, message: SdkMessage): SessionState {
  let changed = false
  let planStatus = state.planStatus
  let planContent = state.planContent
  let questionAnswers = state.questionAnswers
  let toolStatus = state.toolStatus
  let toolResults = state.toolResults
  let activeSubagents = state.activeSubagents

  // Generic tool status — seed 'running' for every tool_use the assistant
  // emits (excluding ones with their own status map: Plan/Subagent/Question).
  const toolStarts = getToolUseStarts(message)
  if (toolStarts.length > 0) {
    toolStatus = new Map(toolStatus)
    for (const id of toolStarts) {
      // Don't clobber a status that's already terminal — could happen in
      // theory if a duplicate tool_use lands during replay.
      if (!toolStatus.has(id)) toolStatus.set(id, 'running')
    }
    toolDebug('seed running', { ids: toolStarts, total: toolStatus.size })
    changed = true
  }

  // Flip to 'success' or 'error' when the matching tool_result lands.
  // Most user messages don't carry tool_results, so defer the Map clone
  // until we actually have a status to update — same trick as the
  // subagent branch below.
  if (message.type === 'user' && toolStatus.size > 0) {
    const outcomes = getToolResultOutcomes(message)
    if (outcomes.length > 0) {
      let touched = false
      // Only allocated when diagnostics are on — keeps the hot path free.
      const orphans = toolDebugEnabled() ? [] as string[] : null
      for (const { toolUseId, outcome } of outcomes) {
        const prev = toolStatus.get(toolUseId)
        // No seeded entry for this result's tool_use_id. Either the
        // result is for an excluded tool (Plan/Subagent/Question — fine),
        // or the id genuinely doesn't match any tool_use we seeded — the
        // latter is the "id-mismatch" failure mode that strands a card on
        // 'running' forever. We can't tell the two apart here, so log it
        // for offline diagnosis rather than guessing.
        if (!prev) {
          if (orphans) orphans.push(toolUseId)
          continue
        }
        if (prev === outcome) continue
        if (!touched) {
          if (toolStatus === state.toolStatus) toolStatus = new Map(toolStatus)
          touched = true
        }
        toolStatus.set(toolUseId, outcome)
        toolDebug('flip', { id: toolUseId, from: prev, to: outcome })
      }
      if (orphans && orphans.length > 0) {
        toolDebug('ORPHAN result (no matching seeded tool_use)', {
          ids: orphans,
          seededIds: Array.from(toolStatus.keys()),
        })
      }
      if (touched) changed = true
    }
  }

  // Capture tool_result payloads so the originating tool_use card can
  // render the result inline (instead of a separate bubble). Only store
  // results whose tool_use_id was seeded into `toolStatus` — that set is
  // exactly the generic tool cards (Plan/Question/Subagent are excluded by
  // getToolUseStarts' TOOL_STATUS_EXCLUDE and own their result rendering).
  // Same lazy-clone discipline as the status flip above.
  if (message.type === 'user' && toolStatus.size > 0) {
    const entries = getToolResultEntries(message)
    if (entries.length > 0) {
      let touched = false
      for (const { toolUseId, content, isError } of entries) {
        if (!toolStatus.has(toolUseId)) continue
        if (toolResults.has(toolUseId)) continue
        if (!touched) {
          if (toolResults === state.toolResults) toolResults = new Map(toolResults)
          touched = true
        }
        toolResults.set(toolUseId, { content, isError })
      }
      if (touched) changed = true
    }
  }

  const planIds = getPlanToolUseIds(message)
  if (planIds.length > 0) {
    planStatus = new Map(planStatus)
    for (const id of planIds) planStatus.set(id, 'pending')
    changed = true
  }

  const planResults = getPlanResultDecisions(message, planStatus)
  if (planResults.length > 0) {
    if (planStatus === state.planStatus) planStatus = new Map(planStatus)
    for (const result of planResults) planStatus.set(result.toolUseId, result.status)
    changed = true
  }

  // Extract plan body from ExitPlanMode tool_result outputs.  The CLI
  // injects plan content from disk into the output (not the input), so
  // we capture it here for the PermissionDialog and inline PlanCard.
  // tool_result blocks only ever land on user messages — gating on
  // msg.type avoids allocating the Set for every assistant/system/result.
  if (message.type === 'user' && planStatus.size > 0) {
    const knownPlanIds = new Set(planStatus.keys())
    const extracted = extractPlanContent(message, knownPlanIds)
    if (extracted.length > 0) {
      if (planContent === state.planContent) planContent = new Map(planContent)
      for (const { toolUseId, plan } of extracted) planContent.set(toolUseId, plan)
      changed = true
    }
  }

  // Track AskUserQuestion tool_use ids so the inline QuestionCard can
  // render a "pending" state immediately (before the user answers).
  // We seed with an empty answers array; the tool_result handler below
  // replaces it when the JSON answers payload lands.
  const questionIds = getQuestionToolUseIds(message)
  if (questionIds.length > 0) {
    let touched = false
    for (const id of questionIds) {
      if (questionAnswers.has(id)) continue
      if (!touched) {
        questionAnswers = new Map(questionAnswers)
        touched = true
      }
      questionAnswers.set(id, [])
    }
    if (touched) changed = true
  }

  // Parse JSON answers from AskUserQuestion tool_results (built by
  // server/permission-helpers.ts:formatQuestionAnswers).  Same gating
  // pattern as the plan-content branch above — only user messages
  // carry tool_results, and we only care if we've seen the matching
  // tool_use first.
  if (message.type === 'user' && questionAnswers.size > 0) {
    const knownQuestionIds = new Set(questionAnswers.keys())
    const extracted = extractQuestionAnswers(message, knownQuestionIds)
    if (extracted.length > 0) {
      if (questionAnswers === state.questionAnswers) questionAnswers = new Map(questionAnswers)
      for (const { toolUseId, answers } of extracted) questionAnswers.set(toolUseId, answers)
      changed = true
    }
  }

  const starts = getSubagentStarts(message)
  if (starts.length > 0) {
    activeSubagents = new Map(activeSubagents)
    // Stamp `startedAt` once per subagent so the chip can show an
    // elapsed time. Preserve any existing value if we re-encounter the
    // same toolUseId (e.g. duplicate dispatch during replay).
    const now = Date.now()
    for (const subagent of starts) {
      const existing = activeSubagents.get(subagent.toolUseId)
      activeSubagents.set(subagent.toolUseId, {
        ...subagent,
        startedAt: existing?.startedAt ?? subagent.startedAt ?? now,
        endedAt: existing?.endedAt,
        status: existing?.status ?? 'running',
        toolCount: existing?.toolCount ?? 0,
      })
    }
    changed = true
  }

  const subagentResultEntries = getToolResultEntries(message)
  if (subagentResultEntries.length > 0 && activeSubagents.size > 0) {
    // Don't delete on tool_result — keep the record around so the
    // overlay can be reopened after completion. Flip status to 'done'
    // ('interrupted' when the result carries is_error, so a failed
    // subagent doesn't show a green check) and stamp endedAt. Also
    // capture the result payload so SubagentCard can merge the
    // subagent's returned output inline at the bottom of the card —
    // mirrors the generic ToolCard merge. The "running" filter
    // elsewhere drops completed subagents from the WorkingBubble chip
    // row automatically.
    //
    // Most turns include tool_results unrelated to subagents, so defer
    // the Map clone until we actually have a matching id — otherwise
    // every Bash/Read/Edit hop allocates a fresh Map for nothing.
    let touched = false
    const now = Date.now()
    for (const { toolUseId, content, isError } of subagentResultEntries) {
      const existing = activeSubagents.get(toolUseId)
      if (!existing || existing.status !== 'running') continue
      if (!touched) {
        if (activeSubagents === state.activeSubagents) activeSubagents = new Map(activeSubagents)
        touched = true
      }
      activeSubagents.set(toolUseId, {
        ...existing,
        status: isError ? 'interrupted' : 'done',
        endedAt: now,
        result: { content, isError },
      })
    }
    changed = changed || touched
  }

  // Count tool_use blocks in assistant messages that belong to a subagent
  // (identified by parent_tool_use_id). This pre-computes the value that
  // SubagentCard previously scanned the full message list to compute.
  if (message.type === 'assistant' && activeSubagents.size > 0) {
    const parentId = (message as Record<string, unknown>).parent_tool_use_id
    if (typeof parentId === 'string') {
      const existing = activeSubagents.get(parentId)
      if (existing) {
        const content = message.message?.content
        if (Array.isArray(content)) {
          let newTools = 0
          for (const b of content as Array<{ type?: string }>) {
            if (b.type === 'tool_use') newTools++
          }
          if (newTools > 0) {
            if (activeSubagents === state.activeSubagents) activeSubagents = new Map(activeSubagents)
            activeSubagents.set(parentId, { ...existing, toolCount: existing.toolCount + newTools })
            changed = true
          }
        }
      }
    }
  }

  return changed
    ? { ...state, planStatus, planContent, questionAnswers, toolStatus, toolResults, activeSubagents }
    : state
}

function updateLiveTurn(state: SessionState, message: SdkMessage): SessionState {
  if (message.type !== 'stream_event') return state
  const event = message.event as Record<string, unknown> | undefined
  if (!event || typeof event.type !== 'string') return state

  let liveTurn = state.liveTurn
  if (!liveTurn) {
    liveTurn = {
      turnId: typeof message.uuid === 'string' ? message.uuid : `turn:${state.eventCount + 1}`,
      phase: null,
      textChunks: [],
      flushedText: '',
      tokenRate: null,
      startedAt: Date.now(),
      lastDeltaAt: Date.now(),
      dirty: false,
    }
  }

  if (event.type === 'message_delta') {
    const usage = (event as { usage?: Record<string, unknown> }).usage
    const outputTokens = usage?.output_tokens
    if (typeof outputTokens === 'number') {
      const prevTokens = liveTurn.outputTokens
      const prevTs = liveTurn.lastDeltaAt
      const now = performance.now()
      let tokenRate = liveTurn.tokenRate
      if (typeof prevTokens === 'number') {
        const dt = (now - prevTs) / 1000
        const dTokens = outputTokens - prevTokens
        if (dt >= 0.3 && dTokens >= 0) tokenRate = Math.round(dTokens / dt)
      }
      liveTurn = {
        ...liveTurn,
        outputTokens,
        tokenRate,
        lastDeltaAt: now,
      }
    }
  } else if (event.type === 'content_block_start') {
    const block = (event as { content_block?: Record<string, unknown> }).content_block
    if (block?.type === 'thinking') {
      liveTurn = { ...liveTurn, phase: 'thinking' }
    } else if (block?.type === 'text') {
      liveTurn = { ...liveTurn, phase: 'writing' }
    } else if (block?.type === 'tool_use') {
      liveTurn = { ...liveTurn, phase: { type: 'tool_use', name: String(block.name ?? 'tool') } }
    }
  } else if (event.type === 'content_block_delta') {
    const delta = (event as { delta?: Record<string, unknown> }).delta
    const text = delta?.text
    if (typeof text === 'string') {
      liveTurn = {
        ...liveTurn,
        textChunks: [...liveTurn.textChunks, text],
        lastDeltaAt: performance.now(),
        dirty: true,
      }
    }
  } else if (event.type === 'message_stop') {
    liveTurn = {
      ...liveTurn,
      outputTokens: undefined,
    }
  }

  return { ...state, liveTurn }
}
