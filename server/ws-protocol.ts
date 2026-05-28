// Server-side concrete aliases for the generic WebSocket wire protocol.
//
// The canonical generic definitions live in `shared/ws-protocol.ts`.
// This file instantiates them with the server's full SDK types
// (SDKMessage, PermissionRequestSnapshot, PermissionDecisionSummary,
// SessionInfo) so that `server/ws.ts` and the rest of the server get
// precise typing without pulling in `shared/` directly.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  PermissionDecisionSummary,
  PermissionRequestSnapshot,
  SessionInfo,
  SessionRecap,
} from './session-types.js'
import type * as shared from '../shared/ws-protocol.js'

// --- inbound (client → server) -----------------------------------------------
// These need no type parameters — re-export directly.
export type {
  WsSubscribe,
  WsUnsubscribe,
  WsPing,
  WsClientFrame,
} from '../shared/ws-protocol.js'

// --- outbound (server → client) ----------------------------------------------
// Instantiate generic frames with the server's concrete payload types.

export type WsSessionsSnapshot = shared.WsSessionsSnapshot<SessionInfo>
export type WsSessionUpdate = shared.WsSessionUpdate<SessionInfo>
export type WsSessionCreated = shared.WsSessionCreated<SessionInfo>
export type { WsSessionRemoved } from '../shared/ws-protocol.js'
export type WsGlobalPermissionRequest = shared.WsGlobalPermissionRequest<PermissionRequestSnapshot>
export type WsReplay = shared.WsReplay<SDKMessage, PermissionRequestSnapshot>
export type WsReplayDone = shared.WsReplayDone<PermissionRequestSnapshot>
export type WsMessage = shared.WsMessage<SDKMessage>
export type WsPermissionRequest = shared.WsPermissionRequest<PermissionRequestSnapshot>
export type WsPermissionResolved = shared.WsPermissionResolved<PermissionDecisionSummary>
export type WsSessionRecapUpdate = shared.WsSessionRecapUpdate<SessionRecap>
export type { WsContextUsage, WsGitStatusChanged, WsPong, WsError } from '../shared/ws-protocol.js'

export type WsServerFrame = shared.WsServerFrame<
  SessionInfo,
  SDKMessage,
  PermissionRequestSnapshot,
  PermissionDecisionSummary,
  SessionRecap
>

export { WS_PATH } from '../shared/ws-protocol.js'
