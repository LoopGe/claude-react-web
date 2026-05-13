import type { PermissionRequest, SdkMessage } from '../types'
import type { ContextUsage } from '../hooks/useChatStream'

export interface TranscriptItem {
  id: string
  msg: SdkMessage
  searchableText: string | null
  isCompactSummary: boolean
  hiddenByDefault: boolean
}

export interface ActiveSubagent {
  toolUseId: string
  label: string
  startedAt?: number
}

export type PlanStatus = 'pending' | 'approved' | 'rejected'

export type ActivePhase =
  | 'thinking'
  | 'writing'
  | { type: 'tool_use'; name: string }
  | null

export interface LiveTurnState {
  turnId: string
  phase: ActivePhase
  textBuffer: string
  flushedText: string
  outputTokens?: number
  tokenRate: number | null
  startedAt: number
  lastDeltaAt: number
  dirty: boolean
}

export interface SessionState {
  sessionId: string
  replayReady: boolean
  items: TranscriptItem[]
  messages: SdkMessage[]
  eventLog: SdkMessage[]
  liveTurn: LiveTurnState | null
  contextUsage: ContextUsage | null
  error: string | null
  queuedAhead: number
  lastMessageUuid: string | null
  permissionPending: Map<string, PermissionRequest>
  permissionDecisions: Map<string, 'allow' | 'deny'>
  pidToToolUseId: Map<string, string>
  planStatus: Map<string, PlanStatus>
  activeSubagents: Map<string, ActiveSubagent>
}

export type SessionAction =
  | { type: 'REPLAY_REPLACE'; messages: SdkMessage[]; permissions: PermissionRequest[] }
  | { type: 'MESSAGE'; message: SdkMessage }
  | { type: 'PERMISSION_REQUEST'; request: PermissionRequest }
  | {
      type: 'PERMISSION_RESOLVED'
      id: string
      decision: { behavior: 'allow' | 'deny'; persisted: boolean; message?: string }
    }
  | { type: 'CONTEXT_USAGE'; usage: ContextUsage }
  | { type: 'ERROR'; message: string | null }
  | { type: 'TRACK_SENT_TURN' }
  | { type: 'LIVE_TURN_FLUSH' }
  | { type: 'RESET' }

export interface SessionSnapshot {
  replayReady: boolean
  items: TranscriptItem[]
  messages: SdkMessage[]
  streamingContent: string | null
  activePhase: ActivePhase
  tokenRate: number | null
  contextUsage: ContextUsage | null
  error: string | null
  queuedAhead: number
  permissionDecisions: ReadonlyMap<string, 'allow' | 'deny'>
  planStatus: ReadonlyMap<string, PlanStatus>
  activeSubagents: ActiveSubagent[]
  lastMessageUuid: string | null
}

export function createInitialSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    replayReady: false,
    items: [],
    messages: [],
    eventLog: [],
    liveTurn: null,
    contextUsage: null,
    error: null,
    queuedAhead: 0,
    lastMessageUuid: null,
    permissionPending: new Map(),
    permissionDecisions: new Map(),
    pidToToolUseId: new Map(),
    planStatus: new Map(),
    activeSubagents: new Map(),
  }
}

