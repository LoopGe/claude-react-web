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
  /** Wall-clock ms when the message was first observed (server-stamped via
   *  SdkMessage.receivedAt, or Date.now() for optimistic local sends).
   *  Undefined for history restored from disk after a server restart — the
   *  header timestamp is hidden in that case. */
  receivedAt?: number
  /** True for optimistic placeholders that haven't been replaced by the
   *  server-side broadcast yet — drives the "sending" spinner on the user
   *  bubble. Cleared automatically when the broadcast lands and the
   *  reducer swaps in the real TranscriptItem (which has no `sending`). */
  sending?: boolean
  /** Delivery state of a top-level user turn relative to the SDK input
   *  queue. Undefined for non-user messages, optimistic placeholders, and
   *  disk-restored history (no server timestamps to reason about).
   *   - 'queued'   — server accepted it (receivedAt set) but the SDK hasn't
   *                  read it off the queue yet (no consumedAt). It's waiting
   *                  behind an in-flight turn.
   *   - 'consumed' — the SDK has read it (consumedAt set); the turn is being
   *                  processed.
   *  Derived purely from the message's receivedAt/consumedAt in
   *  toTranscriptItem so it stays correct across replay without extra state. */
  deliveryStatus?: 'queued' | 'consumed'
}

export type SubagentStatus = 'running' | 'background' | 'pending' | 'dismissed' | 'done' | 'rejected' | 'interrupted'

export interface ActiveSubagent {
  toolUseId: string
  label: string
  startedAt?: number
  /** Set when the matching tool_result lands. Undefined while running. */
  endedAt?: number
  /** Lifecycle status. Drives chip color and overlay header.
   *
   *  `background` is exclusive to async/background subagents: their Agent
   *  tool_result is a launch ack (not completion), so instead of flipping to
   *  `done` they enter `background` and stay there — still shown in the
   *  WorkingBubble chip row — until the real completion signal (a
   *  `<task-notification>` user injection or a `system`/`task_notification`
   *  frame carrying this record's tool_use_id) flips them to `done`.
   *
   *  `pending` is the post-turn-end form of `background`: the parent turn's
   *  `result` frame swept a still-`background` record to `pending` (NOT
   *  `interrupted`) because the async subagent is still running and its
   *  completion signal is expected to arrive later — possibly well after the
   *  parent turn ended. `pending` is INCLUDED in `getRunningSubagents` so the
   *  WorkingBubble stays mounted in its `Waiting` state (the chip is
   *  dismissible); the completion branch STILL accepts it (unlike
   *  `interrupted`/`dismissed`) so a late task_notification can flip it to
   *  `done`.
   *
   *  `dismissed` is set ONLY by an explicit user action (the Waiting bubble's
   *  dismiss button on a `pending` chip). It is distinct from `interrupted`
   *  (which means the subagent was aborted/errored) so the inline
   *  SubagentCard can render a neutral "tracking dismissed" state instead of
   *  a false error. The completion branch excludes `dismissed` (the user gave
   *  up tracking), and `getRunningSubagents` excludes it (the chip is gone). */
  status: SubagentStatus
  /** Pre-computed count of tool_use blocks within this subagent's messages.
   *  Incremented during updateIndexes so SubagentCard doesn't need to scan
   *  the full message list on every render. */
  toolCount: number
  /** The full `prompt` passed to the subagent (Agent/Task/Explore tool_use
   *  input.prompt). The SDK doesn't echo an async subagent's input prompt
   *  back as a child frame on the main stream, so SubagentOverlay — which
   *  filters by parent_tool_use_id — would otherwise have no trace of what
   *  was asked. The overlay injects this as a synthetic leading "subagent"
   *  bubble at the top of the inner conversation (skipped for sync, where
   *  the SDK already echoes the prompt as a child user frame). */
  prompt?: string
  /** Whether this subagent runs async/background (true) or synchronous
   *  (false). Seeded from the tool_use input's `run_in_background` flag
   *  when present, and confirmed/overridden by frame timing: if a child
   *  frame arrives AFTER the Agent tool_result, the result was an async
   *  launch ack (not the subagent's completion), so this flips to true.
   *  Undefined only when neither signal has fired yet (just spawned, no
   *  ack and no children). SubagentCard surfaces it as an async/sync chip. */
  isAsync?: boolean
  /** Captured tool_result payload of the subagent call itself (the Agent/
   *  Task/Explore result that lands on the MAIN thread). Set when the
   *  matching tool_result arrives. Lets SubagentCard render the subagent's
   *  returned output inline at the bottom of the card — same merge pattern
   *  as generic ToolCard, so the standalone orphan bubble is suppressed. */
  result?: ToolResultEntry
}

