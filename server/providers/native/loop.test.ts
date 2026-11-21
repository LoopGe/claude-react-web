// server/providers/native/loop.test.ts
import { describe, expect, it, vi } from 'vitest'
import { runTurn, type LoopDeps, type NativeLoopFrame } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import { assistantFrame, defaultFrameContext, isRetainedThinkingBlock, resultFrame, streamEventFrame, toolResultFrame, type Frame, type FrameContext } from '../native-frames.js'
import { projectNativeFrameToSdk, projectNativeEventToSdk, type NativeFrameEnvelope } from '../native-host-frame-adapter.js'
import type { RequestMessage, ToolResultMessage } from './vocabulary/message.js'
import type { AssistantFrame, OperationalFrame } from './vocabulary/live-frame.js'
import { NativeTaskManager } from './task-manager.js'
import { createReadTool } from './tools/read.js'
import { NativeReadState } from './read-state.js'
import { askUserQuestionTool } from './tools/ask-user-question.js'
import type { ToolContext, ToolDef, ToolOutcome } from './tools/types.js'

/** Scripted fake streamer: one entry per API round-trip in the turn. Yields
 *  canonical events directly — the loop's actual contract. `req.messages` is
 *  the WIRE request (API-shaped), so request assertions stay SDK-shaped even
 *  though the loop's history and emission are neutral. */
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
  tools: [createReadTool(new NativeReadState())],
  cwd: process.cwd(),
  tasks: new NativeTaskManager(() => {}),
  requestPermission: async (_t, input, _id, _signal) => ({ allowed: true, input }),
  emit: () => {},
  persistToolResult: () => {},
  attachmentProjection: {},
  system: 'SYS',
  ...over,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

// ── neutral emission accessors ────────────────────────────────────────────
const isAssistant = (f: NativeLoopFrame): f is AssistantFrame => 'type' in f && f.type === 'assistant-frame'
const isToolResult = (f: NativeLoopFrame): f is ToolResultMessage => 'role' in f && f.role === 'tool'
const isResult = (f: NativeLoopFrame) => 'type' in f && f.type === 'result'
const isRaw = (f: NativeLoopFrame) => 'type' in f && f.type === 'raw-stream-event'
const assistantOf = (emitted: NativeLoopFrame[]) => emitted.find(isAssistant)!
const toolResultsOf = (emitted: NativeLoopFrame[]) => emitted.filter(isToolResult)
const userText = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })

interface WireToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: Array<{ type: 'text'; text: string }>
  is_error: boolean
}

/** tool_result blocks in the last WIRE request message (API-shaped). */
function wireToolResults(request: unknown): WireToolResultBlock[] {
  const messages = request as Array<{ role: string; content: unknown[] }>
  return messages.at(-1)!.content.filter(
    (block): block is WireToolResultBlock => (block as { type?: string }).type === 'tool_result',
  )
}

