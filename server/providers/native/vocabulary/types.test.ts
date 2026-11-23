import { describe, it, expect, expectTypeOf } from 'vitest'
import { brandString, type MessageId, type ToolCallId } from './brand.js'
import {
  finishReasonOf,
  isRetainedThinkingBlock,
  parseToolInput,
  type ContentBlock,
  type ContentBlockMap,
  type ContentBlockType,
  type FileBlock,
  type FinishReason,
  type ImageBlock,
  type ImageRefBlock,
  type LlmFailure,
  type ReasoningBlock,
  type TextBlock,
  type TokenUsage,
  type ToolAdditionBlock,
  type ToolCallBlock,
  type ToolRemovalBlock,
} from './types.js'
import type { FileAttachmentRef } from '../../../../shared/attachments.js'
import type { ImageAttachmentRef, LegacyImageBlock } from '../../../../shared/image-attachment.js'

const imageRef: ImageAttachmentRef = {
  id: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 1024,
  width: 8,
  height: 8,
}

const fileRef: FileAttachmentRef = {
  id: 'up_1',
  name: 'notes.txt',
  size: 12,
  digest: 'b'.repeat(64),
}

/** Exhaustive switch: compiles only when every ContentBlock member is covered
 *  and each case narrows to its own shape (no trailing return needed). */
function blockPayload(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'reasoning': return block.text
    case 'image': return 'attachment' in block ? block.attachment.id : block.source.data
    case 'file': return block.attachment.name
    case 'tool-call': return block.arguments
    case 'tool-addition': return block.toolName
    case 'tool-removal': return block.toolName
  }
}

/** Exhaustive switch over FinishReason; aborted/error narrow to the failure. */
function finishDetail(reason: FinishReason): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool-calls'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return reason.failure.code
    case 'error': return reason.failure.code
  }
}

describe('isRetainedThinkingBlock', () => {
  it('keeps every non-thinking block', () => {
    expect(isRetainedThinkingBlock({ type: 'text' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'tool_use' })).toBe(true)
    expect(isRetainedThinkingBlock({})).toBe(true)
  })

  it('keeps thinking only with a non-empty string signature', () => {
    expect(isRetainedThinkingBlock({ type: 'thinking', signature: 'sig-1' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'thinking', signature: '' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'thinking' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'thinking', signature: 1 })).toBe(false)
  })

  it('keeps redacted_thinking only with non-empty string data', () => {
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking', data: 'ENCRYPTED' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking', data: '' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking', data: 1 })).toBe(false)
  })

  it('applies the same retention to NEUTRAL reasoning blocks (T13 replay)', () => {
    // Signed reasoning kept; unsigned / empty-signature stripped.
    expect(isRetainedThinkingBlock({ type: 'reasoning', signature: 'sig-1' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'reasoning', signature: '' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'reasoning' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'reasoning', signature: 1 })).toBe(false)
    // Redacted reasoning kept only with non-empty string data.
    expect(isRetainedThinkingBlock({ type: 'reasoning', redacted: true, data: 'ENC' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'reasoning', redacted: true, data: '' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'reasoning', redacted: true })).toBe(false)
  })
})

describe('parseToolInput (shared boundary parse)', () => {
  it('parses a JSON object into the tool input', () => {
    expect(parseToolInput('{"command":"ls","n":2}')).toEqual({ command: 'ls', n: 2 })
    expect(parseToolInput('{}')).toEqual({})
  })

  it('empty, invalid and non-object JSON become {}', () => {
    expect(parseToolInput('')).toEqual({})
    expect(parseToolInput('not json')).toEqual({})
    expect(parseToolInput('{broken')).toEqual({})
    expect(parseToolInput('5')).toEqual({})
    expect(parseToolInput('"str"')).toEqual({})
    expect(parseToolInput('true')).toEqual({})
    expect(parseToolInput('null')).toEqual({})
  })

  it('a JSON array becomes {} — tool_use.input must be an object on replay', () => {
    // Arrays are typeof 'object' but not a valid Anthropic tool_use.input;
    // the shared parse rejects them like any other non-object JSON (the
    // wire projection pin asserts the same shape end-to-end).
    expect(parseToolInput('[1,2]')).toEqual({})
    expect(parseToolInput('[]')).toEqual({})
  })
})

