import { describe, it, expect, expectTypeOf } from 'vitest'
import { brandString, type ToolCallId } from './brand.js'
import type { ContentBlock, ContentBlockType, FinishReason, TokenUsage } from './types.js'
import type { ReplayEnvelope } from './source.js'
import type { AssistantMessage } from './message.js'
import type { NativeLiveFrame, RawStreamEvent, StreamChunk } from './stream.js'
import { BlockAssembler } from './assembler.js'

/** Exhaustive switch over StreamChunk with NO default: compiles only when the
 *  union is exactly the seven closed kinds and each case narrows to its own
 *  shape (TS2366 otherwise) — the closed-union leak detector, mirroring
 *  message.test.ts's roleDetail. */
function chunkDetail(chunk: StreamChunk): string {
  switch (chunk.type) {
    case 'block-start': return `start:${chunk.index}:${chunk.blockType}`
    case 'text-delta': return `text:${chunk.index}:${chunk.text}`
    case 'reasoning-delta': return `reasoning:${chunk.index}:${chunk.text}`
    case 'tool-call-delta': return `tool:${chunk.index}:${chunk.id}:${chunk.argumentsDelta}`
    case 'block-end': return `end:${chunk.index}:${chunk.block.type}`
    case 'usage': return `usage:${chunk.usage.outputTokens}`
    case 'finish': return `finish:${chunk.reason.kind}`
  }
}

/** NativeLiveFrame discrimination: the raw passthrough kind plus every
 *  StreamChunk kind, exhaustively (no default). */
function frameDetail(frame: NativeLiveFrame): string {
  return frame.type === 'raw-stream-event' ? 'raw' : chunkDetail(frame)
}

const callId = (s: string) => brandString<'ToolCallId'>(s)
const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 }
const SOURCE = { provider: 'anthropic', model: 'claude-test' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('StreamChunk union (closed)', () => {
  it('is exactly the seven specified kinds with the specified fields', () => {
    expectTypeOf<StreamChunk>().toEqualTypeOf<
      | { type: 'block-start'; index: number; blockType: ContentBlockType }
      | { type: 'text-delta'; index: number; text: string }
      | { type: 'reasoning-delta'; index: number; text: string }
      | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
      | { type: 'block-end'; index: number; block: ContentBlock }
      | { type: 'usage'; usage: TokenUsage }
      | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
    >()
  })

  it('discriminates all seven kinds by type', () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'reasoning-delta', index: 1, text: 'think' },
      { type: 'tool-call-delta', index: 2, id: callId('toolu_1'), argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      { type: 'usage', usage: USAGE },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    expect(chunks.map(chunkDetail)).toEqual([
      'start:0:text', 'text:0:hi', 'reasoning:1:think', 'tool:2:toolu_1:{}',
      'end:0:text', 'usage:5', 'finish:stop',
    ])
  })

  it('tool-call-delta carries a branded id and a raw-JSON argumentsDelta string', () => {
    expectTypeOf<Extract<StreamChunk, { type: 'tool-call-delta' }>['id']>().toEqualTypeOf<ToolCallId>()
    expectTypeOf<Extract<StreamChunk, { type: 'tool-call-delta' }>['argumentsDelta']>().toEqualTypeOf<string>()
    expectTypeOf<Extract<StreamChunk, { type: 'tool-call-delta' }>['name']>().toEqualTypeOf<string | undefined>()
  })

  it('finish carries an optional ReplayEnvelope', () => {
    expectTypeOf<Extract<StreamChunk, { type: 'finish' }>['replayState']>().toEqualTypeOf<ReplayEnvelope | undefined>()
  })

  it('rejects an unknown kind and a bare-string tool-call id', () => {
    // @ts-expect-error — the union is closed: no eighth kind
    const bogus: StreamChunk = { type: 'bogus', index: 0 }
    expect(bogus.type).toBe('bogus')
    // @ts-expect-error — a bare string can never pose as a branded ToolCallId
    const rawId: StreamChunk = { type: 'tool-call-delta', index: 0, id: 'toolu_1', argumentsDelta: '' }
    expect(rawId.type).toBe('tool-call-delta')
  })
})