/** Lifecycle status for a Workflow orchestration. Mirrors SubagentStatus —
 *  'running' while its child agents are still spawning, 'done' when its
 *  tool_result lands without error, 'interrupted' on an errored result
 *  (a failed/aborted workflow shouldn't get a green check). 'rejected' is
 *  kept for type-parallelism but unused today (Workflows don't go through
 *  the plan-approval gate). */
export type WorkflowStatus = SubagentStatus

/** A declared phase from a Workflow script (`meta.phases[]`). `title` is the
 *  label shown in the tree; `detail` is the optional supplementary text the
 *  script author attached. Order is preserved from the script so the tree
 *  matches the author's intent. */
export interface WorkflowPhaseMeta {
  title: string
  detail?: string
}

/** A child agent spawned by a Workflow. Mirrors a sliver of ActiveSubagent
 *  (label / status / toolCount) so the phase tree can render each branch the
 *  same way SubagentCard renders a top-level subagent, plus the `phase`
 *  grouping tag (read from the child tool_use's `input.phase` or
 *  `input.opts.phase`) and `toolName` so a chip can distinguish Agent /
 *  Task / Explore / Verify etc. */
export interface WorkflowChildAgent {
  toolUseId: string
  label: string
  toolName: string
  /** Phase this child belongs to. null when the child's agent() call did not
   *  pass an explicit phase — grouped under the synthetic "(ungrouped)"
   *  bucket in the tree. */
  phase: string | null
  status: WorkflowStatus
  startedAt?: number
  endedAt?: number
  toolCount: number
  result?: ToolResultEntry
}

/** Index record for an active Workflow tool call — the Workflow analogue of
 *  ActiveSubagent. Keyed by the Workflow's tool_use_id (which is also the
 *  parent_tool_use_id of every child agent frame it spawns, so the overlay
 *  can filter its inner conversation with the SAME parentToolUseIdFilter
 *  mechanism SubagentOverlay uses).
 *
 *  The phase tree is derived two ways:
 *   - `phases`      : the DECLARED phases from input.meta.phases (title +
 *                     detail only — known up front, before any child runs).
 *                     Drives the tree skeleton.
 *   - `childAgents` : the child Agent/Task/Explore tool_use frames the
 *                     Workflow spawned, each tagged with the phase it was
 *                     assigned. Grouped under their phase to show live
 *                     progress per branch.
 *
 *  Like ActiveSubagent the record is KEPT after completion (so the overlay is
 *  reopenable from the card) and carries `result` so WorkflowCard can merge
 *  the synthesized tool_result inline. */
