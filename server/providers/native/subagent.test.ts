// server/providers/native/subagent.test.ts
import { describe, expect, it } from 'vitest'
import { createAgentTool, type AgentToolDeps } from './subagent.js'
import { defaultFrameContext, type Frame } from './frames.js'
import type { CanonicalEvent } from './canonical.js'
import type { AgentMessage } from '../../agent-message.js'
import type { AgentDefinitionStore, StoredAgentDefinition } from '../../agent-definition-store.js'
import type { ToolDef } from './tools/types.js'
import { readTool } from './tools/read.js'

type StreamReq = { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }

/** One entry per nested API round-trip; captures the request and the opts so
 *  the tests can assert what the nested loop asked for. */
function scriptedStreamer(scripts: CanonicalEvent[][]) {
  let call = 0
  const streamer = {
    calls: [] as StreamReq[],
    opts: [] as Array<{ suppressRetryFrames?: boolean } | undefined>,
    async *streamFor(req: StreamReq, opts?: { suppressRetryFrames?: boolean }) {
      streamer.calls.push({ ...req, messages: structuredClone(req.messages), tools: structuredClone(req.tools) })
      streamer.opts.push(opts)
      for (const ev of scripts[call++] ?? []) yield ev
    },
  }
  return streamer
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

const noopTool: ToolDef = {
  name: 'Noop',
  description: 'Does nothing.',
  guidance: 'Noop.',
  promptOrder: 1,
  schema: {},
  async run() { return { text: 'ok' } },
}

const extraTool: ToolDef = {
  name: 'Extra',
  description: 'Another tool.',
  guidance: 'Extra.',
  promptOrder: 2,
  schema: {},
  async run() { return { text: 'ok' } },
}

function baseDeps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    cwd: process.cwd(),
    model: () => 'parent-model',
    system: () => 'PARENT-SYS',
    frameCtx: defaultFrameContext('sess-1'),
    tools: () => [noopTool],
    streamFor: async function* () { /* replaced by tests */ },
    requestPermission: async (_t, input, _id, _signal) => ({ allowed: true, input }),
    emit: () => {},
    ...over,
  }
}

async function runAgent(
  agent: ToolDef,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
) {
  return agent.run(input as never, { cwd: process.cwd(), signal, toolUseId: 'tu-parent' })
}

function fakeStore(defs: Record<string, Partial<StoredAgentDefinition>>): AgentDefinitionStore {
  return {
    get: (name: string) => defs[name] as StoredAgentDefinition | undefined,
  } as unknown as AgentDefinitionStore
}

