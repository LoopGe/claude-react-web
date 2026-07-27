// Public type surface for @claude-react-web/plugin-api.
//
// These mirror the host's `shared/app-plugins/` contract (the wire shapes a
// plugin sends/receives). They are curated + self-contained so the published
// package has no cross-repo type imports. Keep in sync with
// `shared/app-plugins/` when the wire protocol changes.

// ── Manifest (for authoring crw-plugin.json — optional, authors may write
//    the JSON directly; importing these types gives type-checking if they
//    generate the manifest from TS) ────────────────────────────────────

export type AppPluginPermission =
  | 'storage' | 'network.fetch' | 'ai.request'
  | 'sessions.read' | 'sessions.send' | 'sessions.interrupt'
  | 'messages.selectedText' | 'git.read' | 'git.write'
  | 'workspace.read' | 'workspace.write' | 'secrets.read' | 'secrets.write'
  | 'ui.notifications' | 'ui.popovers' | 'ui.dialogs'
  | 'ui.clipboard' | 'ui.openExternal' | 'process.execute'

export interface PermissionParams {
  /** For network.fetch: declared hosts (`api.example.com`, `*.example.com`). */
  hosts?: string[]
  purpose?: string
}

export type PermissionSpec =
  | AppPluginPermission
  | { permission: AppPluginPermission; params?: PermissionParams }

export interface PluginManifest {
  manifestVersion: 1
  id: string
  name: string
  description?: string
  version: string
  publisher?: string
  license?: string
  engines: { claudeReactWeb: string; pluginApi?: string; node: string }
  runtime: { service: string }
  activationEvents?: string[]
  permissions: PermissionSpec[]
  contributes: {
    commands?: unknown[]
    contextMenus?: unknown[]
    actions?: unknown[]
    configuration?: { properties: unknown[] }
  }
}

// ── Command context (what executeCommand receives) ───────────────────

export interface BaseCommandContext {
  invocationId: string
  commandId: string
  invokedAt: number
}

export interface GlobalCommandContext extends BaseCommandContext { source: 'global' }
export interface SessionCommandContext extends BaseCommandContext {
  source: 'session'
  sessionId: string
  session: { provider: string; cwd: string; model?: string }
}
export interface MessageCommandContext extends BaseCommandContext {
  source: 'message'
  sessionId: string
  messageId: string
  message: { role: 'user' | 'assistant' | 'system' | 'tool'; contentBlockType: 'text' | 'code' | 'thinking' | 'tool-use' | 'tool-result' }
}
export interface MessageSelectionCommandContext extends BaseCommandContext {
  source: 'message-selection'
  sessionId: string
  messageId: string
  message: { role: 'user' | 'assistant' | 'system' | 'tool'; contentBlockType: 'text' | 'code' | 'thinking' | 'tool-use' | 'tool-result' }
  selection: { text: string; length: number; truncated: boolean }
}
export interface GitFileCommandContext extends BaseCommandContext {
  source: 'git.file'
  sessionId: string
  path: string
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflicted'
}

export type PluginCommandContext =
  | GlobalCommandContext
  | SessionCommandContext
  | MessageCommandContext
  | MessageSelectionCommandContext
  | GitFileCommandContext

// ── Command result (what executeCommand returns) ─────────────────────

export type PluginResultContent =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'key-value'; items: Array<{ key: string; value: string }> }

export type PluginCommandResult =
  | { type: 'none'; invocationId: string }
  | { type: 'notification'; invocationId: string; level: 'info' | 'success' | 'warn' | 'error'; title?: string; content?: PluginResultContent; ttlMs?: number }
  | { type: 'popover'; invocationId: string; title?: string; content: PluginResultContent; dismissible?: boolean }
  | { type: 'dialog'; invocationId: string; title?: string; content: PluginResultContent; actions?: Array<{ id: string; label: string; style?: 'default' | 'primary' | 'danger' }> }

// ── Host API method types ────────────────────────────────────────────

export type StorageScope = 'global' | 'workspace' | 'cache'

export interface NetworkFetchOptions {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  timeoutMs?: number
}
export interface NetworkFetchResult {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

export interface AiRequestOptions {
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

export interface SessionMetadata {
  provider: string
  cwd: string
  model?: string
}

export interface GitReadOptions {
  op: 'status' | 'diff' | 'log'
  path?: string
  limit?: number
}

// ── Lifecycle ────────────────────────────────────────────────────────

export interface ActivateContext {
  pluginId: string
  version: string
  dataDir: string
  permissions: string[]
  configuration: Record<string, unknown>
}

export type DeactivateReason = 'disable' | 'uninstall' | 'shutdown' | 'reload'

export interface ExecuteCommandRequest {
  invocationId: string
  commandId: string
  context: PluginCommandContext
  host: Host
}

// The Host API surface (passed to executeCommand). Each method is a typed
// wrapper around the JSON-RPC call into the host; the host enforces
// permissions + schema per call.
export interface Host {
  storage: {
    get(scope: StorageScope, key: string): Promise<{ value: unknown } | { found: false }>
    set(scope: StorageScope, key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string; quota?: boolean }>
    delete(scope: StorageScope, key: string): Promise<{ ok: true } | { ok: false; error: string }>
  }
  network: {
    fetch(opts: NetworkFetchOptions): Promise<NetworkFetchResult>
  }
  ai: {
    request(opts: AiRequestOptions): Promise<AiRequestResult>
  }
  sessions: {
    read(sessionId: string): Promise<SessionMetadata | null>
    send(sessionId: string, text: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
  }
  git: {
    read(sessionId: string, opts: GitReadOptions): Promise<unknown>
  }
  workspace: {
    read(sessionId: string, path: string): Promise<string>
    write(sessionId: string, path: string, content: string): Promise<void>
  }
  secrets: {
    get(key: string): Promise<{ value: string } | { found: false }>
    set(key: string, value: string): Promise<void>
  }
  ui: {
    clipboard(text: string): Promise<void>
    openExternal(url: string): Promise<{ ok: true }>
  }
  log: {
    error(message: string): Promise<void>
    warn(message: string): Promise<void>
    info(message: string): Promise<void>
    debug(message: string): Promise<void>
    trace(message: string): Promise<void>
  }
}
