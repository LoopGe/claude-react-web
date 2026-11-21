// server/providers/native/session-log/migration.ts
//
// Lossless v1/v2 → v3 migration projection (design "Persistence v3 + migration",
// R5/R7). `migrateEventToV3` maps ONE legacy SDK-shaped `NativeLogEvent` to its
// neutral `NativeSessionEvent` counterpart, preserving every durable fact the
// host history path, model-history replay, compact, skill, attachment and usage
// consumers read:
//
//   - uuid identities ride the neutral message id (the host uuid is NOT re-minted);
//   - the contiguous seq is carried verbatim;
//   - `parent_tool_use_id` null-vs-string maps one-to-one onto the envelope axis;
//   - thinking signatures / redacted data survive on reasoning blocks;
//   - tool_use input becomes RAW-JSON tool-call arguments (parsing stays a
//     boundary job — the legacy projection re-parses them identically);
//   - a tool_result user frame becomes a first-class `tool/result` event;
//   - inline base64 image content stays a LegacyImageBlock (R5: NO store offload,
//     no host-service side effect inside a neutral migration);
//   - `isCompactSummary` rides the `compact-summary` message source kind;
//   - the raw API stop_reason rides `rawStopReason` so rare reasons the closed
//     FinishReason union cannot express survive (T11 minor 1);
//   - compact text+context, skill body, supplement, descriptor, attachment
//     catalog, agent base snapshot and turn/end + assistant usage map verbatim.
//
// Pure: no I/O, no logging, no host-service imports. Imports only the neutral
// vocabulary + the session-log format types. The inverse projection
// (`projectNeutralEventToLegacy`, format.ts) reconstructs the legacy SDK line the
// host saw; the parsed-line round-trip pin (migration.test.ts) asserts
// `projectNeutralEventToLegacy(migrateEventToV3(e)) === e` on real corpora.

import type {
  NativeAssistantEvent,
  NativeLogEvent,
  NativeUsage,
  NativeUserEvent,
} from './format.js'
import type {
  AssistantStreamRecord,
  NativeSessionEvent,
  SessionEventMap,
} from '../vocabulary/session-event.js'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '../vocabulary/message.js'
import type { ContentBlock, FinishReason, TokenUsage } from '../vocabulary/types.js'
import type { ImageAttachmentRef } from '../../../../shared/image-attachment.js'
import type { FileAttachmentRef } from '../../../../shared/attachments.js'
import { brandString } from '../vocabulary/brand.js'

/** SDK usage counter pair (the v1/v2 turn/end + assistant usage shape) → the
 *  neutral disjoint TokenUsage. Cache buckets are carried when present so the
 *  full usage survives migration (the inverse `sdkUsageOf` re-emits them). */
function neutralUsageOf(usage: NativeUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
  }
}

/** Parse a legacy ISO timestamp to the neutral ms-epoch envelope time. Native
 *  logs stamp `new Date(...).toISOString()` (canonical, millisecond precision),
 *  so the legacy projection's `new Date(time).toISOString()` reconstructs the
 *  identical string. A non-parseable timestamp is corruption surfaced loudly —
 *  v3 requires a finite time and a native log never carries one. */
function timeOf(timestamp: string): number {
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) {
    throw new Error(`native migration: event timestamp is not a parseable ISO string: ${JSON.stringify(timestamp)}`)
  }
  return time
}

/** Map the API stop reason to the neutral FinishReason the packed finish record
 *  carries (mirrors the core settlement mapping). Rare reasons map to `stop`;
 *  the verbatim string is preserved separately on `rawStopReason`. */
function finishReasonOf(stopReason: string): FinishReason {
  switch (stopReason) {
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return { kind: 'stop' }
  }
}

/** One SDK assistant content block → neutral. Reasoning keeps the thinking
 *  signature / redacted data verbatim; tool_use.input becomes RAW-JSON arguments
 *  (the legacy projection re-parses them to the identical input object). */
function neutralAssistantBlock(raw: unknown): ContentBlock {
  const block = raw as { type?: unknown; text?: unknown; thinking?: unknown; signature?: unknown; data?: unknown; id?: unknown; name?: unknown; input?: unknown }
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string }
    case 'thinking':
      return {
        type: 'reasoning',
        text: block.thinking as string,
        ...(block.signature !== undefined ? { signature: block.signature as string } : {}),
      }
    case 'redacted_thinking':
      return { type: 'reasoning', text: '', redacted: true, data: block.data as string }
    case 'tool_use':
      return {
        type: 'tool-call',
        id: brandString<'ToolCallId'>(block.id as string),
        name: block.name as string,
        arguments: JSON.stringify(block.input ?? {}),
      }
    default:
      throw new Error(`native migration: unsupported assistant block type "${String(block.type)}"`)
  }
}

