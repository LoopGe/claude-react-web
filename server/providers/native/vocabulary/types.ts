// Neutral content-block vocabulary for the native provider core. Imports
// ONLY neutral shared/* refs and the local brand helper — zero SDK or
// host-domain imports (the neutrality pin in ../host-free.test.ts covers
// this directory). Mirrors DSH dsh-llm's block shapes, native-tailored:
// reasoning blocks keep the thinking signature / redacted data the
// Anthropic API needs on replay, and tool-call arguments stay RAW JSON
// strings end-to-end (parsing belongs to the wire adapter).

import type { ImageAttachmentRef, LegacyImageBlock } from '../../../../shared/image-attachment.js'
import type { FileAttachmentRef } from '../../../../shared/attachments.js'
import type { ToolCallId } from './brand.js'

export interface TextBlock {
  type: 'text'
  text: string
}

/** Model reasoning. `signature` (signed thinking) and `redacted` + `data`
 *  (redacted thinking) are preserved verbatim for API replay — see
 *  isRetainedThinkingBlock below. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  signature?: string
  redacted?: true
  data?: string
}

/** One image occurrence backed by the content-addressed store. Distinct
 *  from shared/image-attachment.ts's wire ImageRefBlock: the vocabulary
 *  form additionally marks occurrences whose bytes were offloaded. */
export interface ImageRefBlock {
  type: 'image'
  attachment: ImageAttachmentRef
  offloaded?: true
}

/** Mixed image model (design resolution R5): store-backed refs AND the
 *  legacy inline base64 block, which v1/v2 logs persist verbatim and
 *  migration preserves as-is (no migration-time offload). */
export type ImageBlock = ImageRefBlock | LegacyImageBlock

export interface FileBlock {
  type: 'file'
  attachment: FileAttachmentRef
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: ToolCallId
  name: string
  /** RAW JSON string — never parsed inside the vocabulary. */
  arguments: string
}

export interface ToolAdditionBlock {
  type: 'tool-addition'
  toolName: string
}

export interface ToolRemovalBlock {
  type: 'tool-removal'
  toolName: string
}

/** Merge-extensible (declaration merging): extensions add a key here and
 *  the derived unions below pick it up automatically. */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'file': FileBlock
  'tool-call': ToolCallBlock
  'tool-addition': ToolAdditionBlock
  'tool-removal': ToolRemovalBlock
}

export type ContentBlockType = keyof ContentBlockMap
export type ContentBlock = ContentBlockMap[ContentBlockType]

/** Disjoint token counts: `inputTokens` is uncached input only; cache
 *  reads/writes and reasoning tokens are separate, never folded in. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** The API usage-counter shape (snake_case, as the Anthropic API returns it):
 *  a plain SDK-free counter pair, relocated here from the former
 *  native/frames.ts so the core's live accounting (lastUsage / usageByModel /
 *  turn-end usage) needs no adapter import. TokenUsage above is the neutral
 *  internal currency; the core bridges the two at its own boundary. */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** A structured LLM failure. Codes are defined at the native API boundary
 *  (CONTEXT_WINDOW_EXCEEDED, EMPTY_RESPONSE, AUTH, RATE_LIMIT, TIMEOUT,
 *  TRANSPORT, …), not enumerated here. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

/** Merge-extensible (declaration merging), like ContentBlockMap. */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}

export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/** Model history may carry a thinking block only when the API can verify it:
 *  signed (`signature` non-empty) or redacted (`data` non-empty). The API
 *  rejects unsigned thinking on a follow-up request, so those are stripped
 *  from history — the UI-facing assistant frame keeps every block. Semantics
 *  moved from ../frames.ts (which keeps its SDK-shaped copy for the legacy
 *  live loop); the two must never diverge. Handles BOTH the neutral
 *  `reasoning` block (T13 neutral replay filters with this) and the SDK
 *  `thinking` / `redacted_thinking` shapes (the wire adapter filters projected
 *  blocks with the same predicate). */
export function isRetainedThinkingBlock(block: { type?: unknown; signature?: unknown; data?: unknown; redacted?: unknown }): boolean {
  if (block.type === 'reasoning') {
    if (block.redacted === true) return typeof block.data === 'string' && block.data !== ''
    return typeof block.signature === 'string' && block.signature !== ''
  }
  if (block.type === 'thinking') return typeof block.signature === 'string' && block.signature !== ''
  if (block.type === 'redacted_thinking') return typeof block.data === 'string' && block.data !== ''
  return true
}
