// Single source of truth for the SessionInfo shape that flows over the
// wire (sessions-snapshot, session-update, session-created frames).
//
// Parameterized over PermissionMode so the server can plug in the SDK's
// PermissionMode union while the client uses its own string-literal
// union — both project to the same JSON. Adding a field here makes
// both ends fail to typecheck until they update, which is the whole
// point: prevents the two `SessionInfo` declarations from drifting.

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
}
