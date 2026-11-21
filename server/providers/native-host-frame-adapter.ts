// Host adapter: neutral native vocabulary → SDK AgentMessage (design R1/R2/R3,
// R6-scoped). This module is a BOUNDARY importer — it lives OUTSIDE native/ and
// is the sole place that knows SDK field names. The neutral vocabulary carries
// the facts; SDK-only representation (snake_case field names, the `msg_` id
// prefix, stop_reason, the `runtime`/`is_backgrounded`/`level` constants, the
// success/error subtype split) is owned here. The core neutrality pin (T18)
// excludes this file; the vocabulary it imports stays pure.
//
// Two projections, two read paths (design "Architecture"):
//   • projectNativeFrameToSdk — LIVE conversation output: a settled assistant
//     message (+ its turn usage), a first-class tool result, or the opaque
//     RawStreamEvent passthrough (R2: the Anthropic event travels VERBATIM so
//     the client reads byte-identical raw fields). Envelope identity comes from
//     the caller's env.
//   • projectNativeEventToSdk — LIVE operational output: the exact system/result
//     subtypes native emits (init / api_retry / informational / task_started /
//     task_notification / result). These are live-only frames, NOT durable
//     SessionEventMap keys (R6); their neutral shapes are defined here as the
//     adapter's input contract until the core grows them in phase 3. Durable
//     session events return null — their SDK-line projection is the history-read
//     seam (T13), which supplies the host-envelope facts this env-less function
//     lacks.
//
// R6 scope: ONLY native's actual emissions are projected. The ~25 claude-only
// subtypes (hook_*, plugin_install, memory_recall, elicitation_complete,
// notification, thinking_tokens, prompt_suggestion, …) are NOT native emissions
// and have no projection here.

import type { AgentMessage } from '../agent-message.js'
import type { AssistantMessage, ToolResultMessage } from './native/vocabulary/message.js'
import type { ContentBlock, TokenUsage } from './native/vocabulary/types.js'
import type { NativeLiveFrame } from './native/vocabulary/stream.js'
import type { ReplayEnvelope } from './native/vocabulary/source.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'

/** Envelope identity stamped on every live conversation frame. `parentToolUseId`
 *  is null for the main thread, a string for a sidechain runner — the
 *  null-vs-string distinction is load-bearing and preserved verbatim.
 *  `receivedAt`, when present, is stamped additively (the host ring reads it). */
export interface NativeFrameEnvelope {
  sessionId: string
  uuid: string
  parentToolUseId: string | null
  receivedAt?: number
}

/** The neutral live assistant emission: the settled message plus its round
 *  usage. The vocabulary's AssistantMessage carries content/model/provider
 *  facts; usage is the assembler's separate accessor (BlockAssembler.usage), so
 *  the live frame bundles both. `stop_reason` is an API-only string the neutral
 *  vocabulary deliberately does not type — it rides the adapter-owned replay
 *  envelope (message.source.replayState.response.stop_reason, R1) and is read
 *  back verbatim, so even an exotic API stop reason survives losslessly. */
export interface NativeAssistantFrame {
  type: 'assistant-frame'
  message: AssistantMessage
  usage: TokenUsage
}

/** Everything the live conversation projection consumes: the streaming-axis
 *  NativeLiveFrame (assembler chunks + raw passthrough), the settled assistant
 *  bundle, and a first-class tool result. The vocabulary's NativeLiveFrame is
 *  StreamChunk | RawStreamEvent only; settled messages join the live output as
 *  themselves, so the adapter's input union is wider (phase 3 reconciles the
 *  core's emission union with this contract). */
export type NativeHostFrame = NativeLiveFrame | NativeAssistantFrame | ToolResultMessage

/** Neutral envelope facts carried inline by the enveloped operational events
 *  (projectNativeEventToSdk takes no env). Task events are envelope-less — they
 *  carry no session_id/uuid/parent on the SDK frame either. */
interface OperationalEnvelope {
  sessionId: string
  uuid: string
  parentToolUseId: string | null
}

