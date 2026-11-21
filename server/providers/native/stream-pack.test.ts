// Focused pin for the core's AssistantStreamRecord packing (T11): the settled
// assistant content packs into runs honoring the inter-arrival convention
// dt[0] === 0, with a finish `chunk` carrying the stop reason. The neutral→legacy
// projection (session-log/format.ts) reconstructs stop_reason from that finish
// record, so the packing is load-bearing for the legacy turn-boundary signal.

import { describe, expect, it } from 'vitest'
import { packAssistantStream } from './native-session.js'
import { brandString } from './vocabulary/brand.js'
import type { ContentBlock } from './vocabulary/types.js'
import type { AssistantStreamRecord } from './vocabulary/session-event.js'

const TIME0 = 1_700_000_000_000

type RunRecord = Exclude<AssistantStreamRecord, { type: 'chunk' }>
function runs(records: AssistantStreamRecord[]): RunRecord[] {
  return records.filter((r): r is RunRecord => r.type !== 'chunk')
}
function finish(records: AssistantStreamRecord[]) {
  return records.find((r) => r.type === 'chunk' && (r.chunk as { type: string }).type === 'finish')
}

describe('packAssistantStream', () => {
  it('packs a text block into a single-chunk run with dt[0]=0', () => {
    const records = packAssistantStream([{ type: 'text', text: 'hello' }], TIME0, 'end_turn')
    expect(runs(records)).toEqual([
      { type: 'text-chunks', time0: TIME0, index: 0, dt: [0], texts: ['hello'] },
    ])
  })

  it('packs signed reasoning into a reasoning-chunks run', () => {
    const records = packAssistantStream(
      [{ type: 'reasoning', text: 'think', signature: 'sig' }], TIME0, 'end_turn',
    )
    expect(runs(records)).toEqual([
      { type: 'reasoning-chunks', time0: TIME0, index: 0, dt: [0], texts: ['think'] },
    ])
  })

  it('packs redacted reasoning as a verbatim block-end chunk (no text delta)', () => {
    const block: ContentBlock = { type: 'reasoning', text: '', redacted: true, data: 'opaque' }
    const records = packAssistantStream([block], TIME0, 'end_turn')
    expect(runs(records)).toEqual([])
    expect(records[0]).toEqual({ type: 'chunk', time: TIME0, chunk: { type: 'block-end', index: 0, block } })
  })

  it('packs a tool call into a tool-call-chunks run with raw-JSON args', () => {
    const id = brandString<'ToolCallId'>('call-1')
    const records = packAssistantStream(
      [{ type: 'tool-call', id, name: 'Read', arguments: '{"path":"a"}' }], TIME0, 'tool_use',
    )
    expect(runs(records)).toEqual([
      { type: 'tool-call-chunks', time0: TIME0, index: 0, dt: [0], id, name: 'Read', args: ['{"path":"a"}'] },
    ])
  })

  it('aligns block indices across a multi-block message and keeps dt[0]=0 everywhere', () => {
    const id = brandString<'ToolCallId'>('call-1')
    const records = packAssistantStream(
      [{ type: 'text', text: 'before' }, { type: 'tool-call', id, name: 'Read', arguments: '{}' }],
      TIME0, 'tool_use',
    )
    const packed = runs(records)
    expect(packed.map((r) => r.index)).toEqual([0, 1])
    for (const run of packed) expect(run.dt[0]).toBe(0)
  })

  it('carries the stop reason as a finish chunk mapped to the neutral FinishReason', () => {
    expect(finish(packAssistantStream([], TIME0, 'tool_use'))).toMatchObject({ chunk: { reason: { kind: 'tool-calls' } } })
    expect(finish(packAssistantStream([], TIME0, 'max_tokens'))).toMatchObject({ chunk: { reason: { kind: 'max-tokens' } } })
    expect(finish(packAssistantStream([], TIME0, 'end_turn'))).toMatchObject({ chunk: { reason: { kind: 'stop' } } })
  })

  it('omits the finish chunk for an interrupted turn (null stop reason)', () => {
    expect(finish(packAssistantStream([{ type: 'text', text: 'partial' }], TIME0, null))).toBeUndefined()
  })
})