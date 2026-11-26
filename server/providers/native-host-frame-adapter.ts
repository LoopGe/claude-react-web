// Host adapter: neutral native vocabulary ↔ SDK AgentMessage / AgentUserMessage
// (design R1/R2/R3/R6). This module is a BOUNDARY importer — it lives OUTSIDE
// native/ and is the sole place that knows SDK field names. The neutral
// vocabulary carries the facts; SDK-only representation (snake_case field names,
// the `msg_` id prefix, stop_reason, the `runtime`/`is_backgrounded`/`level`
// constants, the success/error subtype split) is owned here. The core neutrality
// pin (T18) excludes this file; the vocabulary it imports stays pure.
//
// Three projections, two read paths (design "Architecture"):
//   • projectNativeFrameToSdk — LIVE conversation output: a settled assistant
//     frame (+ its turn usage), a first-class tool result, or the opaque
//     RawStreamEvent passthrough (R2: the Anthropic event travels VERBATIM so
//     the client reads byte-identical raw fields). Envelope identity comes from
//     the caller's env.
//   • projectNativeEventToSdk — LIVE operational output: the exact system/result
//     subtypes native emits (init / api_retry / informational / hook_started /
//     hook_progress / hook_response / task_started / task_notification / result)
//     plus the top-level prompt_suggestion message.
//     These are live-only frames, NOT durable SessionEventMap keys (R6). Durable
//     session events return null — their SDK-line projection is the history-read
//     seam (T13).
//   • projectSdkInputToNative — LIVE input: a host AgentUserMessage → neutral
//     RequestMessage (file → FileBlock ref, base64 image → LegacyImageBlock, ref
//     image → ImageRefBlock, text → TextBlock). The neutral uuid is freshly
//     minted; the adapter re-keys the host receivedAt identity onto it.
//
// F1 (Task 7): the assistant bundle (AssistantFrame) and the operational frame
// shapes (OperationalFrame) now live in the NEUTRAL vocabulary
// (native/vocabulary/live-frame.ts) so the core can emit them without importing
// this adapter. The adapter imports them and owns only their SDK projection.
//
// R1: wrapNativeCore implements the SDK-shaped ProviderSessionHandle by wrapping
// a neutral NativeSessionCore. The adapter owns host-input identity (the
// receivedAt re-key + the host↔neutral pairing), the lease callbacks (which wrap
// the core's neutral persistence outcomes), copyConsumedAt, and the handle
// translation. The legacy handle-text file projection (projectFileBlocksForProvider)
// stays adapter-side: the neutral input path keeps structured FileBlock refs (the
// wire adapter projects them to handle text / PDF for the API request); the
// handle-text form is re-exported here for the legacy text-only boundary.
//
// R6 scope: ONLY native's actual emissions are projected. The claude-only
// subtypes (plugin_install, memory_recall, elicitation_complete, notification,
// thinking_tokens, …) are NOT native emissions and have no projection here.
// prompt_suggestion IS a native emission: the neutral prompt/suggestion
// OperationalFrame projects to the SDK prompt_suggestion message (live-only —
// the pump bypasses the history ring on its type alone). Hook activity IS a
// native emission too: the neutral hook/run OperationalFrame projects to the
// SDK system/hook_started|hook_progress|hook_response frames the pump's
// hookLifecycleMessage already parses (zero pump change).

import { randomUUID } from 'node:crypto'
import {
  copyConsumedAt,
  projectFileBlocksForProvider,
  type AgentMessage,
  type AgentUserMessage,
  type ProviderContentBlock,
} from '../agent-message.js'
import type {
  ProviderAttachmentOccurrence,
  ProviderInterruptReceipt,
  ProviderResetBaseSettings,
  ProviderSessionHandle,
} from './types.js'
import type { SupplementOutcome } from './steering-format.js'
import type { FileAttachmentRef } from '../../shared/attachments.js'
import type { HookRunStatus } from '../../shared/hooks.js'
import type { ImageAttachmentRef, LegacyImageBlock } from '../../shared/image-attachment.js'
import { freezeMessage, type RequestMessage, type ToolResultMessage } from './native/vocabulary/message.js'
import { brandString } from './native/vocabulary/brand.js'
import { parseToolInput, type ContentBlock, type TokenUsage } from './native/vocabulary/types.js'
import type { NativeLiveFrame } from './native/vocabulary/stream.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'
import type { RawLine } from '../../shared/transcript-format.js'
import { projectNeutralEventToLegacy } from './native/session-log/format.js'
import type { AssistantFrame, OperationalFrame, NativeCoreFrame } from './native/vocabulary/live-frame.js'
import type {
  NativeSessionCore,
  NativeAttachmentOccurrence,
  NativeEffectiveSettings,
  NativeResetBaseSettings,
} from './native/core-contract.js'

