// Neutral live-frame vocabulary for the native provider core (design R1/R6,
// Task 7 F1 relocation). These are the LIVE conversation + operational frames
// the core emits — distinct from the durable SessionEvent vocabulary
// (./session-event.ts): live-only frames are never persisted (R6). Imports ONLY
// sibling vocabulary modules (./message, ./types, ./stream, ./source) — zero SDK
// or host-domain imports (the purity pin in ./live-frame.test.ts covers this).
//
// F1: the assistant bundle and the operational frame shapes formerly lived in
// the host adapter (native-host-frame-adapter.ts). They relocate here because
// the core (T9/T10) must EMIT them and cannot import the host-side adapter. The
// adapter now imports these neutral types and owns only their SDK projection.
//
// F2: AssistantFrame carries `stopReason` as a FIRST-CLASS field so the core can
// populate it from the finish reason directly (the assembler discards the replay
// envelope on block misalignment, so the envelope is not a reliable stop-reason
// source). `replayState` rides along for API replay but is not the stop-reason
// authority.

import type { AssistantMessage, ToolResultMessage } from './message.js'
import type { TokenUsage } from './types.js'
import type { StreamChunk, RawStreamEvent } from './stream.js'
import type { ReplayEnvelope } from './source.js'

/** The neutral live assistant emission: the settled message plus its round
 *  usage and the first-class finish facts. The vocabulary's AssistantMessage
 *  carries content/model/provider facts; usage is the assembler's separate
 *  accessor (BlockAssembler.usage), so the live frame bundles both. `stopReason`
 *  is the API stop reason as a plain string (null = no stop reason received, an
 *  interrupted turn); `model` is the responding model id. Both are first-class
 *  (F2) — the adapter projects them verbatim, never reading the replay envelope
 *  for stop_reason. */
export interface AssistantFrame {
  type: 'assistant-frame'
  message: AssistantMessage
  usage: TokenUsage
  stopReason: string | null
  model: string
  replayState?: ReplayEnvelope
}

/** Neutral envelope facts carried inline by the enveloped operational frames
 *  (init / api_retry / informational / result). Task frames are envelope-less —
 *  they carry no session_id/uuid/parent on the SDK frame either. */
interface OperationalEnvelope {
  sessionId: string
  uuid: string
  parentToolUseId: string | null
}

/** The neutral live-operational frame language (R6: live-only, never durable).
 *  Field names are neutral facts; the host adapter maps them to the exact SDK
 *  system/result subtypes native emits. `time` is the ms-epoch fact the host
 *  reads as `receivedAt` on task frames. `fastMode` is the boolean intent the
 *  adapter encodes as the SDK's 'on'/'off' string. CLOSED on purpose — consumers
 *  switch + assertNever over it. */
export type OperationalFrame =
  | ({ type: 'init'; fastMode: boolean } & OperationalEnvelope)
  | ({ type: 'api/retry'; attempt: number; maxRetries: number; delayMs: number } & OperationalEnvelope)
  | ({ type: 'informational'; text: string } & OperationalEnvelope)
  | {
      type: 'task/started'
      taskId: string
      toolUseId: string
      taskType: 'local_bash' | 'local_agent'
      description: string
      subagentType?: string
      time: number
    }
  | {
      type: 'task/notification'
      taskId: string
      toolUseId: string
      description: string
      status: 'completed' | 'failed' | 'stopped'
      result?: string
      reason?: 'worker_restart'
      time: number
    }
  | ({
      type: 'result'
      result: string
      usage: TokenUsage
      numTurns: number
      durationMs: number
      isError: boolean
      fastMode?: boolean
    } & OperationalEnvelope)

/** A conversation frame carrying its sidechain emission context (neutral).
 *  The core stamps `parentToolUseId` at emission — null for the main thread,
 *  the spawning `tool_use` id for a nested (Agent/Task) runner — because the
 *  conversation frames themselves (assistant bundle / raw passthrough /
 *  first-class tool result) carry no envelope identity. The host adapter
 *  derives the SDK envelope from this context (T10; the nested runner's
 *  neutral parent axis, T15). Operational frames are NOT wrapped: they carry
 *  their envelope inline. */
export interface EnvelopedConversationFrame {
  type: 'enveloped-conversation'
  frame: AssistantFrame | RawStreamEvent | ToolResultMessage
  parentToolUseId: string | null
}

/** The core emission union: everything the neutral core pushes onto its live
 *  `messages` channel. StreamChunk is assembler-internal (the host adapter
 *  throws on it — the host reads raw Anthropic events and settled messages,
 *  never a neutral chunk); RawStreamEvent is the R2 verbatim passthrough;
 *  AssistantFrame is the settled assistant bundle; OperationalFrame is the
 *  live-only system/result surface; ToolResultMessage is a first-class live
 *  tool result (T10 folds it into the emission union — the loop emits it via
 *  the widened NativeLoopFrame). The core emits conversation frames wrapped
 *  in EnvelopedConversationFrame so the sidechain parent travels neutrally;
 *  the bare conversation variants remain for the projection contract and
 *  main-thread convenience. The host adapter projects each member to the SDK
 *  AgentMessage the pump consumes. */
export type NativeCoreFrame =
  | StreamChunk
  | RawStreamEvent
  | AssistantFrame
  | OperationalFrame
  | ToolResultMessage
  | EnvelopedConversationFrame