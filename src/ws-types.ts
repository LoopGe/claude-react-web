// Browser-side copy of the WebSocket wire protocol types. Must stay in
// sync with `server/ws-protocol.ts`. We duplicate rather than re-export
// because importing from `server/` would pull in Node-only SDK typings
// into the browser bundle (the server protocol file references
// `PermissionRequestSnapshot` and friends, which chain back to
// `@anthropic-ai/claude-agent-sdk`).
//
// The shapes below use `unknown` for payloads the browser treats as
// opaque; the existing `PermissionRequest` / `SessionInfo` types from
// `./types.ts` are reused where structure matters.

import type { PermissionRequest, SessionInfo } from './types'

// --- inbound (client → server) -----------------------------------------------

export interface WsSubscribe {
  kind: 'subscribe'
  sessionId: string
}
export interface WsUnsubscribe {
  kind: 'unsubscribe'
  sessionId: string
}
export interface WsPing {
  kind: 'ping'
  nonce?: number
}

export type WsClientFrame = WsSubscribe | WsUnsubscribe | WsPing

// --- outbound (server → client) ----------------------------------------------

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
export interface WsGlobalPermissionRequest {
  kind: 'global-permission-request'
  sessionId: string
  request: PermissionRequest
}

/** `messages` is `unknown[]` because SDK message shapes are opaque to
 *  the browser (SdkMessage is a loose Record). */
export interface WsReplay {
  kind: 'replay'
  sessionId: string
  messages: unknown[]
  permissions: PermissionRequest[]
}
export interface WsReplayDone {
  kind: 'replay-done'
  sessionId: string
  /** Chunked replay: permissions arrive with the final replay-done frame. */
  permissions?: PermissionRequest[]
}
export interface WsMessage {
  kind: 'message'
  sessionId: string
  message: unknown
}
export interface WsPermissionRequest {
  kind: 'permission-request'
  sessionId: string
  payload: PermissionRequest
}
export interface WsPermissionResolved {
  kind: 'permission-resolved'
  sessionId: string
  id: string
  decision: {
    behavior: 'allow' | 'deny'
    persisted: boolean
    message?: string
  }
}
export interface WsContextUsage {
  kind: 'context-usage'
  sessionId: string
  usage: unknown
}
export interface WsPong {
  kind: 'pong'
  nonce?: number
}
export interface WsError {
  kind: 'error'
  message: string
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

/** Endpoint path. Matches server/ws-protocol.ts::WS_PATH. */
export const WS_PATH = '/api/ws'
