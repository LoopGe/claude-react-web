// server/providers/native/loop.test.ts
import { describe, expect, it, vi } from 'vitest'
import { runTurn, type LoopDeps } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import { defaultFrameContext, isRetainedThinkingBlock, type Frame } from './frames.js'
import { NativeTaskManager } from './task-manager.js'
import { readTool } from './tools/read.js'
import { askUserQuestionTool } from './tools/ask-user-question.js'
import type { ToolContext, ToolDef, ToolOutcome } from './tools/types.js'

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

function thinkingBlock(index: number, thinking: string, signature?: string): CanonicalEvent[] {
  const events: CanonicalEvent[] = [
    { kind: 'block_start', index, block: { type: 'thinking' } },
    { kind: 'block_delta', index, delta: { type: 'thinking', thinking } },
  ]
  if (signature !== undefined) events.push({ kind: 'block_delta', index, delta: { type: 'signature', signature } })
  events.push({ kind: 'block_end', index })
  return events
}

function redactedThinkingBlock(index: number, data: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'redacted_thinking', data } },
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
  tasks: new NativeTaskManager(() => {}),
  requestPermission: async (_t, input, _id, _signal) => ({ allowed: true, input }),
  emit: () => {},
  system: 'SYS',
  ...over,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: Array<{ type: 'text'; text: string }>
  is_error: boolean
}

