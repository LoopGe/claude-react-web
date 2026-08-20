// MCP elicitation — canonical shared shapes.
//
// Mirrors the SDK's `onElicitation` callback surface (ElicitationRequest /
// ElicitResult) in browser-safe form: no Node or SDK imports, so both the
// server (broker snapshots, REST payloads, WS frames) and the client (dialog
// rendering) instantiate these directly. Style follows
// shared/permission-request.ts.

/** A pending MCP elicitation request as shown in the UI.
 *
 *  `id` is minted server-side from the SDK's (optional) `elicitationId`,
 *  falling back to a random UUID, and stays stable across the WS broadcast,
 *  the REST snapshot, and the decide round-trip. Note that resolving the
 *  SDK's `onElicitation` promise IS the answer — the id is only a UI-side
 *  correlation key (plus matching the later `elicitation_complete` system
 *  message when the SDK emits one). */
export interface ElicitationRequestUi {
  id: string
  serverName: string
  message: string
  /** 'url' → OAuth-style authorization link; 'form' → fields derived from
   *  `requestedSchema`. Absent → plain message with accept/decline/cancel. */
  mode?: 'form' | 'url'
  url?: string
  title?: string
  displayName?: string
  description?: string
  requestedSchema?: Record<string, unknown>
  createdAt: number
}

/** Decision returned to the SDK. Mirrors MCP's ElicitResult: `action` is
 *  required; `content` carries form answers (values restricted to
 *  string | number | boolean | string[], enforced by the decide route). */
export interface ElicitationDecision {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}