describe('runTurn — neutral emission + neutral history', () => {
  it('single text response: emits raw passthrough, neutral assistant frame, result frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'hello'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'),
      [], userText('hi'), 'm1', new AbortController().signal,
    )
    expect(res.finalText).toBe('hello')
    expect(res.isError).toBe(false)
    expect(res.numTurns).toBe(1)
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    // 5 raw passthrough events + assistant-frame + result.
    expect(emitted.map((f) => (isRaw(f) ? 'raw' : isAssistant(f) ? 'assistant' : isResult(f) ? 'result' : 'other'))).toEqual([
      'raw', 'raw', 'raw', 'raw', 'raw', 'assistant', 'result',
    ])
    const assistant = assistantOf(emitted)
    expect(assistant.message.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(assistant.stopReason).toBe('end_turn')
    expect(assistant.model).toBe('m1')
    expect(assistant.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('forwards raw Anthropic events byte-identically (R2), falling back to the canonical shape', async () => {
    const rawStart = { type: 'message_start', message: { id: 'msg_raw', usage: { input_tokens: 10 } } }
    const rawDelta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }
    const s = scriptedStreamer([
      [
        { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 }, raw: rawStart },
        { kind: 'block_start', index: 0, block: { type: 'text' } },
        { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'hello' }, raw: rawDelta },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
      ],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    const raws = emitted.filter(isRaw) as Array<{ type: 'raw-stream-event'; event: unknown }>
    // Events carrying a raw payload forward it VERBATIM (same reference).
    expect(raws[0].event).toBe(rawStart)
    expect(raws[2].event).toBe(rawDelta)
    // Events without a raw payload fall back to the canonical shape.
    expect(raws[1].event).toEqual({ kind: 'block_start', index: 0, block: { type: 'text' } })
    expect(raws[4].event).toEqual({ kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } })
  })

  it('sources stopReason directly from message_end (F2), not the replay envelope', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'truncated'), deltaStop('max_tokens')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    // No replay envelope is produced by the canonical stream; stopReason still
    // carries the raw API string.
    expect(assistantOf(emitted).stopReason).toBe('max_tokens')
    expect(assistantOf(emitted).replayState).toBeUndefined()
  })

  it('accepts ordered initial user messages without merging them or later tool results', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const initial: readonly RequestMessage[] = [userText('/demo do X'), userText('CANONICAL SKILL BODY')]
    const history: RequestMessage[] = []

    await runTurn(
      baseDeps({ stream: s.stream.bind(s) }),
      defaultFrameContext('sess-1'), history, initial, 'm1', new AbortController().signal,
    )

    // The wire request keeps the two user messages distinct (API-shaped).
    expect(s.calls[0]).toEqual([{ role: 'user', content: [{ type: 'text', text: '/demo do X' }] }, { role: 'user', content: [{ type: 'text', text: 'CANONICAL SKILL BODY' }] }])
    expect((s.calls[1] as unknown[]).slice(0, 2)).toEqual(s.calls[0])
    expect(wireToolResults(s.calls[1])).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 't1' }),
    ])
    // Neutral history keeps the initial messages by reference.
    expect(history[0]).toBe(initial[0])
    expect(history[1]).toBe(initial[1])
  })

  it('tool round-trip: permission → execute → neutral tool result → second response', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    const permCalls: string[] = []
    const res = await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f),
        requestPermission: async (name, input, _id, _signal) => { permCalls.push(name); return { allowed: true, input } },
      }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    expect(permCalls).toEqual(['Read'])
    expect(res.numTurns).toBe(2)
    const toolResult = toolResultsOf(emitted)[0]
    expect(toolResult.toolCallId).toBe('t1')
    expect(toolResult.content[0]).toMatchObject({ type: 'text' })
    // The neutral history carries a first-class role-tool message.
  })

  it('groups consecutive first-class tool results into ONE wire user message', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{}'), ...toolUseBlock(1, 't2', 'Read', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const tool: ToolDef = { name: 'Read', description: 'd', guidance: 'g', promptOrder: 1, schema: {}, async run() { return { text: 'body' } } }
    const history: RequestMessage[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), tools: [tool] }), defaultFrameContext('sess-1'), history, userText('hi'), 'm1', new AbortController().signal)
    // Neutral history keeps TWO first-class role-tool messages…
    expect(history.filter((m) => m.role === 'tool')).toHaveLength(2)
    // …the wire request regroups them into ONE user message with two blocks.
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second).toHaveLength(3)
    expect(second[2].role).toBe('user')
    expect(wireToolResults(s.calls[1]).map((r) => r.tool_use_id)).toEqual(['t1', 't2'])
  })

  it('caps model rounds without permitting or executing final-round tool calls', async () => {
    const run = vi.fn(async () => ({ text: 'ran' }))
    const tool: ToolDef = { name: 'Capped', description: 'd', guidance: 'g', promptOrder: 1, schema: {}, run }
    const requestPermission = vi.fn(async (_name: string, input: Record<string, unknown>) => ({ allowed: true, input }))
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'partial report'), ...toolUseBlock(1, 't1', 'Capped', '{}'), ...toolUseBlock(2, 't2', 'Capped', '{}'), deltaStop('tool_use')],
    ])
    const emitted: NativeLoopFrame[] = []
    const history: RequestMessage[] = []

    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), tools: [tool], requestPermission, emit: (frame) => emitted.push(frame), maxTurns: 1 }),
      defaultFrameContext('sess-1'), history, userText('hi'), 'm1', new AbortController().signal,
    )

    expect(requestPermission).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(res).toMatchObject({ isError: true, numTurns: 1, finalText: 'partial report' })
    // user input + assistant + 2 first-class tool results = 4 neutral messages.
    expect(history).toHaveLength(4)
    const assistant = history[1] as { role: string; content: ReadonlyArray<{ type: string; id: string }> }
    expect(assistant.role).toBe('assistant')
    expect(assistant.content.filter((b) => b.type === 'tool-call').map((b) => [b.type, b.id])).toEqual([['tool-call', 't1'], ['tool-call', 't2']])
    expect((history[2] as ToolResultMessage).toolCallId).toBe('t1')
    expect((history[2] as ToolResultMessage).content).toEqual([{ type: 'text', text: 'max turns reached (1); tool not executed' }])
    expect((history[2] as ToolResultMessage).isError).toBe(true)
    expect((history[3] as ToolResultMessage).toolCallId).toBe('t2')
    // maxTurns caps the turn after one round: the synthetic results join history
    // and the live stream but no further wire request is built.
    expect(s.calls).toHaveLength(1)
    const liveResults = toolResultsOf(emitted)
    expect(liveResults.map((r) => r.toolCallId)).toEqual(['t1', 't2'])
    expect(liveResults[0].content).toEqual([{ type: 'text', text: 'max turns reached (1); tool not executed' }])
    const terminal = emitted.filter(isResult)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ isError: true })
  })

  it('completes normally when the final allowed round ends without tool calls', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'done'), deltaStop('end_turn')]])
    const emitted: NativeLoopFrame[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (frame) => emitted.push(frame), maxTurns: 1 }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    expect(res).toMatchObject({ finalText: 'done', isError: false, numTurns: 1 })
    expect(emitted.filter(isResult)).toHaveLength(1)
    expect(emitted.find(isResult)).toMatchObject({ isError: false })
  })

  it('marks a final allowed round without natural end_turn as an error', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'truncated'), deltaStop('max_tokens')]])
    const emitted: NativeLoopFrame[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (frame) => emitted.push(frame), maxTurns: 1 }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    expect(res).toMatchObject({ finalText: 'truncated', isError: true, numTurns: 1 })
    expect(emitted.find(isResult)).toMatchObject({ isError: true })
  })

  it.each([0, -1, 1.5])('rejects invalid maxTurns %s before writing history', async (maxTurns) => {
    const s = scriptedStreamer([])
    const history: RequestMessage[] = []
    await expect(runTurn(
      baseDeps({ stream: s.stream.bind(s), maxTurns }),
      defaultFrameContext('sess-1'), history, userText('hi'), 'm1', new AbortController().signal,
    )).rejects.toThrow(/maxTurns.*positive integer/)
    expect(history).toEqual([])
    expect(s.calls).toEqual([])
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
      name: 'Detachable', description: 'd', guidance: 'g', promptOrder: 1, schema: {},
      backgroundable: { taskType: 'shell', describe: (input) => `run ${input.command}` },
      async run(_input, ctx) { taskSignal = ctx.signal; markStarted(); return execution.promise },
    }
    const taskFrames: OperationalFrame[] = []
    const tasks = new NativeTaskManager((frame) => taskFrames.push(frame))
    const turn = new AbortController()
    const deps = baseDeps({
      stream: s.stream.bind(s), tools: [tool], tasks,
      requestPermission: async () => ({ allowed: true, input: { command: 'updated' } }),
    })
    const waiting = runTurn(deps, defaultFrameContext('sess-1'), [], userText('hi'), 'm1', turn.signal)
    await started
    expect(taskSignal).not.toBe(turn.signal)
    expect(tasks.background('tu-1')).toBe(true)
    await vi.waitFor(() => expect(s.calls).toHaveLength(2))
    const results = wireToolResults(s.calls[1])
    expect(results).toEqual([expect.objectContaining({ tool_use_id: 'tu-1', is_error: false })])
    expect(results[0].content[0].text).toContain('TaskOutput')
    expect(taskFrames[0]).toMatchObject({ type: 'task/started', taskId: 'tu-1', description: 'run updated', taskType: 'local_bash' })
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
      name: 'Direct', description: 'd', guidance: 'g', promptOrder: 1, schema: {},
      async run(_input, ctx) { toolSignal = ctx.signal; return { text: 'direct output' } },
    }
    await runTurn(baseDeps({ stream: s.stream.bind(s), tools: [tool], tasks }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', turn.signal)
    expect(toolSignal).toBe(turn.signal)
    expect(runForeground).not.toHaveBeenCalled()
  })

  it('denied permission produces an error tool result and continues', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f), requestPermission: async (_t, input, _id, _signal) => ({ allowed: false, input, message: 'nope' }) }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    const toolResult = toolResultsOf(emitted)[0]
    expect(toolResult.isError).toBe(true)
    expect(JSON.stringify(toolResult.content)).toContain('nope')
  })

  async function runAskUserQuestion(decision: { message?: string; questionResult?: boolean }): Promise<ToolResultMessage> {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'AskUserQuestion', '{"questions":[{"question":"q1","options":[{"label":"a"}]}]}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f), tools: [askUserQuestionTool], requestPermission: async (_t, input, _id, _signal) => ({ allowed: false, input, ...decision }) }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    return toolResultsOf(emitted)[0]
  }

  it('a marked AskUserQuestion denial is the answer payload, not an error', async () => {
    const answer = JSON.stringify({ note: 'ok', answers: [{ question: 'q1', answer: 'a' }] })
    const result = await runAskUserQuestion({ message: answer, questionResult: true })
    expect(result.toolCallId).toBe('t1')
    expect(result.content).toEqual([{ type: 'text', text: answer }])
    expect(result.isError).toBe(false)
  })

  it('a marked clarification (plain text) is also a normal tool result', async () => {
    const clarification = 'User wants to clarify: focus on the second option.'
    const result = await runAskUserQuestion({ message: clarification, questionResult: true })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toBe(clarification)
  })

  it('an aborted AskUserQuestion denial stays an error', async () => {
    expect((await runAskUserQuestion({ message: 'aborted' })).isError).toBe(true)
  })

  it('a session-closed AskUserQuestion denial stays an error', async () => {
    expect((await runAskUserQuestion({ message: 'session closed' })).isError).toBe(true)
  })

  it('an unmarked (missing-handler / ordinary) AskUserQuestion denial stays an error', async () => {
    expect((await runAskUserQuestion({ message: 'no permission handler registered for this session' })).isError).toBe(true)
  })

  it('the question-result marker never downgrades another tool denial', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f), requestPermission: async (_t, input, _id, _signal) => ({ allowed: false, input, message: 'nope', questionResult: true }) }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    expect(toolResultsOf(emitted)[0].isError).toBe(true)
  })

  it('unknown tool name yields an error tool result', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Nope', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    const toolResult = toolResultsOf(emitted)[0]
    expect(toolResult.isError).toBe(true)
    expect((toolResult.content[0] as { text: string }).text).toContain('unknown tool: Nope')
  })

  it('abort between tools skips the remaining tools but answers every tool_use', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), ...toolUseBlock(1, 't2', 'Read', '{"file_path":"b.txt"}'), deltaStop('tool_use')],
    ])
    const emitted: NativeLoopFrame[] = []
    const permCalls: string[] = []
    const ac = new AbortController()
    const abortDuringT1 = async (name: string, input: Record<string, unknown>, _id: string, _sig: AbortSignal) => {
      permCalls.push(name)
      if (permCalls.length === 1) ac.abort()
      return { allowed: true, input }
    }
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f), requestPermission: abortDuringT1 }),
      defaultFrameContext('sess-1'), [], userText('hi'), 'm1', ac.signal,
    )
    expect(permCalls).toEqual(['Read'])
    const results = toolResultsOf(emitted)
    expect(results.map((r) => r.toolCallId)).toEqual(['t1', 't2'])
    expect(results[1].isError).toBe(true)
  })

  it('emitResult: false suppresses the terminal result frame but returns TurnResult', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'inner'), deltaStop('end_turn')]])
    const emitted: NativeLoopFrame[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f), emitResult: false }),
      defaultFrameContext('sess-1', 'tu1'), [], userText('hi'), 'm1', new AbortController().signal,
    )
    expect(emitted.some(isResult)).toBe(false)
    expect(res.finalText).toBe('inner')
    expect(res.numTurns).toBe(1)
    expect(res.isError).toBe(false)
  })

  it('passes the tool_use id to the tool context', async () => {
    const seen: Array<ToolContext | undefined> = []
    const captureTool: ToolDef = {
      name: 'Capture', description: 'd', guidance: 'g', promptOrder: 1, schema: {},
      async run(_input, ctx) { seen.push(ctx); return { text: 'ok' } },
    }
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 'tu-9', 'Capture', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    await runTurn(baseDeps({ stream: s.stream.bind(s), tools: [captureTool] }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolUseId).toBe('tu-9')
    expect(seen[0]?.cwd).toBe(process.cwd())
  })

  it('injects drained supplements into neutral history before the NEXT request, verbatim', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const wrapped = '[ADDITIONAL GUIDANCE] wrapped pivot'
    let drainCalls = 0
    const drainSupplement = async () => { drainCalls++; return drainCalls === 1 ? [] : [{ uuid: 'sup-1', text: wrapped }] }
    const history: RequestMessage[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), drainSupplement }), defaultFrameContext('sess-1'), history, userText('hi'), 'm1', new AbortController().signal)
    expect(drainCalls).toBe(2)
    expect(JSON.stringify(s.calls[0])).not.toContain('[ADDITIONAL GUIDANCE]')
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(second.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: wrapped }] })
    expect(JSON.stringify(second).split('[ADDITIONAL GUIDANCE]')).toHaveLength(2)
    // The supplement joined the NEUTRAL history as a user message.
    expect(history.some((m) => m.role === 'user' && JSON.stringify(m.content).includes(wrapped))).toBe(true)
  })

  it('second wire request carries the assistant blocks and grouped tool results', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    await runTurn(baseDeps({ stream: s.stream.bind(s) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    const second = s.calls[1] as unknown[]
    expect(second).toHaveLength(3)
    expect((second[1] as { role: string }).role).toBe('assistant')
    expect((second[2] as { role: string }).role).toBe('user')
  })

  it('keeps a signed thinking block in the next request and the neutral assistant frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...thinkingBlock(0, 'plan', 'sig-1'), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(assistantOf(emitted).message.content[0]).toEqual({ type: 'reasoning', text: 'plan', signature: 'sig-1' })
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second[1].content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1' })
  })

  it('strips an unsigned thinking block from the next request but keeps it in the assistant frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...thinkingBlock(0, 'plan'), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(assistantOf(emitted).message.content[0]).toEqual({ type: 'reasoning', text: 'plan' })
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string }> }>
    expect(second[1].content.map((b) => b.type)).toEqual(['tool_use'])
  })

  it('keeps a redacted_thinking block with data in the next request and the assistant frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...redactedThinkingBlock(0, 'ENCRYPTED'), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(assistantOf(emitted).message.content[0]).toEqual({ type: 'reasoning', text: '', redacted: true, data: 'ENCRYPTED' })
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second[1].content[0]).toEqual({ type: 'redacted_thinking', data: 'ENCRYPTED' })
  })

  it('strips a thinking block whose signature_delta is empty from the wire request', async () => {
    const s = scriptedStreamer([
      [startStop, ...thinkingBlock(0, 'plan', ''), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(assistantOf(emitted).message.content[0]).toEqual({ type: 'reasoning', text: 'plan' })
    const second = s.calls[1] as Array<{ role: string; content: Array<{ type: string }> }>
    expect(second[1].content.map((b) => b.type)).toEqual(['tool_use'])
  })

  it('strips a redacted_thinking block with empty data from the wire request but keeps the assistant frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...redactedThinkingBlock(0, ''), ...toolUseBlock(1, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(assistantOf(emitted).message.content[0]).toEqual({ type: 'reasoning', text: '', redacted: true, data: '' })
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
    const emitted: NativeLoopFrame[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), defaultFrameContext('sess-1'), [], userText('hi'), 'm1', new AbortController().signal)
    expect(assistantOf(emitted).message.content[0]).toEqual({ type: 'reasoning', text: 'plan', signature: 'sig-1sig-2' })
    const second = s.calls[1] as Array<{ role: string; content: unknown[] }>
    expect(second[1].content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1sig-2' })
  })

  it('projects structured files on every tool round without modifying neutral history', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const attachment = { id: 'upload-1', name: 'notes.txt', size: 4, digest: 'a'.repeat(64), path: '/registry/notes.txt', modelForm: 'handle' as const }
    const initial: RequestMessage = { role: 'user', content: [{ type: 'file', attachment }, { type: 'text', text: 'read it' }] }
    const history: RequestMessage[] = []
    await runTurn(baseDeps({ stream: s.stream.bind(s) }), defaultFrameContext('sess-1'), history, initial, 'm1', new AbortController().signal)
    expect(s.calls).toHaveLength(2)
    for (const request of s.calls) expect(JSON.stringify(request)).not.toContain('"type":"file"')
    expect(JSON.stringify(s.calls[0])).toContain('Upload id: upload-1')
    expect(JSON.stringify(s.calls[1])).toContain('Upload id: upload-1')
    // The neutral history keeps the structured file occurrence by reference.
    expect(history[0]).toBe(initial)
    expect((history[0] as { content: readonly unknown[] }).content[0]).toBe((initial as { content: readonly unknown[] }).content[0])
  })

  it('persists structured tool content once and shares its UUID with the text-only live frame', async () => {
    const attachment = { id: 'upload-1', name: 'notes.txt', size: 4, digest: 'a'.repeat(64), path: '/registry/notes.txt', modelForm: 'handle' as const }
    const tool: ToolDef = {
      ...createReadTool(new NativeReadState()),
      async run() { return { text: 'read notes.txt', content: [{ type: 'text', text: 'read notes.txt' }, { type: 'file', attachment }] } },
    }
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    const persisted: Array<{ uuid: string; message: ToolResultMessage }> = []
    const history: RequestMessage[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), tools: [tool], emit: (frame) => emitted.push(frame), persistToolResult: (record) => persisted.push(record) }),
      defaultFrameContext('sess-1'), history, userText('hi'), 'm1', new AbortController().signal,
    )
    const liveFrame = toolResultsOf(emitted)[0]
    expect(persisted).toHaveLength(1)
    // The live frame id IS the persisted uuid (shared identity).
    expect(liveFrame.id).toBe(persisted[0].uuid)
    expect(liveFrame.content).toEqual([{ type: 'text', text: 'read notes.txt' }])
    // The persisted neutral message carries the FULL canonical content (file included).
    expect(persisted[0].message.content).toEqual([{ type: 'text', text: 'read notes.txt' }, { type: 'file', attachment }])
    expect(JSON.stringify(s.calls[1])).not.toContain('"type":"file"')
    expect(JSON.stringify(s.calls[1])).toContain('Upload id: upload-1')
    // The neutral history keeps the structured file in the first-class tool message.
    const historyTool = history.find((m) => m.role === 'tool') as ToolResultMessage
    expect(JSON.stringify(historyTool.content)).toContain('"type":"file"')
  })
})

