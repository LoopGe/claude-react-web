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
