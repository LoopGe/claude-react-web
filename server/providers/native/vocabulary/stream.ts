// Neutral live-stream vocabulary for the native provider core: the closed
// StreamChunk union the BlockAssembler folds, plus the opaque RawStreamEvent
// passthrough (design resolution R2). Imports ONLY sibling vocabulary modules
// (./brand, ./types, ./source) — zero SDK or host-domain imports. Mirrors DSH
// dsh-llm's StreamChunk, native-tailored with the raw-event second frame kind.

import type { ToolCallId } from './brand.js'
import type { ContentBlock, ContentBlockType, FinishReason, TokenUsage } from './types.js'
import type { ReplayEnvelope } from './source.js'

/** Raw streaming protocol emitted by adapters. Block indexes correlate
 *  interleaved deltas, and `block-end` carries the authoritative assembled
 *  block. CLOSED on purpose — consumers switch + assertNever over it.
 *  Tool-call arguments stay RAW JSON strings end-to-end: `argumentsDelta`
 *  accumulates raw JSON, and parsing belongs to the wire adapter. */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }

/** Opaque raw-protocol passthrough (R2): the adapter forwards the Anthropic
 *  stream event verbatim so the client reads byte-identical raw fields
 *  (`content_block_start.content_block.name`, `content_block_delta.delta.text`,
 *  `message_delta.usage.output_tokens`, `message_stop`). Core never inspects
 *  `event` — an unknown blob is permitted inside the neutral vocabulary
 *  precisely because it is never interpreted here. */
export interface RawStreamEvent {
  type: 'raw-stream-event'
  event: unknown
}

/** One neutral live frame: an assembler chunk or a raw passthrough event.
 *  The durable SessionEvent vocabulary is distinct — live-only frames are
 *  never persisted (design resolution R6). */
export type NativeLiveFrame = StreamChunk | RawStreamEvent
