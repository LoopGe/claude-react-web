// Type definitions extracted from session-manager.ts for modularity.
// This file contains all public/internal interfaces and types.

import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Pushable } from './pushable.js'
import type { SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'
import type { MpStore } from './mp-store.js'
import type { SessionInfoBase } from '../shared/session-info.js'

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
  /** Auto-deny timer handle. Stored so decide() / answerQuestion() can
   *  clear it when the user responds before the timeout fires, avoiding
   *  a leaked timer closure that holds the Session reference alive. */
  timeoutTimer: ReturnType<typeof setTimeout> | null
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
  sessionId: string
  /** Best display title: customTitle ?? summary ?? firstPrompt. */
  title?: string
  /** First meaningful user prompt — shown as a preview/secondary line. */
  firstPrompt?: string
  cwd?: string
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
}

/** Re-export the canonical shapes from shared so server-side modules
 *  that import them (recap manager, session manager) can pull them
 *  through `session-types.ts` like everything else. */
export type { SessionPhase, SessionRecap, SessionRecapStats } from '../shared/session-info.js'

export interface Session {
  id: string
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
  input: Pushable<SDKUserMessage>
  query: Query
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
   *  which specific turn is outstanding — just whether ANY is. */
  pendingTurns: number
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
  /** Snapshot of HEAD captured at session spawn. Used by the GitPanel
   *  "This session" view to scope diffs to this conversation. Mirrored
   *  into SessionInfo and persisted via SessionMeta so it survives
   *  resume + server restart. */
  gitStartSha?: string
  /** Per-subscriber pushables for context_usage events — separate from
   *  message history so reconnects don't replay stale usage snapshots.
   *  Each WS subscriber gets its own pushable to avoid waiter overwrite
   *  when multiple tabs are connected to the same session. */
  contextUsageSubscribers: Set<Pushable<unknown>>
  /** Per-subscriber pushables for `git-status-changed` signal frames.
   *  Same shape as contextUsageSubscribers but carries a signal-only
   *  payload (no GitStatus snapshot — clients refetch). Driven by
   *  session-pump on mutating tool_results and by git-write routes on
   *  user-initiated mutations. */
  gitStatusSubscribers: Set<Pushable<unknown>>
  /** Per-subscriber pushables for `message-consumed` signal frames.
   *  Carries { uuid, consumedAt } each time the SDK reads a user turn off
   *  the input queue. Mirrors gitStatusSubscribers (signal-shaped, small
   *  payload). Each WS subscriber gets its own pushable so a slow tab
   *  can't block another tab's updates. */
  messageStatusSubscribers: Set<Pushable<unknown>>
  /** Per-subscriber pushables for `session-recap-update` frames.
   *  Mirrors gitStatusSubscribers; carries the SessionRecap payload
   *  (or undefined to mean cleared). Driven by RecapManager.invalidate
   *  / requestGenerate via SessionManager. Each WS subscriber gets its
   *  own pushable so a slow tab can't block another tab's updates. */
  recapSubscribers: Set<Pushable<unknown>>
  /** AbortController whose signal races the pump's `iter.next()` so
   *  unload() can break a wedged generator without waiting for the SDK
   *  subprocess to exit. */
  abortController: AbortController
  /** Stored canUseTool callback for auto-resume. Reused when the Query
   *  exits cleanly and needs to be re-spawned without recreating the
   *  permission handling logic. */
  canUseTool?: CanUseTool
  /** AI-generated session recap state. Lives on the live session (not
   *  in `history`) so it isn't subject to the 500-msg ring-buffer cap
   *  and so the WS frame can carry it as a typed payload rather than
   *  as a synthetic SDK message. Reset to undefined on `invalidate`
   *  (any user-initiated change to the conversation). Not persisted —
   *  unloading the session drops it; resume regenerates on demand. */
  recap?: import('../shared/session-info.js').SessionRecap
}

/** End every live subscriber (messages, permissions, context-usage) and
 *  clear the collections so no dangling references prevent GC.
 *  Shared across handleProcessExit, cleanupPump, and unload. */
export function endAllSubscribers(s: Session): void {
  for (const sub of s.subscribers.values()) {
    try { sub.end() } catch { /* subscriber dead — don't break cleanup for others */ }
  }
  s.subscribers.clear()
  for (const sub of s.permissionSubscribers.values()) {
    try { sub.end() } catch { /* subscriber dead — skip */ }
  }
  s.permissionSubscribers.clear()
  for (const sub of s.contextUsageSubscribers) {
    try { sub.end() } catch { /* subscriber dead — skip */ }
  }
  s.contextUsageSubscribers.clear()
  for (const sub of s.gitStatusSubscribers) {
    try { sub.end() } catch { /* subscriber dead — skip */ }
  }
  s.gitStatusSubscribers.clear()
  for (const sub of s.messageStatusSubscribers) {
    try { sub.end() } catch { /* subscriber dead — skip */ }
  }
  s.messageStatusSubscribers.clear()
  for (const sub of s.recapSubscribers) {
    try { sub.end() } catch { /* subscriber dead — skip */ }
  }
  s.recapSubscribers.clear()
}

export interface SessionManagerOptions {
  historyCap?: number
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
  /** Timeout (ms) for pending tool-permission requests. Auto-denies
   *  if the user doesn't respond in time. 0 = no timeout. */
  permissionTimeoutMs?: number
  /** Maximum time (ms) a session can stay "working" before the GC
   *  auto-interrupts it. 0 = disabled. */
  workingStuckMs?: number
  /** When true, sessions automatically re-spawn their Query after a
   *  clean exit (idle timeout). Default true in production, false in tests. */
  autoResume?: boolean
}

/** Global session-list update event. Broadcast whenever a session's
 *  info changes (working toggled, turn completed, error set, etc.) so
 *  the frontend sidebar can replace 5-second polling with a push feed. */
export type GlobalSessionEvent =
  | { kind: 'update'; session: SessionInfo }
  | { kind: 'created'; session: SessionInfo }
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
 *  Narrower than the full SessionManager — depends only on the fan-out
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
  subscribeContextUsage(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
  subscribeGitStatus(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
  /** Per-session subscription for `message-consumed` signal frames.
   *  Returns null when the session is unknown (callers short-circuit).
   *  Mirrors subscribeGitStatus. */
  subscribeMessageStatus(sessionId: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null
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
}

// Re-export HttpError from its canonical location so existing importers
// (session-manager.ts re-exports, etc.) continue to work during migration.
export { HttpError } from './errors.js'