export interface WorkflowRecord {
  toolUseId: string
  /** Human label — parsed from the script's `meta.name`, falling back to the
   *  input `name` (named workflow), `description`/`prompt` snippet, the
   *  `scriptPath` basename, then 'Workflow'. Shown in the card title and
   *  overlay header. May be rescued from 'Workflow' to the authoritative
   *  `WorkflowOutput.workflowName` once the result lands. */
  label: string
  startedAt?: number
  endedAt?: number
  status: WorkflowStatus
  /** Declared phases parsed from the `meta` literal in `input.script`, in
   *  declaration order. May be empty if the script didn't declare any (or the
   *  literal failed to parse) — the tree then collapses to a flat child list
   *  under a synthetic "(ungrouped)" bucket. The SDK `WorkflowInput` has no
   *  `meta` field; meta lives inside the script string. */
  phases: WorkflowPhaseMeta[]
  /** Child agents spawned by this Workflow, in arrival order. Updated
   *  incrementally as child tool_use frames stream in. */
  childAgents: WorkflowChildAgent[]
  /** The Workflow's own tool_result payload (the synthesized output that
   *  lands on the MAIN thread). Set when the matching tool_result arrives, so
   *  WorkflowCard renders it inline and the orphan bubble is suppressed. */
  result?: ToolResultEntry
  /** Authoritative task type from `WorkflowOutput` (parsed at completion).
   *  `'remote_agent'` means the work dispatched to a CCR cloud session; the
   *  card then offers a `sessionUrl`. Absent until the result lands. */
  taskType?: 'local_workflow' | 'remote_agent'
  /** Cloud session URL when the workflow dispatched to CCR
   *  (`WorkflowOutput.status === 'remote_launched'`). Rendered as an
   *  "Open remote session" link on the card. */
  sessionUrl?: string
  /** Local workflow run id — the `resumeFromRunId` handle for resuming a
   *  prior Workflow invocation. Captured from `WorkflowOutput.runId`. */
  runId?: string
  /** Persisted workflow script path (from `WorkflowOutput.scriptPath`).
   *  Editable via Write/Edit; pass back as `scriptPath` to re-run without
   *  resending the script. UI affordance is a follow-up. */
  scriptPath?: string
  /** True when this workflow runs in a remote CCR session
   *  (`remote_launched` / `taskType === 'remote_agent'`) — no local sidechain
   *  children arrive; the card surfaces the cloud session link instead. */
  remote?: boolean
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

/** Captured tool_result payload, keyed by tool_use_id.
 *
 *  Lets the originating tool_use card render its result inline at the
 *  bottom of the same card (instead of as a separate "tool result"
 *  bubble further down the transcript). `content` is the raw
 *  tool_result block content (string or block array) so the shared
 *  preview/truncation logic in ToolResultDetails can format it the same
 *  way the standalone bubble used to. `isError` mirrors the SDK's
 *  is_error flag (also reflected in ToolStatus, but kept here so the
 *  result renderer doesn't need a second lookup). */
export interface ToolResultEntry {
  content: unknown
  isError: boolean
}

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
  /** Output token rate in tok/s. This is a CUMULATIVE AVERAGE over the
   *  writing phase (outputTokens / writing-elapsed), not an instantaneous
   *  rate, so it converges toward the mean as the turn grows longer. Null
   *  until the first real message_delta (or the char-flow fallback) lands. */
  tokenRate: number | null
  startedAt: number
  lastDeltaAt: number
  dirty: boolean
  /** Total characters received in content_block_delta events.
   *  Used to estimate token rate from character flow when message_delta
   *  events arrive too infrequently (e.g., only at turn end). Converted to
   *  tokens at 4 chars/token — see reducer for rationale. */
  totalChars: number
  /** Timestamp of last tokenRate update from character-based estimation.
   *  Throttled to avoid jitter (minimum 500ms between updates). */
  lastRateUpdate: number
  /** Timestamp when the first text content_block_start arrived.
   *  Excludes thinking phase time from rate calculation. */
  writingStartedAt: number | null
}