describe('createAgentTool', () => {
  it('exposes the Agent tool interface', () => {
    const agent = createAgentTool(baseDeps())
    expect(agent.name).toBe('Agent')
    expect(agent.promptOrder).toBe(80)
    expect(agent.schema).toEqual({
      type: 'object',
      properties: {
        description: { type: 'string', description: expect.any(String) },
        prompt: { type: 'string', description: expect.any(String) },
        subagent_type: { type: 'string', description: expect.any(String) },
        model: { type: 'string', description: expect.any(String) },
      },
      required: ['description', 'prompt'],
    })
  })

  it('forwards nested frames with the parent tool_use id and no result frame', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'nested answer'), deltaStop('end_turn')]])
    const emitted: Frame[] = []
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s), emit: (f) => emitted.push(f as Frame) }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'do the thing' })

    expect(outcome).toEqual({ text: 'nested answer' })
    expect(emitted.length).toBeGreaterThan(0)
    for (const frame of emitted) expect(frame.parent_tool_use_id).toBe('tu-parent')
    expect(emitted.some((f) => f.type === 'result')).toBe(false)
  })

  it('builds the nested request from the parent system, tools and model', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')]])
    let agent: ToolDef = noopTool
    agent = createAgentTool(baseDeps({ tools: () => [noopTool, agent], streamFor: s.streamFor.bind(s) }))

    await runAgent(agent, { description: 'd', prompt: 'p' })

    const req = s.calls[0]
    expect(req.system.startsWith('PARENT-SYS\n\n')).toBe(true)
    expect(req.system.length).toBeGreaterThan('PARENT-SYS\n\n'.length)
    expect((req.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['Noop'])
    expect(req.model).toBe('parent-model')
    expect(s.opts[0]).toEqual({ suppressRetryFrames: true })
  })

  it('lets input.model win over the parent model', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')]])
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s) }))

    await runAgent(agent, { description: 'd', prompt: 'p', model: 'override-model' })

    expect(s.calls[0].model).toBe('override-model')
  })

  it('treats a non-string or blank input.model as absent', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'one'), deltaStop('end_turn')],
      [startStop, ...textBlock(0, 'two'), deltaStop('end_turn')],
    ])
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s) }))

    await runAgent(agent, { description: 'd', prompt: 'p', model: 42 })
    await runAgent(agent, { description: 'd', prompt: 'p', model: '   ' })

    expect(s.calls[0].model).toBe('parent-model')
    expect(s.calls[1].model).toBe('parent-model')
  })

  it('reads the model getter at call time', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'one'), deltaStop('end_turn')],
      [startStop, ...textBlock(0, 'two'), deltaStop('end_turn')],
    ])
    let current = 'm1'
    const agent = createAgentTool(baseDeps({ model: () => current, streamFor: s.streamFor.bind(s) }))

    await runAgent(agent, { description: 'd', prompt: 'p' })
    current = 'm2'
    await runAgent(agent, { description: 'd', prompt: 'p' })

    expect(s.calls[0].model).toBe('m1')
    expect(s.calls[1].model).toBe('m2')
  })

  it('runs a nested tool call and stamps its tool_result with the parent id', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 'inner-1', 'Read', '{"file_path":"does-not-exist.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    const permitted: Array<{ name: string; toolUseId: string }> = []
    const agent = createAgentTool(baseDeps({
      tools: () => [readTool],
      streamFor: s.streamFor.bind(s),
      emit: (f) => emitted.push(f as Frame),
      requestPermission: async (name, input, toolUseId) => {
        permitted.push({ name, toolUseId })
        return { allowed: true, input }
      },
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' })

    expect(permitted).toEqual([{ name: 'Read', toolUseId: 'inner-1' }])
    expect(outcome).toEqual({ text: 'done' })
    const toolResult = emitted.find((f) => f.type === 'user') as Frame
    expect(toolResult.parent_tool_use_id).toBe('tu-parent')
    expect(toolResult.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'inner-1' })
  })

  it('reads the tools getter at call time', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'one'), deltaStop('end_turn')],
      [startStop, ...textBlock(0, 'two'), deltaStop('end_turn')],
    ])
    let current: ToolDef[] = [noopTool]
    const agent = createAgentTool(baseDeps({ tools: () => current, streamFor: s.streamFor.bind(s) }))

    await runAgent(agent, { description: 'd', prompt: 'p' })
    current = [noopTool, extraTool]
    await runAgent(agent, { description: 'd', prompt: 'p' })

    expect((s.calls[0].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['Noop'])
    expect((s.calls[1].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['Noop', 'Extra'])
  })

  it('uses an enabled agent definition for the nested system and default model', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'reviewed'), deltaStop('end_turn')]])
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      agentStore: fakeStore({
        reviewer: { name: 'reviewer', description: 'Reviews code', prompt: 'REVIEW-PROMPT', model: 'm2', enabled: true },
      }),
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'reviewer' })

    expect(outcome).toEqual({ text: 'reviewed' })
    expect(s.calls[0].system.endsWith('REVIEW-PROMPT')).toBe(true)
    expect(s.calls[0].model).toBe('m2')
  })

  it('lets input.model override the agent definition model', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')]])
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      agentStore: fakeStore({
        reviewer: { name: 'reviewer', description: 'Reviews code', prompt: 'REVIEW-PROMPT', model: 'm2', enabled: true },
      }),
    }))

    await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'reviewer', model: 'm3' })

    expect(s.calls[0].model).toBe('m3')
  })

  it('rejects an unknown or disabled subagent_type without running', async () => {
    const s = scriptedStreamer([])
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      agentStore: fakeStore({
        off: { name: 'off', description: 'Disabled', prompt: 'OFF-PROMPT', enabled: false },
      }),
    }))

    expect(await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'ghost' }))
      .toEqual({ text: 'unknown subagent_type: ghost', isError: true })
    expect(await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'off' }))
      .toEqual({ text: 'unknown subagent_type: off', isError: true })
    expect(s.calls).toHaveLength(0)
  })

  it('requires a non-empty prompt', async () => {
    const s = scriptedStreamer([])
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s) }))

    expect(await runAgent(agent, { description: 'd' }))
      .toEqual({ text: 'prompt is required', isError: true })
    expect(await runAgent(agent, { description: 'd', prompt: '   ' }))
      .toEqual({ text: 'prompt is required', isError: true })
    expect(await runAgent(agent, { description: 'd', prompt: 42 }))
      .toEqual({ text: 'prompt is required', isError: true })
    expect(s.calls).toHaveLength(0)
  })

  it('rejects a non-string subagent_type', async () => {
    const s = scriptedStreamer([])
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s) }))

    expect(await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 7 }))
      .toEqual({ text: 'unknown subagent_type: 7', isError: true })
    expect(s.calls).toHaveLength(0)
  })

  it('returns (no output) when the nested run produced only tool calls', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Noop', '{}'), deltaStop('tool_use')],
      [startStop, ...toolUseBlock(0, 't2', 'Noop', '{}'), deltaStop('tool_use')],
      [],
    ])
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s) }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' })

    expect(outcome).toEqual({ text: '(no output)' })
  })

  it('returns aborted for an already-aborted signal without starting', async () => {
    const s = scriptedStreamer([])
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s) }))
    const ac = new AbortController()
    ac.abort()

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' }, ac.signal)

    expect(outcome).toEqual({ text: 'aborted', isError: true })
    expect(s.calls).toHaveLength(0)
  })

  it('returns aborted when the signal aborts while the nested run ignores it', async () => {
    const ac = new AbortController()
    const agent = createAgentTool(baseDeps({
      async *streamFor() {
        yield startStop
        for (const ev of textBlock(0, 'finished')) yield ev
        yield deltaStop('end_turn')
        ac.abort()
      },
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' }, ac.signal)

    expect(outcome).toEqual({ text: 'aborted', isError: true })
  })

  it('does not fail the tool when the nested result frame is suppressed', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'inner'), deltaStop('end_turn')]])
    const emitted: AgentMessage[] = []
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s), emit: (f) => emitted.push(f) }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' })

    expect(outcome.isError).toBeUndefined()
    expect(outcome.text).toBe('inner')
    expect(emitted.some((f) => (f as Frame).type === 'result')).toBe(false)
  })

  it('throws when the tool_use id is missing', async () => {
    const agent = createAgentTool(baseDeps())

    await expect(agent.run(
      { description: 'd', prompt: 'p' },
      { cwd: process.cwd(), signal: new AbortController().signal },
    )).rejects.toThrow('Agent requires a tool_use id')
  })
})