describe('finishReasonOf (shared settlement mapping)', () => {
  it('maps tool_use and max_tokens to their settlement kinds', () => {
    expect(finishReasonOf('tool_use')).toEqual({ kind: 'tool-calls' })
    expect(finishReasonOf('max_tokens')).toEqual({ kind: 'max-tokens' })
  })

  it('every other reason — including null and unknown strings — maps to stop', () => {
    expect(finishReasonOf('end_turn')).toEqual({ kind: 'stop' })
    expect(finishReasonOf('stop_sequence')).toEqual({ kind: 'stop' })
    expect(finishReasonOf(null)).toEqual({ kind: 'stop' })
    expect(finishReasonOf('')).toEqual({ kind: 'stop' })
    expect(finishReasonOf('unknown')).toEqual({ kind: 'stop' })
  })
})

describe('ContentBlock union', () => {
  it('discriminates all seven members by type', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'hmm', signature: 'sig' },
      { type: 'image', attachment: imageRef },
      { type: 'file', attachment: fileRef },
      { type: 'tool-call', id: brandString('toolu_01'), name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'tool-addition', toolName: 'Read' },
      { type: 'tool-removal', toolName: 'Write' },
    ]
    expect(blocks.map(blockPayload)).toEqual([
      'hello', 'hmm', imageRef.id, 'notes.txt', '{"command":"ls"}', 'Read', 'Write',
    ])
  })

  it('derives ContentBlockType and ContentBlock from the merge-extensible map', () => {
    expectTypeOf<ContentBlockType>().toEqualTypeOf<
      'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | 'tool-addition' | 'tool-removal'
    >()
    expectTypeOf<ContentBlockMap['text']>().toEqualTypeOf<TextBlock>()
    expectTypeOf<ContentBlockMap['reasoning']>().toEqualTypeOf<ReasoningBlock>()
    expectTypeOf<ContentBlockMap['image']>().toEqualTypeOf<ImageBlock>()
    expectTypeOf<ContentBlockMap['file']>().toEqualTypeOf<FileBlock>()
    expectTypeOf<ContentBlockMap['tool-call']>().toEqualTypeOf<ToolCallBlock>()
    expectTypeOf<ContentBlockMap['tool-addition']>().toEqualTypeOf<ToolAdditionBlock>()
    expectTypeOf<ContentBlockMap['tool-removal']>().toEqualTypeOf<ToolRemovalBlock>()
    expectTypeOf<ContentBlock>().toEqualTypeOf<
      TextBlock | ReasoningBlock | ImageBlock | FileBlock | ToolCallBlock | ToolAdditionBlock | ToolRemovalBlock
    >()
  })

  it('keeps ToolCallBlock.arguments a RAW JSON string (never parsed here)', () => {
    const call: ToolCallBlock = {
      type: 'tool-call',
      id: brandString('toolu_01'),
      name: 'Bash',
      arguments: '{"command":"ls -la"}',
    }
    expectTypeOf<ToolCallBlock['arguments']>().toEqualTypeOf<string>()
    expect(call.arguments).toBe('{"command":"ls -la"}')
    expect(JSON.parse(call.arguments)).toEqual({ command: 'ls -la' })
  })

  it('ImageBlock accepts both the ref form and the legacy base64 form (R5)', () => {
    const refForm: ImageBlock = { type: 'image', attachment: imageRef }
    const legacyForm: ImageBlock = {
      type: 'image',
      source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' },
    }
    expectTypeOf<ImageBlock>().toEqualTypeOf<ImageRefBlock | LegacyImageBlock>()
    expect('attachment' in refForm).toBe(true)
    expect('source' in legacyForm).toBe(true)
    if ('attachment' in refForm) expect(refForm.attachment).toEqual(imageRef)
    if ('source' in legacyForm) expect(legacyForm.source.data).toBe('aGVsbG8=')
  })

  it('ImageRefBlock marks offloaded occurrences with offloaded: true', () => {
    const offloaded: ImageRefBlock = { type: 'image', attachment: imageRef, offloaded: true }
    expect(offloaded.offloaded).toBe(true)
  })

  it('FileBlock carries the neutral FileAttachmentRef', () => {
    expectTypeOf<FileBlock['attachment']>().toEqualTypeOf<FileAttachmentRef>()
    const block: FileBlock = { type: 'file', attachment: fileRef }
    expect(block.attachment.name).toBe('notes.txt')
  })

  it('ReasoningBlock preserves thinking signature and redacted data', () => {
    const signed: ReasoningBlock = { type: 'reasoning', text: 'hmm', signature: 'sig-1' }
    const redacted: ReasoningBlock = { type: 'reasoning', text: '', redacted: true, data: 'ENCRYPTED' }
    expect(signed.signature).toBe('sig-1')
    expect(redacted.redacted).toBe(true)
    expect(redacted.data).toBe('ENCRYPTED')
  })
})

