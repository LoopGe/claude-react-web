import type { PermissionRequest, SdkMessage } from '../types'
import type { ContextUsage } from '../hooks/useChatStream'
import type { QuestionAnswerEntry } from '../utils/question-answers'

export interface TranscriptItem {
  id: string
  msg: SdkMessage
  /** Canonical plain-text view of the message — markdown syntax
   *  stripped, block boundaries collapsed to single newlines.  This
   *  is the SSOT for in-session search: both the match counter
   *  (Chat.tsx) and the highlight renderer (rehype-highlight.ts in
   *  src/search/) agree because they derive their views from this
   *  same canonicalisation pipeline.  Null when the message has no
   *  text content (e.g. tool-result-only frames). */
  plainText: string | null
  isCompactSummary: boolean
  hiddenByDefault: boolean
  /** True for optimistic placeholders that haven't been replaced by the
   *  server-side broadcast yet — drives the "sending" spinner on the user
   *  bubble. Cleared automatically when the broadcast lands and the
   *  reducer swaps in the real TranscriptItem (which has no `sending`). */
  sending?: boolean
}

export type SubagentStatus = 'running' | 'done' | 'rejected' | 'interrupted'

export interface ActiveSubagent {
  toolUseId: string
  label: string
  startedAt?: number
  /** Set when the matching tool_result lands. Undefined while running. */
  endedAt?: number
  /** Lifecycle status. Drives chip color and overlay header. */
  status: SubagentStatus
  /** Pre-computed count of tool_use blocks within this subagent's messages.
   *  Incremented during updateIndexes so SubagentCard doesn't need to scan
   *  the full message list on every render. */
  toolCount: number
}

export type PlanStatus = 'pending' | 'approved' | 'rejected'

/** Tool execution lifecycle.
 *
 *  - 'running'  — assistant emitted a tool_use block, no matching tool_result yet
 *  - 'success'  — matching tool_result arrived without an is_error flag
 *  - 'error'    — matching tool_result arrived with is_error: true (the SDK
 *                 sets this when canUseTool denies, when the tool throws,
 *                 or when the tool reports failure)
 *
 *  Used by ToolUseBlock to render a status badge in the upper-right of
 *  every tool card. PlanCard / QuestionCard / SubagentCard maintain their
 *  own (more specific) status maps because their lifecycle differs — a
 *  Plan's "approved/rejected" doesn't map cleanly to "success/error" of a
 *  generic tool, and AskUserQuestion doesn't have a meaningful "error". */
export type ToolStatus = 'running' | 'success' | 'error'

export type ActivePhase =
  | 'thinking'
  | 'writing'
  | { type: 'tool_use'; name: string }
  | null

export interface LiveTurnState {
  turnId: string
  phase: ActivePhase
  textChunks: string[]
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
  eventCount: number
  liveTurn: LiveTurnState | null
  contextUsage: ContextUsage | null
  error: string | null
  queuedAhead: number
  lastMessageUuid: string | null
  /** IDs of optimistic user messages pending server confirmation.
   *  A Set (not a single pointer) so rapid sequential sends each get
   *  their own placeholder that is replaced independently when the
   *  server echo arrives. */
  pendingUserMessageIds: ReadonlySet<string>
  permissionPending: Map<string, PermissionRequest>
  permissionDecisions: Map<string, 'allow' | 'deny'>
  pidToToolUseId: Map<string, string>
  planStatus: Map<string, PlanStatus>
  /** Plan body text extracted from ExitPlanMode tool_result output.
   *  Keyed by tool_use_id.  The CLI injects plan content from disk into
   *  the tool_result (not the tool_use input), so we capture it here
   *  for the PermissionDialog and inline PlanCard to display. */
  planContent: Map<string, string>
  /** Parsed answers from AskUserQuestion tool_results, keyed by
   *  tool_use_id.  An empty array means the tool_use was seen but the
   *  answers JSON hasn't landed yet (or couldn't be parsed) — the
   *  inline QuestionCard renders that as "pending".  A non-empty array
   *  means the user submitted answers.  See utils/question-answers.ts. */
  questionAnswers: Map<string, QuestionAnswerEntry[]>
  /** Generic tool lifecycle keyed by tool_use_id. Drives the status badge
   *  on every ToolUseBlock card. PlanCard / QuestionCard / SubagentCard
   *  use their own (more semantic) maps because their lifecycle differs —
   *  but for Bash / Read / Grep / Edit / Write / etc. this map is the
   *  single source of truth. */
  toolStatus: Map<string, ToolStatus>
  activeSubagents: Map<string, ActiveSubagent>
}

export type SessionAction =
  | { type: 'REPLAY_REPLACE'; messages: SdkMessage[]; permissions: PermissionRequest[] }
  | { type: 'MESSAGE'; message: SdkMessage }
  | { type: 'OPTIMISTIC_USER_MESSAGE'; message: SdkMessage }
  /** Roll back the most recent optimistic user message (POST failed
   *  before the server could broadcast it). Identified by pendingId
   *  so concurrent unrelated dispatches don't drop the wrong row. */
  | { type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE'; pendingId: string }
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
  planContent: ReadonlyMap<string, string>
  /** Parsed AskUserQuestion answers keyed by tool_use_id.  Empty array
   *  for pending (no answers submitted yet); non-empty for answered. */
  questionAnswers: ReadonlyMap<string, QuestionAnswerEntry[]>
  /** Generic tool lifecycle by tool_use_id (running/success/error). */
  toolStatus: ReadonlyMap<string, ToolStatus>
  /** Currently-running subagents only — drives the WorkingBubble chip row. */
  activeSubagents: ActiveSubagent[]
  /** Full index (running + completed) keyed by toolUseId. Used by the
   *  SubagentCard placeholder and the SubagentOverlay so completed
   *  subagents are still inspectable after their tool_result lands. */
  subagentIndex: ReadonlyMap<string, ActiveSubagent>
  lastMessageUuid: string | null
}

export function createInitialSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    replayReady: false,
    items: [],
    messages: [],
    eventCount: 0,
    liveTurn: null,
    contextUsage: null,
    error: null,
    queuedAhead: 0,
    lastMessageUuid: null,
    pendingUserMessageIds: new Set<string>(),
    permissionPending: new Map(),
    permissionDecisions: new Map(),
    pidToToolUseId: new Map(),
    planStatus: new Map(),
    planContent: new Map(),
    questionAnswers: new Map(),
    toolStatus: new Map(),
    activeSubagents: new Map(),
  }
}

