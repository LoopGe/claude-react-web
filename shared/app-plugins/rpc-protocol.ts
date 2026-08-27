// JSON-RPC 2.0 over stdio framing for the App Plugin subprocess.
//
// One subprocess per activated plugin. stdout carries ONLY protocol frames
// (newline-delimited JSON); stderr is captured, rate-limited, and exposed
// as plugin logs. The host (parent) and plugin (child) are symmetric peers:
// both send requests and notifications, both respond to requests.
//
// This module defines the wire shapes and the method catalog. The actual
// framing/peer implementation lives in server/app-plugins/rpc-peer.ts
// (parent side) and is re-implemented by the plugin SDK contract (child
// side). Both must agree on these types.

// ── JSON-RPC 2.0 envelope ────────────────────────────────────────────

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: P
}
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: P
}
export interface JsonRpcSuccessResult<R = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result: R
}
export interface JsonRpcErrorResult {
  jsonrpc: '2.0'
  id: number | string
  error: { code: number; message: string; data?: unknown }
}
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResult
  | JsonRpcErrorResult

// ── Standard error codes (JSON-RPC + our app codes) ──────────────────

export const RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // App codes (>= -32099)
  PERMISSION_DENIED: -32001,
  TIMEOUT: -32002,
  CANCELLED: -32003,
  QUOTA_EXCEEDED: -32004,
} as const

// ── Method catalog ───────────────────────────────────────────────────
//
// Host → plugin (the lifecycle + command methods). Params/result shapes
// are spelled out so both sides typecheck against the same contract.

export interface ActivateParams {
  pluginId: string
  version: string
  /** Path to the plugin's own data directory (<stateDir>/app-plugins/data/<id>). */
  dataDir: string
  /** Granted permissions (normalised). The plugin should gate its Host API
   *  requests to these — the host re-checks anyway, but early client-side
   *  gating avoids a round-trip denial. */
  permissions: string[]
  /** Declared configuration values (defaults applied). */
  configuration: Record<string, unknown>
}
export type ActivateResult = { ok: true } | { ok: false; error: string }

export interface DeactivateParams {
  reason: 'disable' | 'uninstall' | 'shutdown' | 'reload'
}
export type DeactivateResult = { ok: true } | { ok: false; error: string }

export interface ExecuteCommandParams {
  invocationId: string
  commandId: string
  /** Serialised PluginCommandContext (command-context.ts). `unknown` here so
   *  the peer validates the shape at runtime per the command's declared
   *  category — the host has already built and signed it. */
  context: unknown
}
export type ExecuteCommandResult = unknown // PluginCommandResult, validated host-side on return

export interface CancelParams {
  invocationId: string
}

// Plugin → host (the Host API). Each maps to a host adapter that checks
// permissions + schema before fulfilling.

export interface StorageGetParams { scope: 'global' | 'workspace' | 'cache'; key: string }
export type StorageGetResult = { value: unknown } | { found: false }

export interface StorageSetParams {
  scope: 'global' | 'workspace' | 'cache'
  key: string
  value: unknown
}
export type StorageSetResult = { ok: true } | { ok: false; error: string; quota?: boolean }

export interface StorageDeleteParams { scope: 'global' | 'workspace' | 'cache'; key: string }
export type StorageDeleteResult = { ok: true } | { ok: false; error: string }

export interface NetworkFetchParams {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  /** Max response bytes (capped by broker). */
  maxBytes?: number
  timeoutMs?: number
}
export interface NetworkFetchResult {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

export interface AiRequestParams {
  purpose: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  model?: string
  maxTokens?: number
}
export interface AiRequestResult {
  content: string
  model: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface SessionReadParams { sessionId: string }
export interface SessionSendParams { sessionId: string; text: string }
export interface SessionInterruptParams { sessionId: string }

/** Coarse per-session activity snapshot for background watchers — never the
 *  transcript. One entry per live session, carrying lifecycle + usage signals
 *  a polling plugin needs (pick an idle session to compact). */
export interface SessionActivity {
  sessionId: string
  provider: string
  cwd?: string
  model?: string
  running: boolean
  terminated: boolean
  slept?: boolean
  /** Pending user turns (messages sent but no matching `result` yet). */
  pendingTurns: number
  /** Number of unanswered tool-permission prompts (0 = none). */
  pendingPermissions: number
  /** Epoch ms of last activity (any user turn / SDK result / interrupt). */
  lastActivityAt: number
  /** Epoch ms when the current turn started, present only while working. */
  workingSince?: number
  /** Number of messages in the in-memory history ring. */
  historyLength: number
}
export type SessionListResult = SessionActivity[]

export interface SessionContextUsageParams { sessionId: string }
/** Cached context-usage snapshot for the session (`session.lastContextUsage`),
 *  or null when the session is unknown or has no snapshot yet. Shape mirrors
 *  `LiteContextUsage` in server/session-pump.ts. */
export type SessionContextUsageResult = {
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  autoCompactThreshold?: number
} | null

export interface SessionCompactParams { sessionId: string }
/** The compact succeeded: the conversation was summarised and swapped to a
 *  fresh session `sessionId` carrying the summary forward. */
export type SessionCompactResult = { ok: true; sessionId: string }

/** The plugin's own validated configuration (defaults applied). */
export type ConfigGetResult = Record<string, unknown>

export interface GitReadParams { sessionId: string; op: 'status' | 'diff' | 'log' }
export type GitReadResult = unknown

export interface LogParams { level: 'error' | 'warn' | 'info' | 'debug' | 'trace'; message: string }

/** All Host API method names. The peer rejects any method not in this set. */
export const HOST_METHODS = [
  'storage.get',
  'storage.set',
  'storage.delete',
  'network.fetch',
  'ai.request',
  'sessions.read',
  'sessions.send',
  'sessions.interrupt',
  'sessions.list',
  'sessions.contextUsage',
  'sessions.compact',
  'config.get',
  'git.read',
  'workspace.read',
  'workspace.write',
  'secrets.read',
  'secrets.write',
  'ui.clipboard',
  'ui.openExternal',
  'log',
] as const
export type HostMethod = (typeof HOST_METHODS)[number]

/** Plugin→host notification: a widget push. This is a child-originated
 *  notification (not a host method), so it is NOT in HOST_METHODS. The host
 *  validates params via parseStatGridPayload before forwarding. */
export interface AppEventParams {
  widgetId: string
  payload: unknown
}