/** One SDK user/tool input content block → neutral. Images discriminate
 *  attachment-first (store-backed ref) vs source (legacy inline base64, R5);
 *  a file occurrence keeps its FULL resolved attachment verbatim. */
function neutralInputBlock(raw: unknown): ContentBlock {
  const block = raw as { type?: unknown; text?: unknown; attachment?: unknown; source?: unknown }
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string }
    case 'image':
      return block.attachment !== undefined
        ? { type: 'image', attachment: block.attachment as ImageAttachmentRef }
        : { type: 'image', source: block.source as { type: 'base64'; data: string; media_type: string } }
    case 'file':
      // The FULL resolved attachment (registry path / mediaType / modelForm)
      // rides structurally — the wire projection and blockPath consumers read it.
      return { type: 'file', attachment: block.attachment as FileAttachmentRef }
    default:
      throw new Error(`native migration: unsupported input block type "${String(block.type)}"`)
  }
}

/** Pack the settled assistant content into AssistantStreamRecord runs honoring
 *  the inter-arrival convention dt[0] === 0 (mirrors the core's
 *  `packAssistantStream`). A legacy log carries no per-delta timing, so each
 *  block becomes one single-chunk run at the event's own time; the finish record
 *  carries the mapped stop reason. The verbatim raw reason rides `rawStopReason`
 *  on the event data, so the legacy projection reconstructs it exactly. */
function packStream(content: readonly ContentBlock[], time0: number, stopReason: string | null | undefined): AssistantStreamRecord[] {
  const records: AssistantStreamRecord[] = []
  for (const [index, block] of content.entries()) {
    switch (block.type) {
      case 'text':
        records.push({ type: 'text-chunks', time0, index, dt: [0], texts: [block.text] })
        break
      case 'reasoning':
        if (block.redacted === true) {
          records.push({ type: 'chunk', time: time0, chunk: { type: 'block-end', index, block } })
        } else {
          records.push({ type: 'reasoning-chunks', time0, index, dt: [0], texts: [block.text] })
        }
        break
      case 'tool-call':
        records.push({ type: 'tool-call-chunks', time0, index, dt: [0], id: block.id, name: block.name, args: [block.arguments] })
        break
      default:
        throw new Error(`native migration: block kind "${(block as { type: string }).type}" is not an assistant emission`)
    }
  }
  if (typeof stopReason === 'string') {
    records.push({ type: 'chunk', time: time0, chunk: { type: 'finish', reason: finishReasonOf(stopReason) } })
  }
  return records
}

/** A legacy tool_result user frame → a first-class neutral `tool/result` event.
 *  The durable shape is exactly ONE tool_result block per user event (the loop
 *  persists one result per call; the crash repair mints one per unanswered id).
 *  Any other shape is a contract violation surfaced loudly, never silently
 *  dropped. The inner content (text + structured files) is preserved verbatim. */
function migrateToolResult(event: NativeUserEvent, time: number): NativeSessionEvent {
  const content = event.message.content
  const block = content[0] as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
  if (content.length !== 1 || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
    throw new Error('native migration: a tool_result user event must carry exactly one tool_result block')
  }
  const callId = brandString<'ToolCallId'>(block.tool_use_id)
  // A legacy tool_result's content may be a bare STRING (the SDK shape older
  // logs / sidechain transcripts carry) or an array of blocks. The neutral
  // message content is always block array; a string becomes one text block.
  // The verbatim string form is an SDK-only representation detail, so it rides
  // the adapter-owned opaque `meta` (fidelity rule) and the legacy projection
  // reconstructs it exactly — keeping migration lossless for string content.
  const rawContent = block.content
  const inner: ContentBlock[] = typeof rawContent === 'string'
    ? [{ type: 'text', text: rawContent }]
    : (Array.isArray(rawContent) ? rawContent : []).map(neutralInputBlock)
  const message: ToolResultMessage = {
    role: 'tool',
    id: brandString<'MessageId'>(event.uuid),
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: inner,
    isError: block.is_error === true,
  }
  return {
    type: 'tool/result',
    seq: event.seq,
    time,
    parentToolUseId: event.parent_tool_use_id,
    data: {
      message,
      ...(typeof rawContent === 'string' ? { meta: { legacyStringContent: rawContent } } : {}),
    },
  }
}

