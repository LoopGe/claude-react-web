// Frontend-visible types. Kept minimal — we avoid importing the SDK in the
// browser bundle and instead rely on `unknown`-shaped messages that the UI
// renders defensively.

import type { SessionInfoBase } from '../shared/session-info'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]

/** Field shape is defined once in shared/session-info.ts and instantiated
 *  here with the client's PermissionMode union. Server uses the SDK's
 *  PermissionMode; both project to the same JSON. */
export type SessionInfo = SessionInfoBase<PermissionMode>

/** A session discoverable on disk via the /resume picker. Mirrors the
 *  server's ResumableSession (server/session-types.ts) — manual mirror,
 *  no automated drift check (same convention as ws-types). Spans both
 *  sessions this app tracks (`known`) and CLI-created ones it doesn't. */
export interface ResumableSession {
  sessionId: string
  title?: string
  firstPrompt?: string
  cwd?: string
  createdAt?: number
  lastModified: number
  gitBranch?: string
  known: boolean
  running: boolean
  terminated: boolean
}

/** A named collection of sessions for quick group switching. Each session
 *  belongs to at most one group (exclusive membership). Sessions not in any
 *  group are "ungrouped" and appear in a separate sidebar section. Each
 *  group holds at most `maxOpen` sessions. Order of sessionIds determines
 *  activation priority (first MAX_OPEN are opened). */
export interface SessionGroup {
  id: string
  name: string
  sessionIds: string[]
  /** Remembered column ratios when the group was last active. */
  panelRatios?: Record<string, number>
}

/** Discriminated union for sidebar section rendering. */
export type SidebarSection =
  | { kind: 'group'; group: SessionGroup; sessions: SessionInfo[] }
  | { kind: 'ungrouped'; sessions: SessionInfo[] }

/** Shape of Options we expose in the "new session" form. */
export interface NewSessionForm {
  cwd?: string
  model?: string
  systemPrompt?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  allowedTools?: string[]
  disallowedTools?: string[]
  title?: string
  /** Anthropic beta flags forwarded verbatim to the SDK. Use this to opt
   *  into extended windows such as the 1M context beta for Sonnet 4/4.5. */
  betas?: string[]
  // Advanced options
  additionalDirectories?: string[]
  fallbackModel?: string
  maxBudgetUsd?: number
  thinking?: 'adaptive' | 'enabled' | 'disabled' | { type: 'enabled'; budgetTokens: number }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  tools?: string[]
  /** Names of global MCP servers to enable for this session. */
  enabledMcpServers?: string[]
  // Advanced (JSON blobs — rendered as <textarea> and parsed on submit)
  mcpServers?: unknown
  /** Frontend-only: chosen accent hex (from theme ACCENT_COLORS). Not
   *  sent to the server — stored in localStorage keyed by the returned
   *  session id once creation succeeds. */
  accent?: string
  /** Frontend-only: target group for the new session. Required. */
  groupId?: string
}

export interface ModelInfo {
  id: string
  display_name?: string
  description?: string
}

/** A slash command exposed by the SDK (e.g. /help, /clear). */
export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}

/** A plugin loaded by the SDK. */
export interface Plugin {
  name: string
  path: string
  source?: string
}

/** An agent exposed by the SDK. */
export interface AgentInfo {
  name: string
  description: string
  model?: string
}

/** Per-skill token usage from context-usage. */
export interface SkillFrontmatter {
  name: string
  source: string
  tokens: number
}

/** A registered marketplace. */
export interface MarketplaceInfo {
  name: string
  source: string
  lastUpdated?: string
  autoUpdate?: boolean
}

/** A plugin available in a marketplace. */
export interface MarketplacePlugin {
  name: string
  description: string
  version: string
  author?: string
  installed: boolean
  /** Only meaningful when `installed` is true. Defaults to true server-side
   *  when the CLI doesn't expose an explicit flag (most installed plugins
   *  are enabled — disabled is the explicit, less common state). */
  enabled: boolean
  marketplace: string
}

// Re-export canonical QuestionSpec from shared.
export type { QuestionSpec } from '../shared/question-spec.js'

// Re-export canonical PermissionRequest from shared.
// Client instantiates with unknown[] for suggestions (opaque to the UI).
import type { PermissionRequestBase } from '../shared/permission-request.js'
export type PermissionRequest = PermissionRequestBase<unknown[]>

/** Broadcast envelope for a resolved permission. */
export interface PermissionResolved {
  id: string
  behavior: 'allow' | 'deny'
  persisted: boolean
  message?: string
}

