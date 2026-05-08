// Frontend-visible types. Kept minimal — we avoid importing the SDK in the
// browser bundle and instead rely on `unknown`-shaped messages that the UI
// renders defensively.

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

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
}

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
}

export interface ModelInfo {
  id: string
  display_name?: string
  description?: string
}

/** Pending tool-use permission request, mirrored from the server. */
export interface PermissionRequest {
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