function migrateUser(event: NativeUserEvent): NativeSessionEvent {
  const time = timeOf(event.timestamp)
  const content = event.message.content
  const first = content[0] as { type?: unknown } | undefined
  if (first?.type === 'tool_result') return migrateToolResult(event, time)
  const message: UserMessage = {
    role: 'user',
    id: brandString<'MessageId'>(event.uuid),
    content: content.map(neutralInputBlock),
    source: { kind: 'user' },
  }
  return {
    type: 'user/message',
    seq: event.seq,
    time,
    parentToolUseId: event.parent_tool_use_id,
    data: { ...message, ...(event.isCompactSummary === true ? { isCompactSummary: true as const } : {}) },
  }
}

function migrateAssistant(event: NativeAssistantEvent): NativeSessionEvent {
  const time = timeOf(event.timestamp)
  const msg = event.message
  const content = (msg.content as unknown[]).map(neutralAssistantBlock)
  const message: AssistantMessage = {
    role: 'assistant',
    id: brandString<'MessageId'>(event.uuid),
    content,
    source: { kind: 'model', provider: 'anthropic', model: typeof msg.model === 'string' ? msg.model : '' },
  }
  const usage = msg.usage as NativeUsage | undefined
  const data: SessionEventMap['assistant/message'] = {
    message,
    stream: packStream(content, time, msg.stop_reason),
    ...(usage !== undefined && usage !== null ? { usage: neutralUsageOf(usage) } : {}),
    ...(typeof msg.stop_reason === 'string' ? { rawStopReason: msg.stop_reason } : {}),
  }
  return {
    type: 'assistant/message',
    seq: event.seq,
    time,
    parentToolUseId: event.parent_tool_use_id,
    data,
  }
}

/** Project one legacy v1/v2 log event to its neutral v3 counterpart, losslessly
 *  (uuid/seq/parent preserved; every durable fact carried). The native-owned
 *  operational events map verbatim onto their neutral data payloads; events
 *  without a legacy timestamp (context / turn-end / end-seed) carry envelope
 *  time 0 (the legacy projection ignores it for those types). */
export function migrateEventToV3(event: NativeLogEvent): NativeSessionEvent {
  switch (event.type) {
    case 'user':
      return migrateUser(event)
    case 'assistant':
      return migrateAssistant(event)
    case 'session/context':
      return { type: 'session/context', seq: event.seq, time: 0, data: { text: event.text } }
    case 'turn/end':
      return {
        type: 'turn/end',
        seq: event.seq,
        time: 0,
        data: {
          reason: event.reason,
          ...(event.usage !== undefined ? { usage: neutralUsageOf(event.usage) } : {}),
        },
      }
    case 'session/end-seed':
      return { type: 'session/end-seed', seq: event.seq, time: 0, data: {} }
    case 'session/compact':
      return {
        type: 'session/compact',
        seq: event.seq,
        time: timeOf(event.timestamp),
        data: { text: event.text, context: event.context, uuid: event.uuid, timestamp: event.timestamp },
      }
    case 'session/supplement':
      return {
        type: 'session/supplement',
        seq: event.seq,
        time: timeOf(event.timestamp),
        data: { uuid: event.uuid, text: event.text, timestamp: event.timestamp },
      }
    case 'session/skill':
      return {
        type: 'session/skill',
        seq: event.seq,
        time: timeOf(event.timestamp),
        data: { name: event.name, body: event.body, timestamp: event.timestamp },
      }
    case 'subagent/descriptor':
      return {
        type: 'subagent/descriptor',
        seq: event.seq,
        time: timeOf(event.timestamp),
        data: {
          toolUseId: event.toolUseId,
          parentToolUseId: event.parentToolUseId,
          kind: event.kind,
          toolName: event.toolName,
          label: event.label,
          depth: event.depth,
          profile: event.profile,
          timestamp: event.timestamp,
        },
      }
    case 'session/attachments':
      return {
        type: 'session/attachments',
        seq: event.seq,
        time: timeOf(event.timestamp),
        data: { attachments: event.attachments, timestamp: event.timestamp },
      }
    case 'session/agent':
      return {
        type: 'session/agent',
        seq: event.seq,
        time: timeOf(event.timestamp),
        data: {
          name: event.name,
          ...(event.definition !== undefined ? { definition: event.definition } : {}),
          base: event.base,
          ...(event.droppedAgent !== undefined ? { droppedAgent: event.droppedAgent } : {}),
          timestamp: event.timestamp,
        },
      }
    default: {
      const exhaustive: never = event
      throw new Error(`native migration: unknown legacy event type "${String((exhaustive as { type?: unknown }).type)}"`)
    }
  }
}