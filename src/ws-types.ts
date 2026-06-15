// Browser-side concrete aliases for the generic WebSocket wire protocol.
//
// The canonical generic definitions live in `shared/ws-protocol.ts`.
// This file instantiates them with the browser's lightweight types
// (unknown for SDK messages, PermissionRequest for permission payloads)
// so the frontend never imports `@anthropic-ai/claude-agent-sdk`.

import type { PermissionRequest, SessionInfo, SlashCommand } from './types'
import type { SessionRecap } from '../shared/session-info.js'
import type * as shared from '../shared/ws-protocol.js'

// --- inbound (client — server) -----------------------------------------------
// These need no type parameters — re-export directly.
export type {
  WsSubscribe,
  WsUnsubscribe,
  WsPing,
  WsClientFrame,
} from '../shared/ws-protocol.js'

// --- outbound (server — client) ----------------------------------------------
// Instantiate generic frames with the browser's payload types.

export type WsSessionsSnapshot = shared.WsSessionsSnapshot<SessionInfo>
export type WsSessionUpdate = shared.WsSessionUpdate<SessionInfo>
export type WsSessionCreated = shared.WsSessionCreated<SessionInfo>
export type { WsSessionRemoved } from '../shared/ws-protocol.js'
export type WsGlobalPermissionRequest = shared.WsGlobalPermissionRequest<PermissionRequest>
/** `messages` is `unknown[]` because SDK message shapes are opaque to
 *  the browser (SdkMessage is a loose Record). */
export type WsReplay = shared.WsReplay<unknown, PermissionRequest>
export type WsReplayDone = shared.WsReplayDone<PermissionRequest>
export type WsMessage = shared.WsMessage<unknown>
export type WsPermissionRequest = shared.WsPermissionRequest<PermissionRequest>
export type WsPermissionResolved = shared.WsPermissionResolved<shared.PermissionDecision>
export type WsSessionRecapUpdate = shared.WsSessionRecapUpdate<SessionRecap>
export type { WsContextUsage, WsGitStatusChanged, WsMessageConsumed, WsSessionCleared, WsCommandsChanged, WsPong, WsError, PermissionDecision } from '../shared/ws-protocol.js'

export type WsServerFrame = shared.WsServerFrame<
  SessionInfo,
  unknown,
  PermissionRequest,
  shared.PermissionDecision,
  SessionRecap,
  SlashCommand
>

export { WS_PATH } from '../shared/ws-protocol.js'