// The legacy handle-text file projection stays adapter-side (boundary home).
// The neutral input path keeps FileBlock refs; this is the text-only boundary's
// projection, re-exported so the provider seam imports it from the adapter.
export { projectFileBlocksForProvider }

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

/** Everything the live CONVERSATION projection consumes: the streaming-axis
 *  NativeLiveFrame (assembler chunks + raw passthrough), the settled assistant
 *  bundle, and a first-class tool result. Operational frames are projected by
 *  projectNativeEventToSdk, not here. The core emission union (NativeCoreFrame)
 *  is wider than this conversation-only input on the operational axis and
 *  narrower on the tool-result axis (first-class tool results travel the
 *  persistence path + this projection, not the core emission union). */
export type NativeHostFrame = NativeLiveFrame | AssistantFrame | ToolResultMessage

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
 *  informational / result / hook/run). Task frames do not use it. */
function operationalEnvelope(event: { sessionId: string; uuid: string; parentToolUseId: string | null }, type: string, subtype: string): Record<string, unknown> {
  return {
    type,
    subtype,
    session_id: event.sessionId,
    uuid: event.uuid,
    parent_tool_use_id: event.parentToolUseId,
  }
}

/** SDK hook_response outcome from the neutral terminal run status. A completed
 *  event carrying a non-terminal status (started/progress) is a contract
 *  violation — surfaced loudly rather than fabricated into a success/error. */
function hookOutcome(status: HookRunStatus): 'success' | 'error' | 'cancelled' {
  switch (status) {
    case 'success':
    case 'error':
    case 'cancelled':
      return status
    default:
      throw new Error(`native host adapter: completed hook run has non-terminal status "${status}"`)
  }
}

/** Project a neutral live conversation frame to the SDK AgentMessage the host
 *  pump consumes. The RawStreamEvent event travels VERBATIM (R2 byte-identity). */