describe('RawStreamEvent / NativeLiveFrame', () => {
  it('RawStreamEvent is an opaque passthrough with an unknown event', () => {
    expectTypeOf<RawStreamEvent['type']>().toEqualTypeOf<'raw-stream-event'>()
    expectTypeOf<RawStreamEvent['event']>().toEqualTypeOf<unknown>()
  })

  it('NativeLiveFrame is exactly StreamChunk | RawStreamEvent', () => {
    expectTypeOf<NativeLiveFrame>().toEqualTypeOf<StreamChunk | RawStreamEvent>()
  })

  it('discriminates the raw kind from every chunk kind', () => {
    const event = { type: 'content_block_delta', delta: { text: 'x' } }
    const frames: NativeLiveFrame[] = [
      { type: 'raw-stream-event', event },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    expect(frames.map(frameDetail)).toEqual(['raw', 'text:0:hi', 'finish:stop'])
    // The event blob is carried verbatim — same reference, never inspected.
    expect((frames[0] as RawStreamEvent).event).toBe(event)
  })
})

describe('BlockAssembler: interleaved assembly', () => {
  it('assembles interleaved deltas by index into ordered blocks', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-start', index: 0, blockType: 'text' })
    a.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
    a.push({ type: 'text-delta', index: 0, text: 'Hel' })
    a.push({ type: 'tool-call-delta', index: 1, id: callId('toolu_1'), name: 'Read', argumentsDelta: '{"file":' })
    a.push({ type: 'text-delta', index: 0, text: 'lo' })
    a.push({ type: 'tool-call-delta', index: 1, id: callId('toolu_1'), argumentsDelta: '"a.ts"}' })
    a.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
    a.push({ type: 'block-end', index: 1, block: { type: 'tool-call', id: callId('toolu_1'), name: 'Read', arguments: '{"file":"a.ts"}' } })
    expect(a.blocks()).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{"file":"a.ts"}' },
    ])
  })

  it('preserves first-seen index order, not numeric order', () => {
    const a = new BlockAssembler()
    a.push({ type: 'text-delta', index: 2, text: 'second-seen-first' })
    a.push({ type: 'text-delta', index: 0, text: 'first-seen-second' })
    expect(a.blocks()).toEqual([
      { type: 'text', text: 'second-seen-first' },
      { type: 'text', text: 'first-seen-second' },
    ])
  })

  it('tolerates a delta-only protocol (no block-start / block-end)', () => {
    const a = new BlockAssembler()
    a.push({ type: 'text-delta', index: 0, text: 'hello' })
    a.push({ type: 'reasoning-delta', index: 1, text: 'hmm' })
    a.push({ type: 'tool-call-delta', index: 2, id: callId('toolu_9'), name: 'Bash', argumentsDelta: '{"cmd":"ls"}' })
    expect(a.blocks()).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'hmm' },
      { type: 'tool-call', id: 'toolu_9', name: 'Bash', arguments: '{"cmd":"ls"}' },
    ])
  })

  it('a duplicate block-start for a seen index does not duplicate the order', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-start', index: 0, blockType: 'text' })
    a.push({ type: 'block-start', index: 0, blockType: 'text' })
    a.push({ type: 'text-delta', index: 0, text: 'once' })
    expect(a.blocks()).toEqual([{ type: 'text', text: 'once' }])
  })

  it('block-end is authoritative over accumulated deltas', () => {
    const a = new BlockAssembler()
    a.push({ type: 'text-delta', index: 0, text: 'partial' })
    a.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'FINAL' } })
    expect(a.blocks()).toEqual([{ type: 'text', text: 'FINAL' }])
  })

  it('first close wins: a re-close and straggler deltas are ignored', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'first' } })
    a.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'second' } })
    a.push({ type: 'text-delta', index: 0, text: 'straggler' })
    a.push({ type: 'reasoning-delta', index: 0, text: 'straggler' })
    expect(a.blocks()).toEqual([{ type: 'text', text: 'first' }])
  })

  it('a straggler tool-call-delta after close cannot corrupt the closed block', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-end', index: 1, block: { type: 'tool-call', id: callId('toolu_1'), name: 'Read', arguments: '{}' } })
    a.push({ type: 'tool-call-delta', index: 1, id: callId('toolu_1'), name: 'Write', argumentsDelta: '{"x":1}' })
    expect(a.blocks()).toEqual([{ type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{}' }])
  })

  it('an open text block assembles from its accumulated deltas', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-start', index: 0, blockType: 'text' })
    a.push({ type: 'text-delta', index: 0, text: 'a' })
    a.push({ type: 'text-delta', index: 0, text: 'b' })
    expect(a.blocks()).toEqual([{ type: 'text', text: 'ab' }])
  })

  it('an open reasoning block assembles from its accumulated deltas', () => {
    const a = new BlockAssembler()
    a.push({ type: 'reasoning-delta', index: 0, text: 'think ' })
    a.push({ type: 'reasoning-delta', index: 0, text: 'more' })
    expect(a.blocks()).toEqual([{ type: 'reasoning', text: 'think more' }])
  })

  it('an open tool-call with no deltas falls back to id call-${index} and name ""', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-start', index: 3, blockType: 'tool-call' })
    const [block] = a.blocks()
    if (block.type !== 'tool-call') throw new Error(`expected tool-call, got ${block.type}`)
    expect(block).toEqual({ type: 'tool-call', id: 'call-3', name: '', arguments: '' })
    expectTypeOf(block.id).toEqualTypeOf<ToolCallId>()
  })

  it('tool-call-delta sets id, keeps a later name, and appends raw-JSON arguments', () => {
    const a = new BlockAssembler()
    a.push({ type: 'tool-call-delta', index: 0, id: callId('toolu_1'), name: 'Read', argumentsDelta: '{"a":' })
    a.push({ type: 'tool-call-delta', index: 0, id: callId('toolu_1'), argumentsDelta: '1}' })
    expect(a.blocks()).toEqual([{ type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{"a":1}' }])
  })

  it('an empty name on a later delta does not erase an earlier name', () => {
    const a = new BlockAssembler()
    a.push({ type: 'tool-call-delta', index: 0, id: callId('toolu_1'), name: 'Read', argumentsDelta: '' })
    a.push({ type: 'tool-call-delta', index: 0, id: callId('toolu_1'), name: '', argumentsDelta: '{}' })
    expect(a.blocks()).toEqual([{ type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{}' }])
  })

  it('a block-start with no deltas assembles an empty text block', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-start', index: 0, blockType: 'text' })
    expect(a.blocks()).toEqual([{ type: 'text', text: '' }])
  })

  it('an open block of a non-delta-assemblable type throws', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-start', index: 0, blockType: 'image' })
    expect(() => a.blocks()).toThrow(/cannot assemble incomplete block of type "image"/)
  })

  it('reads are non-destructive: a mid-stream read then more deltas grows the block', () => {
    const a = new BlockAssembler()
    a.push({ type: 'text-delta', index: 0, text: 'a' })
    expect(a.blocks()).toEqual([{ type: 'text', text: 'a' }])
    a.push({ type: 'text-delta', index: 0, text: 'b' })
    expect(a.blocks()).toEqual([{ type: 'text', text: 'ab' }])
  })
})

describe('BlockAssembler: max-tokens settlement + replay prune', () => {
  const text = (t: string): ContentBlock => ({ type: 'text', text: t })
  const tool = (id: string): ContentBlock => ({ type: 'tool-call', id: callId(id), name: 'Read', arguments: '{}' })

  function seedThree(a: BlockAssembler) {
    a.push({ type: 'block-end', index: 0, block: text('before') })
    a.push({ type: 'block-end', index: 1, block: tool('toolu_1') })
    a.push({ type: 'block-end', index: 2, block: text('after') })
  }

  it('max-tokens drops every tool-call block, keeping text in order', () => {
    const a = new BlockAssembler()
    seedThree(a)
    a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(a.blocks()).toEqual([text('before'), text('after')])
  })

  it('max-tokens prunes replay.blocks at the same positions, keeping response', () => {
    const a = new BlockAssembler()
    seedThree(a)
    const envelope: ReplayEnvelope = { response: { id: 'resp_1' }, blocks: ['e0', 'e1', 'e2'] }
    a.push({ type: 'finish', reason: { kind: 'max-tokens' }, replayState: envelope })
    expect(a.blocks()).toEqual([text('before'), text('after')])
    expect(a.replayState).toEqual({ response: { id: 'resp_1' }, blocks: ['e0', 'e2'] })
  })

  it('an aligned envelope with no tool-calls passes through unchanged', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-end', index: 0, block: text('only') })
    const envelope: ReplayEnvelope = { response: { id: 'resp_1' }, blocks: ['e0'] }
    a.push({ type: 'finish', reason: { kind: 'max-tokens' }, replayState: envelope })
    expect(a.replayState).toBe(envelope)
  })

  it('an envelope without per-block entries passes through unchanged under max-tokens', () => {
    const a = new BlockAssembler()
    seedThree(a)
    const envelope: ReplayEnvelope = { response: { id: 'resp_1' } }
    a.push({ type: 'finish', reason: { kind: 'max-tokens' }, replayState: envelope })
    expect(a.replayState).toBe(envelope)
    expect(a.blocks()).toEqual([text('before'), text('after')])
  })

  it('a misaligned envelope length discards the whole envelope, blocks still settle', () => {
    const a = new BlockAssembler()
    seedThree(a)
    const envelope: ReplayEnvelope = { response: { id: 'resp_1' }, blocks: ['e0', 'e1'] }
    a.push({ type: 'finish', reason: { kind: 'stop' }, replayState: envelope })
    expect(a.replayState).toBeUndefined()
    expect(a.blocks()).toEqual([text('before'), tool('toolu_1'), text('after')])
  })

  it('a non-max-tokens finish drops nothing', () => {
    const a = new BlockAssembler()
    seedThree(a)
    a.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(a.blocks()).toEqual([text('before'), tool('toolu_1'), text('after')])
  })

  it('no finish chunk defaults to stop and drops nothing', () => {
    const a = new BlockAssembler()
    seedThree(a)
    expect(a.blocks()).toEqual([text('before'), tool('toolu_1'), text('after')])
  })

  it('replayState is undefined until a finish chunk carries one', () => {
    const a = new BlockAssembler()
    seedThree(a)
    expect(a.replayState).toBeUndefined()
    const envelope: ReplayEnvelope = { response: { id: 'resp_1' } }
    a.push({ type: 'finish', reason: { kind: 'stop' }, replayState: envelope })
    expect(a.replayState).toBe(envelope)
  })

  it('settlement re-runs: a late max-tokens finish drops tool-calls on the next read', () => {
    const a = new BlockAssembler()
    seedThree(a)
    expect(a.blocks()).toHaveLength(3)
    a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(a.blocks()).toEqual([text('before'), text('after')])
  })
})

describe('BlockAssembler: usage / finish accessors', () => {
  it('usage is undefined until a usage chunk arrives', () => {
    const a = new BlockAssembler()
    expect(a.usage).toBeUndefined()
    a.push({ type: 'usage', usage: USAGE })
    expect(a.usage).toEqual(USAGE)
  })

  it('the last usage chunk wins', () => {
    const a = new BlockAssembler()
    a.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
    a.push({ type: 'usage', usage: USAGE })
    expect(a.usage).toEqual(USAGE)
  })

  it('finish defaults to {kind:"stop"} when the stream ended without one', () => {
    const a = new BlockAssembler()
    expect(a.finish).toEqual({ kind: 'stop' })
  })

  it('finish reflects the terminal finish chunk', () => {
    const a = new BlockAssembler()
    a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(a.finish).toEqual({ kind: 'max-tokens' })
  })

  it('a later finish chunk replaces the stored replay state', () => {
    const a = new BlockAssembler()
    a.push({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'first' } } })
    expect(a.replayState).toEqual({ response: { id: 'first' } })
    a.push({ type: 'finish', reason: { kind: 'stop' } })
    expect(a.replayState).toBeUndefined()
  })
})

