// Single source of truth for the SessionInfo shape that flows over the
// wire (sessions-snapshot, session-update, session-created frames).
//
// Parameterized over PermissionMode so the server can plug in the SDK's
// PermissionMode union while the client uses its own string-literal
// union — both project to the same JSON. Adding a field here makes
// both ends fail to typecheck until they update, which is the whole
// point: prevents the two `SessionInfo` declarations from drifting.

import type { SessionSkillOverride } from './skills.js'
import type { SandboxSetting } from './sandbox.js'

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

/** Per-session auto-memory intent (SDK Settings.autoMemoryEnabled /
 *  autoMemoryDirectory / autoDreamEnabled). Applied via
 *  Query.applyFlagSettings and re-applied on every re-spawn. A key that
 *  is undefined means "not set" (inherit the project/SDK default); the
 *  whole object is undefined when no memory setting has been pinned.
 *  Persisted via SessionMeta so it survives resume / fork / clear. */
export interface SessionMemorySettings {
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
  autoDreamEnabled?: boolean
}

/** Runtime display mode for extended thinking (SDK ThinkingConfig.display /
 *  setMaxThinkingTokens `thinkingDisplay`). `undefined` = default: omit the
 *  field so the SDK/model default applies. */
export type ThinkingDisplay = 'summarized' | 'omitted'

/** Per-session extended-thinking setting (mirrors the SDK's ThinkingConfig
 *  shape, JSON-serializable). `display` is only meaningful while thinking is
 *  on, so the `disabled` variant omits it (SDK ThinkingDisabled has none).
 *  `undefined` on a session means "no explicit choice — use the SDK/model
 *  default". Persisted via SessionMeta so it survives resume / fork / clear. */
export type ThinkingSetting =
  | { type: 'adaptive'; display?: ThinkingDisplay }
  | { type: 'disabled' }
  | { type: 'enabled'; budgetTokens?: number; display?: ThinkingDisplay }

/** Defensive runtime validation + narrowing of an unknown value into a
 *  ThinkingSetting. Returns undefined for anything malformed. */
export function coerceThinkingSetting(v: unknown): ThinkingSetting | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const t = v as { type?: unknown; budgetTokens?: unknown; display?: unknown }
  // `display` absent → fine; 'summarized' | 'omitted' → fine; anything else
  // (numbers, booleans, null, unknown strings) → the whole value is dropped.
  let display: ThinkingDisplay | undefined
  if (t.display !== undefined) {
    if (t.display !== 'summarized' && t.display !== 'omitted') return undefined
    display = t.display
  }
  if (t.type === 'adaptive') return { type: 'adaptive', ...(display ? { display } : {}) }
  if (t.type === 'disabled') return { type: 'disabled' }
  if (t.type === 'enabled') {
    // Absent budget = bare enabled (valid). A PRESENT but non-positive /
    // non-numeric budget is malformed — returning bare enabled would silently
    // change the user's meaning, so the whole value is dropped instead.
    if (t.budgetTokens === undefined) {
      return { type: 'enabled', ...(display ? { display } : {}) }
    }
    return typeof t.budgetTokens === 'number' && t.budgetTokens > 0
      ? { type: 'enabled', budgetTokens: Math.round(t.budgetTokens), ...(display ? { display } : {}) }
      : undefined
  }
  return undefined
}

