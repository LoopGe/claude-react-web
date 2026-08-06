// Type definitions extracted from session-manager.ts for modularity.
// This file contains all public/internal interfaces and types.

import type {
  CanUseTool,
  EffortLevel,
  FastModeState,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Pushable } from './pushable.js'
import type { SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'
import type { MpStore } from './mp-store.js'
import type { SessionInfoBase } from '../shared/session-info.js'
import type { ProviderRegistry } from './providers/registry.js'
import type { ProviderSessionHandle } from './providers/types.js'
import type { HookRunRecord, HookRuntimeEvent, SessionHooksConfig } from '../shared/hooks.js'
import type { SessionSkillOverride } from '../shared/skills.js'
import type { PromptUuidEntry } from './prompt-uuid-store.js'

/** Subscriber deach connected client gets one of these. */
export interface Subscriber {
  id: string
  push: (msg: SDKMessage) => void
  end: () => void
  closed: boolean
}

/** Permission-channel subscriber dseparate from the SDK message channel so
 *  we don't have to widen the Subscriber type into a union. */
export type PermissionEvent =
  | { kind: 'request'; payload: PermissionRequestSnapshot }
  | { kind: 'resolved'; pid: string; decision: PermissionDecisionSummary }
export interface PermissionSubscriber {
  id: string
  push: (ev: PermissionEvent) => void
  end: () => void
}

// Re-export canonical QuestionSpec from share?.
export type { QuestionSpec } from '../shared/question-spec.js'

// Re-export canonical PermissionRequestSnapshot from share?.
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

/** Metadata returned by list() / get(). Field shape lives in
 *  shared/session-info.ts so client and server cannot drift. */
export type SessionInfo = SessionInfoBase<PermissionMode>

/** A session discoverable on disk via the SDK's `listSessions()`, surfaced
 *  to the frontend's /resume picker. Spans BOTH sessions this app created
 *  (`known: true`) and sessions created by the `claude` CLI directly in the
 *  same project dirs (`known: false`) dthe latter are the whole point of
 *  the picker (they're invisible in the sidebar). `running` / `terminated`
 *  are annotated from this app's live + persisted state so the picker can
 *  dim/disable rows that can't be resume?. */
export interface ResumableSession {
  provider?: string
  sessionId: string
  /** Best display title: customTitle — summary — firstPrompt. */
  title?: string
  /** First meaningful user prompt dshown as a preview/secondary line. */
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

export interface Session {
  id: string
  provider: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
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
  /** SDK-reported runtime fast-mode state ('off' | 'cooldown' | 'on'),
   *  parsed from system/init and result messages. Read-only dreflects what
   *  the backend is actually doing (e.g. 'cooldown' after a rate limit).
   *  undefined means the current model doesn't support fast mode (the SDK
   *  omits the field), which the UI uses to hide the toggle. Not persisted —   *  the SDK re-reports it after respawn. */
  fastModeState?: FastModeState
  /** User intent: reasoning effort level ('low'|'medium'|'high'|'xhigh'|
   *  'max'). Controls how many tokens the model spends. Persisted, re-applied
   *  on respawn. Undefined means no explicit level (SDK default 'high'). */
  effortLevel?: EffortLevel
  /** Structured hooks config for this session. Persisted and re-applied on resume. */
  hooks?: SessionHooksConfig
  /** Effort levels the CURRENT model supports, fetched from the SDK
   *  (supportedModels) at spawn / model-change. Three-state:
   *   - undefined: capability unknown (not fetched yet, model not matched,
   *     or proxy didn't report it) — UI falls back to offering all 5.
   *   - []        : model explicitly does NOT support effort — UI hides chip.
   *   - [levels]  : the supported subset — UI offers only these.
   *  Not persisted dre-fetched on every spawn (capability tracks the
   *  model + SDK version, not the conversation). */
  effortLevels?: EffortLevel[]
  handle: ProviderSessionHandle
  subscribers: Map<string, Subscriber>
  permissionSubscribers: Map<string, PermissionSubscriber>
  /** Pending tool-use permission requests awaiting a user decision. */
  pending: Map<string, PendingPermission>
  history: SDKMessage[]
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
   *  which specific turn is outstanding djust whether ANY is. */
  pendingTurns: number
  /** Set true while SessionManager.clear() is in flight: from the moment we
   *  begin tearing down the live Query through the fresh respawn of a brand
   *  new Query. Read by the pump's cleanupPump branch (skip auto-resume; do
   *  NOT mark terminated; keep subscribers alive across the gap) and by
   *  autoResume itself (refuse to fire while a clear is driving its own
   *  respawn). Cleared in clear()'s finally block once the new pump is up.
   *  Runtime-only; never persisted. */
  clearing?: boolean
  /** Epoch ms when the first pending turn starte?. Cleared when all turns
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
   *  subtype==='success' lands). The anchor for crash-recovery Step 2's
   *  `--fork-session --resume-session-at`: forking from here drops the
   *  poisonous/crashed trailing turn while preserving everything before it.
   *  undefined when no turn has completed (the first-turn-crash floor).
   *  Runtime-only. */
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
  /** Compound keys of the plugin subset this session was spawned with.
   *  `undefined` = all enabled; `[]` = none. Persisted via SessionMeta. */
  enabledPlugins?: string[]
  /** Per-subscriber pushables for context_usage events dseparate from
   *  message history so reconnects don't replay stale usage snapshots.
   *  Each WS subscriber gets its own pushable to avoid waiter overwrite
   *  when multiple tabs are connected to the same session. */
  contextUsageSubscribers: Set<Pushable<unknown>>
  /** Last context-usage snapshot pushed to subscribers. Cached so a freshly
   *  subscribed tab (reconnect / new panel / refresh+resume) gets the current
   *  value immediately via subscribeContextUsage's snapshot, instead of
   *  waiting for the next `result`. Cleared on /clear. Not persisted —   *  re-derived from the next result after resume. */
  lastContextUsage?: import('./session-pump.js').LiteContextUsage
  /** Per-subscriber pushables for `git-status-changed` signal frames.
   *  Same shape as contextUsageSubscribers but carries a signal-only
   *  payload (no GitStatus snapshot dclients refetch). Driven by
   *  session-pump on mutating tool_results and by git-write routes on
   *  user-initiated mutations. */
  gitStatusSubscribers: Set<Pushable<unknown>>
  /** Per-subscriber pushables for `message-consumed` signal frames.
   *  Carries { uuid, consumedAt } each time the SDK reads a user turn off
   *  the input queue. Mirrors gitStatusSubscribers (signal-shaped, small
   *  payload). Each WS subscriber gets its own pushable so a slow tab
   *  can't block another tab's updates. */
  messageStatusSubscribers: Set<Pushable<unknown>>
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
   *  (any user-initiated change to the conversation). Not persisted —   *  unloading the session drops it; resume regenerates on demand. */
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
  /** Per-session override for the pinned "current question" header.
   *  Undefined = inherit the global config default; a boolean pins it.
   *  Persisted via SessionMeta and mirrored into SessionInfo. Pure UI
   *  pref — no SDK applyFlagSettings call. */
  showPinnedUserMessage?: boolean
  /** Per-session override for idle auto-recap. Undefined = inherit the
   *  global config default; a boolean pins it. Persisted via SessionMeta
   *  and mirrored into SessionInfo. Pure UI pref — no SDK call. */
  autoRecap?: boolean
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
 *  `Set<Pushable<T>>` and `Map<K, V>` where values have an `end()` metho?. */
function endAndClear<T extends { end(): void }>(
  collection: { values(): Iterable<T>; clear(): void },
): void {
  for (const sub of collection.values()) {
    try { sub.end() } catch { /* subscriber dead dskip */ }
  }
  collection.clear()
}

/** End every live subscriber (messages, permissions, context-usage, — and
 *  clear the collections so no dangling references prevent GC.
 *  Shared across handleProcessExit, cleanupPump, and unloa?. */
export function endAllSubscribers(s: Session): void {
  endAndClear(s.subscribers)
  endAndClear(s.permissionSubscribers)
  endAndClear(s.contextUsageSubscribers)
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
  /** Absolute path to the `claude` CLI binary, injected into every
   *  Query's Options.pathToClaudeCodeExecutable. Bypasses the SDK's
   *  internal platform-native-package resolution, which can pick a
   *  wrong libc variant on some systems. */
  claudeBinary?: string
  /** Maximum time (ms) a session can stay "working" before the GC
   *  auto-interrupts it. 0 = disable?. */
  workingStuckMs?: number
  /** When true, sessions automatically re-spawn their Query after a
   *  clean exit (idle timeout). Default true in production, false in tests. */
  autoResume?: boolean
  /** When true, a CLI subprocess crash (non-zero exit / signal / killed)
   *  triggers a bounded recovery ladder before marking the session
   *  terminated: Step 1 re-resumes the same id (handles transient crashes
   *  and tail corruption — the CLI self-heals partial trailing lines);
   *  Step 2 forks from the last completed turn (`--fork-session
   *  --resume-session-at`) to drop a poisonous trailing turn. spawn-failures
   *  (missing binary) and first-turn crashes (no completed turn to resume
   *  from) bypass the ladder and terminate. Default true in production,
   *  false in tests. */
  crashRecovery?: boolean
}

/** Global session-list update event. Broadcast whenever a session's
 *  info changes (working toggled, turn completed, error set, etc.) so
 *  the frontend sidebar can replace 5-second polling with a push fee?. */
export type GlobalSessionEvent =
  | { kind: 'update'; session: SessionInfo }
  | { kind: 'created'; session: SessionInfo; joinGroupOf?: string; evictingSource?: boolean }
  | { kind: 'removed'; id: string }
  /** A tool-permission request arrived for a session. Mirrored onto the
   *  global channel so that App-level code can fire a desktop notification
   *  even when the
   *  session's Chat panel isn't mounted. `sessionId` lets the frontend
   *  route-to-session on click. */
  | { kind: 'permission_request'; sessionId: string; request: PermissionRequestSnapshot }

export interface GlobalSubscriber {
  id: string
  push: (ev: GlobalSessionEvent) => void
  end: () => void
}

/** Read-only subscription surface used by ws.ts.
 *  Narrower than the full SessionManager ddepends only on the fan-out
 *  methods, not on any mutation or lifecycle operations. */
export interface SessionBroadcaster {
  subscribeGlobal(): {
    iterable: AsyncIterable<GlobalSessionEvent>
    snapshot: SessionInfo[]
    unsubscribe: () => void
  }
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
  subscribeContextUsage(sessionId: string): { iterable: AsyncIterable<unknown>; snapshot?: import('./session-pump.js').LiteContextUsage | undefined; unsubscribe: () => void } | null
  subscribeGitStatus(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
  /** Per-session subscription for `message-consumed` signal frames.
   *  Returns null when the session is unknown (callers short-circuit).
   *  Mirrors subscribeGitStatus. */
  subscribeMessageStatus(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
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