// ── Live pin: neutral emission projects (T6) to the SAME SDK frames ─────────
// The legacy loop emitted SDK frames via frames.ts. The neutral loop emits
// neutral frames; the host boundary projects them through the T6 adapter. This
// pin asserts the projection reproduces the legacy SDK frames exactly (random
// uuid / msg_ ids normalized — they are minted independently on each path).

/** Project a neutral loop frame to SDK exactly as native-session's emission
 *  boundary does (envelope derived from the frame context). */
function projectToSdk(frame: NativeLoopFrame, ctx: FrameContext): Frame {
  const parent = ctx.parentToolUseId ?? null
  if ('type' in frame) {
    switch (frame.type) {
      case 'init': case 'api/retry': case 'informational': case 'task/started': case 'task/notification': case 'result': {
        const projected = projectNativeEventToSdk(frame)
        if (projected === null) throw new Error('operational frame projected to null')
        return projected as Frame
      }
    }
  }
  const uuid = 'role' in frame && frame.role === 'tool'
    ? frame.id
    : 'type' in frame && frame.type === 'assistant-frame'
      ? frame.message.id
      : ctx.uuid()
  const env: NativeFrameEnvelope = { sessionId: ctx.sessionId, uuid, parentToolUseId: parent }
  return projectNativeFrameToSdk(frame as never, env) as Frame
}

