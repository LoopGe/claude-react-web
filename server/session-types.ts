// Type definitions extracted from session-manager.ts for modularity.
// This file contains all public/internal interfaces and types.

import type {
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
import { HISTORY_CAP } from './config.js'

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
}

/** Metadata returned by list() / get(). */
export interface SessionInfo {
  id: string
  createdAt: number
  lastActivityAt: number
  subscribers: number
  messageCount: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  running: boolean
  terminated: boolean
  error?: string
  /** True when the SDK is mid-turn (a user message has been sent and no
   *  matching `result` has arrived yet). Drives the "thinking" animation. */
  working: boolean
  /** Epoch ms when the current turn started (first pending turn). Only set
   *  while `working` is true; allows the client to compute an accurate
   *  elapsed timer that survives component remounts. */
  workingSince?: number
  /** Epoch ms of the last completed turn (last `result` message). The
   *  frontend diffs this against a locally-remembered value to decide
   *  whether to show an unread badge on non-focused sessions. */
  lastTurnAt?: number
  /** User pinned this session — sticks to the top of the sidebar and
   *  survives the 3-panel eviction rule. */
  pinned?: boolean
}

export interface Session {
  id: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  pinned?: boolean
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
  error?: string
  /** Pending turns (user messages sent but no matching `result` yet). A
   *  simple counter rather than a set because we don't need to identify
   *  which specific turn is outstanding — just whether ANY is. */
  pendingTurns: number
  /** Epoch ms when the first pending turn started. Cleared when all turns
   *  complete (pendingTurns drops to 0) or the session terminates. */
  workingSince?: number
  /** Timestamp of the last `result` message, used for the unread badge. */
  lastTurnAt?: number
  /** Pushable for context_usage events — separate from message history
   *  so reconnects don't replay stale usage snapshots. */
  contextUsagePushable: Pushable<unknown>
}

export interface SessionManagerOptions {
  idleMs?: number
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

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Re-export for convenience — all session types come from this module. */
export { HISTORY_CAP }