export function projectNativeFrameToSdk(frame: NativeHostFrame, env: NativeFrameEnvelope): AgentMessage {
  // A first-class tool result is discriminated by its role (it has no `type`).
  if ('role' in frame && frame.role === 'tool') {
    return projectToolResult(frame, env)
  }
  const live = frame as NativeLiveFrame | AssistantFrame
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

function projectAssistant(frame: AssistantFrame, env: NativeFrameEnvelope): AgentMessage {
  // F2: stop_reason / model are FIRST-CLASS frame fields (the core sources
  // stopReason from the finish reason). The replay envelope is never read here.
  return {
    ...frameEnvelope(env, 'assistant'),
    message: {
      id: `msg_${env.uuid}`,
      type: 'assistant',
      role: 'assistant',
      model: frame.model,
      content: frame.message.content.map(sdkAssistantBlock),
      stop_reason: frame.stopReason,
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

/** Project a neutral operational event to the exact SDK shape native emits
 *  (R6): the system/result subtypes and the top-level prompt_suggestion message.
 *  Durable SessionEventMap keys return null: their SDK-line projection is the
 *  history-read seam `projectNativeEventToSdkLine` below, which supplies the
 *  host-envelope facts (session_id / uuid) this env-less function does not have. */
export function projectNativeEventToSdk(event: NativeSessionEvent | OperationalFrame): AgentMessage | null {
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
    case 'prompt/suggestion':
      // SDKPromptSuggestionMessage carries only type/suggestion/uuid/session_id
      // — no subtype, no parent_tool_use_id — so it is built directly, never via
      // operationalEnvelope. Live-only: the pump keys on the type alone and
      // bypasses the history ring.
      return {
        type: 'prompt_suggestion',
        suggestion: event.suggestion,
        uuid: event.uuid,
        session_id: event.sessionId,
      } as AgentMessage
    case 'hook/run': {
      // The pump's hookLifecycleMessage parses system/hook_started|hook_progress|
      // hook_response; outcome rides only hook_response and the exit code is the
      // SDK snake_case exit_code. Optional output fields appear only when present.
      const { kind, run } = event.event
      const fields = {
        hook_id: run.hookId,
        hook_name: run.hookName,
        hook_event: run.event,
        ...(run.stdout !== undefined ? { stdout: run.stdout } : {}),
        ...(run.stderr !== undefined ? { stderr: run.stderr } : {}),
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.exitCode !== undefined ? { exit_code: run.exitCode } : {}),
      }
      switch (kind) {
        case 'started':
          return { ...operationalEnvelope(event, 'system', 'hook_started'), ...fields } as AgentMessage
        case 'progress':
          return { ...operationalEnvelope(event, 'system', 'hook_progress'), ...fields } as AgentMessage
        case 'completed':
          return { ...operationalEnvelope(event, 'system', 'hook_response'), ...fields, outcome: hookOutcome(run.status) } as AgentMessage
        default:
          return assertNever(kind, 'projectNativeEventToSdk hook/run')
      }
    }
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
    case 'session/title':
      return null
    default:
      return assertNever(event, 'projectNativeEventToSdk')
  }
}

// ── History read seam: durable neutral event → SDK RawLine (T13) ───────────

/** Project one durable neutral session event to the SDK RawLine the host
 *  history path consumes (cache.ts collectRenderable / reader.ts normalize +
 *  paginateRenderable). This is the history-read translation point (design
 *  "Two translation points live, two read paths"): the neutral v3 log is
 *  parsed natively, and ONLY this boundary knows the SDK line shape.
 *
 *  The three message events (user/message, assistant/message, tool/result)
 *  project to the exact legacy SDK line — the lossless inverse the v1/v2
 *  format owns (`projectNeutralEventToLegacy`, pinned by the migration
 *  round-trip): envelope identity (uuid / session_id / parent_tool_use_id /
 *  timestamp), the `msg_<uuid>` id convention (or the migrated original SDK
 *  message.id), the verbatim rawStopReason (or the packed-finish fallback),
 *  usage buckets, isCompactSummary, and a migrated bare-string tool_result
 *  content. `seq` rides along so the reader's compact floor can key on it.
 *
 *  Durable operational events (context / compact / skill / supplement /
 *  descriptor / attachments / agent / turn-end / end-seed) are NOT renderable
 *  transcript lines: the reader synthesizes the compact boundary + summary
 *  occurrences itself and ignores the rest, so they project to null. */
export function projectNativeEventToSdkLine(event: NativeSessionEvent, sessionId: string): RawLine | null {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      return projectNeutralEventToLegacy(event, sessionId) as unknown as RawLine
    default:
      return null
  }
}

// ── Live input: SDK AgentUserMessage → neutral RequestMessage ─────────────

/** One host input content block as the projection sees it. The SDK input union
 *  carries text / base64-image / resolved-file blocks; the mixed image model
 *  (R5) also admits store-backed image refs, so the image branch discriminates
 *  `attachment` (ref) vs `source` (legacy base64). */
type HostInputBlock = ProviderContentBlock

/** Project a resolved file attachment to the neutral FileBlock attachment.
 *  The FIDELITY input retains the FULL resolved attachment (registry path /
 *  observed media type / model form): the core's durable persistence and the
 *  wire request projection (handle text / PDF document) consume those facts,
 *  and the native log has always stored them. The public UI transcript strips
 *  them at the history-read boundary (publicNativeHistoryLine), so server-only
 *  metadata never reaches the client. The neutral FileBlock type declares the
 *  public FileAttachmentRef; the resolved superset rides structurally (the wire
 *  adapter reads it as NativeFileAttachment). T10 reconciliation: a stripped
 *  public-only ref would starve assignPdfModelForms (mediaType) and the wire
 *  projection (modelForm/path); core-side re-resolution by id/digest is a
 *  future refinement (the attachment port exposes no registry getById). */
function neutralFileRef(attachment: FileAttachmentRef): FileAttachmentRef {
  return attachment
}

/** Project one host input block to its neutral ContentBlock. Lossless on the
 *  three real input shapes (text / image / file); any other kind is a contract
 *  violation surfaced loudly (user input never carries assistant/tool blocks). */
function neutralInputBlock(block: HostInputBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'file':
      return { type: 'file', attachment: neutralFileRef(block.attachment) }
    case 'image': {
      const image = block as LegacyImageBlock | { type: 'image'; attachment: ImageAttachmentRef }
      if ('attachment' in image) return { type: 'image', attachment: image.attachment }
      return { type: 'image', source: image.source }
    }
    default:
      throw new Error(`native host adapter: input block kind "${(block as { type: string }).type}" is not a user input emission`)
  }
}

