// WebSocket wire protocol — canonical generic definitions.
//
// This file defines the frame shapes shared between server and client.
// Payload types are generic parameters so the server can use full
// SDKMessage/PermissionRequestSnapshot/PermissionDecisionSummary typing
// while the browser uses `unknown` / its own stripped types.
//
// Design principles (see server/ws-protocol.ts for the full write-up):
// - ONE WS connection per browser tab, multiplexed by `kind`.
// - Inbound: subscribe / unsubscribe / ping. User turns go through REST.
// - Outbound: self-describing frames with no stream-order dependency.

// --- inbound (client → server) -----------------------------------------------

/** Ask the server to start streaming events for `sessionId` on this
 *  connection. The server responds with a `replay` frame (possibly empty)
 *  followed by a `replay-done`, then live frames as they arrive.
 *
 *  When `sinceUuid` is set, the server sends only messages after the one
 *  with that UUID (incremental sync). If the UUID is not found in the
 *  session's history ring (too old / evicted), the server falls back to
 *  a full replay. Clients should omit `sinceUuid` on reconnects where
 *  they cannot guarantee cache continuity. */
export interface WsSubscribe {
  kind: 'subscribe'
  sessionId: string
  sinceUuid?: string
}

/** Stop streaming events for `sessionId`. Safe to call even if not
 *  currently subscribed. */
export interface WsUnsubscribe {
  kind: 'unsubscribe'
  sessionId: string
}

/** Heartbeat from the client. Server echoes a `pong`. */
export interface WsPing {
  kind: 'ping'
  /** Opaque correlation value — echoed back in `pong`. */
  nonce?: number
}

export type WsClientFrame = WsSubscribe | WsUnsubscribe | WsPing

// --- outbound (server → client) ----------------------------------------------

/** Initial session list snapshot + subsequent updates. */
export interface WsSessionsSnapshot<Session> {
  kind: 'sessions-snapshot'
  sessions: Session[]
}
export interface WsSessionUpdate<Session> {
  kind: 'session-update'
  session: Session
}
export interface WsSessionCreated<Session> {
  kind: 'session-created'
  session: Session
}
export interface WsSessionRemoved {
  kind: 'session-removed'
  id: string
}
/** Global permission-request mirror — fired alongside per-session
 *  `permission-request` so App-level code can notify even when the
 *  session's Chat panel isn't mounted. */
export interface WsGlobalPermissionRequest<Perm> {
  kind: 'global-permission-request'
  sessionId: string
  request: Perm
}

/** Beginning of a per-session replay burst. Contains the full message
 *  history + any pending permissions, then a terminator frame. */
export interface WsReplay<Msg, Perm> {
  kind: 'replay'
  sessionId: string
  /** SDK messages already emitted to the session, in order. */
  messages: Msg[]
  /** Still-outstanding permission requests for this session. */
  permissions: Perm[]
}
export interface WsReplayDone<Perm> {
  kind: 'replay-done'
  sessionId: string
  /** When the server uses chunked replay (>50 messages), permissions
   *  ride on the final replay-done frame instead of the first replay
   *  chunk. Older clients ignore unknown fields, so this is safe. */
  permissions?: Perm[]
}

/** Live SDK message. */
export interface WsMessage<Msg> {
  kind: 'message'
  sessionId: string
  message: Msg
}
/** New tool-permission request. */
export interface WsPermissionRequest<Perm> {
  kind: 'permission-request'
  sessionId: string
  payload: Perm
}
/** Canonical shape for a permission decision summary. Both server
 *  (PermissionDecisionSummary) and client use this as the Decision
 *  type parameter. Defined here to avoid cross-importing between
 *  server/ and src/. */
export interface PermissionDecision {
  behavior: 'allow' | 'deny'
  persisted: boolean
  message?: string
}

/** Existing request was resolved (by this tab or another). */
export interface WsPermissionResolved<Decision> {
  kind: 'permission-resolved'
  sessionId: string
  id: string
  decision: Decision
}
/** Fresh context-usage snapshot pushed from the server. Shape is
 *  deliberately `unknown` — the frontend treats it as opaque JSON. */
export interface WsContextUsage {
  kind: 'context-usage'
  sessionId: string
  usage: unknown
}

/** Heartbeat reply. */
export interface WsPong {
  kind: 'pong'
  nonce?: number
}

/** A server-generated error response for a specific inbound frame
 *  (e.g. subscribed to an unknown session). The client can surface this
 *  without tearing down the connection. */
export interface WsError {
  kind: 'error'
  message: string
  /** Best-effort echo of the sessionId involved, when applicable. */
  sessionId?: string
}

export type WsServerFrame<Session, Msg, Perm, Decision> =
  | WsSessionsSnapshot<Session>
  | WsSessionUpdate<Session>
  | WsSessionCreated<Session>
  | WsSessionRemoved
  | WsGlobalPermissionRequest<Perm>
  | WsReplay<Msg, Perm>
  | WsReplayDone<Perm>
  | WsMessage<Msg>
  | WsPermissionRequest<Perm>
  | WsPermissionResolved<Decision>
  | WsContextUsage
  | WsPong
  | WsError

/** WebSocket endpoint mounted on the Hono HTTP server. Kept as a
 *  constant so tests and tools all refer to the same path. */
export const WS_PATH = '/api/ws'