/** The neutral live-operational event language (R6: live-only, never durable).
 *  Field names are neutral facts; the adapter maps them to the exact SDK
 *  system/result subtypes native emits. `time` is the ms-epoch fact the host
 *  reads as `receivedAt` on task frames. `fastMode` is the boolean intent the
 *  adapter encodes as the SDK's 'on'/'off' string. */
export type NativeOperationalEvent =
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

/** The adapter's view of the replay envelope's raw response: it reads only the
 *  API-only stop_reason. Absent envelope/response means no stop reason was
 *  received (an interrupted turn) → null, the SDK's representation. */
interface NativeReplayResponse {
  stop_reason?: string | null
}

/** Mark an unreachable closed-union branch (mirrors the vocabulary assembler). */
function assertNever(value: never, context: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant in ${context}: ${rendered}`)
}

/** SDK usage buckets from the neutral disjoint TokenUsage. Cache fields appear
 *  only when present, matching the legacy frame's conditional spread. The
 *  neutral-only total/reasoning counts have no SDK Usage field on native's
 *  emission surface and are not host-read, so they are not projected. */
function sdkUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  }
}

/** Parse a tool-call's raw-JSON arguments into the SDK tool_use.input. Mirrors
 *  loop.ts's parseJsonInput: empty/invalid/non-object JSON becomes {} (the model
 *  sees an empty input, never a crash). Parsing is a boundary job (R3). */
function parseToolInput(json: string): Record<string, unknown> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Project one neutral assistant content block to its SDK shape. Only text /
 *  reasoning / tool-call occur in assistant output; the other block kinds are
 *  user-input or developer blocks and never reach a live assistant frame. */
function sdkAssistantBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      if (block.redacted === true) return { type: 'redacted_thinking', data: block.data }
      return {
        type: 'thinking',
        thinking: block.text,
        ...(typeof block.signature === 'string' && block.signature !== '' ? { signature: block.signature } : {}),
      }
    case 'tool-call':
      return { type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.arguments) }
    default:
      throw new Error(`native host adapter: block kind "${(block as { type: string }).type}" is not an assistant emission`)
  }
}

/** Envelope shared by the live conversation frames (assistant / user /
 *  stream_event). Mirrors frames.ts's base() plus the additive receivedAt. */
function frameEnvelope(env: NativeFrameEnvelope, type: string): Record<string, unknown> {
  return {
    type,
    session_id: env.sessionId,
    uuid: env.uuid,
    parent_tool_use_id: env.parentToolUseId,
    ...(env.receivedAt !== undefined ? { receivedAt: env.receivedAt } : {}),
  }
}

/** Envelope shared by the enveloped operational events (init / api_retry /
 *  informational / result). Task frames do not use it. */
function operationalEnvelope(event: OperationalEnvelope, type: string, subtype: string): Record<string, unknown> {
  return {
    type,
    subtype,
    session_id: event.sessionId,
    uuid: event.uuid,
    parent_tool_use_id: event.parentToolUseId,
  }
}

/** Project a neutral live conversation frame to the SDK AgentMessage the host
 *  pump consumes. The RawStreamEvent event travels VERBATIM (R2 byte-identity). */
export function projectNativeFrameToSdk(frame: NativeHostFrame, env: NativeFrameEnvelope): AgentMessage {
  // A first-class tool result is discriminated by its role (it has no `type`).
  if ('role' in frame && frame.role === 'tool') {
    return projectToolResult(frame, env)
  }
  const live = frame as NativeLiveFrame | NativeAssistantFrame
  switch (live.type) {
    case 'raw-stream-event':
      return { ...frameEnvelope(env, 'stream_event'), event: live.event } as AgentMessage
    case 'assistant-frame':
      return projectAssistant(live, env)
    // Assembler chunks are core-internal: the host reads raw Anthropic stream
    // events and settled messages, never a neutral StreamChunk. Projecting one
    // is a contract violation, surfaced loudly rather than fabricated.
    case 'block-start':
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call-delta':
    case 'block-end':
    case 'usage':
    case 'finish':
      throw new Error(`native host adapter: StreamChunk "${live.type}" is assembler-internal, not a host frame`)
    default:
      return assertNever(live, 'projectNativeFrameToSdk')
  }
}

function projectAssistant(frame: NativeAssistantFrame, env: NativeFrameEnvelope): AgentMessage {
  const message = frame.message
  const response = (message.source.replayState as ReplayEnvelope | undefined)?.response as NativeReplayResponse | undefined
  return {
    ...frameEnvelope(env, 'assistant'),
    message: {
      id: `msg_${env.uuid}`,
      type: 'assistant',
      role: 'assistant',
      model: message.source.model,
      content: message.content.map(sdkAssistantBlock),
      stop_reason: response?.stop_reason ?? null,
      usage: sdkUsage(frame.usage),
    },
  } as unknown as AgentMessage
}

function projectToolResult(message: ToolResultMessage, env: NativeFrameEnvelope): AgentMessage {
  // The live tool-result frame is the TEXT summary the loop emits (canonical
  // file content travels the persistence path, never the UI frame). A non-text
  // block here is a contract violation, surfaced loudly.
  const content = message.content.map((block) => {
    if (block.type !== 'text') {
      throw new Error(`native host adapter: tool-result block kind "${block.type}" is not a live UI emission`)
    }
    return { type: 'text', text: block.text }
  })
  return {
    ...frameEnvelope(env, 'user'),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content,
        is_error: message.isError ?? false,
      }],
    },
  } as unknown as AgentMessage
}

/** Project a neutral operational event to the exact SDK system/result subtype
 *  native emits (R6). Durable SessionEventMap keys return null: their SDK-line
 *  projection belongs to the history-read seam (T13), which supplies the
 *  host-envelope facts (session_id / uuid) this env-less function does not have. */
export function projectNativeEventToSdk(event: NativeSessionEvent | NativeOperationalEvent): AgentMessage | null {
  switch (event.type) {
    case 'init':
      return {
        ...operationalEnvelope(event, 'system', 'init'),
        fast_mode_state: event.fastMode ? 'on' : 'off',
      } as AgentMessage
    case 'api/retry':
      return {
        ...operationalEnvelope(event, 'system', 'api_retry'),
        attempt: event.attempt,
        max_retries: event.maxRetries,
        retry_delay_ms: event.delayMs,
      } as AgentMessage
    case 'informational':
      return {
        ...operationalEnvelope(event, 'system', 'informational'),
        content: event.text,
        level: 'warning',
      } as AgentMessage
    case 'task/started':
      return {
        type: 'system',
        subtype: 'task_started',
        task_id: event.taskId,
        tool_use_id: event.toolUseId,
        task_type: event.taskType,
        description: event.description,
        ...(event.subagentType !== undefined ? { subagent_type: event.subagentType } : {}),
        is_backgrounded: true,
        receivedAt: event.time,
      } as unknown as AgentMessage
    case 'task/notification':
      return {
        type: 'system',
        subtype: 'task_notification',
        task_id: event.taskId,
        tool_use_id: event.toolUseId,
        description: event.description,
        status: event.status,
        ...(event.result ? { result: event.result } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        receivedAt: event.time,
      } as unknown as AgentMessage
    case 'result':
      return {
        ...operationalEnvelope(event, 'result', event.isError ? 'error_during_execution' : 'success'),
        runtime: 'native',
        result: event.result,
        usage: sdkUsage(event.usage),
        num_turns: event.numTurns,
        duration_ms: event.durationMs,
        is_error: event.isError,
        ...(event.fastMode !== undefined ? { fast_mode_state: event.fastMode ? 'on' : 'off' } : {}),
      } as unknown as AgentMessage
    // Durable session events: no live operational projection (history seam owns
    // them). Listed exhaustively so a future SessionEventMap merge forces a
    // deliberate decision via the assertNever below rather than silently null.
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
    case 'session/context':
    case 'turn/end':
    case 'session/end-seed':
    case 'session/compact':
    case 'session/supplement':
    case 'session/skill':
    case 'subagent/descriptor':
    case 'session/attachments':
    case 'session/agent':
      return null
    default:
      return assertNever(event, 'projectNativeEventToSdk')
  }
}