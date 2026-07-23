// Command result — the structured, host-rendered outcome a plugin returns.
//
// v1 supports: NoContent, Notification, Popover, Dialog. There is NO
// OpenView / iframe result (iframe Views are deferred). Content is restricted
// to plain text, safe Markdown, and key-value pairs — the host renders it
// through its existing safe Markdown path. Raw HTML is forbidden.
//
// A result carries the invocationId so the client can anchor a Popover to
// the message element captured at gesture time (see invocation-anchor-store).

export type PluginCommandResult =
  | PluginNoContentResult
  | PluginNotificationResult
  | PluginPopoverResult
  | PluginDialogResult

export interface PluginNoContentResult {
  type: 'none'
  invocationId: string
}

export type PluginResultContent = PluginTextContent | PluginMarkdownContent | PluginKeyValueContent

export interface PluginTextContent {
  kind: 'text'
  text: string
}
export interface PluginMarkdownContent {
  kind: 'markdown'
  /** Safe Markdown only — rendered through the host's sanitising renderer. */
  markdown: string
}
export interface PluginKeyValueContent {
  kind: 'key-value'
  items: Array<{ key: string; value: string }>
}

export interface PluginNotificationResult {
  type: 'notification'
  invocationId: string
  level: 'info' | 'success' | 'warn' | 'error'
  title?: string
  content?: PluginResultContent
  /** Auto-dismiss after ms. Undefined = default per level. */
  ttlMs?: number
}

export interface PluginPopoverResult {
  type: 'popover'
  invocationId: string
  title?: string
  content: PluginResultContent
  /** If false, the popover is not dismissible by clicking outside (e.g. an
   *  inline action is required). Default true. */
  dismissible?: boolean
}

export interface PluginDialogResult {
  type: 'dialog'
  invocationId: string
  title?: string
  content: PluginResultContent
  /** Dialog action buttons. The host renders them; clicking one POSTs back
   *  as a new command invocation with the chosen action id in the context.
   *  v1: an empty actions list renders a single "Close" button. */
  actions?: Array<{ id: string; label: string; style?: 'default' | 'primary' | 'danger' }>
}

// ── Errors ───────────────────────────────────────────────────────────
//
// A failed command (timeout, plugin crash, permission denial, session
// cleared mid-flight) is NOT a PluginCommandResult — it's an HTTP error
// from the route with a typed code the client maps to a diagnostic. Keep
// the codes stable; the client branches on them.

export type PluginCommandErrorCode =
  | 'plugin-not-enabled'
  | 'plugin-quarantined'
  | 'permission-denied'
  | 'activation-timeout'
  | 'command-timeout'
  | 'command-cancelled'
  | 'plugin-crashed'
  | 'session-cleared'
  | 'disabled'
  | 'rpc-error'
  | 'unknown'

export interface PluginCommandError {
  code: PluginCommandErrorCode
  message: string
}
