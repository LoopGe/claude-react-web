// server/providers/native/loop.test.ts
import { describe, expect, it } from 'vitest'
import { runTurn, type LoopDeps } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import { defaultFrameContext, type Frame } from './frames.js'
import { readTool } from './tools/read.js'

/** Scripted fake streamer: one entry per API round-trip in the turn. Yields
 *  canonical events directly — the loop's actual contract. */
function scriptedStreamer(scripts: CanonicalEvent[][]) {
  let call = 0
  return {
    calls: [] as unknown[],
    async *stream(req: { messages: unknown[] }) {
      this.calls.push(structuredClone(req.messages))
      for (const ev of scripts[call++] ?? []) yield ev
    },
  }
}

function textBlock(index: number, text: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'text' } },
    { kind: 'block_delta', index, delta: { type: 'text', text } },
    { kind: 'block_end', index },
  ]
}

function toolUseBlock(index: number, id: string, name: string, inputJson: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index },
  ]
}

const startStop: CanonicalEvent = { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
const deltaStop = (stop: string): CanonicalEvent => ({ kind: 'message_end', stopReason: stop, usage: { output_tokens: 5 } })

const baseDeps = (over: Partial<LoopDeps>): LoopDeps => ({
  stream: async function* () { /* replaced by tests */ },
  tools: [readTool],
  cwd: process.cwd(),
  requestPermission: async (_t, input, _id, _signal) => ({ allowed: true, input }),
  emit: () => {},
  system: 'SYS',
  ...over,
})

describe('runTurn', () => {
  it('single text response: emits stream events, assistant frame, result frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'hello'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    expect(res.finalText).toBe('hello')
    expect(res.isError).toBe(false)
    expect(res.numTurns).toBe(1)
    const types = emitted.map((f) => f.type)
    expect(types).toEqual(['stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result'])
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('tool round-trip: permission → execute → tool_result → second response', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    const permCalls: string[] = []
    const res = await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f as Frame),
        requestPermission: async (name, input, _id, _signal) => { permCalls.push(name); return { allowed: true, input } },
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    // cwd of the test run contains no a.txt, but the loop only needs the
    // tool to RUN — a missing file yields an error tool_result and the turn
    // continues. Assert the flow instead of the content.
    expect(permCalls).toEqual(['Read'])
    expect(res.numTurns).toBe(2)
    const toolResult = emitted.find((f) => f.type === 'user') as Frame
    expect(toolResult.message.content[0].type).toBe('tool_result')
    expect(toolResult.message.content[0].tool_use_id).toBe('t1')
  })

  it('denied permission produces an error tool_result and continues', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f as Frame),
        requestPermission: async (_t, input, _id, _signal) => ({ allowed: false, input, message: 'nope' }),
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const toolResult = emitted.find((f) => f.type === 'user') as Frame
    expect(toolResult.message.content[0].is_error).toBe(true)
    expect(JSON.stringify(toolResult.message.content[0])).toContain('nope')
  })

  it('unknown tool name yields an error tool_result', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Nope', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const toolResult = emitted.find((f) => f.type === 'user') as Frame
    expect(toolResult.message.content[0].is_error).toBe(true)
    expect(toolResult.message.content[0].content[0].text).toContain('unknown tool: Nope')
  })

  it('abort between tools skips the remaining tools but answers every tool_use', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), ...toolUseBlock(1, 't2', 'Read', '{"file_path":"b.txt"}'), deltaStop('tool_use')],
    ])
    const emitted: Frame[] = []
    const permCalls: string[] = []
    // The turn signal aborts while t1 is being processed (t1 still runs —
    // the abort lands after its permission resolves); t2 must never reach
    // requestPermission.
    const ac = new AbortController()
    const abortDuringT1 = async (name: string, input: Record<string, unknown>, _id: string, _sig: AbortSignal) => {
      permCalls.push(name)
      if (permCalls.length === 1) ac.abort()
      return { allowed: true, input }
    }
    await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f as Frame),
        requestPermission: abortDuringT1,
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', ac.signal,
    )
    expect(permCalls).toEqual(['Read'])
    // tool_result frames are one-per-result: collect them all in order.
    const results = emitted.filter((f) => f.type === 'user').map((f) => (f as Frame).message.content[0] as { tool_use_id: string; is_error: boolean })
    // Both tool_uses are answered: t1 ran, t2 got the synthetic aborted result.
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2'])
    expect(results[1].is_error).toBe(true)
  })

  it('second request history contains the assistant blocks and tool results, without thinking blocks', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    await runTurn(
      baseDeps({ stream: s.stream.bind(s) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const second = s.calls[1] as unknown[]
    // user input + assistant(tool_use) + user(tool_result) = 3 messages
    expect(second).toHaveLength(3)
    expect((second[1] as { role: string }).role).toBe('assistant')
    expect((second[2] as { role: string }).role).toBe('user')
  })
})