function toolResultsOf(request: unknown): ToolResultBlock[] {
  const messages = request as Array<{ role: string; content: unknown[] }>
  return messages.at(-1)!.content.filter(
    (block): block is ToolResultBlock => (block as { type?: string }).type === 'tool_result',
  )
}

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

  it('detaches a backgroundable tool and continues with its TaskOutput acknowledgement', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 'tu-1', 'Detachable', '{"command":"original"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const execution = deferred<ToolOutcome>()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let taskSignal: AbortSignal | undefined
    const tool: ToolDef<{ command: string }> = {
      name: 'Detachable',
      description: 'd',
      guidance: 'g',
      promptOrder: 1,
      schema: {},
      backgroundable: {
        taskType: 'shell',
        describe: (input) => `run ${input.command}`,
      },
      async run(_input, ctx) {
        taskSignal = ctx.signal
        markStarted()
        return execution.promise
      },
    }
    const taskFrames: Frame[] = []
    const tasks = new NativeTaskManager((frame) => taskFrames.push(frame as Frame))
    const turn = new AbortController()
    const deps = baseDeps({
      stream: s.stream.bind(s),
      tools: [tool],
      tasks,
      requestPermission: async () => ({ allowed: true, input: { command: 'updated' } }),
    })

    const waiting = runTurn(
      deps,
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', turn.signal,
    )
    await started
    expect(taskSignal).not.toBe(turn.signal)
    expect(tasks.background('tu-1')).toBe(true)
    await vi.waitFor(() => expect(s.calls).toHaveLength(2))

    const results = toolResultsOf(s.calls[1])
    expect(results).toEqual([
      expect.objectContaining({ tool_use_id: 'tu-1', is_error: false }),
    ])
    expect(results[0].content[0].text).toContain('TaskOutput')
    expect(taskFrames[0]).toMatchObject({
      subtype: 'task_started',
      task_id: 'tu-1',
      description: 'run updated',
      task_type: 'local_bash',
    })

    execution.resolve({ text: 'eventual output' })
    await expect(waiting).resolves.toMatchObject({ finalText: 'done' })
  })

  it('keeps non-backgroundable tools on the direct path with the original turn signal', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 'tu-direct', 'Direct', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const tasks = new NativeTaskManager(() => {})
    const runForeground = vi.spyOn(tasks, 'runForeground')
    const turn = new AbortController()
    let toolSignal: AbortSignal | undefined
    const tool: ToolDef = {
      name: 'Direct',
      description: 'd',
      guidance: 'g',
      promptOrder: 1,
      schema: {},
      async run(_input, ctx) {
        toolSignal = ctx.signal
        return { text: 'direct output' }
      },
    }

    await runTurn(
      baseDeps({ stream: s.stream.bind(s), tools: [tool], tasks }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', turn.signal,
    )

    expect(toolSignal).toBe(turn.signal)
    expect(runForeground).not.toHaveBeenCalled()
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

  /** Run one scripted AskUserQuestion call whose permission decision is
   *  `decision`, and return its tool_result block. */
  async function runAskUserQuestion(
    decision: { message?: string; questionResult?: boolean },
  ): Promise<{ tool_use_id: string; content: Array<{ text: string }>; is_error: boolean }> {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'AskUserQuestion', '{"questions":[{"question":"q1","options":[{"label":"a"}]}]}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f as Frame),
        tools: [askUserQuestionTool],
        requestPermission: async (_t, input, _id, _signal) => ({ allowed: false, input, ...decision }),
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const toolResult = emitted.find((f) => f.type === 'user') as Frame
    return toolResult.message.content[0] as { tool_use_id: string; content: Array<{ text: string }>; is_error: boolean }
  }

  it('a marked AskUserQuestion denial is the answer payload, not an error', async () => {
    const answer = JSON.stringify({ note: 'ok', answers: [{ question: 'q1', answer: 'a' }] })
    const result = await runAskUserQuestion({ message: answer, questionResult: true })
    expect(result).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'text', text: answer }],
      is_error: false,
    })
  })

  it('a marked clarification (plain text) is also a normal tool result', async () => {
    const clarification = 'User wants to clarify: focus on the second option.'
    const result = await runAskUserQuestion({ message: clarification, questionResult: true })
    expect(result.is_error).toBe(false)
    expect(result.content[0].text).toBe(clarification)
  })

  it('an aborted AskUserQuestion denial stays an error', async () => {
    const result = await runAskUserQuestion({ message: 'aborted' })
    expect(result.is_error).toBe(true)
  })

  it('a session-closed AskUserQuestion denial stays an error', async () => {
    const result = await runAskUserQuestion({ message: 'session closed' })
    expect(result.is_error).toBe(true)
  })

  it('an unmarked (missing-handler / ordinary) AskUserQuestion denial stays an error', async () => {
    const result = await runAskUserQuestion({ message: 'no permission handler registered for this session' })
    expect(result.is_error).toBe(true)
  })

  it('the question-result marker never downgrades another tool denial', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f as Frame),
        requestPermission: async (_t, input, _id, _signal) => ({ allowed: false, input, message: 'nope', questionResult: true }),
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const toolResult = emitted.find((f) => f.type === 'user') as Frame
    expect(toolResult.message.content[0].is_error).toBe(true)
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

  it('emitResult: false suppresses the terminal result frame but returns TurnResult', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'inner'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame), emitResult: false }),
      defaultFrameContext('sess-1', 'tu1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    expect(emitted.some((f) => f.type === 'result')).toBe(false)
    expect(res.finalText).toBe('inner')
    expect(res.numTurns).toBe(1)
    expect(res.isError).toBe(false)
  })

  it('passes the tool_use id to the tool context', async () => {
    const seen: Array<ToolContext | undefined> = []
    const captureTool: ToolDef = {
      name: 'Capture',
      description: 'd',
      guidance: 'g',
      promptOrder: 1,
      schema: {},
      async run(_input, ctx) {
        seen.push(ctx)
        return { text: 'ok' }
      },
    }
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 'tu-9', 'Capture', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), tools: [captureTool] }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolUseId).toBe('tu-9')
    expect(seen[0]?.cwd).toBe(process.cwd())
  })

  it('injects drained supplements into history before the NEXT request, verbatim', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    // Already-wrapped guidance (the session wraps it; the loop must not).
    const wrapped = '[ADDITIONAL GUIDANCE] wrapped pivot'
    let drainCalls = 0
    const drainSupplement = async () => {
      drainCalls++
      return drainCalls === 1 ? [] : [{ uuid: 'sup-1', text: wrapped }]
    }
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), drainSupplement }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    // Drained before every round (including the first, which had nothing).
    expect(drainCalls).toBe(2)
    expect(JSON.stringify(s.calls[0])).not.toContain('[ADDITIONAL GUIDANCE]')
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(second.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: wrapped }] })
    // Exactly one injection.
    expect(JSON.stringify(second).split('[ADDITIONAL GUIDANCE]')).toHaveLength(2)
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

  it('keeps a signed thinking block in the next request and the UI frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...thinkingBlock(0, 'plan', 'sig-1'), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1' })
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second[1].content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1' })
  })

  it('strips an unsigned thinking block from the next request but keeps it in the UI frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...thinkingBlock(0, 'plan'), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'thinking', thinking: 'plan' })
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string }> }>
    expect(second[1].content.map((b) => b.type)).toEqual(['tool_use'])
  })

  it('keeps a redacted_thinking block with data in the next request and the UI frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...redactedThinkingBlock(0, 'ENCRYPTED'), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'redacted_thinking', data: 'ENCRYPTED' })
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second[1].content[0]).toEqual({ type: 'redacted_thinking', data: 'ENCRYPTED' })
  })

  it('strips a thinking block whose signature_delta is empty from API history', async () => {
    const s = scriptedStreamer([
      [startStop, ...thinkingBlock(0, 'plan', ''), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'thinking', thinking: 'plan' })
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string }> }>
    expect(second[1].content.map((b) => b.type)).toEqual(['tool_use'])
  })

  it('strips a redacted_thinking block with empty data from API history but keeps the UI frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...redactedThinkingBlock(0, ''), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'redacted_thinking', data: '' })
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string }> }>
    expect(second[1].content.map((b) => b.type)).toEqual(['tool_use'])
  })

  it('accumulates multiple signature deltas onto one thinking block', async () => {
    const s = scriptedStreamer([
      [
        startStop,
        { kind: 'block_start', index: 0, block: { type: 'thinking' } },
        { kind: 'block_delta', index: 0, delta: { type: 'thinking', thinking: 'plan' } },
        { kind: 'block_delta', index: 0, delta: { type: 'signature', signature: 'sig-1' } },
        { kind: 'block_delta', index: 0, delta: { type: 'signature', signature: 'sig-2' } },
        { kind: 'block_end', index: 0 },
        ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'),
        deltaStop('tool_use'),
      ],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f as Frame) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const assistant = emitted.find((f) => f.type === 'assistant') as Frame
    expect(assistant.message.content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1sig-2' })
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second[1].content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1sig-2' })
  })
})

describe('isRetainedThinkingBlock', () => {
  it('keeps every non-thinking block type', () => {
    expect(isRetainedThinkingBlock({ type: 'text' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'tool_use' })).toBe(true)
    expect(isRetainedThinkingBlock({})).toBe(true)
  })

  it('keeps a thinking block only with a non-empty signature', () => {
    expect(isRetainedThinkingBlock({ type: 'thinking', signature: 'sig-1' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'thinking', signature: '' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'thinking' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'thinking', signature: 1 })).toBe(false)
  })

  it('keeps a redacted_thinking block only with non-empty data', () => {
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking', data: 'ENCRYPTED' })).toBe(true)
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking', data: '' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking' })).toBe(false)
    expect(isRetainedThinkingBlock({ type: 'redacted_thinking', data: 1 })).toBe(false)
  })
})