/** Normalize independently-minted identities so two emission paths compare on
 *  structure: top-level uuids and `msg_`-prefixed message ids. Meaningful ids
 *  (tool_use ids, tool_use_id) are preserved. */
function normalizeIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeIds)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (key === 'uuid') out[key] = '<uuid>'
      else if (key === 'id' && typeof val === 'string' && val.startsWith('msg_')) out[key] = '<msgid>'
      else out[key] = normalizeIds(val)
    }
    return out
  }
  return value
}

describe('live pin — neutral frames project to the legacy SDK frames', () => {
  it('text turn: stream_event passthrough + assistant + result match frames.ts', async () => {
    const events: CanonicalEvent[] = [startStop, ...textBlock(0, 'hello'), deltaStop('end_turn')]
    const s = scriptedStreamer([events])
    const emitted: NativeLoopFrame[] = []
    const ctx = defaultFrameContext('sess-1')
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }), ctx, [], userText('hi'), 'm1', new AbortController().signal)

    const projected = emitted.map((f) => normalizeIds(projectToSdk(f, ctx)))
    const usage = { input_tokens: 10, output_tokens: 5 }
    const legacy = [
      ...events.map((ev) => streamEventFrame(ctx, ev.raw ?? ev)),
      assistantFrame(ctx, { model: 'm1', content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn', usage }),
      resultFrame(ctx, { result: 'hello', usage, numTurns: 1, durationMs: 0, isError: false }),
    ].map((f) => normalizeIds(f))
    expect(projected).toEqual(legacy)
  })

  it('tool turn: assistant(tool_use) + text-only tool_result user frame match frames.ts', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    const ctx = defaultFrameContext('sess-1')
    const tool: ToolDef = { name: 'Read', description: 'd', guidance: 'g', promptOrder: 1, schema: {}, async run() { return { text: 'file body' } } }
    await runTurn(baseDeps({ stream: s.stream.bind(s), tools: [tool], emit: (f) => emitted.push(f) }), ctx, [], userText('hi'), 'm1', new AbortController().signal)

    // Compare the assistant + tool-result + final assistant frames (skip the
    // raw passthrough events, pinned separately).
    const conversation = emitted.filter((f) => !isRaw(f))
    const projected = conversation.map((f) => normalizeIds(projectToSdk(f, ctx)))
    const usage = { input_tokens: 10, output_tokens: 5 }
    const toolUuid = (conversation.find(isToolResult) as ToolResultMessage).id
    const legacy = [
      assistantFrame(ctx, { model: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }], stopReason: 'tool_use', usage }),
      toolResultFrame(ctx, 't1', 'file body', false, toolUuid),
      assistantFrame(ctx, { model: 'm1', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage }),
      resultFrame(ctx, { result: 'done', usage, numTurns: 2, durationMs: 0, isError: false }),
    ].map((f) => normalizeIds(f))
    expect(projected).toEqual(legacy)
  })

  it('structured tool content: the live SDK tool_result frame matches frames.ts while the file rides persistence', async () => {
    // Handle form (the AttachmentRead same-partition duplicate result): the
    // wire projection needs no registry port, so the pin stays loop-scoped.
    const attachment = { id: 'upload-1', name: 'document.pdf', size: 4, digest: 'a'.repeat(64), path: '/registry/document.pdf', mediaType: 'application/pdf', modelForm: 'handle' as const }
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'AttachmentRead', '{"id":"upload-1"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: NativeLoopFrame[] = []
    const persisted: Array<{ uuid: string; message: ToolResultMessage }> = []
    const ctx = defaultFrameContext('sess-1')
    const tool: ToolDef = {
      name: 'AttachmentRead', description: 'd', guidance: 'g', promptOrder: 1, schema: {},
      async run() { return { text: 'Read PDF document.pdf', content: [{ type: 'text', text: 'Read PDF document.pdf' }, { type: 'file', attachment }] } },
    }
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), tools: [tool], emit: (f) => emitted.push(f), persistToolResult: (record) => persisted.push(record) }),
      ctx, [], userText('hi'), 'm1', new AbortController().signal,
    )

    const conversation = emitted.filter((f) => !isRaw(f))
    const projected = conversation.map((f) => normalizeIds(projectToSdk(f, ctx)))
    const usage = { input_tokens: 10, output_tokens: 5 }
    const toolUuid = (conversation.find(isToolResult) as ToolResultMessage).id
    const legacy = [
      assistantFrame(ctx, { model: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'AttachmentRead', input: { id: 'upload-1' } }], stopReason: 'tool_use', usage }),
      toolResultFrame(ctx, 't1', 'Read PDF document.pdf', false, toolUuid),
      assistantFrame(ctx, { model: 'm1', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage }),
      resultFrame(ctx, { result: 'done', usage, numTurns: 2, durationMs: 0, isError: false }),
    ].map((f) => normalizeIds(f))
    expect(projected).toEqual(legacy)
    // The structured file never enters the live SDK frame; the persisted
    // neutral tool message keeps the full canonical content (file included).
    expect(JSON.stringify(projected)).not.toContain('"type":"file"')
    expect(persisted[0].message.content).toEqual([{ type: 'text', text: 'Read PDF document.pdf' }, { type: 'file', attachment }])
  })

  it('sidechain parent is preserved on every projected conversation frame', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'inner'), deltaStop('end_turn')]])
    const emitted: NativeLoopFrame[] = []
    const ctx = defaultFrameContext('sess-1', 'tu-parent')
    await runTurn(baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f), emitResult: false }), ctx, [], userText('hi'), 'm1', new AbortController().signal)
    for (const frame of emitted) {
      expect(projectToSdk(frame, ctx).parent_tool_use_id).toBe('tu-parent')
    }
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