describe('TokenUsage', () => {
  it('carries disjoint token counts', () => {
    const usage: TokenUsage = {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 44,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 7,
    }
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(20)
    expect(usage.cacheReadTokens).toBe(5)
    expect(usage.cacheWriteTokens).toBe(2)
    expect(usage.reasoningTokens).toBe(7)
    expectTypeOf<TokenUsage['inputTokens']>().toEqualTypeOf<number>()
    expectTypeOf<TokenUsage['outputTokens']>().toEqualTypeOf<number>()
    expectTypeOf<TokenUsage['totalTokens']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<TokenUsage['cacheReadTokens']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<TokenUsage['cacheWriteTokens']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<TokenUsage['reasoningTokens']>().toEqualTypeOf<number | undefined>()
    const minimal: TokenUsage = { inputTokens: 1, outputTokens: 2 }
    expect(minimal.totalTokens).toBeUndefined()
  })
})

describe('LlmFailure', () => {
  it('carries a structured failure with optional provider metadata', () => {
    const failure: LlmFailure = {
      message: 'rate limited',
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 26_000,
      requestId: 'req_1',
    }
    expect(failure.message).toBe('rate limited')
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.status).toBe(429)
    expect(failure.providerRetryAfterMs).toBe(26_000)
    expect(failure.requestId).toBe('req_1')
    const minimal: LlmFailure = { message: 'boom', code: 'TRANSPORT' }
    expect(minimal.status).toBeUndefined()
    expectTypeOf<LlmFailure['message']>().toEqualTypeOf<string>()
    expectTypeOf<LlmFailure['code']>().toEqualTypeOf<string>()
    expectTypeOf<LlmFailure['status']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<LlmFailure['providerRetryAfterMs']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<LlmFailure['requestId']>().toEqualTypeOf<string | undefined>()
  })
})

describe('FinishReason', () => {
  it('discriminates by kind; aborted and error carry the failure', () => {
    const failure: LlmFailure = { message: 'aborted by user', code: 'ABORTED' }
    const reasons: FinishReason[] = [
      { kind: 'stop' },
      { kind: 'tool-calls' },
      { kind: 'max-tokens' },
      { kind: 'aborted', failure },
      { kind: 'error', failure: { message: 'boom', code: 'TRANSPORT' } },
    ]
    expect(reasons.map(finishDetail)).toEqual(['stop', 'tool-calls', 'max-tokens', 'ABORTED', 'TRANSPORT'])
    expectTypeOf<FinishReason>().toEqualTypeOf<
      | { kind: 'stop' }
      | { kind: 'tool-calls' }
      | { kind: 'max-tokens' }
      | { kind: 'aborted'; failure: LlmFailure }
      | { kind: 'error'; failure: LlmFailure }
    >()
  })
})

describe('brandString', () => {
  it('returns the same string value', () => {
    expect(brandString('toolu_01')).toBe('toolu_01')
  })

  it('brands strings usable as ToolCallId and MessageId', () => {
    const callId: ToolCallId = brandString('toolu_01')
    const messageId: MessageId = brandString('msg_01')
    expect(callId).toBe('toolu_01')
    expect(messageId).toBe('msg_01')
    expectTypeOf(brandString<'ToolCallId'>('x')).toEqualTypeOf<ToolCallId>()
    expectTypeOf(brandString<'MessageId'>('x')).toEqualTypeOf<MessageId>()
    expectTypeOf<ToolCallId>().toMatchTypeOf<string>()
    expectTypeOf<MessageId>().toMatchTypeOf<string>()
  })

  it('keeps brands distinct and unforgeable from plain strings', () => {
    expectTypeOf<string>().not.toMatchTypeOf<ToolCallId>()
    expectTypeOf<string>().not.toMatchTypeOf<MessageId>()
    expectTypeOf<MessageId>().not.toMatchTypeOf<ToolCallId>()
    expectTypeOf<ToolCallId>().not.toMatchTypeOf<MessageId>()
  })
})
