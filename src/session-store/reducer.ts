import type { PermissionRequest, SdkMessage } from '../types'
import { createInitialSessionState, type SessionAction, type SessionState } from './types'
import {
  extractPlanContent,
  getPlanResultDecisions,
  getPlanToolUseIds,
  getSubagentStarts,
  getToolResultIds,
  toTranscriptItem,
} from './normalize'

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
      const permissionPending = new Map(state.permissionPending)
      permissionPending.delete(action.id)
      const pidToToolUseId = new Map(state.pidToToolUseId)
      const permissionDecisions = new Map(state.permissionDecisions)
      const planStatus = new Map(state.planStatus)
      const toolUseId = pidToToolUseId.get(action.id)
      if (toolUseId) {
        permissionDecisions.set(toolUseId, action.decision.behavior)
        if (planStatus.has(toolUseId)) {
          planStatus.set(toolUseId, action.decision.behavior === 'allow' ? 'approved' : 'rejected')
        }
      }
      pidToToolUseId.delete(action.id)
      return { ...state, permissionPending, pidToToolUseId, permissionDecisions, planStatus }
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
          flushedText: state.liveTurn.textBuffer,
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
      queuedAhead: Math.max(0, state.queuedAhead - 1),
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
  let activeSubagents = state.activeSubagents

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

  return changed ? { ...state, planStatus, planContent, activeSubagents } : state
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
      textBuffer: '',
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
        textBuffer: liveTurn.textBuffer + text,
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
