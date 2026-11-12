// server/providers/native/subagent.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createAgentTool, type AgentToolDeps } from './subagent.js'
import { defaultFrameContext, type Frame } from './frames.js'
import type { CanonicalEvent } from './canonical.js'
import type { AgentMessage } from '../../agent-message.js'
import type { AgentDefinitionStore, StoredAgentDefinition } from '../../agent-definition-store.js'
import { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'
import { readTool } from './tools/read.js'
import { bashTool } from './tools/bash.js'
import { createSkillTool } from './tools/skill.js'
import type { NativeSkillCatalog, NativeSkillView } from './skills.js'
import type { EffortLevel } from './anthropic-stream.js'

type StreamReq = { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }
type StreamOpts = { suppressRetryFrames?: boolean; effortLevel?: () => EffortLevel | undefined }

/** One entry per nested API round-trip; captures the request and the opts so
 *  the tests can assert what the nested loop asked for. */
function scriptedStreamer(scripts: CanonicalEvent[][]) {
  let call = 0
  const streamer = {
    calls: [] as StreamReq[],
    opts: [] as Array<StreamOpts | undefined>,
    async *streamFor(req: StreamReq, opts?: StreamOpts) {
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

function namedTool(name: string): ToolDef {
  return { ...noopTool, name, description: `${name} tool.` }
}

function skillView(policy?: readonly string[] | 'all'): NativeSkillView {
  return {
    section: () => '',
    bodyOf: (name) => ({ text: `${Array.isArray(policy) ? policy.join(',') : policy}: ${name}` }),
    commands: () => [],
  }
}

function baseDeps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    cwd: process.cwd(),
    model: () => 'parent-model',
    effortLevel: () => 'high',
    permissionMode: () => 'default',
    system: () => 'PARENT-SYS',
    frameCtx: defaultFrameContext('sess-1'),
    tools: () => [noopTool],
    mcpToolServers: () => new Map(),
    skillView,
    skillToolFor: (view) => createSkillTool(view as unknown as NativeSkillCatalog),
    tasks: new NativeTaskManager(() => {}),
    streamFor: async function* () { /* replaced by tests */ },
    requestPermission: async (_t, input, _id, _signal) => ({ allowed: true, input }),
    emit: () => {},
    appendDescriptor: async (input) => ({ ...input, seq: 0, timestamp: 't' }),
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

  it('declares subagent background metadata from the description and validated type', () => {
    const agent = createAgentTool(baseDeps())

    expect(agent.backgroundable?.taskType).toBe('subagent')
    expect(agent.backgroundable?.describe({ description: 'inspect the parser', prompt: 'p' }))
      .toBe('inspect the parser')
    expect(agent.backgroundable?.subagentType?.({ description: 'd', prompt: 'p', subagent_type: ' reviewer ' }))
      .toBe('reviewer')
    expect(agent.backgroundable?.subagentType?.({ description: 'd', prompt: 'p' }))
      .toBe('general-purpose')
    expect(agent.backgroundable?.subagentType?.({ description: 'd', prompt: 'p', subagent_type: '   ' }))
      .toBe('general-purpose')
    expect(agent.backgroundable?.subagentType?.({ description: 'd', prompt: 'p', subagent_type: 42 }))
      .toBe('general-purpose')
  })

  it('persists the descriptor before the first nested stream call', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'done'), deltaStop('end_turn')]])
    let releaseDescriptor!: () => void
    const gate = new Promise<void>((resolve) => { releaseDescriptor = resolve })
    const appendDescriptor = vi.fn(async (input: Parameters<AgentToolDeps['appendDescriptor']>[0]) => {
      await gate
      return { ...input, seq: 4, timestamp: 't' }
    })
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      appendDescriptor,
    }))

    const pending = runAgent(agent, { description: '  inspect logs  ', prompt: 'p' })
    await vi.waitFor(() => expect(appendDescriptor).toHaveBeenCalledOnce())
    expect(s.calls).toHaveLength(0)
    expect(appendDescriptor).toHaveBeenCalledWith({
      type: 'subagent/descriptor',
      toolUseId: 'tu-parent',
      parentToolUseId: null,
      kind: 'agent',
      toolName: 'Agent',
      label: 'inspect logs',
      depth: 1,
      profile: null,
    })

    releaseDescriptor()
    expect(await pending).toEqual({ text: 'done' })
    expect(s.calls).toHaveLength(1)
  })

  it('does not stream when the signal aborts while descriptor persistence is pending', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'must not stream'), deltaStop('end_turn')]])
    let releaseDescriptor!: () => void
    const gate = new Promise<void>((resolve) => { releaseDescriptor = resolve })
    const appendDescriptor = vi.fn(async (input: Parameters<AgentToolDeps['appendDescriptor']>[0]) => {
      await gate
      return { ...input, seq: 4, timestamp: 't' }
    })
    const emitted: Frame[] = []
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      appendDescriptor,
      emit: (frame) => emitted.push(frame as Frame),
    }))
    const ac = new AbortController()

    const pending = runAgent(agent, { description: 'd', prompt: 'p' }, ac.signal)
    await vi.waitFor(() => expect(appendDescriptor).toHaveBeenCalledOnce())
    ac.abort()
    releaseDescriptor()

    expect(await pending).toEqual({ text: 'aborted', isError: true })
    expect(s.calls).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  it('returns an outer error without streaming when descriptor persistence fails', async () => {
    const s = scriptedStreamer([])
    const emitted: Frame[] = []
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      emit: (frame) => emitted.push(frame as Frame),
      appendDescriptor: async () => { throw new Error('disk full') },
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' })

    expect(outcome).toEqual({ text: 'disk full', isError: true })
    expect(s.calls).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  it('records the Task tool name and a detached custom profile snapshot', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'done'), deltaStop('end_turn')]])
    const appendDescriptor = vi.fn(baseDeps().appendDescriptor)
    const definition = {
      name: 'reviewer', description: 'Reviews', prompt: 'REVIEW', enabled: true,
      tools: ['Read'], skills: [],
    }
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      appendDescriptor,
      agentStore: fakeStore({ reviewer: definition }),
    }), 'Task')

    expect(agent.name).toBe('Task')
    expect(await runAgent(agent, {
      description: '', prompt: 'p', subagent_type: 'reviewer',
    })).toEqual({ text: 'done' })
    const descriptor = appendDescriptor.mock.calls[0][0]
    expect(descriptor).toMatchObject({
      toolName: 'Task',
      label: 'reviewer',
      profile: { name: 'reviewer', instruction: 'REVIEW', tools: ['Read'], skills: [] },
    })
    expect(descriptor.profile?.tools).not.toBe(definition.tools)
    expect(descriptor.profile?.skills).not.toBe(definition.skills)
  })

  it('falls back to the generic descriptor label', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'done'), deltaStop('end_turn')]])
    const appendDescriptor = vi.fn(baseDeps().appendDescriptor)
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s), appendDescriptor }))

    await runAgent(agent, { description: 7, prompt: 'p' })

    expect(appendDescriptor.mock.calls[0][0].label).toBe('Subagent')
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
    expect(s.opts[0]).toMatchObject({ suppressRetryFrames: true })
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

  it('runs nested Bash to completion without detaching the outer Agent', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 'nested-bash', 'Bash', '{"command":"echo nested-bash-output"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'nested Bash complete'), deltaStop('end_turn')],
    ])
    const emitted: Frame[] = []
    const agent = createAgentTool(baseDeps({
      tools: () => [bashTool],
      streamFor: s.streamFor.bind(s),
      emit: (f) => emitted.push(f as Frame),
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' })

    expect(outcome).toEqual({ text: 'nested Bash complete' })
    expect(emitted.some((f) => f.type === 'system' && f.subtype === 'task_started')).toBe(false)
    expect(emitted.some((f) => f.type === 'system' && f.subtype === 'task_notification')).toBe(false)
    const nestedResult = emitted.find(
      (f) => f.type === 'user'
        && (f.message.content[0] as { tool_use_id?: string } | undefined)?.tool_use_id === 'nested-bash',
    )
    expect(nestedResult?.parent_tool_use_id).toBe('tu-parent')
    expect(JSON.stringify(nestedResult)).toContain('nested-bash-output')
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

  it('filters the complete nested tool snapshot in allow, deny, MCP ownership order', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')]])
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      tools: () => [
        namedTool('Agent'),
        namedTool('Read'),
        namedTool('Write'),
        namedTool('Edit'),
        namedTool('Skill'),
        namedTool('mcp__a__echo'),
        namedTool('mcp__b__echo'),
      ],
      mcpToolServers: () => new Map([
        ['mcp__a__echo', { name: 'a', source: 'sdk' }],
        ['mcp__b__echo', { name: 'b', source: 'dynamic' }],
      ]),
      agentStore: fakeStore({
        readonly: {
          name: 'readonly', description: 'Read only', prompt: 'READONLY', enabled: true,
          tools: ['Agent', 'Read', 'Write', 'Skill', 'mcp__a__echo', 'mcp__b__echo'],
          disallowedTools: ['Write'],
          mcpServers: ['a'],
          permissionMode: 'bypassPermissions',
        },
      }),
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'readonly' })

    expect(outcome.isError).toBeUndefined()
    expect((s.calls[0].tools as Array<{ name: string }>).map((tool) => tool.name))
      .toEqual(['Read', 'Skill', 'mcp__a__echo'])
  })

  it('uses profile effort for one nested run and inherits the current parent effort otherwise', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'one'), deltaStop('end_turn')],
      [startStop, ...textBlock(0, 'two'), deltaStop('end_turn')],
    ])
    let parentEffort: EffortLevel = 'high'
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      effortLevel: () => parentEffort,
      agentStore: fakeStore({
        scoped: { name: 'scoped', description: 'Scoped', prompt: 'SCOPED', enabled: true, effort: 'low' },
        inherit: { name: 'inherit', description: 'Inherit', prompt: 'INHERIT', enabled: true },
      }),
    }))

    await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'scoped' })
    parentEffort = 'max'
    await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'inherit' })

    expect(s.opts[0]).toMatchObject({ suppressRetryFrames: true })
    expect(s.opts[0]?.effortLevel?.()).toBe('low')
    expect(s.opts[1]).toMatchObject({ suppressRetryFrames: true })
    expect(s.opts[1]?.effortLevel?.()).toBe('max')
  })

  it('snapshots inherited parent permission for the whole nested run', async () => {
    const s = scriptedStreamer([
      [
        startStop,
        ...toolUseBlock(0, 'one', 'Noop', '{}'),
        ...toolUseBlock(1, 'two', 'Noop', '{}'),
        deltaStop('tool_use'),
      ],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    let parentMode = 'default'
    const modes: string[] = []
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      permissionMode: () => parentMode,
      requestPermission: async (_tool, input, _id, _signal, mode = parentMode) => {
        modes.push(mode)
        parentMode = 'bypassPermissions'
        return { allowed: true, input }
      },
      agentStore: fakeStore({
        inherit: { name: 'inherit', description: 'Inherit', prompt: 'INHERIT', enabled: true },
      }),
    }))

    await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'inherit' })

    expect(modes).toEqual(['default', 'default'])
  })

  it('reports a non-natural final round as an error without claiming a tool was blocked', async () => {
    const s = scriptedStreamer([[startStop, ...textBlock(0, 'PARTIAL'), deltaStop('max_tokens')]])
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      agentStore: fakeStore({
        capped: { name: 'capped', description: 'Capped', prompt: 'CAPPED', enabled: true, maxTurns: 1 },
      }),
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'capped' })

    expect(outcome).toEqual({ text: 'max turns reached (1)\n\nPARTIAL', isError: true })
    expect(outcome.text).not.toContain('tool not executed')
    expect(s.calls).toHaveLength(1)
  })

  it.each([0, -1, 1.5])('rejects invalid profile maxTurns %s before appending or streaming', async (maxTurns) => {
    const s = scriptedStreamer([])
    const appendDescriptor = vi.fn(baseDeps().appendDescriptor)
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      appendDescriptor,
      agentStore: fakeStore({
        invalid: {
          name: 'invalid', description: 'Invalid', prompt: 'INVALID', enabled: true, maxTurns,
        },
      }),
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'invalid' })

    expect(outcome).toEqual({ text: 'maxTurns must be a positive integer', isError: true })
    expect(appendDescriptor).not.toHaveBeenCalled()
    expect(s.calls).toHaveLength(0)
  })

  it('rejects unsupported definition fields before appending or starting a nested stream', async () => {
    const s = scriptedStreamer([])
    const appendDescriptor = vi.fn(baseDeps().appendDescriptor)
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      appendDescriptor,
      agentStore: fakeStore({
        invalid: {
          name: 'invalid', description: 'Invalid', prompt: 'INVALID', enabled: true,
          background: true, effort: 3,
        },
      }),
    }))

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'invalid' })

    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('background')
    expect(outcome.text).toContain('effort')
    expect(outcome.text).toContain('Supported fields:')
    expect(s.calls).toHaveLength(0)
    expect(appendDescriptor).not.toHaveBeenCalled()
  })

  it('rejects an unknown or disabled subagent_type without running', async () => {
    const s = scriptedStreamer([])
    const appendDescriptor = vi.fn(baseDeps().appendDescriptor)
    const agent = createAgentTool(baseDeps({
      streamFor: s.streamFor.bind(s),
      appendDescriptor,
      agentStore: fakeStore({
        off: { name: 'off', description: 'Disabled', prompt: 'OFF-PROMPT', enabled: false },
      }),
    }))

    expect(await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'ghost' }))
      .toEqual({ text: 'unknown subagent_type: ghost', isError: true })
    expect(await runAgent(agent, { description: 'd', prompt: 'p', subagent_type: 'off' }))
      .toEqual({ text: 'unknown subagent_type: off', isError: true })
    expect(s.calls).toHaveLength(0)
    expect(appendDescriptor).not.toHaveBeenCalled()
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

  it('returns aborted for an already-aborted signal without appending or starting', async () => {
    const s = scriptedStreamer([])
    const appendDescriptor = vi.fn(baseDeps().appendDescriptor)
    const agent = createAgentTool(baseDeps({ streamFor: s.streamFor.bind(s), appendDescriptor }))
    const ac = new AbortController()
    ac.abort()

    const outcome = await runAgent(agent, { description: 'd', prompt: 'p' }, ac.signal)

    expect(outcome).toEqual({ text: 'aborted', isError: true })
    expect(s.calls).toHaveLength(0)
    expect(appendDescriptor).not.toHaveBeenCalled()
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