export interface SessionInfoBase<PM = string> {
  id: string
  provider?: string
  createdAt: number
  lastActivityAt: number
  subscribers: number
  messageCount: number
  cwd?: string
  model?: string
  /** Active model group id. When set, the session was created with a
   *  modelGroupId that resolves to a ModelGroupConfig, and `model` is the
   *  group's resolved main slot model. */
  modelGroupId?: string
  /** Provider profile id this session is pinned to. Undefined = follow the
   *  active (global) profile. Persisted so resume/fork/clear keep the pin. */
  profileId?: string
  /** Display name of the session's effective profile. Server-derived, not
   *  persisted — recomputed from profileId / the active profile at info time. */
  profileName?: string
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
  /** Per-session auto-memory settings; see SessionMemorySettings. */
  memory?: SessionMemorySettings
  /** Per-session sandbox intent (SDK Settings.sandbox). A present object =
   *  sandbox ON; undefined = off (project/SDK default). Persisted; survives
   *  resume/restart/fork; runtime-switchable. */
  sandbox?: SandboxSetting
  /** SDK-reported runtime fast-mode state. undefined means the current
   *  model doesn't support fast mode — the UI uses this to hide the
   *  toggle entirely. 'cooldown' means fast mode is rate-limited and
   *  temporarily inactive. Not persisted (the SDK re-reports it). */
  fastModeState?: 'off' | 'cooldown' | 'on'
  /** SDK-reported runtime compaction state — true while the CLI is compacting
   *  the transcript (auto-recap / context-window compression). Surfaced so the
   *  WorkingBubble can show "Recap (auto)…" instead of a stale phase while the
   *  context window is being compressed mid-turn. Not persisted; the SDK
   *  re-reports it via `system/status` after respawn. */
  compacting?: boolean
  /** User intent: reasoning effort level. Undefined means no explicit
   *  level was set (the SDK default is 'high'). Persisted. */
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Effort levels the current model supports (SDK capability). Three-state:
   *  undefined = unknown → UI offers all 5; [] = unsupported → UI hides the
   *  chip; [subset] = UI offers only these. Not persisted. */
  effortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  /** User intent: extended-thinking configuration for this session.
   *  Undefined means no explicit choice (SDK/model default). Persisted. */
  thinking?: ThinkingSetting
  /** Whether the current model supports thinking at all (keyword-classified
   *  from the model id, like effortLevels — the SDK's report is untrustworthy
   *  on gateway deployments). undefined = unknown → UI shows the chip;
   *  false = hide it. Not persisted. */
  thinkingSupported?: boolean
  /** User intent: absolute auto-compact window size in tokens (SDK
   *  Settings.autoCompactWindow). Undefined means "auto" — the CLI derives
   *  the threshold from the model's context window. Persisted so it survives
   *  resume / fork / restart. The client converts this to a percentage of
   *  the model's raw context window for the slider. */
  autoCompactWindow?: number
  running: boolean
  /** True while the crash-recovery ladder is mid-flight (between a CLI
   *  crash and a successful in-place respawn or give-up). Lets the client
   *  show a 'recovering' badge and reject interaction during the window
   *  (the server's requireRunnable also blocks sends). Always false for
   *  non-claude providers and when crashRecovery is disabled. */
  recovering?: boolean
  terminated: boolean
  terminatedReason?: string
  /** True when the session is `terminated` but only with a *transient*
   *  reason (process crash / query error / spawn failure) AND the server
   *  would still allow a manual `resume()` — i.e. the SDK transcript is
   *  expected to be recoverable. Lets the client offer a "retry resume"
   *  affordance instead of a hard "session ended" dead-end, without the
   *  client having to mirror the server's reason classification.
   *
   *  Always false for non-terminated sessions and for hard-terminal
   *  reasons (deleted / transcript_missing / crash_recovered_fork /
   *  unknown). A successful resume clears `terminated` (and thus this)
   *  via spawn()'s writeStore. */
  canRetryResume?: boolean
  error?: string
  /** True while the SDK is mid-turn. Drives the "thinking" animation. */
  working: boolean
  /** Epoch ms when the current turn started. Only set while `working` is
   *  true; allows the UI to compute an accurate elapsed timer. */
  workingSince?: number
  /** Number of background (async) subagents currently in flight for this
   *  session. The parent turn may have COMPLETED (`working` false, phase
   *  'idle'-ish) while these are still running — the SDK's Agent tool acks
   *  a `run_in_background` launch immediately and the main turn ends, but
   *  the subagent keeps producing until a task_notification lands. Derived
   *  server-side from the active subagent-transcript watchers, so the
   *  sidebar can avoid showing a session as a plain green "live" while it
   *  is actually waiting on background work. Undefined/0 when none. */
  backgroundSubagentCount?: number
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
  /** When present, this session is a Side Chat — a lightweight,
   *  ephemeral fork of the parent session. The value is the parent's
   *  session ID. Undefined for normal sessions. */
  parentId?: string
  /** Names of MCP servers the session was spawned with. Derived from
   *  the resolved mcpServers config passed to the SDK at create / resume
   *  / fork time. Used by the client as a reliable baseline for the
   *  "connected" set — unlike the flaky mcp-status SDK control request,
   *  this travels via the session snapshot (WS) and survives restarts
   *  via persistence. Undefined only for sessions created before this
   *  field was added (legacy). */
  mcpServerNames?: string[]
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset this
   *  session was spawned with. `undefined` = all enabled; `[]` = none.
   *  Persisted via SessionMeta. */
  enabledPlugins?: string[]
  /** Per-session skill policy override. Undefined or `{kind:'inherit'}`
   *  means "follow the global config". Overrides are RAM-only — they
   *  reset to inherit on resume so multi-panel users can pin different
   *  skill policies per chat without losing them on the same Query, but
   *  also without surprising state surviving a server restart. */
  skillOverride?: SessionSkillOverride
  /** Per-session override for the pinned "current question" header.
   *  Undefined = inherit the global default (config.showPinnedUserMessage);
   *  a boolean pins this session to that value. Persisted so it survives
   *  resume / fork / reload. */
  showPinnedUserMessage?: boolean
  /** Per-session override for idle auto-recap. Undefined = inherit the
   *  global default (config.autoRecap); a boolean pins this session to
   *  that value. Manual recap (Alt+R) is never gated by this. Persisted
   *  so it survives resume / fork / reload. */
  autoRecap?: boolean
  /** True when the user explicitly put this session to sleep (dormant) via
   *  the "Sleep" action — distinct from a passive dormant state caused by a
   *  server restart or crash. The client uses this to skip auto/background
   *  resume paths (group-switch sibling resume, programmatic group open) so
   *  a deliberately-slept session isn't woken behind the user's back. An
   *  explicit click / drop / Resume-button still wakes it (and clears the
   *  flag). Persisted so the intent survives a server restart. */
  slept?: boolean
}
