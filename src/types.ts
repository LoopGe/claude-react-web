// Frontend-visible types. Kept minimal — we avoid importing the SDK in the
// browser bundle and instead rely on `unknown`-shaped messages that the UI
// renders defensively.

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]

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
  /** Server-reported: the SDK is mid-turn. Drives the "thinking" dot. */
  working: boolean
  /** Epoch ms of last completed turn. Used to flag unread. */
  lastTurnAt?: number
  /** User pinned this session — sticks to the top of the sidebar. */
  pinned?: boolean
}

/** A named collection of sessions for quick group switching. Sessions
 *  can belong to multiple groups (Tag semantics). Order of sessionIds
 *  determines activation priority (first MAX_OPEN are opened). */
export interface SessionGroup {
  id: string
  name: string
  sessionIds: string[]
  /** Remembered column ratios when the group was last active. */
  panelRatios?: Record<string, number>
}

/** Discriminated union for sidebar section rendering. */
export type SidebarSection =
  | { kind: 'pinned'; sessions: SessionInfo[] }
  | { kind: 'group'; group: SessionGroup; sessions: SessionInfo[] }

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
  // Advanced (JSON blobs — rendered as <textarea> and parsed on submit)
  mcpServers?: unknown
  plugins?: unknown
  sandbox?: unknown
  thinking?: unknown
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
  skills?: string[] | 'all'
  includePartialMessages?: boolean
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

/** One question within an AskUserQuestion tool call. */
export interface QuestionSpec {
  question: string
  header?: string
  multiSelect?: boolean
  options: Array<{
    label: string
    description?: string
    preview?: string
  }>
}

/** Pending event routed on the permission channel. The server uses a
 *  `kind` discriminator to send both tool-permission prompts and
 *  interactive AskUserQuestion calls through the same channel — they
 *  both mean "SDK paused, waiting on the user" — but each kind renders
 *  with its own dialog. */
export type PermissionRequest =
  | {
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      displayName?: string
      description?: string
      suggestions?: unknown[] // SDK PermissionUpdate[] — opaque to the UI
      toolUseID: string
      createdAt: number
    }
  | {
      kind: 'question'
      id: string
      toolName: 'AskUserQuestion'
      questions: QuestionSpec[]
      toolUseID: string
      createdAt: number
    }

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