/** Subset of SDK message shapes we actually render in the Chat panel. */
export interface SdkMessage {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  /** Wall-clock ms when the server first observed this message (stamped in
   *  session-pump / pushToSession before it enters the history ring). Travels
   *  with the message over both replay and live WS frames. Absent for
   *  messages restored from the CLI's on-disk log after a server restart —
   *  the UI hides the timestamp when undefined rather than guessing. */
  receivedAt?: number
  /** Wall-clock ms when the SDK actually read this user message off its input
   *  queue (i.e. started processing the turn), as opposed to `receivedAt`
   *  which is when the server accepted it over HTTP. The gap is how long the
   *  turn sat queued behind an in-flight turn. Stamped server-side onto the
   *  same object in the history ring, so it rides along on replay — a
   *  reconnecting client sees it already set on consumed messages. Only
   *  meaningful on top-level user messages; absent (undefined) means the
   *  message is still queued and hasn't been picked up yet. */
  consumedAt?: number
  // `message` is present on user/assistant. For user: { role: 'user', content: string }.
  // For assistant: { role: 'assistant', content: ContentBlock[] } (Anthropic SDK shape).
  message?: {
    role?: string
    content?: unknown
  }
  // `stream_event` partials have `event`
  event?: unknown
  error?: string
  // result messages
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
  /** Why the turn ended. Optional on both `success` and `error_*` SDK
   *  `result` messages (the SDK declares it on both result variants). The
   *  two `aborted_*` values mean the user interrupted the turn — the UI
   *  renders those as an interrupted (⊘) result instead of a completed
   *  (✓) one. This rides along on the message itself, so it survives
   *  Virtuoso unmount/remount (unlike the old transient ref-based flag). */
  terminal_reason?:
    | 'blocking_limit'
    | 'rapid_refill_breaker'
    | 'prompt_too_long'
    | 'image_error'
    | 'model_error'
    | 'aborted_streaming'
    | 'aborted_tools'
    | 'stop_hook_prevented'
    | 'hook_stopped'
    | 'tool_deferred'
    | 'max_turns'
    | 'completed'
  stop_reason?: string | null
  [k: string]: unknown
}

// ── Content Block ────────────────────────────────────────────────

/** A single content block within an SDK message's content array.
 *  Used by MessageList, ToolUseBlock, and the session-store normalisers
 *  for rendering and tool/plan/subagent extraction. */
export interface Block {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  [k: string]: unknown
}

// ── Image Paste ──────────────────────────────────────────────────

export interface PastedImage {
  id: string
  data: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  width: number
  height: number
  size: number
  previewUrl: string
}

// ── MCP Server Status ─────────────────────────────────────────────

export interface McpServerTool {
  name: string
  description?: string
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean }
}

export interface McpServerStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: { name?: string; version?: string }
  error?: string
  scope?: string
  config?: unknown
  tools?: McpServerTool[]
}

// ── Global MCP Config ─────────────────────────────────────────────

/** API-safe representation of a stored global MCP server (secrets masked). */
export interface McpServerConfigMeta {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  alwaysLoad?: boolean
  enabled?: boolean
  createdAt: number
  updatedAt: number
  envKeys?: string[]
  headerKeys?: string[]
}

export type { McpServerInput } from '../shared/mcp-types'

// ── Session Recap ─────────────────────────────────────────────────

export interface RecapStats {
  messageCount: number
  userTurns: number
  assistantTurns: number
  totalCostUsd: number
  durationMs: number
  toolsUsed: string[]
}

export interface RecapResponse {
  summary: string
  stats: RecapStats
  cached: boolean
  generatedAt: number
  fallback?: boolean
}

// ── Marketplace (homegrown /api/mp) ───────────────────────────────
//
// UI mirror of the server-side types. Intentionally NOT imported from
// the server module — the browser bundle stays free of node-specific
// imports. Drift is bounded because both sides project to the same JSON
// shape; the wire layer is the source of truth.

export interface MpSource {
  type: 'https'
  url: string
  ref?: string
}

/** Marketplace summary returned by GET /mp/marketplaces. The cached
 *  manifest is intentionally omitted to keep the list response small;
 *  per-plugin data lives behind GET /mp/marketplaces/:id/plugins. */
export interface MpListItem {
  id: string
  displayName: string
  source: MpSource
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
  manifestVersion?: string
  ownerName?: string
}

/** Plugin entry as surfaced by the marketplace plugins endpoint. */
export interface MpPluginInfo {
  name: string
  description?: string
  version?: string
  author?: string
  category?: string
  tags?: string[]
  enabled: boolean
}

/** Non-fatal warning surfaced by the manifest parser. The UI displays
 *  these next to the marketplace so the user knows when a plugin was
 *  silently dropped. */
export interface MpParseWarning {
  kind: 'plugin-missing-name' | 'plugin-dir-not-found' | 'plugin-invalid-name' | 'plugin-bad-shape'
  detail: string
}
