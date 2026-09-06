// Type definitions extracted from session-manager.ts for modularity.
// This file contains all public/internal interfaces and types.

import type {
  CanUseTool,
  EffortLevel,
  ElicitationResult,
  FastModeState,
  OnElicitation,
  OnUserDialog,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk'
import type { Pushable } from './pushable.js'
import type { SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'
import type { MpStore } from './mp-store.js'
import type { AgentDefinitionStore } from './agent-definition-store.js'
import type { SessionInfoBase, SessionMemorySettings, ThinkingSetting } from '../shared/session-info.js'
import type { SandboxSetting } from '../shared/sandbox.js'
import type { ProviderRegistry } from './providers/registry.js'
import type { ProviderSessionHandle } from './providers/types.js'
import type { HookRunRecord, HookRuntimeEvent, SessionHooksConfig } from '../shared/hooks.js'
import type { SessionSkillOverride } from '../shared/skills.js'
import type { SessionToolProfile } from '../shared/tool-profile.js'
import type { PromptUuidEntry } from './prompt-uuid-store.js'
import type { ElicitationDecision, ElicitationRequestUi } from '../shared/elicitation.js'
import type { CliNotification, WsMessageConsumed, WsMessagesWithdrawn } from '../shared/ws-protocol.js'
import type { UserDialogDecision, UserDialogRequestUi } from '../shared/user-dialog.js'

/** Subscriber — each connected client gets one of these. */
export interface Subscriber {
  id: string
  push: (msg: SDKMessage) => void
  end: () => void
  closed: boolean
}

/** Permission-channel subscriber — separate from the SDK message channel so
 *  we don't have to widen the Subscriber type into a union. */
export type PermissionEvent =
  | { kind: 'request'; payload: PermissionRequestSnapshot }
  | { kind: 'resolved'; pid: string; decision: PermissionDecisionSummary }
export interface PermissionSubscriber {
  id: string
  push: (ev: PermissionEvent) => void
  end: () => void
}

/** Elicitation-channel subscriber — mirrors PermissionSubscriber but for
 *  MCP elicitation (auth) events, on its own subscriber set so the two
 *  fan-outs never mix. */
export type ElicitationEvent =
  | { kind: 'request'; payload: ElicitationRequestUi }
  | { kind: 'resolved'; eid: string; decision: ElicitationDecision }
export interface ElicitationSubscriber {
  id: string
  push: (ev: ElicitationEvent) => void
  end: () => void
}

/** User-dialog-channel subscriber — mirrors ElicitationSubscriber but for
 *  blocking CLI dialogs (e.g. the refusal-fallback prompt), on its own
 *  subscriber set. */
export type DialogEvent =
  | { kind: 'request'; payload: UserDialogRequestUi }
  | { kind: 'resolved'; did: string; decision: UserDialogDecision; retractedMessageUuids?: string[] }
export interface DialogSubscriber {
  id: string
  push: (ev: DialogEvent) => void
  end: () => void
}

// Re-export canonical MCP elicitation shapes from shared.
export type { ElicitationRequestUi, ElicitationDecision }
// Re-export canonical user-dialog shapes from shared.
export type { UserDialogRequestUi, UserDialogDecision }

// Re-export canonical QuestionSpec from shared.
export type { QuestionSpec } from '../shared/question-spec.js'

// Re-export canonical PermissionRequestSnapshot from shared.
// Server instantiates with the SDK's PermissionUpdate[] for suggestions.
import type { PermissionRequestBase } from '../shared/permission-request.js'
export type PermissionRequestSnapshot = PermissionRequestBase<PermissionUpdate[]>

/** Summary of how a pending request was resolved (broadcast to all tabs).
 *  Extends the canonical `PermissionDecision` from shared/ws-protocol.ts
 *  so server and client use a structurally identical type. */
import type { PermissionDecision } from '../shared/ws-protocol.js'
export type PermissionDecisionSummary = PermissionDecision

/** Answer submitted for a pending AskUserQuestion. Indices align with
 *  the `questions` array. Each entry is either a single option label
 *  (single-select) or an array of labels (multi-select), or null when
 *  the user skipped (we forward a "user skipped" note to the model). */
export type QuestionAnswer = string | string[] | null

/** Internal server-side state per pending request. Carries the SDK
 *  resolver + signal alongside the JSON-serializable snapshot so the
 *  single `pending` map can hold both flavours. */
export type PendingPermission = PermissionRequestSnapshot & {
  resolve: (r: PermissionResult) => void
  signal: AbortSignal
  abortHandler: () => void
}

/** Internal server-side state per pending MCP elicitation. Carries the SDK
 *  resolver + signal alongside the JSON-serializable snapshot, mirroring
 *  PendingPermission. Resolving with an ElicitationResult IS the answer to
 *  the SDK's `await onElicitation(...)` — no id-based correlation needed. */
export type PendingElicitation = ElicitationRequestUi & {
  resolve: (r: ElicitationResult) => void
  signal: AbortSignal
  abortHandler: () => void
}

/** Internal server-side state per pending user dialog. Carries the SDK
 *  resolver + signal alongside the JSON-serializable snapshot, mirroring
 *  PendingElicitation. Resolving with a UserDialogResult IS the answer to
 *  the SDK's `await onUserDialog(...)` — no id-based correlation needed. */
export type PendingUserDialog = UserDialogRequestUi & {
  resolve: (r: UserDialogResult) => void
  signal: AbortSignal
  abortHandler: () => void
}

/** Metadata returned by list() / get(). Field shape lives in
 *  shared/session-info.ts so client and server cannot drift. */
export type SessionInfo = SessionInfoBase<PermissionMode>

/** A session discoverable on disk via the SDK's `listSessions()`, surfaced
 *  to the frontend's /resume picker. Spans BOTH sessions this app created
 *  (`known: true`) and sessions created by the `claude` CLI directly in the
 *  same project dirs (`known: false`) — the latter are the whole point of
 *  the picker (they're invisible in the sidebar). `running` / `terminated`
 *  are annotated from this app's live + persisted state so the picker can
 *  dim/disable rows that can't be resumed. */
export interface ResumableSession {
  provider?: string
  sessionId: string
  /** Best display title: customTitle — summary — firstPrompt. */
  title?: string
  /** First meaningful user prompt — shown as a preview/secondary line. */
  firstPrompt?: string
  cwd?: string
  /** The CLI's permission mode (default/acceptEdits/bypassPermissions/plan),
   *  from the SDK's getSessionInfo `mode` field. Only set for CLI-created
   *  sessions adopted from disk; sessions this app created read it from
   *  sessions.json instead. */
  permissionMode?: string
  /** Creation time (epoch ms), from the transcript's first entry. */
  createdAt?: number
  /** Last-modified time (epoch ms) of the on-disk transcript. */
  lastModified: number
  gitBranch?: string
  /** True when this app already tracks the session (live or persisted). */
  known: boolean
  /** True when the session currently has a live Query in memory. */
  running: boolean
  /** True when this app has marked the session terminated (cannot resume). */
  terminated: boolean
  /** True when terminated but only with a transient reason (crash / query
   *  error) — the server would still allow a manual resume. Mirrors
   *  SessionInfo.canRetryResume so the /resume picker can offer retry on
   *  transiently-terminated sessions instead of greying them out. */
  canRetryResume?: boolean
}

/** Re-export the canonical shapes from shared so server-side modules
 *  that import them (recap manager, session manager) can pull them
 *  through `session-types.ts` like everything else. */
export type { SessionPhase, SessionRecap, SessionRecapStats } from '../shared/session-info.js'

/** Coarse per-session activity snapshot returned by `SessionManager.listActivity()`
 *  and surfaced to plugins via the `sessions.list` Host API. Single source of
 *  truth lives in the shared wire protocol so server and plugin contract can't
 *  drift. */
export type { SessionActivity } from '../shared/app-plugins/rpc-protocol.js'

export interface Session {
  id: string
  provider: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  /** Start-as custom agent name (SDK Options.agent). Stored on the live
   *  session; persisted via SessionMeta so resume/restart/fork keep the
   *  persona (dropped with a warning if its def is later deleted/disabled). */
  agent?: string
  /** Active model group id (set at create time; the group's resolved main
   *  model becomes `model`). Stored on the live session; persisted via
   *  SessionMeta so resume/restart/fork keep the group identity. */
  modelGroupId?: string
  /** Provider profile id this session is pinned to. Undefined = follow the
   *  active profile. Persisted via SessionMeta; resolved at spawn. */
  profileId?: string
  permissionMode?: PermissionMode
  title?: string
  /** Anthropic beta flags the session was spawned with (e.g.
   *  `context-1m-...`). Stored on the live session so restart / resume
   *  / fork can re-apply them and the context window stays consistent. */
  betas?: string[]
  /** User intent: whether fast mode is requested for this session. Set via
   *  setFastMode (forwarded to the SDK as applyFlagSettings({ fastMode })),
   *  persisted so it survives resume/restart, and re-applied on respawn. */
  fastMode?: boolean
  /** Per-session auto-memory settings (enable / directory / auto-dream).
   *  Set via setMemorySettings (forwarded to the SDK as applyFlagSettings
   *  memory keys), persisted so it survives resume/restart, and re-applied
   *  on respawn. Undefined when no memory key has been pinned. */
  memory?: SessionMemorySettings
  /** Per-session sandbox intent (SDK Settings.sandbox). Set via setSandbox
   *  (forwarded to the SDK as applyFlagSettings({ sandbox })), persisted so it
   *  survives resume/restart, and re-applied on respawn. A present object =
   *  sandbox ON; undefined = off (project/SDK default). */
  sandbox?: SandboxSetting
  /** SDK-reported runtime fast-mode state ('off' | 'cooldown' | 'on'),
   *  parsed from system/init and result messages. Read-only — reflects what
   *  the backend is actually doing (e.g. 'cooldown' after a rate limit).
   *  undefined means the current model doesn't support fast mode (the SDK
   *  omits the field), which the UI uses to hide the toggle. Not persisted —
   *  the SDK re-reports it after respawn. */
  fastModeState?: FastModeState
  /** SDK-reported runtime compaction state — true while the CLI is compacting
   *  the transcript (`system/status` frames with `status: 'compacting'`), so
   *  the WorkingBubble can show "Recap (auto)…" instead of a stale phase.
   *  Mirrors fastModeState: read-only, transient, not persisted; the SDK
   *  re-reports it via a later status frame after respawn. Cleared at turn
   *  end as a lifecycle bound (compaction is a mid-turn phenomenon). */
  compacting?: boolean
  /** User intent: reasoning effort level ('low'|'medium'|'high'|'xhigh'|
   *  'max'). Controls how many tokens the model spends. Persisted, re-applied
   *  on respawn. Undefined means no explicit level (SDK default 'high'). */
  effortLevel?: EffortLevel
  /** Structured hooks config for this session. Persisted and re-applied on resume. */
  hooks?: SessionHooksConfig
  /** Effort levels the CURRENT model supports, fetched from the SDK
   *  (supportedModels) at spawn / model-change. Three-state:
   *   - undefined: capability unknown (not fetched yet, model not matched,
   *     or proxy didn't report it) → UI falls back to offering all 5.
   *   - []        : model explicitly does NOT support effort → UI hides chip.
   *   - [levels]  : the supported subset → UI offers only these.
   *  Not persisted — re-fetched on every spawn (capability tracks the
   *  model + SDK version, not the conversation). */
  effortLevels?: EffortLevel[]
  /** User intent: extended-thinking config (SDK ThinkingConfig shape).
   *  Persisted, re-applied on respawn via Options.thinking. Undefined means
   *  no explicit choice (SDK/model default). */
  thinking?: ThinkingSetting
  /** Whether the CURRENT model supports extended thinking at all — keyword
   *  classified from the model id (effort-capability.ts), NOT from the SDK's
   *  supportedModels report (untrustworthy on gateways). Three-state:
   *   - undefined: capability unknown → UI shows the chip (fail-open).
   *   - false    : model can't think → UI hides the chip.
   *   - true     : supported.
   *  Not persisted — re-derived on every spawn / model switch. */
  thinkingSupported?: boolean
  /** User intent: absolute auto-compact window size in tokens (SDK
   *  Settings.autoCompactWindow). Set via setAutoCompactWindow (forwarded to
   *  the SDK as applyFlagSettings({ autoCompactWindow, autoCompactEnabled })),
   *  persisted so it survives resume/restart, and re-applied on respawn.
   *  Undefined means "auto" — the CLI derives the threshold from the model's
   *  context window. */
  autoCompactWindow?: number
  handle: ProviderSessionHandle
  subscribers: Map<string, Subscriber>
  permissionSubscribers: Map<string, PermissionSubscriber>
  /** Pending tool-use permission requests awaiting a user decision. */
  pending: Map<string, PendingPermission>
  elicitationSubscribers: Map<string, ElicitationSubscriber>
  /** Pending MCP elicitation (auth) requests awaiting a user decision. */
  elicitationPending: Map<string, PendingElicitation>
  dialogSubscribers: Map<string, DialogSubscriber>
  /** Plugin outbound-event subscribers (App Plugin `sessions.subscribe`).
   *  Separate from `subscribers` so plugin consumers can't block or be
   *  evicted by browser-tab logic, and so we can end them at teardown
   *  without touching the WS live set. Each entry is owned by a
   *  SessionSubscriptionRegistry and pushes already-filtered SDKMessages. */
  pluginSubscribers: Map<string, Subscriber>
  /** Pending user dialogs (e.g. refusal fallback) awaiting a user decision. */
  dialogPending: Map<string, PendingUserDialog>
  history: SDKMessage[]
  /** Subagent frames only (parent_tool_use_id != null) — a separate FIFO
   *  budget (config subagentHistoryCap) so subagent volume can never evict
   *  main-thread frames from `history`. Every read surface (replay, getHistory,
   *  fork seeds, compact input) goes through SessionManager.mergedHistory(),
   *  which merges both rings in receivedAt order. Not persisted to disk —
   *  history-reader drops isSidechain lines, so after a server restart the
   *  subagent transcript is gone (same as before the split). */
  subagentHistory: SDKMessage[]
  pumpTask: Promise<void>
  running: boolean
  terminated: boolean
  /** Set to true during the window between a clean process exit (abort)
   *  and cleanupPump deciding whether to auto-resume or terminate.
   *  Prevents the GC's checkStuck() from misidentifying the session as
   *  stuck while it is already being cleaned up. */
  exiting?: boolean
  terminatedReason?: string
  error?: string
  /** Pending turns (user messages sent but no matching `result` yet). A
   *  simple counter rather than a set because we don't need to identify
   *  which specific turn is outstanding — just whether ANY is. */
  pendingTurns: number
  /** Set true while SessionManager.clear() is in flight: from the moment we
   *  begin tearing down the live Query through the fresh respawn of a brand
   *  new Query. Read by the pump's cleanupPump branch (skip auto-resume; do
   *  NOT mark terminated; keep subscribers alive across the gap) and by
   *  autoResume itself (refuse to fire while a clear is driving its own
   *  respawn). Cleared in clear()'s finally block once the new pump is up.
   *  Runtime-only; never persisted. */
  clearing?: boolean
  /** Epoch ms when the first pending turn started. Cleared when all turns
   *  complete (pendingTurns drops to 0) or the session terminates. */
  workingSince?: number
  /** Epoch ms of the last auto-interrupt the GC fired against this session.
   *  Used to throttle: we don't re-fire interrupt on every tick. Cleared
   *  when state actually progresses (lastActivityAt moves) or the turn
   *  completes. */
  autoInterruptedAt?: number
  /** Timestamp of the last `result` message, used for the unread badge. */
  lastTurnAt?: number
  /** CLI crash context recorded by handleProcessExit when a subprocess exits
   *  non-cleanly (non-zero code / signal / killed). Acts as the discriminator
   *  that routes cleanupPump into the crash-recovery ladder instead of the
   *  clean-idle autoResume path or immediate termination. Cleared on a
   *  successful in-place recovery (Step 1) so a subsequent clean idle-exit
   *  falls back to autoResume; the next crash re-sets it. Runtime-only. */
  lastCrash?: {
    code: number | null
    signal: NodeJS.Signals | null
    killed: boolean
    spawnError?: { code?: string; message: string }
  }
  /** True while the crash-recovery ladder is mid-flight (between a crash and
   *  either a successful respawn or give-up). checkStuck() skips recovering
   *  sessions so the 60s GC can't force-unload one mid-ladder. Runtime-only. */
  recovering?: boolean
  /** uuid of the most recent `assistant` message (updated on every assistant
   *  msg). Used to promote `lastSafeResumeUuid` when a turn completes.
   *  Runtime-only. */
  lastAssistantUuid?: string
  /** uuid of the last assistant message belonging to a *successfully
   *  completed* turn (promoted from `lastAssistantUuid` when a `result`
   *  subtype==='success' lands). Was the anchor for crash-recovery Step 2's
   *  auto-fork; that auto-fork is gone, so nothing forks from here anymore —
   *  the manual "Fork from last completed turn" button resolves its anchor
   *  from the turn-anchor sidecar instead. Kept because the pump still
   *  promotes it (cheap) and history-reader mirrors its success-only
   *  semantics. undefined when no turn has completed (the first-turn-crash
   *  floor). Runtime-only. */
  lastSafeResumeUuid?: string
  /** Snapshot of HEAD captured at session spawn. Used by the GitPanel
   *  "This session" view to scope diffs to this conversation. Mirrored
   *  into SessionInfo and persisted via SessionMeta so it survives
   *  resume + server restart. */
  gitStartSha?: string
  /** When present, this session is a Side Chat forked from the
   *  indicated parent session. Set by createSideChat(), persisted via
   *  SessionMeta, and mirrored into SessionInfo. */
  parentId?: string
  /** uuid of the parent's last renderable message at Side-Chat fork time.
   *  The fork copies the parent's transcript verbatim into this session's
   *  on-disk file, then appends the side chat's own turns — so everything
   *  up to AND including this uuid is inherited parent context that the UI
   *  must never display (it's reference-only, per SIDE_DEVELOPER_INSTRUCTIONS).
   *  Used as the `afterUuid` boundary for history reads (getHistoryPage /
   *  resume seed / search) so paging and resume-seeding surface only the
   *  side chat's own messages. Undefined for non-Side-Chat sessions. */
  forkBoundaryUuid?: string
  /** Names of MCP servers the session was spawned with. Derived from
   *  the resolved mcpServers config at create / resume / fork. Persisted
   *  via SessionMeta and mirrored into SessionInfo so the client can
   *  compute "available" reliably without the flaky mcp-status request. */
  mcpServerNames?: string[]
  /** Runtime-only: the last user-configured dynamic MCP servers map passed
   *  to setMcpServers (pre-injection — never contains first-party servers).
   *  Initialized at spawn from the pre-injection mcpServers map. Used by the
   *  immediate first-party toggle to re-run injection without dropping the
   *  user's servers. NOT persisted (re-established by the client on resume). */
  dynamicMcpServers?: Record<string, unknown>
  /** Runtime-only: per-first-party-server build/registration errors from the
   *  last injection, surfaced via toolServerStatus. NOT persisted. */
  firstPartyErrors?: Record<string, string>
  /** Compound keys of the plugin subset this session was spawned with.
   *  `undefined` = all enabled; `[]` = none. Persisted via SessionMeta. */
  enabledPlugins?: string[]
  /** Per-subscriber pushables for context_usage events — separate from
   *  message history so reconnects don't replay stale usage snapshots.
   *  Each WS subscriber gets its own pushable to avoid waiter overwrite
   *  when multiple tabs are connected to the same session. */
  contextUsageSubscribers: Set<Pushable<unknown>>
  /** Last context-usage snapshot pushed to subscribers. Cached so a freshly
   *  subscribed tab (reconnect / new panel / refresh+resume) gets the current
   *  value immediately via subscribeContextUsage's snapshot, instead of
   *  waiting for the next `result`. Cleared on /clear. Not persisted —
   *  re-derived from the next result after resume. */
  lastContextUsage?: import('./session-pump.js').LiteContextUsage
  /** Per-subscriber pushables for prompt_suggestion events — separate from
   *  message history (suggestions are ephemeral, not conversation content).
   *  Same shape as contextUsageSubscribers. */
  promptSuggestionSubscribers: Set<Pushable<unknown>>
  /** Last predicted next-user-prompt from the SDK. Cached so a freshly
   *  subscribed tab gets the current suggestion immediately. Cleared on
   *  /clear. Not persisted. */
  lastPromptSuggestion?: string | null
  /** Last authoritative CLI session state from `system/session_state_changed`
   *  frames ('idle' | 'running' | 'requires_action'). The pump forwards the
   *  raw frame to live subscribers only on CHANGE. Ephemeral, not persisted. */
  lastSessionState?: 'idle' | 'running' | 'requires_action'
  /** Cold-start instrumentation: wall-clock ms when the pump began waiting on
   *  the CLI's first message (boot start), when the `system/init` handshake
   *  completed, and when the first turn's `result` landed. Logged once each by
   *  the pump to quantify cold-start latency (create/resume/fork first turn)
   *  before deciding whether an SDK `startup()`/WarmQuery pre-warm pool is
   *  worth building. Not persisted. */
  bootStartedAt?: number
  initAtMs?: number
  firstTurnAtMs?: number
  /** Folded background-task state (task_started / task_updated /
   *  task_progress / task_notification frames), keyed by taskId. The SDK
   *  exposes no task-list query API, so this map IS the list. Seeded both
   *  by SDK frames (applyTaskEvent in session-pump) and by the subagent
   *  watcher (watcher-tracked agents on CLI versions that emit no task_*
   *  frames would otherwise never appear). Cleared on /clear. Not
   *  persisted — task state is in-memory only, lost on unload/dormancy
   *  (same trade-off as backgroundSubagentCount). */
  tasks: Map<string, import('../shared/tasks.js').TaskRecordUi>
  /** Per-subscriber pushables receiving FULL task-list snapshots (the
   *  Map's values as an array) on every task-state change. Same shape as
   *  contextUsageSubscribers; snapshot semantics make reconnects trivial. */
  taskSubscribers: Set<Pushable<import('../shared/tasks.js').TaskRecordUi[]>>
  /** Per-subscriber pushables for `git-status-changed` signal frames.
   *  Same shape as contextUsageSubscribers but carries a signal-only
   *  payload (no GitStatus snapshot — clients refetch). Driven by
   *  session-pump on mutating tool_results and by git-write routes on
   *  user-initiated mutations. */
  gitStatusSubscribers: Set<Pushable<unknown>>
  /** Per-subscriber pushables for input-queue message-status signal frames.
   *  Carries either a full `message-consumed` frame each time the SDK reads
   *  a user turn off the input queue, or a full `messages-withdrawn` frame
   *  when an interrupt with cancelQueued removed queued turns (see
   *  SessionManager.interrupt). Mirrors gitStatusSubscribers (signal-shaped,
   *  small payload). Each WS subscriber gets its own pushable so a slow tab
   *  can't block another tab's updates. */
  messageStatusSubscribers: Set<Pushable<WsMessageConsumed | WsMessagesWithdrawn>>
  /** Server-minted uuids of user turns withdrawn by cancelQueued interrupts
   *  (most recent last, capped). Replayed to each NEW message-status
   *  subscriber as a synthetic `messages-withdrawn` frame so a tab that was
   *  disconnected during the stop still evicts its bubbles: incremental
   *  sinceUuid replay can never heal this, because the withdrawn messages
   *  are gone from the ring and so are never re-sent to compare against. */
  withdrawnUuids: string[]
  commandSubscribers: Set<Pushable<unknown>>
  /** Recent hook lifecycle events, kept outside chat history so the UI can
   *  inspect hook activity without rendering it as conversation content. */
  hookRuns: HookRunRecord[]
  hookRunSubscribers: Set<Pushable<HookRuntimeEvent>>
  /** Per-subscriber pushables for `session-recap-update` frames.
   *  Mirrors gitStatusSubscribers; carries the SessionRecap payload
   *  (or undefined to mean cleared). Driven by RecapManager.invalidate
   *  / requestGenerate via SessionManager. Each WS subscriber gets its
   *  own pushable so a slow tab can't block another tab's updates. */
  recapSubscribers: Set<Pushable<unknown>>
  /** Per-subscriber pushables for `session-cleared` signal frames.
   *  Mirrors gitStatusSubscribers (signal-shaped, no payload beyond the
   *  sessionId). Driven by the pump when a `/clear`-triggered init lands.
   *  Clients respond by resetting their transcript store + local cache. */
  sessionClearedSubscribers: Set<Pushable<unknown>>
  /** Stored canUseTool callback for auto-resume. Reused when the Query
   *  exits cleanly and needs to be re-spawned without recreating the
   *  permission handling logic. */
  canUseTool?: CanUseTool
  /** Stored onElicitation callback (MCP elicitation / OAuth auth prompts).
   *  Mirrors canUseTool: rebuilt by ElicitationBroker.buildOnElicitation at
   *  spawn, persisted on the Session (runtime-only), and re-applied by
   *  buildResumeOpts / respawnInPlace so idle-exit auto-resume and crash
   *  recovery keep elicitation handling alive. Without it the SDK
   *  auto-declines every elicitation on the resumed Query. */
  onElicitation?: OnElicitation
  /** Stored onUserDialog callback (blocking CLI dialogs, e.g. refusal
   *  fallback). Mirrors onElicitation: rebuilt by DialogBroker.buildOnUserDialog
   *  at spawn, persisted on the Session (runtime-only), and re-applied by
   *  buildResumeOpts / respawnInPlace so idle-exit auto-resume and crash
   *  recovery keep dialog handling alive. Without it the SDK never sees
   *  supportedDialogKinds on the resumed Query and the flow degrades to its
   *  no-dialog behavior. */
  onUserDialog?: OnUserDialog
  /** Abort handle for the current in-flight `!`/`!!` exec, if any. `!` is
   *  serial (the client's sendingRef blocks concurrent commands), so at most
   *  one exec runs per session at a time — no exec-id tracking needed.
   *  execInSession sets this before awaiting execCommand and clears it in a
   *  finally; the /exec/abort route fires it to SIGKILL the child. Not
   *  persisted (runtime-only); unload() aborts any in-flight exec to avoid
   *  leaking the child process. */
  execAbort?: AbortController
  /** AI-generated session recap state. Lives on the live session (not
   *  in `history`) so it isn't subject to the 500-msg ring-buffer cap
   *  and so the WS frame can carry it as a type payload rather than
   *  as a synthetic SDK message. Reset to undefined on `invalidate`
   *  (any user-initiated change to the conversation). Not persisted —
   *  unloading the session drops it; resume regenerates on demand. */
  recap?: import('../shared/session-info.js').SessionRecap
  /** Per-session skill policy override. RAM-only by design:
   *   - Initial spawn applies the GLOBAL config via Options.skills.
   *   - When this becomes anything other than `{kind:'inherit'}`, we
   *     forward applyFlagSettings({skillOverrides:<map>}) to switch the
   *     active skill set mid-Query.
   *   - When the session unloads / resumes, this resets to undefined
   *     and the global policy is re-applied. Pin-and-forget is not the
   *     intended UX — overrides are scoped to "the current run". */
  skillOverride?: SessionSkillOverride
  /** Per-session tool-surface profile (tools / allowedTools / disallowedTools
   *  / toolAliases / toolConfig). RAM-only like skillOverride — retitles a
   *  session's built-in tool surface at spawn (these are spawn-time Options,
   *  not runtime Settings). Applied on create / clear / fork; dropped on
   *  resume-from-disk so the (possibly out-of-date) profile never pins a
   *  session forever. */
  toolProfile?: SessionToolProfile
  /** Per-session override for the pinned "current question" header.
   *  Undefined = inherit the global config default; a boolean pins it.
   *  Persisted via SessionMeta and mirrored into SessionInfo. Pure UI
   *  pref — no SDK applyFlagSettings call. */
  showPinnedUserMessage?: boolean
  /** Per-session override for idle auto-recap. Undefined = inherit the
   *  global config default; a boolean pins it. Persisted via SessionMeta
   *  and mirrored into SessionInfo. Pure UI pref — no SDK call. */
  autoRecap?: boolean
  /** Per-session override for the first-party `apptools` git MCP server.
   *  Undefined = inherit the global config default; a boolean pins it.
   *  Persisted via SessionMeta and mirrored into SessionInfo. Read at
   *  spawn / live setMcpServers; not itself an SDK call. */
  appToolsGit?: boolean
  /** Per-session overrides for first-party tool servers (keyed by server
   *  name, e.g. `apptools`). `true`/`false` pin that server; `null` clears
   *  the override to inherit the global default. `appToolsGit` is the legacy
   *  single-entry form of `firstPartyTools.apptools`. */
  firstPartyTools?: Record<string, boolean | null>
  /** True when the user explicitly slept this session via the "Sleep"
   *  action. Distinguishes deliberate dormancy from passive restart/crash
   *  dormancy so the client can skip auto-resume paths for slept sessions.
   *  Set by sleep(), cleared by spawn() (resume / fresh). Persisted via
   *  SessionMeta and mirrored into SessionInfo. */
  slept?: boolean
  /** In-memory mirror of the promptUuids sidecar (server/prompt-uuid-store.ts):
   *  the server-minted uuid + content hash of each top-level prompt ever sent,
   *  newest-capped to historyCap. Loaded from the sidecar on resume, empty on a
   *  fresh spawn, appended on send(). Used by resume() to rewrite the disk-seed
   *  ring's prompt uuids (SDK V → server U) so the client's uuid-anchored
   *  replay overlap detection works after a server restart. Undefined on
   *  sessions spawned before this field existed (treated as empty → no bridge,
   *  signature fallback handles dedup). */
  promptUuids?: PromptUuidEntry[]
}

/** End every subscriber in a collection and clear it. Works on both
 *  `Set<Pushable<T>>` and `Map<K, V>` where values have an `end()` method. */
function endAndClear<T extends { end(): void }>(
  collection: { values(): Iterable<T>; clear(): void },
): void {
  for (const sub of collection.values()) {
    try { sub.end() } catch { /* subscriber dead — skip */ }
  }
  collection.clear()
}

/** End every live subscriber (messages, permissions, context-usage, — and
 *  clear the collections so no dangling references prevent GC.
 *  Shared across handleProcessExit, cleanupPump, and unload. */
export function endAllSubscribers(s: Session): void {
  endAndClear(s.subscribers)
  endAndClear(s.permissionSubscribers)
  endAndClear(s.elicitationSubscribers)
  endAndClear(s.dialogSubscribers)
  endAndClear(s.pluginSubscribers)
  endAndClear(s.contextUsageSubscribers)
  endAndClear(s.promptSuggestionSubscribers)
  endAndClear(s.taskSubscribers)
  endAndClear(s.gitStatusSubscribers)
  endAndClear(s.messageStatusSubscribers)
  endAndClear(s.commandSubscribers)
  endAndClear(s.hookRunSubscribers)
  endAndClear(s.recapSubscribers)
  endAndClear(s.sessionClearedSubscribers)
}

export interface SessionManagerOptions {
  providers?: ProviderRegistry
  defaultProvider?: string
  historyCap?: number
  /** FIFO budget for the subagent ring — see ServerConfig.subagentHistoryCap.
   *  Boot-time only (lives in the cached PumpDeps and existing rings), so it
   *  is not in WRITABLE_CONFIG_KEYS. */
  subagentHistoryCap?: number
  /** Forward subagent text/thinking frames — see ServerConfig.forwardSubagentText.
   *  Spawn-time SDK Options key, so it only takes effect for sessions created
   *  after boot; not runtime-writable. */
  forwardSubagentText?: boolean
  /** State directory. Used as the parent for the per-session
   *  prompt-uuid sidecar store (<stateDir>/prompt-uuids/<id>.json).
   *  Required in production (cli passes it); omitted in tests that
   *  don't exercise resume-seed bridging. */
  stateDir?: string
  /** When set, session metadata is persisted here so dormant sessions
   *  survive restarts. See server/persistence.ts. */
  store?: SessionStore
  /** When set, global MCP server configs are available for merging
   *  into new sessions. See server/mcp-config.ts. */
  mcpConfigStore?: McpConfigStore
  /** When set, every new SDK Query is spawned with plugin paths from
   *  enabled marketplace plugins injected into Options.plugins. */
  mpStore?: MpStore
  /** When set, every new SDK Query is spawned with enabled custom agent
   *  definitions injected into Options.agents. See agent-definition-store. */
  agentStore?: AgentDefinitionStore
  /** Absolute path to the `claude` CLI binary, injected into every
   *  Query's Options.pathToClaudeCodeExecutable. Bypasses the SDK's
   *  internal platform-native-package resolution, which can pick a
   *  wrong libc variant on some systems. */
  claudeBinary?: string
  /** Maximum time (ms) a session can stay "working" before the GC
   *  auto-interrupts it. 0 = disabled. */
  workingStuckMs?: number
  /** When true, sessions automatically re-spawn their Query after a
   *  clean exit (idle timeout). Default true in production, false in tests. */
  autoResume?: boolean
  /** When true, a CLI subprocess crash (non-zero exit / signal / killed)
   *  triggers a bounded recovery ladder before marking the session
   *  terminated: every attempt re-resumes the same id (handles transient
   *  crashes and tail corruption — the CLI self-heals partial trailing
   *  lines). When the attempt budget (`maxCrashRecovery`) is exhausted the
   *  session terminates with the transient crash reason so the UI shows the
   *  Resume / Fork-from-last-completed choice banner — there is no automatic
   *  fork. spawn-failures (missing binary) and first-turn crashes (no
   *  completed turn to resume from) bypass the ladder and terminate. Default
   *  true in production, false in tests. */
  crashRecovery?: boolean
  /** Max in-place resume attempts per crash episode before giving up. Every
   *  attempt is Step 1 (re-resume the same session id); there is no auto-fork.
   *  With N, the first N crashes in-place-resume and the (N+1)th terminates
   *  with the transient crash reason (`canRetryResume`) so the UI offers the
   *  user Resume / Fork-from-last-completed. Default 2 (two in-place resumes,
   *  third crash shows the banner); raising it adds more in-place resumes. */
  maxCrashRecovery?: number
}

/** Global session-list update event. Broadcast whenever a session's
 *  info changes (working toggled, turn completed, error set, etc.) so
 *  the frontend sidebar can replace 5-second polling with a push feed. */
export type GlobalSessionEvent =
  | { kind: 'update'; session: SessionInfo }
  | { kind: 'created'; session: SessionInfo; joinGroupOf?: string; evictingSource?: boolean; replacesSource?: boolean }
  | { kind: 'removed'; id: string }
  /** A tool-permission request arrived for a session. Mirrored onto the
   *  global channel so that App-level code can fire a desktop notification
   *  even when the
   *  session's Chat panel isn't mounted. `sessionId` lets the frontend
   *  route-to-session on click. */
  | { kind: 'permission_request'; sessionId: string; request: PermissionRequestSnapshot }
  /** A CLI notification frame (SDK `system/notification`) arrived. Mirrored
   *  onto the global channel so App-level code can fire a browser/OS
   *  notification even when the session's Chat panel isn't mounted —
   *  same rationale as `permission_request`. */
  | { kind: 'cli_notification'; sessionId: string; notification: CliNotification }

export interface GlobalSubscriber {
  id: string
  push: (ev: GlobalSessionEvent) => void
  end: () => void
}

/** Read-only subscription surface used by ws.ts.
 *  Narrower than the full SessionManager — depends only on the fan-out
 *  methods plus the two operations needed to *begin streaming* a session:
 *  `get` (does the session exist, and is it live?) and `resume` (bring a
 *  known-but-dormant session back so a WS subscribe that raced the
 *  session's `/resume` can actually be served). No other mutation or
 *  lifecycle operations. */
export interface SessionBroadcaster {
  subscribeGlobal(): {
    iterable: AsyncIterable<GlobalSessionEvent>
    snapshot: SessionInfo[]
    unsubscribe: () => void
  }
  /** Return the session's current info. Throws HttpError(404) for a
   *  session that is neither live nor in the persisted store — i.e.
   *  deleted or never tracked. Returns `running: false` for a
   *  known-but-dormant (persisted, not loaded) session. */
  get(id: string): SessionInfo
  /** Ensure a known session is loaded and return its info. Idempotent
   *  and coalesced by the manager: concurrent resume() calls for the
   *  same id share one spawn promise, and a live session resolves
   *  immediately (no-op). Used by the WS subscribe path to serve a
   *  subscribe that landed before the session's `/resume` completed.
   *  Throws 404 (unknown) / 410 (ended and unresumable). */
  resume(id: string, opts?: { permissionMode?: PermissionMode }): Promise<SessionInfo>
  subscribe(sessionId: string): {
    iterable: AsyncIterable<SDKMessage>
    history: SDKMessage[]
    unsubscribe: () => void
  }
  subscribePermissions(sessionId: string): {
    iterable: AsyncIterable<PermissionEvent>
    snapshot: PermissionRequestSnapshot[]
    unsubscribe: () => void
  }
  subscribeElicitation(sessionId: string): {
    iterable: AsyncIterable<ElicitationEvent>
    snapshot: ElicitationRequestUi[]
    unsubscribe: () => void
  }
  subscribeDialog(sessionId: string): {
    iterable: AsyncIterable<DialogEvent>
    snapshot: UserDialogRequestUi[]
    unsubscribe: () => void
  }
  subscribeContextUsage(sessionId: string): { iterable: AsyncIterable<unknown>; snapshot?: import('./session-pump.js').LiteContextUsage | undefined; unsubscribe: () => void } | null
  subscribePromptSuggestion(sessionId: string): { iterable: AsyncIterable<unknown>; snapshot?: string | null; unsubscribe: () => void } | null
  subscribeTasks(sessionId: string): { iterable: AsyncIterable<unknown>; snapshot: import('../shared/tasks.js').TaskRecordUi[]; unsubscribe: () => void } | null
  subscribeGitStatus(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
  /** Per-session subscription for `message-consumed` / `messages-withdrawn`
   *  signal frames (typed union — the channel carries full frames, not bare
   *  payloads). Returns null when the session is unknown (callers
   *  short-circuit). Mirrors subscribeGitStatus. */
  subscribeMessageStatus(sessionId: string): {
    iterable: AsyncIterable<WsMessageConsumed | WsMessagesWithdrawn>
    unsubscribe: () => void
  } | null
  subscribeCommandChanges(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
  subscribeHookRuns(sessionId: string): {
    iterable: AsyncIterable<HookRuntimeEvent>
    snapshot: HookRunRecord[]
    unsubscribe: () => void
  } | null
  /** Per-session recap subscription. Returns the current recap snapshot
   *  alongside the live iterable so a freshly-subscribed tab sees the
   *  current state without waiting for the next transition. Null when
   *  the session is unknown (callers short-circuit). */
  subscribeSessionRecap(sessionId: string): {
    iterable: AsyncIterable<unknown>
    snapshot: import('../shared/session-info.js').SessionRecap | undefined
    unsubscribe: () => void
  } | null
  /** Push a `git-status-changed` signal to every subscriber of the
   *  session. Mutator-shaped (modifies subscriber state by enqueueing)
   *  but pure from the caller's perspective; included in the broadcaster
   *  contract so the debounce helper and write routes can both call it. */
  broadcastGitStatusChanged(sessionId: string): void
  /** Per-session subscription for `session-cleared` signal frames.
   *  Returns null when the session is unknown (callers short-circuit).
   *  Mirrors subscribeGitStatus. */
  subscribeSessionCleared(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
  /** Push a `session-cleared` signal to every subscriber of the session.
   *  Signal-only (bare sessionId). Called by the pump when a `/clear`-
   *  triggered context reset is confirmed. No-op when the session is
   *  unknown or has no subscribers. */
  broadcastSessionCleared(sessionId: string): void
}

// Re-export HttpError from its canonical location so existing importers
// (session-manager.ts re-exports, etc.) continue to work during migration.
export { HttpError } from './errors.js'