/** Server-authored fields. Everything here is derived purely from WS frames
 *  (replay, message, permission-*, context-usage, message-consumed, error).
 *  The client never originates writes into this layer; the reducer routes
 *  server frames into it.
 *
 *  Architectural invariant: any reducer path that handles a SERVER payload
 *  (REPLAY_REPLACE, MESSAGE, PERMISSION_*, CONTEXT_USAGE, MESSAGE_CONSUMED,
 *  ERROR) may only mutate `state.mirror`. Such paths must NEVER reconstruct
 *  `state.intent` — that's client-only territory and is preserved verbatim
 *  across every server-driven action. The split is enforced by the field
 *  partitioning here: there is no way to express "wipe pendingPlaceholders"
 *  from a `Partial<ServerMirror>`.
 *
 *  The bug this guards against: pre-refactor, REPLAY_REPLACE could fall into
 *  a `createInitialSessionState`-and-rebuild branch that incidentally zeroed
 *  `pendingUserMessageIds` (which lived alongside mirror data in a flat
 *  state). That broke the optimistic-merge for the very next user message,
 *  manifesting as the "first message stuck" symptom under StrictMode's
 *  double-mount. */
export interface ServerMirror {
  replayReady: boolean
  items: TranscriptItem[]
  messages: SdkMessage[]
  eventCount: number
  liveTurn: LiveTurnState | null
  contextUsage: ContextUsage | null
  lastMessageUuid: string | null
  /** Transient `api_retry` system frame (rate-limit retry indicator). Lives
   *  OUTSIDE items/messages/IDB — it is purely transient (only meaningful
   *  while a retry is in flight, cleared by the next non-retry message), so
   *  routing it to a dedicated slot keeps the transcript append-only (no
   *  in-place replace, no IDB supersession tracking). Null when no retry is
   *  in progress. */
  apiRetry: SdkMessage | null
  /** message-consumed frames that arrived before the matching message row.
   *  The WS channels are independent, so an idle session can deliver the
   *  consumed signal before the user-message broadcast. Cache it here and
   *  apply it when the row appears instead of leaving the bubble queued. */
  pendingConsumedMessages: ReadonlyMap<string, number>
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
  /** Captured tool_result payloads keyed by tool_use_id. Populated only
   *  for ids already present in `toolStatus` (i.e. generic tool cards —
   *  Plan/Question/Subagent are excluded because they own their result
   *  rendering). Drives the inline result section on each ToolCard. */
  toolResults: Map<string, ToolResultEntry>
  activeSubagents: Map<string, ActiveSubagent>
  /** Workflow tool_use index, keyed by the Workflow's tool_use_id. The
   *  Workflow analogue of `activeSubagents`: records are kept after
   *  completion (so WorkflowCard + WorkflowOverlay stay reopenable) and
   *  each carries its declared phases + spawned child agents so the
   *  two-column overlay never re-scans the transcript. Like
   *  `activeSubagents`, the Map reference is identity-compared in the store
   *  so snapshots only reallocate when a Workflow record actually changes. */
  activeWorkflows: Map<string, WorkflowRecord>
}

/** Client-only intent. The server has no opinion about this layer; only
 *  user actions originate writes here (with one carve-out: ERROR frames
 *  from the server set `intent.error`, but the lifecycle — cleared by the
 *  user via clearError() — is client-owned, so it conceptually belongs
 *  here too).
 *
 *  Critically: any server frame handler that rebuilds `state.mirror` MUST
 *  preserve `state.intent` verbatim. That's the whole point of the split. */
export interface ClientIntent {
  /** Optimistic user-message placeholders awaiting their server echo.
   *  Keyed by placeholder id (the temp uuid stamped by insertUserMessage),
   *  value is the full TranscriptItem so snapshot-time render-merge has
   *  everything it needs without consulting mirror.items.
   *
   *  Placeholders live HERE, not in mirror.items, so REPLAY_REPLACE
   *  (which rebuilds mirror.items from the server payload) cannot wipe
   *  them. The render path (SessionStore.buildSnapshot) merges them at
   *  the tail of mirror.items, so components see the same flat list
   *  they did pre-refactor. On echo, applyMessage removes the matching
   *  placeholder from intent and appends the real message to mirror.items.
   *
   *  A Map (not a Set) so insertion order is preserved — echoes arrive in
   *  send order, so the oldest pending placeholder matches the next echo. */
  pendingPlaceholders: ReadonlyMap<string, TranscriptItem>
  /** Last error string to surface in the chat header. Written by the
   *  ERROR action (driven by WS error frames) and cleared by the client
   *  via clearError(). The clear path makes this client-owned. */
  error: string | null
}