/** Project a host AgentUserMessage to a neutral RequestMessage (an identified,
 *  immutable UserMessage). File blocks become neutral FileBlock refs (the
 *  handle-text projection stays adapter-side via projectFileBlocksForProvider
 *  for the legacy text-only boundary); base64 images become LegacyImageBlock;
 *  store-backed image refs become ImageRefBlock; text becomes TextBlock.
 *
 *  IDENTITY (R1 / Goal-4): the neutral message CARRIES THE HOST UUID as its
 *  durable id (branded MessageId), NOT a fresh randomUUID. The legacy native log
 *  persists the host uuid (native-session.ts `uuid: next.uuid!`) and the entire
 *  resume/replay/compact/lease bridge keys on it (rewriteSeedPromptUuids, the
 *  prompt-uuid sidecar, getSkillCompactionEntries.afterUserUuid). Preserving it
 *  here means the core's v3 log stores the same identity, so durable resume needs
 *  no fresh-id↔host-id reconciliation. The adapter re-keys receivedAt onto this
 *  uuid (see wrapNativeCore). A host message without a uuid is a contract
 *  violation surfaced loudly (the manager always mints one before enqueue). */
export function projectSdkInputToNative(message: AgentUserMessage): RequestMessage {
  const hostUuid = message.uuid
  if (typeof hostUuid !== 'string') {
    throw new Error('native host adapter: AgentUserMessage has no uuid identity to preserve')
  }
  const content = message.message.content
  const blocks: ContentBlock[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content.map(neutralInputBlock)
  return freezeMessage({
    role: 'user',
    id: brandString<'MessageId'>(hostUuid),
    content: blocks,
    source: { kind: 'user' },
  })
}

// ── wrapNativeCore: neutral core → SDK ProviderSessionHandle ──────────────

/** The host lease callbacks the adapter wires to the core's neutral persistence
 *  outcomes. Mirrors CreateSessionOptions' callback shapes (host-contract types
 *  stay here on the wrapper, never on the neutral core). */
export interface NativeHostCallbacks {
  onUserMessageConsumed?: (message: AgentUserMessage) => void
  onUserMessagePersistence?: (message: AgentUserMessage, outcome: 'appended' | 'failed') => void
  onSupplementDelivered?: (uuid: string, outcome: SupplementOutcome) => void
}

/** The uuid identity of an identified RequestMessage. projectSdkInputToNative
 *  preserves the host uuid as the neutral id, so a drained or consumed neutral
 *  message carries one; a missing id is a contract violation surfaced loudly
 *  rather than silently dropping the host pairing. */
function neutralIdOf(msg: RequestMessage): string {
  const id = (msg as { id?: string }).id
  if (typeof id !== 'string') {
    throw new Error('native host adapter: core emitted a RequestMessage without a uuid identity')
  }
  return id
}

/** The operational frame discriminants (the live-only system/result surface).
 *  Everything else in NativeCoreFrame is a conversation frame projected by
 *  projectNativeFrameToSdk. A first-class tool result has no `type` (it is
 *  discriminated by role), so it is never operational. */
function isOperationalFrame(frame: NativeCoreFrame): frame is OperationalFrame {
  if (!('type' in frame)) return false
  switch (frame.type) {
    case 'init':
    case 'api/retry':
    case 'informational':
    case 'task/started':
    case 'task/notification':
    case 'result':
    case 'prompt/suggestion':
    case 'hook/run':
      return true
    default:
      return false
  }
}

/** Envelope for a conversation frame: the assistant bundle carries its own
 *  neutral uuid (message.id); a first-class tool result carries its minted id
 *  (shared with the persisted result); raw passthrough mints a fresh frame
 *  uuid (the legacy streamEventFrame mints ctx.uuid() likewise). The sidechain
 *  parent is supplied by the core's emission context (the enveloped wrapper). */
function conversationEnv(frame: NativeHostFrame, sessionId: string, parentToolUseId: string | null): NativeFrameEnvelope {
  // A first-class tool result is the only role-bearing host frame; it carries
  // its minted id (shared with the persisted result).
  if ('role' in frame) {
    return { sessionId, uuid: frame.id, parentToolUseId }
  }
  const uuid = frame.type === 'assistant-frame' ? frame.message.id : randomUUID()
  return { sessionId, uuid, parentToolUseId }
}

/** Project one core emission frame to the SDK AgentMessage the pump consumes:
 *  an enveloped conversation frame through projectNativeFrameToSdk with the
 *  core's sidechain parent; operational frames through projectNativeEventToSdk
 *  (inline envelope); a bare conversation frame (main-thread convenience / the
 *  projection contract) with a null parent. */
function projectCoreFrame(frame: NativeCoreFrame, sessionId: string): AgentMessage {
  if ('type' in frame && frame.type === 'enveloped-conversation') {
    return projectNativeFrameToSdk(frame.frame, conversationEnv(frame.frame, sessionId, frame.parentToolUseId))
  }
  if (isOperationalFrame(frame)) {
    const projected = projectNativeEventToSdk(frame)
    if (projected === null) {
      throw new Error(`native host adapter: operational frame "${frame.type}" projected to null`)
    }
    return projected
  }
  return projectNativeFrameToSdk(frame as NativeHostFrame, conversationEnv(frame as NativeHostFrame, sessionId, null))
}

/** Core-retrieval seam: the neutral core behind a wrapped handle. The handle
 *  is the SDK-shaped translation surface; host code (and tests) that need the
 *  neutral core's internals reach it through this accessor rather than a
 *  property on the handle contract. Keyed weakly so a discarded handle does
 *  not retain its core. */
const coreByHandle = new WeakMap<ProviderSessionHandle, NativeSessionCore>()
export function nativeCoreOf(handle: ProviderSessionHandle): NativeSessionCore | undefined {
  return coreByHandle.get(handle)
}

/** Optional host-input pre-projection applied BEFORE the neutral input
 *  projection. The pre-fidelity (legacy text-only) boundary uses it to turn
 *  structured file blocks into handle text (projectFileBlocksForProvider); the
 *  fidelity path leaves the input untouched. The pairing/lease bookkeeping
 *  always keys on the ORIGINAL host message, so consumedAt bridging and drain
 *  return the object the manager enqueued. */
export interface WrapNativeCoreOptions {
  projectInput?: (host: AgentUserMessage) => AgentUserMessage
}

/** Wrap a neutral NativeSessionCore into the SDK-shaped ProviderSessionHandle.
 *  The adapter owns the host↔neutral translation: input projection + the
 *  receivedAt re-key + the host pairing, the lease callbacks (wrapping the
 *  core's neutral persistence outcomes with copyConsumedAt bridging), the live
 *  frame projection, and the ~50-method handle delegation. */
export function wrapNativeCore(
  core: NativeSessionCore,
  hostCallbacks: NativeHostCallbacks,
  opts: WrapNativeCoreOptions = {},
): ProviderSessionHandle {
  const projectInput = opts.projectInput ?? ((host: AgentUserMessage) => host)
  // Host identity paired by uuid. The neutral message id IS the host uuid
  // (projectSdkInputToNative preserves it), so the pairing key is the durable
  // host identity itself. The map still holds the ORIGINAL host AgentUserMessage
  // object (carrying receivedAt / resolved SDK content) because the lease
  // callbacks and drainQueuedInput must return that exact object — the manager
  // reads consumedAt off it and re-enqueues it verbatim. receivedAt is re-keyed
  // from the legacy WeakMap<AgentUserMessage> onto the uuid.
  const hostByUuid = new Map<string, AgentUserMessage>()
  const receivedAtByUuid = new Map<string, number>()

  const rememberHost = (neutral: RequestMessage, host: AgentUserMessage): void => {
    const id = neutralIdOf(neutral)
    hostByUuid.set(id, host)
    const arrival = (host as { receivedAt?: number }).receivedAt
    receivedAtByUuid.set(id, typeof arrival === 'number' ? arrival : Date.now())
  }
  const hostFor = (neutral: RequestMessage): AgentUserMessage => {
    const host = hostByUuid.get(neutralIdOf(neutral))
    if (!host) {
      throw new Error('native host adapter: core reported an outcome for an unpaired prompt uuid')
    }
    return host
  }
  // Release the pairing on a TERMINAL outcome (consumed or failed) or an
  // interrupt withdrawal — NOT on drain. The manager drains its host queue
  // BEFORE interrupt, and the core then fires 'failed' for the withdrawn parked
  // head (native-session.ts:1376), which still needs the pairing to map back to
  // the host uuid. The legacy provider keyed receivedAt by a GC-friendly
  // WeakMap; this strong Map must release terminal prompts explicitly or it
  // grows for the session lifetime.
  const forget = (id: string): void => {
    hostByUuid.delete(id)
    receivedAtByUuid.delete(id)
  }

  // Wire the core's neutral persistence-outcome callbacks to the host lease
  // callbacks. The host callback fires on a shallow projection of the original
  // host message (preserving uuid / content), stamped with the re-keyed arrival
  // time; copyConsumedAt bridges the consumption stamp the manager writes on that
  // projection back onto the original host message the manager reads after
  // enqueueUserMessage returns. Outcome order is persistence('appended') BEFORE
  // consumption (the durable append precedes the consume ack). 'appended' keeps
  // the pairing (consumption follows); 'failed' and consumption are terminal and
  // release it.
  const projectHost = (neutral: RequestMessage): { id: string; original: AgentUserMessage; projected: AgentUserMessage } => {
    const id = neutralIdOf(neutral)
    const original = hostFor(neutral)
    const projected = { ...original }
    ;(projected as { receivedAt?: number }).receivedAt = receivedAtByUuid.get(id)
    return { id, original, projected }
  }
  core.onUserMessageConsumed = (neutral) => {
    const { id, original, projected } = projectHost(neutral)
    hostCallbacks.onUserMessageConsumed?.(projected)
    copyConsumedAt(projected, original)
    forget(id)
  }
  core.onUserMessagePersistence = (neutral, outcome) => {
    const { id, projected } = projectHost(neutral)
    hostCallbacks.onUserMessagePersistence?.(projected, outcome)
    // 'failed' abandons the prompt (terminal); 'appended' precedes consumption.
    if (outcome === 'failed') forget(id)
  }
  core.onSupplementDelivered = (uuid, outcome) => {
    hostCallbacks.onSupplementDelivered?.(uuid, outcome)
  }

  // A custom iterable (NOT an async generator): the pump tears down via
  // iter.return() while iter.next() is parked on the core's emission queue.
  // An async generator QUEUES return() behind the pending next() (generator
  // semantics), so return() would deadlock until the core's queue ends — the
  // pump's abort teardown would hang. Forwarding return() straight to the
  // source iterator resolves the parked waiter immediately (the Pushable
  // contract), unblocking the pending next() exactly like the legacy direct
  // iterable. next() projects each neutral frame to SDK.
  const messages: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]() {
      const source = core.messages[Symbol.asyncIterator]()
      return {
        async next(): Promise<IteratorResult<AgentMessage>> {
          const result = await source.next()
          if (result.done) return { done: true, value: undefined }
          return { done: false, value: projectCoreFrame(result.value, core.sessionId) }
        },
        async return(): Promise<IteratorResult<AgentMessage>> {
          await source.return?.()
          return { done: true, value: undefined }
        },
      }
    },
  }

  const handle: ProviderSessionHandle = {
    provider: 'native',
    echoesUserPrompts: false,
    messages,
    enqueueUserMessage(host: AgentUserMessage): void {
      const neutral = projectSdkInputToNative(projectInput(host))
      rememberHost(neutral, host)
      core.enqueue(neutral)
    },
    sendControlMessage(host: AgentUserMessage): void {
      const neutral = projectSdkInputToNative(projectInput(host))
      // No rememberHost: a control seed (compact hand-off) never fires a
      // persistence/consumption outcome and is never drained, so a pairing
      // entry would be immortal. It needs neither lease callbacks nor drain.
      core.enqueueControl(neutral)
    },
    clearQueuedInput(): number {
      // WITHDRAWAL: the core fires a terminal 'failed' per entry (T7 pairing
      // fix), releasing the pairing AND the manager's send lease — no orphan.
      return core.clearQueued()
    },
    drainQueuedInput(): AgentUserMessage[] {
      // TRANSFER (Q1): the manager calls this to MOVE queued prompts into a
      // respawned session (respawnInPlace drain → re-enqueue) — and also for the
      // interrupt withdrawal leg-1 / failed-resume abandonment, where it owns the
      // send-lease decision itself (releases on withdrawal/abandonment, preserves
      // on transfer). So this path drains in 'transfer' mode: NO host 'failed'
      // outcome (the send lease is preserved across the re-enqueue, which never
      // re-acquires it), and the pairing is released SILENTLY here. Snapshot the
      // pairing first so the original host objects are still returned after the
      // release. The live map does not grow.
      const snapshot = new Map(hostByUuid)
      const drained = core.drainQueued('transfer')
      for (const neutral of drained) forget(neutralIdOf(neutral))
      return drained.map((neutral) => {
        const host = snapshot.get(neutralIdOf(neutral))
        if (!host) {
          throw new Error('native host adapter: drained prompt has no paired host uuid')
        }
        return host
      })
    },
    get queueDepth() { return core.queueDepth },
    get closed() { return core.closed },
    abortSignal: core.abortSignal,
    processExited: core.processExited,
    abort(): void { core.abort() },
    destroy(reason?: string) { return core.destroy(reason) },
    reloadSkills() { return core.reloadSkills() },
  }

  // Optional members: exposed only when the core implements them, so a core
  // without steering / compaction / MCP simply omits the handle member (the
  // manager capability-gates against the absent method).
  if (core.awaitingDurableRetry !== undefined) {
    Object.defineProperty(handle, 'awaitingDurableRetry', { get: () => core.awaitingDurableRetry })
  }
  if (core.processRealExit !== undefined) {
    Object.defineProperty(handle, 'processRealExit', { value: core.processRealExit })
  }
  if (core.steeringActive !== undefined) {
    Object.defineProperty(handle, 'steeringActive', { get: () => core.steeringActive })
  }
  if (core.enqueueSupplement) handle.enqueueSupplement = (entry) => core.enqueueSupplement!(entry)
  if (core.drainSupplements) handle.drainSupplements = () => core.drainSupplements!()
  if (core.noteTurnSettled) handle.noteTurnSettled = () => core.noteTurnSettled!()
  if (core.interrupt) {
    handle.interrupt = async (opts): Promise<ProviderInterruptReceipt | void> => {
      const receipt = await core.interrupt!(opts)
      if (!receipt || receipt.cancelledQueued === undefined) return receipt ?? undefined
      // Identity is preserved (neutral id === host uuid), so the cancelled ids
      // ARE host uuids — pass them through to the manager's withdrawal accounting
      // (it ignores unknown ids) and release the withdrawn pairings (no leak).
      for (const id of receipt.cancelledQueued) forget(id)
      return { cancelledQueued: receipt.cancelledQueued }
    }
  }
  if (core.compactInPlace) handle.compactInPlace = (summary, opts) => core.compactInPlace!(summary, opts)
  if (core.seedCompactSummary) handle.seedCompactSummary = (summary, opts) => core.seedCompactSummary!(summary, opts)
  if (core.dispatchHook) {
    // The host seam dispatches only the non-REPL compact lifecycle events
    // (PreCompact / PostCompact), so the context is constructed here: the
    // session abort signal and hasContext:false (RS §12.2 — prompt/agent hooks
    // report the non-blocking availability error, never an LLM round).
    handle.dispatchHook = (event, input) => core.dispatchHook!(event, input, {
      signal: core.abortSignal,
      hasContext: false,
    })
  }
  if (core.getAttachmentOccurrences) {
    handle.getAttachmentOccurrences = (): readonly ProviderAttachmentOccurrence[] =>
      core.getAttachmentOccurrences!().map((occ: NativeAttachmentOccurrence) => ({
        messageUuid: occ.messageUuid,
        blockPath: occ.blockPath,
        attachment: occ.attachment,
      }))
  }
  if (core.getAttachmentCatalog) handle.getAttachmentCatalog = () => core.getAttachmentCatalog!()
  if (core.getSkillCompactionEntries) handle.getSkillCompactionEntries = () => core.getSkillCompactionEntries!()
  if (core.getContextUsage) handle.getContextUsage = (opts) => core.getContextUsage!(opts)
  if (core.getEffectiveSettings) {
    handle.getEffectiveSettings = (): { model: string; permissionMode?: string; effortLevel?: string; agent: string | null } => {
      const settings: NativeEffectiveSettings = core.getEffectiveSettings!()
      return {
        model: settings.model,
        ...(settings.permissionMode !== undefined ? { permissionMode: settings.permissionMode } : {}),
        ...(settings.effortLevel !== undefined ? { effortLevel: settings.effortLevel } : {}),
        agent: settings.agent,
      }
    }
  }
  if (core.getResetBaseSettings) {
    handle.getResetBaseSettings = (): ProviderResetBaseSettings => {
      const base: NativeResetBaseSettings = core.getResetBaseSettings!()
      return {
        model: base.model,
        permissionMode: base.permissionMode,
        effortLevel: base.effortLevel,
        skills: base.skills,
        toolProfile: base.toolProfile,
      }
    }
  }
  if (core.getUsage) handle.getUsage = () => core.getUsage!()
  if (core.accountInfo) handle.accountInfo = () => core.accountInfo!()
  if (core.generateTitle) handle.generateTitle = (description) => core.generateTitle!(description)
  if (core.backgroundTasks) handle.backgroundTasks = (toolUseId) => core.backgroundTasks!(toolUseId)
  if (core.stopTask) handle.stopTask = (taskId) => core.stopTask!(taskId)
  if (core.setModel) handle.setModel = (model) => core.setModel!(model)
  if (core.setPermissionMode) handle.setPermissionMode = (mode) => core.setPermissionMode!(mode)
  if (core.applyFlagSettings) handle.applyFlagSettings = (settings) => core.applyFlagSettings!(settings)
  if (core.setMaxThinkingTokens) handle.setMaxThinkingTokens = (tokens, display) => core.setMaxThinkingTokens!(tokens, display)
  if (core.supportedModels) handle.supportedModels = () => core.supportedModels!()
  if (core.supportedCommands) handle.supportedCommands = () => core.supportedCommands!()
  if (core.supportedAgents) handle.supportedAgents = () => core.supportedAgents!()
  if (core.mcpServerStatus) handle.mcpServerStatus = () => core.mcpServerStatus!()
  if (core.readMcpResource) handle.readMcpResource = (serverName, uri) => core.readMcpResource!(serverName, uri)
  if (core.reconnectMcpServer) handle.reconnectMcpServer = (name) => core.reconnectMcpServer!(name)
  if (core.toggleMcpServer) handle.toggleMcpServer = (name, enabled) => core.toggleMcpServer!(name, enabled)
  if (core.setMcpServers) handle.setMcpServers = (servers) => core.setMcpServers!(servers)
  if (core.setMcpPermissionModeOverride) handle.setMcpPermissionModeOverride = (serverName, mode) => core.setMcpPermissionModeOverride!(serverName, mode)
  if (core.reloadPlugins) handle.reloadPlugins = () => core.reloadPlugins!()
  if (core.readFile) handle.readFile = (path, options) => core.readFile!(path, options)
  if (core.seedReadState) handle.seedReadState = (path, mtime) => core.seedReadState!(path, mtime)
  if (core.listSubagents) handle.listSubagents = () => core.listSubagents!()

  coreByHandle.set(handle, core)
  return handle
}