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
import type { SessionInfoBase } from '../shared/session-info.js'

/** Subscriber — each connected client gets one of these. */
export interface Subscriber {
  id: string
  push: (msg: SDKMessage) => void
  /** Push a named event that bypasses message history (e.g. context_usage). */
  pushEvent: (name: string, data: unknown) => void
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

/** One question within an AskUserQuestion tool_use. Mirrors the SDK's
 *  internal shape but narrowed so the frontend can rely on it. */
export interface QuestionSpec {
  question: string
  /** Short header/label for the question, shown as a chip in the UI. */
  header?: string
  multiSelect?: boolean
  options: Array<{
    label: string
    description?: string
    /** Preview body (markdown by default). SDK's toolConfig.askUserQuestion
     *  can flip this to HTML, but we don't set that option. */
    preview?: string
  }>
}

/** JSON-safe snapshot of a pending permission request OR interactive
 *  question. Permissions and questions ride on the same channel and
 *  the same pending map — they're both "SDK waiting on the user" events
 *  — but the frontend renders them with different components, so the
 *  `kind` discriminator matters. */
export type PermissionRequestSnapshot =
  | {
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      displayName?: string
      description?: string
      suggestions?: PermissionUpdate[]
      toolUseID: string
      createdAt: number
    }
  | {
      kind: 'question'
      id: string
      toolName: 'AskUserQuestion'
      /** Raw questions array as handed to the tool. The frontend renders
       *  one form per element; each is single- or multi-select. */
      questions: QuestionSpec[]
      toolUseID: string
      createdAt: number
    }

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

export interface Session {
  id: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
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
  /** Per-subscriber pushables for context_usage events — separate from
   *  message history so reconnects don't replay stale usage snapshots.
   *  Each WS subscriber gets its own pushable to avoid waiter overwrite
   *  when multiple tabs are connected to the same session. */
  contextUsageSubscribers: Set<Pushable<unknown>>
  /** AbortController whose signal races the pump's `iter.next()` so
   *  unload() can break a wedged generator without waiting for the SDK
   *  subprocess to exit. */
  abortController: AbortController
  /** Stored canUseTool callback for auto-resume. Reused when the Query
   *  exits cleanly and needs to be re-spawned without recreating the
   *  permission handling logic. */
  canUseTool?: CanUseTool
}

export interface SessionManagerOptions {
  historyCap?: number
  /** When set, session metadata is persisted here so dormant sessions
   *  survive restarts. See server/persistence.ts. */
  store?: SessionStore
  /** When set, global MCP server configs are available for merging
   *  into new sessions. See server/mcp-config.ts. */
  mcpConfigStore?: McpConfigStore
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
}

// Re-export HttpError from its canonical location so existing importers
// (session-manager.ts re-exports, etc.) continue to work during migration.
export { HttpError } from './errors.js'

