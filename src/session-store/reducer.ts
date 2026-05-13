import type { PermissionRequest, SdkMessage } from '../types'
import { createInitialSessionState, type SessionAction, type SessionState } from './types'
import {
  getPlanResultDecisions,
  getPlanToolUseIds,
  getSubagentStarts,
  getToolResultIds,
  toTranscriptItem,
} from './normalize'

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'REPLAY_REPLACE':
      return replayReplace(state.sessionId, action.messages, action.permissions)
    case 'MESSAGE':
      return applyMessage(state, action.message)
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
      return { ...state, queuedAhead: Math.max(state.queuedAhead, 1) }
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

function replayReplace(sessionId: string, messages: SdkMessage[], permissions: PermissionRequest[]): SessionState {
  let state = createInitialSessionState(sessionId)
  for (const permission of permissions) {
    state = reduceSessionState(state, { type: 'PERMISSION_REQUEST', request: permission })
  }
  for (const message of messages) {
    state = applyMessage(state, message)
  }
  return { ...state, replayReady: true }
}

function applyMessage(state: SessionState, message: SdkMessage): SessionState {
  let next: SessionState = {
    ...state,
    eventLog: [...state.eventLog, message],
  }

  if (typeof message.uuid === 'string') {
    next.lastMessageUuid = message.uuid
  }

  next = updateLiveTurn(next, message)
  next = updateTranscript(next, message)
  next = updateIndexes(next, message)

  if (message.type === 'result') {
    next = {
      ...next,
      queuedAhead: 0,
      liveTurn: null,
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

  const starts = getSubagentStarts(message)
  if (starts.length > 0) {
    activeSubagents = new Map(activeSubagents)
    for (const subagent of starts) activeSubagents.set(subagent.toolUseId, subagent)
    changed = true
  }

  const toolResultIds = getToolResultIds(message)
  if (toolResultIds.length > 0 && activeSubagents.size > 0) {
    let removed = false
    if (activeSubagents === state.activeSubagents) activeSubagents = new Map(activeSubagents)
    for (const id of toolResultIds) {
      removed = activeSubagents.delete(id) || removed
    }
    changed = changed || removed
  }

  return changed ? { ...state, planStatus, activeSubagents } : state
}

function updateLiveTurn(state: SessionState, message: SdkMessage): SessionState {
  if (message.type !== 'stream_event') return state
  const event = message.event as Record<string, unknown> | undefined
  if (!event || typeof event.type !== 'string') return state

  let liveTurn = state.liveTurn
  if (!liveTurn) {
    liveTurn = {
      turnId: typeof message.uuid === 'string' ? message.uuid : `turn:${state.eventLog.length + 1}`,
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
