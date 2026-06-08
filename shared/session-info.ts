// Single source of truth for the SessionInfo shape that flows over the
// wire (sessions-snapshot, session-update, session-created frames).
//
// Parameterized over PermissionMode so the server can plug in the SDK's
// PermissionMode union while the client uses its own string-literal
// union — both project to the same JSON. Adding a field here makes
// both ends fail to typecheck until they update, which is the whole
// point: prevents the two `SessionInfo` declarations from drifting.

/** Coarse-grained session lifecycle. The server is the single source of
 *  truth for this — derived from `(running, working, queueDepth,
 *  pendingPermission, terminated, dormant)`. The frontend uses it to
 *  gate user-visible behaviour (auto-recap timer, "Refresh recap"
 *  affordance, future idle-only actions) without each consumer having
 *  to re-derive idle-ness from primitive flags.
 *
 *   idle       — session is alive, no work in flight, no queued input
 *   working    — SDK is currently producing a turn (or one is queued)
 *   terminated — Query has ended; resume() will refuse
 *   dormant    — metadata-only, Query was unloaded; needs resume()
 */
export type SessionPhase = 'idle' | 'working' | 'terminated' | 'dormant'

/** AI-generated session recap. Lives on SessionInfo (not in history)
 *  so it travels via WS push and survives the 500-msg history cap. */
export interface SessionRecapStats {
  messageCount: number
  userTurns: number
  assistantTurns: number
  totalCostUsd: number
  durationMs: number
  toolsUsed: string[]
}
export interface SessionRecap {
  /** Lifecycle:
   *    pending — generation in flight (LLM call running)
   *    ready   — summary present and considered fresh
   *    error   — last attempt failed; UI shows the message and a retry
   *  No `absent` state: the field is simply undefined on SessionInfo
   *  when there's nothing to report. */
  status: 'pending' | 'ready' | 'error'
  summary?: string
  stats?: SessionRecapStats
  error?: string
  /** Epoch ms of the most recent successful generation OR the most
   *  recent error. Used by the client only for display. */
  generatedAt?: number
}

export interface SessionInfoBase<PM = string> {
  id: string
  createdAt: number
  lastActivityAt: number
  subscribers: number
  messageCount: number
  cwd?: string
  model?: string
  permissionMode?: PM
  title?: string
  /** Anthropic beta flags the session was created with — kept around so
   *  restart / resume / fork can re-spawn with the same flags. The
   *  practical case is `context-1m-...` for Sonnet 4's 1M window: without
   *  preservation, restart silently drops back to the default 200k. */
  betas?: string[]
  /** User intent: whether fast mode is requested for this session.
   *  Persisted; survives resume/restart. */
  fastMode?: boolean
  /** SDK-reported runtime fast-mode state. undefined means the current
   *  model doesn't support fast mode — the UI uses this to hide the
   *  toggle entirely. 'cooldown' means fast mode is rate-limited and
   *  temporarily inactive. Not persisted (the SDK re-reports it). */
  fastModeState?: 'off' | 'cooldown' | 'on'
  /** User intent: reasoning effort level. Undefined means no explicit
   *  level was set (the SDK default is 'high'). Persisted. */
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Effort levels the current model supports (SDK capability). Three-state:
   *  undefined = unknown → UI offers all 5; [] = unsupported → UI hides the
   *  chip; [subset] = UI offers only these. Not persisted. */
  effortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  running: boolean
  terminated: boolean
  terminatedReason?: string
  error?: string
  /** True while the SDK is mid-turn. Drives the "thinking" animation. */
  working: boolean
  /** Epoch ms when the current turn started. Only set while `working` is
   *  true; allows the UI to compute an accurate elapsed timer. */
  workingSince?: number
  /** Epoch ms of the last completed turn. Used to flag unread. */
  lastTurnAt?: number
  /** Snapshot of HEAD at session spawn time. Used by the GitPanel
   *  "This session" view to scope diffs to this conversation's
   *  duration. Undefined when cwd was not a git repo at spawn,
   *  HEAD was detached/unborn, or git was unavailable. Survives
   *  process restarts via persistence.coerceMeta. */
  gitStartSha?: string
  /** Number of tool-permission requests / AskUserQuestion prompts
   *  awaiting a user decision. Drives the sidebar badge on
   *  SessionCard so users can see at a glance which background
   *  sessions are blocked waiting on them. Always 0 for dormant
   *  sessions (a torn-down Query has no pending callbacks). */
  pendingPermissionCount?: number
  /** Coarse-grained lifecycle. Server-derived; see SessionPhase. */
  phase: SessionPhase
  /** AI session recap. Undefined when no recap has been generated
   *  for this session yet (or the previous one was invalidated and
   *  not yet regenerated). Updated by the recapManager and pushed
   *  via WS frames. */
  recap?: SessionRecap
}