export interface SessionState {
  sessionId: string
  mirror: ServerMirror
  intent: ClientIntent
}

export type SessionAction =
  | { type: 'REPLAY_REPLACE'; messages: SdkMessage[]; permissions: PermissionRequest[] }
  /** Prepend older messages fetched from disk (lazy-load on scroll-up).
   *  Messages are in chronological order (oldest first) and are unshifted
   *  ahead of the current transcript. Deduped by uuid against what's
   *  already present. */
  | { type: 'PREPEND_MESSAGES'; messages: SdkMessage[] }
  | { type: 'MESSAGE'; message: SdkMessage }
  | { type: 'OPTIMISTIC_USER_MESSAGE'; message: SdkMessage }
  /** The REST send endpoint accepted an optimistic user message and returned
   *  the server-side uuid. Clears the local sending spinner immediately while
   *  keeping the id in pendingUserMessageIds until the WS echo/replay/result
   *  reconciles the turn. */
  | { type: 'ACK_USER_MESSAGE'; pendingId: string; serverUuid: string; receivedAt?: number }
  /** Roll back the most recent optimistic user message (POST failed
   *  before the server could broadcast it). Identified by pendingId
   *  so concurrent unrelated dispatches don't drop the wrong row. */
  | { type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE'; pendingId: string }
  | { type: 'PERMISSION_REQUEST'; request: PermissionRequest }
  | {
      type: 'PERMISSION_RESOLVED'
      id: string
      decision: { behavior: 'allow' | 'deny'; persisted: boolean; message?: string; questionResolution?: 'clarified' }
    }
  | { type: 'CONTEXT_USAGE'; usage: ContextUsage }
  /** The SDK read a queued user turn off its input queue. Flips the
   *  matching message's deliveryStatus from 'queued' to 'consumed'. */
  | { type: 'MESSAGE_CONSUMED'; uuid: string; consumedAt: number }
  | { type: 'ERROR'; message: string | null }
  | { type: 'LIVE_TURN_FLUSH' }
  /** User dismissed an in-flight subagent (running/background/pending) from
   *  the SubagentOverlay's × button. Flips it to `dismissed` so it leaves
   *  the chip set (the bubble clears) and the inline SubagentCard shows a
   *  neutral settled state. For sync (running) the tool_result merge later
   *  overwrites to done/interrupted; for async (background/pending) the
   *  completion branch excludes `dismissed`, so a late task_notification is
   *  ignored — the user explicitly gave up on tracking it. */
  | { type: 'DISMISS_SUBAGENT'; toolUseId: string }
  /** Wipe BOTH layers (mirror + intent) and leave `replayReady=true`. Used
   *  by the /clear flow (and by store.reset()): the post-wipe state is
   *  "live and empty" with no pending replay, so the MessageList shows the
   *  empty-state, not the skeleton. This is the ONLY wipe semantic — the
   *  WS subscription persists across the wipe, the server doesn't re-replay,
   *  and the new Query's `system/init` isn't broadcast to clients, so nothing
   *  else flips replayReady back to true. The initial pre-subscribe state
   *  (replayReady=false) is set by createInitialServerMirror at construction,
   *  not by an action. */
  | { type: 'CLEAR_TRANSCRIPT' }

export interface SessionSnapshot {
  replayReady: boolean
  items: TranscriptItem[]
  messages: SdkMessage[]
  streamingContent: string | null
  activePhase: ActivePhase
  tokenRate: number | null
  contextUsage: ContextUsage | null
  error: string | null
  permissionDecisions: ReadonlyMap<string, 'allow' | 'deny'>
  planStatus: ReadonlyMap<string, PlanStatus>
  planContent: ReadonlyMap<string, string>
  /** Parsed AskUserQuestion answers keyed by tool_use_id.  Empty array
   *  for pending (no answers submitted yet); non-empty for answered. */
  questionAnswers: ReadonlyMap<string, QuestionAnswerEntry[]>
  /** Generic tool lifecycle by tool_use_id (running/success/error). */
  toolStatus: ReadonlyMap<string, ToolStatus>
  /** Captured tool_result payloads by tool_use_id — drives the inline
   *  result section rendered at the bottom of each generic ToolCard. */
  toolResults: ReadonlyMap<string, ToolResultEntry>
  /** Currently-running subagents only — drives the WorkingBubble chip row. */
  activeSubagents: ActiveSubagent[]
  /** Full index (running + completed) keyed by toolUseId. Used by the
   *  SubagentCard placeholder and the SubagentOverlay so completed
   *  subagents are still inspectable after their tool_result lands. */
  subagentIndex: ReadonlyMap<string, ActiveSubagent>
  /** Currently-running Workflows only — drives the WorkflowCard status +
   *  any live chip. Mirrors activeSubagents (running-only filter of the
   *  full workflowIndex). */
  activeWorkflows: WorkflowRecord[]
  /** Full Workflow index (running + completed) keyed by the Workflow's
   *  tool_use_id. Used by WorkflowCard and WorkflowOverlay so a completed
   *  Workflow stays inspectable after its tool_result lands. Mirrors
   *  subagentIndex. */
  workflowIndex: ReadonlyMap<string, WorkflowRecord>
  lastMessageUuid: string | null
  /** Transient `api_retry` frame mirrored from ServerMirror (see there). */
  apiRetry: SdkMessage | null
}

/** Build a fresh ServerMirror. Used by createInitialSessionState and by any
 *  reducer path that needs to rebuild the mirror from scratch (e.g.
 *  REPLAY_REPLACE over an empty cache). NEVER touches `intent`. */
export function createInitialServerMirror(): ServerMirror {
  return {
    replayReady: false,
    items: [],
    messages: [],
    eventCount: 0,
    liveTurn: null,
    contextUsage: null,
    lastMessageUuid: null,
    apiRetry: null,
    pendingConsumedMessages: new Map<string, number>(),
    permissionPending: new Map(),
    permissionDecisions: new Map(),
    pidToToolUseId: new Map(),
    planStatus: new Map(),
    planContent: new Map(),
    questionAnswers: new Map(),
    toolStatus: new Map(),
    toolResults: new Map(),
    activeSubagents: new Map(),
    activeWorkflows: new Map(),
  }
}

/** Build a fresh ClientIntent. Used by createInitialSessionState and by
 *  CLEAR_TRANSCRIPT (which intentionally wipes both layers). NEVER called
 *  from any server-frame handler. */
export function createInitialClientIntent(): ClientIntent {
  return {
    pendingPlaceholders: new Map<string, TranscriptItem>(),
    error: null,
  }
}

export function createInitialSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    mirror: createInitialServerMirror(),
    intent: createInitialClientIntent(),
  }
}

/** Helper for the architectural invariant: produce a new SessionState whose
 *  ONLY change is a new ServerMirror. Use this in every server-frame handler
 *  in the reducer so the intent layer's preservation is visible at every
 *  call site. */
export function withMirror(state: SessionState, mirror: ServerMirror): SessionState {
  if (mirror === state.mirror) return state
  return { sessionId: state.sessionId, mirror, intent: state.intent }
}

/** Helper symmetrical to withMirror, for actions that only change the client
 *  intent layer (OPTIMISTIC_USER_MESSAGE, ROLLBACK, clearError). */
export function withIntent(state: SessionState, intent: ClientIntent): SessionState {
  if (intent === state.intent) return state
  return { sessionId: state.sessionId, mirror: state.mirror, intent }
}
