import type { PermissionRequest, SdkMessage } from '../types'
import { createInitialSessionState, type SessionAction, type SessionState } from './types'
import {
  extractPlanContent,
  getPlanResultDecisions,
  getPlanToolUseIds,
  getSubagentStarts,
  getToolResultIds,
  getToolResultOutcomes,
  getToolUseStarts,
  toTranscriptItem,
} from './normalize'
import {
  extractQuestionAnswers,
  getQuestionToolUseIds,
  parseQuestionAnswersMessage,
} from '../utils/question-answers'

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'REPLAY_REPLACE':
      return replayReplace(state, action.messages, action.permissions)
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
  // replaced TranscriptItem has no `sending` field).
  const optimisticItem = { ...item, sending: true }
  const next = new Set(state.pendingUserMessageIds)
  next.add(optimisticItem.id)
  return {
    ...state,
    items: [...state.items, optimisticItem],
    messages: [...state.messages, optimisticItem.msg],
    pendingUserMessageIds: next,
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
    next = {
      ...next,
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
      // Clear active subagents at turn end. Any entries still marked
      // 'running' are stale — their tool_result either didn't arrive
      // or wasn't matched. Without this, stale chips persist across
      // turns because the Map is never pruned.
      activeSubagents: new Map(),
    }
  }

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

function updateIndexes(state: SessionState, message: SdkMessage): SessionState {
  let changed = false
  let planStatus = state.planStatus
  let planContent = state.planContent
  let questionAnswers = state.questionAnswers
  let toolStatus = state.toolStatus
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
      for (const { toolUseId, outcome } of outcomes) {
        const prev = toolStatus.get(toolUseId)
        if (!prev || prev === outcome) continue
        if (!touched) {
          if (toolStatus === state.toolStatus) toolStatus = new Map(toolStatus)
          touched = true
        }
        toolStatus.set(toolUseId, outcome)
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

  const toolResultIds = getToolResultIds(message)
  if (toolResultIds.length > 0 && activeSubagents.size > 0) {
    // Don't delete on tool_result — keep the record around so the
    // overlay can be reopened after completion. Just flip status to
    // 'done' (or 'interrupted'/'rejected' if we can detect from content)
    // and stamp endedAt. The "running" filter elsewhere drops them
    // from the WorkingBubble chip row automatically.
    //
    // Most turns include tool_results unrelated to subagents, so defer
    // the Map clone until we actually have a matching id — otherwise
    // every Bash/Read/Edit hop allocates a fresh Map for nothing.
    let touched = false
    const now = Date.now()
    for (const id of toolResultIds) {
      const existing = activeSubagents.get(id)
      if (!existing || existing.status !== 'running') continue
      if (!touched) {
        if (activeSubagents === state.activeSubagents) activeSubagents = new Map(activeSubagents)
        touched = true
      }
      activeSubagents.set(id, {
        ...existing,
        status: 'done',
        endedAt: now,
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
    ? { ...state, planStatus, planContent, questionAnswers, toolStatus, activeSubagents }
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
