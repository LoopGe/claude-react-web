// WebSocket wire protocol, imported by both the server multiplexer
// (server/ws.ts) and the client hub (src/hooks/useWsHub.ts). Keeping the
// types co-located avoids accidental drift.
//
// Design principles:
// - ONE WS connection per browser tab. All session messages, permission
//   events, context-usage snapshots, and the global session list ride on
//   this connection multiplexed by a `kind` discriminator.
// - Inbound (client → server) only has a few control verbs: subscribe /
//   unsubscribe a session, and ping. Actual user turns still go through
//   REST (POST /sessions/:id/messages) so the WS path stays a pure fan-
//   out channel — sending over WS would force us to duplicate all the
//   input validation and error-reporting machinery the REST layer
//   already has.
// - Outbound (server → client) is the union of everything the SSE
//   routes used to emit, flattened so each frame carries its own
//   sessionId (for per-session events) or none (for global events).
// - Every outbound frame is self-describing — there's no stream-order
//   dependency, so a client subscribing mid-session just gets a fresh
//   `replay` followed by live events, identical to the SSE behaviour.

import type {
  PermissionDecisionSummary,
  PermissionRequestSnapshot,
  SessionInfo,
} from './session-manager.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

// --- inbound (client → server) -----------------------------------------------

/** Ask the server to start streaming events for `sessionId` on this
 *  connection. The server responds with a `replay` frame (possibly empty)
 *  followed by a `replay-done`, then live frames as they arrive. */
export interface WsSubscribe {
  kind: 'subscribe'
  sessionId: string
}

/** Stop streaming events for `sessionId`. Safe to call even if not
 *  currently subscribed. */
export interface WsUnsubscribe {
  kind: 'unsubscribe'
  sessionId: string
}

/** Heartbeat from the client. Server echoes a `pong`. Browsers auto-kill
 *  idle WebSockets through some middleboxes; a 20-30s app-level ping
 *  keeps the connection alive across them. */
export interface WsPing {
  kind: 'ping'
  /** Opaque correlation value — echoed back in `pong`. */
  nonce?: number
}

export type WsClientFrame = WsSubscribe | WsUnsubscribe | WsPing

// --- outbound (server → client) ----------------------------------------------

/** Initial session list snapshot + subsequent updates. */
export interface WsSessionsSnapshot {
  kind: 'sessions-snapshot'
  sessions: SessionInfo[]
}
export interface WsSessionUpdate {
  kind: 'session-update'
  session: SessionInfo
}
export interface WsSessionCreated {
  kind: 'session-created'
  session: SessionInfo
}
export interface WsSessionRemoved {
  kind: 'session-removed'
  id: string
}
/** Global permission-request mirror — fired alongside per-session
 *  `permission-request` so App-level code can notify even when the
 *  session's Chat panel isn't mounted. */
export interface WsGlobalPermissionRequest {
  kind: 'global-permission-request'
  sessionId: string
  request: PermissionRequestSnapshot
}

/** Beginning of a per-session replay burst. Contains the full message
 *  history + any pending permissions, then a terminator frame. */
export interface WsReplay {
  kind: 'replay'
  sessionId: string
  /** SDK message already emitted to the session, in order. */
  messages: SDKMessage[]
  /** Still-outstanding permission requests for this session. */
  permissions: PermissionRequestSnapshot[]
}
export interface WsReplayDone {
  kind: 'replay-done'
  sessionId: string
  /** When the server uses chunked replay (>50 messages), permissions
   *  ride on the final replay-done frame instead of the first replay
   *  chunk. Older clients ignore unknown fields, so this is safe. */
  permissions?: PermissionRequestSnapshot[]
}

/** Live SDK message. */
export interface WsMessage {
  kind: 'message'
  sessionId: string
  message: SDKMessage
}
/** New tool-permission request. */
export interface WsPermissionRequest {
  kind: 'permission-request'
  sessionId: string
  payload: PermissionRequestSnapshot
}
/** Existing request was resolved (by this tab or another). */
export interface WsPermissionResolved {
  kind: 'permission-resolved'
  sessionId: string
  id: string
  decision: PermissionDecisionSummary
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

export type WsServerFrame =
  | WsSessionsSnapshot
  | WsSessionUpdate
  | WsSessionCreated
  | WsSessionRemoved
  | WsGlobalPermissionRequest
  | WsReplay
  | WsReplayDone
  | WsMessage
  | WsPermissionRequest
  | WsPermissionResolved
  | WsContextUsage
  | WsPong
  | WsError

/** WebSocket endpoint mounted on the Hono HTTP server. Kept as a
 *  constant so tests and tools all refer to the same path. */
export const WS_PATH = '/api/ws'