describe('BlockAssembler: interruptedBlocks', () => {
  it('keeps closed and open text/reasoning with non-whitespace content, in order', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'closed' } })
    a.push({ type: 'reasoning-delta', index: 1, text: 'open thought' })
    a.push({ type: 'text-delta', index: 2, text: 'open text' })
    expect(a.interruptedBlocks()).toEqual([
      { type: 'text', text: 'closed' },
      { type: 'reasoning', text: 'open thought' },
      { type: 'text', text: 'open text' },
    ])
  })

  it('excludes tool calls (open and closed), whitespace-only, images, and open unknown blocks', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-end', index: 0, block: { type: 'tool-call', id: callId('toolu_1'), name: 'Read', arguments: '{}' } })
    a.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
    a.push({ type: 'text-delta', index: 2, text: '   ' })
    a.push({ type: 'block-end', index: 3, block: { type: 'text', text: '' } })
    a.push({ type: 'block-end', index: 4, block: { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } } })
    a.push({ type: 'block-start', index: 5, blockType: 'file' })
    a.push({ type: 'text-delta', index: 6, text: 'kept' })
    expect(a.interruptedBlocks()).toEqual([{ type: 'text', text: 'kept' }])
  })

  it('is empty when nothing streamed before the interruption', () => {
    const a = new BlockAssembler()
    expect(a.interruptedBlocks()).toEqual([])
  })
})

