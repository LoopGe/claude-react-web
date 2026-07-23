// Command context — the structured, host-sanitised payload a plugin receives
// when one of its commands is invoked.
//
// The host builds this from the user's gesture (palette pick, context-menu
// click, header action) and the current UI state, then POSTs it to
// /api/app-plugins/:id/commands/:commandId. The plugin never receives raw
// DOM nodes, React state, or session history beyond what is explicitly
// declared here. Selection context in particular is a SINGLE-GESTURE
// capability: only the text the user just selected, never the whole message
// or transcript.

// ── Shared envelope ──────────────────────────────────────────────────

export type PluginCommandContext =
  | GlobalCommandContext
  | SessionCommandContext
  | MessageCommandContext
  | MessageSelectionCommandContext
  | GitFileCommandContext

interface BaseCommandContext {
  /** Server-generated, globally unique. Echoed back in the result so the
   *  client can locate its invocation anchor. */
  invocationId: string
  /** The plugin command id (`<pluginId>.<name>`). */
  commandId: string
  /** ms epoch when the host created the gesture. */
  invokedAt: number
}

export interface GlobalCommandContext extends BaseCommandContext {
  source: 'global'
}

export interface SessionCommandContext extends BaseCommandContext {
  source: 'session'
  sessionId: string
  /** Coarse session metadata only — never the transcript. */
  session: { provider: string; cwd: string; model?: string }
}

export interface MessageCommandContext extends BaseCommandContext {
  source: 'message'
  sessionId: string
  messageId: string
  message: {
    role: 'user' | 'assistant' | 'system' | 'tool'
    contentBlockType: 'text' | 'code' | 'thinking' | 'tool-use' | 'tool-result'
  }
}

export interface MessageSelectionCommandContext extends BaseCommandContext {
  source: 'message-selection'
  sessionId: string
  messageId: string
  message: {
    role: 'user' | 'assistant' | 'system' | 'tool'
    contentBlockType: 'text' | 'code' | 'thinking' | 'tool-use' | 'tool-result'
  }
  selection: {
    text: string
    length: number
    truncated: boolean
  }
}

export interface GitFileCommandContext extends BaseCommandContext {
  source: 'git.file'
  sessionId: string
  /** Repo-relative path, already validated by server/git.ts helpers. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflicted'
}

// ── Selection construction limits ────────────────────────────────────
//
// The client builds the selection text from window.getSelection(); the host
// caps it before sending. Constants live in validation.ts (LIMITS). A
// selection spanning more than one message boundary is rejected client-side
// (no context is sent at all) — see invocation-anchor-store + MessageList
// wiring.