describe('BlockAssembler: message(source)', () => {
  it('yields a frozen AssistantMessage over blocks() with forced role and source kind', () => {
    const a = new BlockAssembler()
    a.push({ type: 'text-delta', index: 0, text: 'hello' })
    const message = a.message(SOURCE)
    expect(message.role).toBe('assistant')
    expect(message.source).toEqual({ kind: 'model', provider: 'anthropic', model: 'claude-test' })
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(message.id).toMatch(UUID_RE)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expectTypeOf(message).toEqualTypeOf<AssistantMessage>()
  })

  it('applies max-tokens settlement to the message content', () => {
    const a = new BlockAssembler()
    a.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'before' } })
    a.push({ type: 'block-end', index: 1, block: { type: 'tool-call', id: callId('toolu_1'), name: 'Read', arguments: '{}' } })
    a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(a.message(SOURCE).content).toEqual([{ type: 'text', text: 'before' }])
  })

  it('detaches from pushed blocks — later mutation never reaches the message', () => {
    const a = new BlockAssembler()
    const block: ContentBlock = { type: 'text', text: 'before' }
    a.push({ type: 'block-end', index: 0, block })
    const message = a.message(SOURCE)
    block.text = 'after'
    expect(message.content).toEqual([{ type: 'text', text: 'before' }])
  })

  it('carries provider facts and an optional replayState on the source', () => {
    const a = new BlockAssembler()
    a.push({ type: 'text-delta', index: 0, text: 'x' })
    const replayState = { response: { id: 'resp_1' } }
    const message = a.message({ ...SOURCE, replayState })
    expect(message.source.replayState).toEqual(replayState)
    expect(message.source.replayState).not.toBe(replayState)
  })
})

describe('BlockAssembler: assertNever on an unknown chunk', () => {
  it('throws on a chunk that escaped the closed union', () => {
    const a = new BlockAssembler()
    const bogus = { type: 'bogus', index: 0 } as unknown as StreamChunk
    expect(() => a.push(bogus)).toThrow(/unreachable variant in BlockAssembler\.push/)
  })
})
