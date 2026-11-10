// server/providers/native/native-session.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { NativeProvider } from './native-provider.js'
import type { NativeMcpConnections, NativeMcpServerInstance } from './mcp/connections.js'
import { NativeSessionStorageError } from './session-log/errors.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './session-log/log.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import { historyFromEvents } from './session-log/replay.js'
import type { NativeLogEvent } from './session-log/format.js'
import { AGENT_GUIDANCE } from './subagent.js'
import type { AgentDefinitionStore, StoredAgentDefinition } from '../../agent-definition-store.js'
import type { CanonicalEvent } from './canonical.js'
import type { Frame } from './frames.js'
import { config, __setConfigForTest } from '../../config.js'

// The retry suppression test drives the real `defaultStream` against a mocked
// wire layer: the mock invokes `onRetry` and yields a minimal canonical round.
// The original function is captured so it can be restored after the test —
// the module mock would otherwise stay implementation-less for the rest of
// this file.
const originalStreamAnthropicMessages = vi.hoisted(() => ({
  fn: undefined as unknown as typeof import('./anthropic-stream.js').streamAnthropicMessages,
}))
const streamAnthropicMessagesMock = vi.hoisted(() => vi.fn())
vi.mock('./anthropic-stream.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./anthropic-stream.js')>()
  originalStreamAnthropicMessages.fn = original.streamAnthropicMessages
  return { ...original, streamAnthropicMessages: streamAnthropicMessagesMock }
})

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

/** A tool-calling response that leaves the tool unanswered when the caller
 *  refuses/crashes before the result is produced. */
function toolTurn(toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Read' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: '{"file_path":"package.json"}' } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

const tempDirs: string[] = []

/** One assistant round whose only call is the Agent tool. */
function agentTurn(toolUseId: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Agent' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** A fresh temp state dir per test — the provider's default state dir is the
 *  real `~/.claude-react-web`, which a test must never touch. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Inject a scripted streamer through the provider's test seam. The seam is
 *  evaluated PER TURN, so reassigning it between turns swaps the script. */
function providerWithStreamer(scripts: CanonicalEvent[][], stateDir: string) {
  const provider = new NativeProvider({ stateDir })
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
    for (const ev of scripts.shift() ?? []) yield ev
  }
  return provider
}

/** A real in-process MCP server with one `echo` tool — the same fixture the
 *  connection manager's own tests use, so the session test exercises the real
 *  InMemoryTransport path rather than a mocked client. */
function echoServer(name = 'echo-server'): McpServer {
  const server = new McpServer({ name, version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo the given text back.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  return server
}

/** Wrap an in-process server so its connect settles asynchronously, like a
 *  real handshake. Without the delay the connect can finish during the turn's
 *  preceding log flush, which would let a missing per-turn `whenReady()` await
 *  slip through: the first request would still advertise the tool. */
function delayedInstance(instance: McpServer, ms = 100): NativeMcpServerInstance {
  return {
    connect: async (transport) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return instance.connect(transport)
    },
    close: () => instance.close(),
  }
}

function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: 'u1',
  }
}

/** The manager's primary send path (and `seedCompactSummary`) hand the
 *  provider `content: text` as a bare string, not a block array. */
function stringUserMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: text },
    parent_tool_use_id: null,
    session_id: '',
    uuid: 'u1',
  }
}

interface LogEventLike {
  type: string
  reason?: string
  text?: string
  isCompactSummary?: boolean
  parent_tool_use_id?: string | null
  message?: { content?: Array<Record<string, unknown>> }
}

interface LogLike {
  header: { id: string; isSeeded: boolean; inheritedEventCount: number }
  events: LogEventLike[]
}

function logOf(session: unknown): LogLike {
  return (session as { log: LogLike }).log
}

/** Text blocks carried by persisted user events, in order. */
function userTexts(session: unknown): string[] {
  return logOf(session).events
    .filter((event) => event.type === 'user')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
}

describe('NativeSession', () => {
  it('emits init, then a full turn of frames for a text-only response', async () => {
    const dir = await tempDir('native-session-')
    const provider = providerWithStreamer([textTurn('hello native')], dir)
    const session = provider.createSession({ id: 's1', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    // init + 5 stream events + assistant + result — NO user frame: the
    // context snapshot lives in history only, and user frames carry only
    // tool_result content (frame contract).
    expect(frames.map((f) => f.type)).toEqual([
      'system', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result',
    ])
    expect(frames[0].subtype).toBe('init')
    const result = frames.at(-1) as Frame
    expect(result.subtype).toBe('success')
    expect(result.result).toBe('hello native')
    await session.destroy()
  })

  it('interrupt during a turn emits exactly one result frame and the session still works', async () => {
    const dir = await tempDir('native-session-')
    const provider = new NativeProvider({ stateDir: dir })
    // Streamer that hangs until its signal aborts — the seam the real
    // defaultStream honors too (fetch rejects on abort). `streamStarted`
    // replaces a fixed sleep: the turn is in flight exactly when the pump
    // calls the streamer, which is stable under parallel test load.
    let streamStarted!: () => void
    const started = new Promise<void>((resolve) => { streamStarted = resolve })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      streamStarted()
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 's3', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('one') as never)
    // Wait for the turn to actually start (no result may have landed yet).
    await started
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(0)
    await session.interrupt?.()
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(1)
      expect(results[0].result).toBe('interrupted by user')
      expect(results[0].is_error).toBe(true)
    })
    // The session is NOT bricked: the next message completes normally. The
    // seam is re-evaluated per turn, so the swapped script takes effect.
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('recovered')) yield ev
    }
    session.enqueueUserMessage(userMsg('two') as never)
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(2)
      expect(results[1].result).toBe('recovered')
      expect(results[1].subtype).toBe('success')
    })
    await session.destroy()
  })

  it('getContextUsage reflects the last turn usage', async () => {
    const dir = await tempDir('native-session-')
    const provider = providerWithStreamer([textTurn('x')], dir)
    const session = provider.createSession({ id: 's2', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      expect(frames.some((f) => f.type === 'result')).toBe(true)
    })
    const usage = (await session.getContextUsage?.()) as { totalTokens: number; maxTokens: number; model: string }
    // { totalTokens, maxTokens, model } — prompt tokens are input + cache
    // (the scripted turn has input 10, no cache; output does not count).
    expect(usage.totalTokens).toBe(10)
    expect(usage.maxTokens).toBe(200_000)
    expect(typeof usage.model).toBe('string')
    await session.destroy()
  })

  it('interrupt during tool processing does not park the turn: next tool skipped, exactly one interrupted result', async () => {
    const dir = await tempDir('native-session-')
    const provider = new NativeProvider({ stateDir: dir })
    // One response carrying TWO tool_use blocks — the abort lands while the
    // first tool is being processed, so the second must never execute.
    const twoToolScript: CanonicalEvent[] = [
      { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
      { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 't1', name: 'Read' } },
      { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: '{"file_path":"package.json"}' } },
      { kind: 'block_end', index: 0 },
      { kind: 'block_start', index: 1, block: { type: 'tool_use', id: 't2', name: 'Read' } },
      { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: '{"file_path":"does-not-exist.txt"}' } },
      { kind: 'block_end', index: 1 },
      { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
    ]
    // The seam honors the signal like the real network streamer (fetch
    // rejects on abort): a post-abort stream call throws immediately.
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted')
      for (const ev of twoToolScript) yield ev
    }
    const canUseToolCalls: string[] = []
    let session: ReturnType<NativeProvider['createSession']> | null = null
    session = provider.createSession({
      id: 's4',
      cwd: process.cwd(),
      canUseTool: async (toolName: unknown) => {
        canUseToolCalls.push(toolName as string)
        // Abort the turn while the FIRST tool's permission resolves — the
        // second tool's permission must never be requested.
        void session?.interrupt?.()
        return { behavior: 'allow', updatedInput: { file_path: 'package.json' } }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session!.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(1)
      expect(results[0].result).toBe('interrupted by user')
      expect(results[0].is_error).toBe(true)
    })
    // Only the FIRST tool ever reached the permission handler.
    expect(canUseToolCalls).toEqual(['Read'])
    // Every tool_use is answered (t1 ran, t2 got the synthetic aborted
    // result) — the next turn's API request stays valid. tool_result frames
    // are one-per-result: collect them all in order.
    const toolResults = frames.filter((f) => f.type === 'user').map((f) => (f as Frame).message.content[0] as { tool_use_id: string })
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(['t1', 't2'])
    await session.destroy()
  })

  it('capabilities declare interrupt and MCP', async () => {
    const dir = await tempDir('native-session-')
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.name).toBe('native')
    expect(provider.capabilities.supportsInterrupt).toBe(true)
    expect(provider.capabilities.supportsMcp).toBe(true)
    expect(provider.capabilities.supportsFineGrainedPermissions).toBe(true)
  })

  it('offers discovered MCP tools to the model and routes their calls', async () => {
    const dir = await tempDir('native-mcp-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ tools: Array<{ name: string }>; messages: unknown[] }> = []
    const scripts: CanonicalEvent[][] = [
      [
        { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
        { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 'm1', name: 'mcp__a__echo' } },
        { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: '{"text":"hi from mcp"}' } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
      ],
      textTurn('done'),
    ]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
      tools: Array<{ name: string }>
      messages: unknown[]
    }) {
      // Snapshot the request: `req.messages` is the session's live history
      // array, mutated by later rounds, so a captured reference would show the
      // FINAL transcript instead of what this request actually sent.
      requests.push({ tools: req.tools, messages: structuredClone(req.messages) })
      for (const ev of scripts.shift() ?? []) yield ev
    }
    let permissionCtx: { toolUseID?: string; mcpServer?: unknown } | undefined
    const session = provider.createSession({
      id: 'mcp',
      cwd: dir,
      // Connect stays pending across the turn's log flush, so this test only
      // passes if the pump actually awaits `whenReady()` before the request.
      mcpServers: { a: { type: 'sdk', instance: delayedInstance(echoServer()) } },
      canUseTool: async (_toolName: unknown, input: unknown, ctx: unknown) => {
        permissionCtx = ctx as { toolUseID?: string; mcpServer?: unknown }
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()

    session.enqueueUserMessage(userMsg('use echo') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })

    // The first API request advertises the builtins plus the discovered tool.
    expect(requests[0].tools.map((t) => t.name)).toEqual([
      'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Agent', 'mcp__a__echo',
    ])
    // The permission request carries the server OWNED BY the tool's FQN,
    // resolved from discovery metadata (never parsed back out of the name).
    expect(permissionCtx).toEqual({
      signal: expect.anything(),
      toolUseID: 'm1',
      mcpServer: { name: 'a', source: 'sdk' },
    })
    // The second request carries the echo result as the tool_result.
    const lastMessage = requests[1].messages.at(-1) as {
      role: string
      content: Array<{ type: string; tool_use_id: string; content: Array<{ text: string }>; is_error: boolean }>
    }
    expect(lastMessage.role).toBe('user')
    expect(lastMessage.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'm1',
        content: [{ type: 'text', text: 'hi from mcp' }],
        is_error: false,
      },
    ])
    // Status reads through to the connection manager (source = sdk entry).
    const statuses = (await session.mcpServerStatus?.()) as Array<Record<string, unknown>>
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ name: 'a', status: 'connected', source: 'sdk', scope: 'session' })
    await session.destroy()
  })

  it('runs the Agent tool as a sidechain: one top-level result, real parents, nested list minus Agent', async () => {
    const dir = await tempDir('native-agent-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{
      tools: Array<{ name: string }>
      messages: unknown[]
      system: string
      model: string
    }> = []
    const scripts: CanonicalEvent[][] = [
      agentTurn('agent-1', { description: 'd', prompt: 'do it' }),
      toolTurn('nested-read'),
      textTurn('NESTED-REPORT'),
      textTurn('PARENT-DONE'),
    ]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
      tools: Array<{ name: string }>
      messages: unknown[]
      system: string
      model: string
    }) {
      // Snapshot the request: `messages` is the live history array.
      requests.push(structuredClone(req))
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: 'agent',
      cwd: dir,
      mcpServers: { a: { type: 'sdk', instance: delayedInstance(echoServer()) } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(userMsg('delegate') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))

    // ONE terminal frame for the whole turn — the nested run emits its own
    // result only if it were given emitResult, which the Agent tool never does.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0].result).toBe('PARENT-DONE')

    // The parent's Agent call got the nested final report back as its result.
    const parentAgentResult = frames.find((f) => f.type === 'user'
      && f.parent_tool_use_id == null
      && (f.message.content[0] as { tool_use_id?: string }).tool_use_id === 'agent-1')
    expect(parentAgentResult?.message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'agent-1',
      content: [{ type: 'text', text: 'NESTED-REPORT' }],
      is_error: false,
    })

    // Sidechain frames carry the spawning tool_use id, assistant AND user.
    const sidechain = frames.filter((f) => f.parent_tool_use_id === 'agent-1')
    expect(sidechain.some((f) => f.type === 'assistant')).toBe(true)
    const nestedToolResult = sidechain.find((f) => f.type === 'user')
    expect(nestedToolResult?.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'nested-read',
    })

    // The parent advertises Agent + the discovered MCP tool; every nested
    // request drops Agent (depth cap 1) but keeps the MCP tool.
    expect(requests[0].tools.map((t) => t.name)).toEqual([
      'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Agent', 'mcp__a__echo',
    ])
    const nestedRequests = requests.filter((r) => !r.tools.some((t) => t.name === 'Agent'))
    expect(nestedRequests).toHaveLength(2)
    for (const r of nestedRequests) {
      expect(r.tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'mcp__a__echo'])
    }

    // Persistence: sidechain events carry the real parent on disk...
    const events = logOf(session).events
    const sidechainAssistants = events.filter(
      (e) => e.type === 'assistant' && e.parent_tool_use_id === 'agent-1',
    )
    expect(sidechainAssistants.length).toBeGreaterThan(0)
    expect(JSON.stringify(sidechainAssistants)).toContain('NESTED-REPORT')
    expect(events.some((e) => e.type === 'user' && e.parent_tool_use_id === 'agent-1')).toBe(true)

    // ...while the model history excludes them (the report itself still reaches
    // the parent as the Agent call's tool_result).
    const mainHistory = historyFromEvents(events as unknown as NativeLogEvent[])
    const mainAssistantBodies = JSON.stringify(
      (mainHistory as Array<{ role: string; content: unknown[] }>).filter((m) => m.role === 'assistant'),
    )
    expect(mainAssistantBodies).not.toContain('NESTED-REPORT')
    expect(mainAssistantBodies).toContain('PARENT-DONE')
    expect(JSON.stringify(mainHistory)).toContain('NESTED-REPORT')

    await session.destroy()
  })

  it('honors an enabled custom agent definition for the nested run', async () => {
    const dir = await tempDir('native-agent-def-')
    const defs: Record<string, Partial<StoredAgentDefinition>> = {
      reviewer: { name: 'reviewer', description: 'Reviews code', prompt: 'REVIEW-PROMPT', model: 'reviewer-model', enabled: true },
    }
    const agentStore = {
      get: (name: string) => defs[name] as StoredAgentDefinition | undefined,
    } as unknown as AgentDefinitionStore
    const provider = new NativeProvider({ stateDir: dir, agentStore })
    const requests: Array<{
      tools: Array<{ name: string }>
      system: string
      model: string
    }> = []
    const scripts: CanonicalEvent[][] = [
      agentTurn('agent-2', { description: 'd', prompt: 'p', subagent_type: 'reviewer' }),
      textTurn('REVIEWED'),
      textTurn('DONE'),
    ]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
      tools: Array<{ name: string }>
      system: string
      model: string
    }) {
      requests.push(structuredClone(req))
      for (const ev of scripts.shift() ?? []) yield ev
    }
    // No MCP server: the `!this.mcp` branch of rebuildTools must still offer Agent.
    const session = provider.createSession({
      id: 'agent-def',
      cwd: dir,
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(userMsg('review') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'DONE')).toBe(true))

    expect(requests[0].tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Agent'])
    const nested = requests.find((r) => !r.tools.some((t) => t.name === 'Agent'))!
    // The definition's prompt is the nested instruction suffix, its model the
    // default nested model, and the static Agent section is in the parent prompt.
    expect(nested.system.endsWith('REVIEW-PROMPT')).toBe(true)
    expect(nested.system).toContain(AGENT_GUIDANCE)
    expect(nested.model).toBe('reviewer-model')
    await session.destroy()
  })

  it('declares Agent support and lists the built-in general-purpose agent', async () => {
    const dir = await tempDir('native-agents-cap-')
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.capabilities.supportsAgents).toBe(true)
    // Task control and subagent transcripts are P1.3b — unchanged here.
    expect(provider.capabilities.supportsTaskControl).toBe(false)
    expect(provider.capabilities.supportsSubagentTranscripts).toBe(false)
    const session = provider.createSession({ id: 'agents-cap', cwd: dir })
    expect(await session.supportedAgents?.()).toEqual([
      { name: 'general-purpose', description: 'General-purpose subagent for self-contained tasks.' },
    ])
    await session.destroy()
  })

  it('destroy closes every MCP connection exactly once', async () => {
    const dir = await tempDir('native-mcp-close-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({
      id: 'mcp-close',
      cwd: dir,
      mcpServers: { a: { type: 'sdk', instance: echoServer() } },
    })
    void (async () => {
      for await (const _ of session.messages) { /* drain */ }
    })()
    const conns = (session as unknown as { mcp: NativeMcpConnections }).mcp
    const closeAll = vi.spyOn(conns, 'closeAll')

    await session.destroy()
    // A second destroy is a no-op, so teardown never closes twice.
    await session.destroy()

    expect(closeAll).toHaveBeenCalledTimes(1)
  })

  it('persists a turn and resumes it with model history', async () => {
    const dir = await tempDir('native-persist-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('hello')) yield ev }
    const first = provider.createSession({ id: 's1', cwd: dir })
    void (async () => { for await (const _ of first.messages) { /* drain */ } })()
    first.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      const log = logOf(first)
      expect(log.events.some((e) => e.type === 'turn/end')).toBe(true)
    })
    await first.destroy()

    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('again')) yield ev }
    const resumed = provider.createSession({ id: 's1', cwd: dir, resume: 's1' })
    const frames: Frame[] = []
    void (async () => { for await (const f of resumed.messages) frames.push(f as Frame) })()
    await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' }))
    expect((resumed as unknown as { history: Array<{ role: string }> }).history[0].role).toBe('user')
    resumed.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'again')).toBe(true))
    await resumed.destroy()
  })

  it('normalizes string-content user turns so resume works', async () => {
    const dir = await tempDir('native-string-')
    const provider = providerWithStreamer([textTurn('first'), textTurn('second')], dir)
    const session = provider.createSession({ id: 'string', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(stringUserMsg('hello string') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'first')).toBe(true))
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))
    const persisted = logOf(session).events.find((e) => e.type === 'user')
    expect(persisted?.message?.content).toEqual([{ type: 'text', text: 'hello string' }])
    await session.destroy()

    // Before normalization this threw `corrupt` (the parser rejects a bare
    // string content); the reply turn proves the rebuilt history is valid.
    const resumed = provider.createSession({ id: 'string', cwd: dir, resume: 'string' })
    const resumedFrames: Frame[] = []
    void (async () => { for await (const f of resumed.messages) resumedFrames.push(f as Frame) })()
    resumed.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(resumedFrames.some((f) => f.type === 'result' && f.result === 'second')).toBe(true))
    await resumed.destroy()
  })

  it('restores usage from the last assistant message when no turn/end carries usage', async () => {
    const dir = await tempDir('native-usage-')
    const seed = NativeSessionLog.open({ stateDir: dir, id: 'usage', cwd: dir, resume: false })
    seed.append({ type: 'session/context', text: 'ctx' })
    seed.append({ type: 'user', uuid: 'u', session_id: 'usage', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    seed.append({ type: 'assistant', uuid: 'a', session_id: 'usage', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 7, output_tokens: 3 } } })
    // A seeded fork's usage-less close must not reset the fallback.
    seed.append({ type: 'turn/end', reason: 'forked' })
    await seed.flush(); await seed.close()

    const provider = new NativeProvider({ stateDir: dir })
    const resumed = provider.createSession({ id: 'usage', cwd: dir, resume: 'usage' })
    expect(await resumed.getUsage?.()).toEqual({
      session: {
        model_usage: {
          'claude-sonnet-4-5': { inputTokens: 7, outputTokens: 3 },
        },
      },
      rate_limits_available: false,
      cost_available: false,
    })
    await resumed.destroy()
  })

  it('reads context usage from the last TOP-LEVEL assistant while summing sidechain billing', async () => {
    const dir = await tempDir('native-side-usage-')
    const seed = NativeSessionLog.open({ stateDir: dir, id: 'side-usage', cwd: dir, resume: false })
    seed.append({ type: 'session/context', text: 'ctx' })
    seed.append({ type: 'user', uuid: 'u', session_id: 'side-usage', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    seed.append({ type: 'assistant', uuid: 'a-top', session_id: 'side-usage', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'top' }], usage: { input_tokens: 7, output_tokens: 3 } } })
    // The LAST assistant frame is sidechain (a nested runner). It must not
    // become the context bar's reading, but its tokens are still billed.
    seed.append({ type: 'assistant', uuid: 'a-side', session_id: 'side-usage', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'inner' }], usage: { input_tokens: 40, output_tokens: 9 } } })
    await seed.flush(); await seed.close()

    const provider = new NativeProvider({ stateDir: dir })
    const resumed = provider.createSession({ id: 'side-usage', cwd: dir, resume: 'side-usage' })
    const contextUsage = (await resumed.getContextUsage?.()) as { totalTokens: number }
    expect(contextUsage.totalTokens).toBe(7)
    expect(await resumed.getUsage?.()).toEqual({
      session: {
        model_usage: {
          'claude-sonnet-4-5': { inputTokens: 47, outputTokens: 12 },
        },
      },
      rate_limits_available: false,
      cost_available: false,
    })
    // Sidechain frames never reach the main model history.
    const history = JSON.stringify((resumed as unknown as { history: unknown[] }).history)
    expect(history).toContain('top')
    expect(history).not.toContain('inner')
    await resumed.destroy()
  })

  it('persists a live sidechain user frame with its real parent', async () => {
    const dir = await tempDir('native-side-persist-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'side-persist', cwd: dir })
    const internals = session as unknown as {
      persistFrame(frame: unknown): void
      log: { flush: () => Promise<void> }
    }
    internals.persistFrame({
      type: 'user',
      uuid: 'side-result',
      session_id: 'side-persist',
      parent_tool_use_id: 'tu-agent',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'inner-tool', content: [{ type: 'text', text: 'ok' }], is_error: false }],
      },
    })
    await internals.log.flush()
    const eventOf = (events: Array<{ type: string }>) =>
      events.find((e) => (e as { uuid?: string }).uuid === 'side-result') as { parent_tool_use_id?: string } | undefined
    expect(eventOf(logOf(session).events)).toMatchObject({ type: 'user', parent_tool_use_id: 'tu-agent' })
    await session.destroy()
    // Durable too, not just in memory.
    expect(eventOf(loadNativeSessionLogSync(dir, 'side-persist')!.events)?.parent_tool_use_id).toBe('tu-agent')
  })

  it('writes the fresh session context synchronously at open', async () => {
    const dir = await tempDir('native-context-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'ctx', cwd: dir })
    // No turn ran and no flush was awaited: the header + context are already
    // on disk, so a crash before the first turn still leaves usable context.
    const raw = readFileSync(nativeSessionLogPath(dir, 'ctx'), 'utf8')
    expect(raw).toContain('"type":"session/context"')
    expect(raw).toContain('Working directory')
    await session.destroy()
  })

  it('survives a persistence flush failure without double-emitting', async () => {
    const dir = await tempDir('native-flush-')
    const provider = providerWithStreamer([textTurn('hello')], dir)
    const session = provider.createSession({ id: 'flush', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    const internals = session as unknown as {
      pumpLoop: () => Promise<void>
      log: { flush: () => Promise<void>; events: LogEventLike[] }
    }
    // `enqueueUserMessage` discards the pump promise; capture it so the test
    // can assert the pump resolves instead of rejecting on a write failure.
    const originalPump = internals.pumpLoop.bind(session)
    let pumpPromise: Promise<void> | null = null
    internals.pumpLoop = () => {
      pumpPromise = originalPump()
      return pumpPromise
    }
    // Fail the turn's pre-run user write exactly once.
    const sessionLog = internals.log
    const originalFlush = sessionLog.flush.bind(sessionLog)
    let rejectNext = true
    sessionLog.flush = () => {
      if (rejectNext) {
        rejectNext = false
        return Promise.reject(new Error('disk full'))
      }
      return originalFlush()
    }

    session.enqueueUserMessage(userMsg('hi') as never)
    await expect(pumpPromise!).resolves.toBeUndefined()
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    expect((frames.find((f) => f.type === 'result') as Frame).result).toBe('disk full')
    expect(internals.log.events.filter((e) => e.type === 'turn/end')).toHaveLength(1)
    await session.destroy()
  })

  it('waits for the assistant event to be durable before a tool can run', async () => {
    const dir = await tempDir('native-durable-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts = [toolTurn('t1'), textTurn('done')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const canUseToolCalls: string[] = []
    const session = provider.createSession({
      id: 'durable',
      cwd: dir,
      canUseTool: async () => {
        canUseToolCalls.push('called')
        return { behavior: 'allow', updatedInput: { file_path: 'package.json' } }
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    const internals = session as unknown as {
      log: { flush: () => Promise<void>; events: LogEventLike[] }
      assistantFlush: Promise<void> | null
    }
    const sessionLog = internals.log
    const originalFlush = sessionLog.flush.bind(sessionLog)
    let releaseAssistant!: () => void
    const gate = new Promise<void>((resolve) => { releaseAssistant = resolve })
    let flushCalls = 0
    // Call 1 is the pump's pre-run user-turn write (awaited before the model
    // sees the prompt); every later call is the assistant event's flush, which
    // this test holds open.
    sessionLog.flush = () => (++flushCalls === 1 ? originalFlush() : gate)

    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => expect(flushCalls).toBeGreaterThanOrEqual(2))
    expect(internals.assistantFlush).not.toBeNull()
    // The assistant frame's flush is still pending: the tool must NOT start.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(canUseToolCalls).toEqual([])

    releaseAssistant()
    await vi.waitFor(() => expect(canUseToolCalls).toHaveLength(1))
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    await session.destroy()
  })

  it('repairs the live history when a failed assistant flush aborts a tool turn', async () => {
    const dir = await tempDir('native-history-repair-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts = [toolTurn('t1'), textTurn('recovered')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: 'history-repair',
      cwd: dir,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: { file_path: 'package.json' } }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const internals = session as unknown as {
      log: { flush: () => Promise<void> }
      history: unknown[]
    }
    const sessionLog = internals.log
    const originalFlush = sessionLog.flush.bind(sessionLog)
    let flushCalls = 0
    // Call 1 is the user-turn write; call 2 is the assistant barrier, which is
    // made to fail before any tool runs.
    sessionLog.flush = () => (++flushCalls === 2 ? Promise.reject(new Error('assistant flush failed')) : originalFlush())

    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    expect((frames.find((f) => f.type === 'result') as Frame).result).toBe('assistant flush failed')
    // The turn died with the assistant tool_use already persisted; the repair
    // must answer it in BOTH the live history and the log so a later restart
    // does not append the result after the next turn.
    expect(JSON.stringify(internals.history)).toContain('tool result missing')
    expect(JSON.stringify(logOf(session).events)).toContain('tool result missing')
    // The live stream must carry the same synthetic result the disk replay
    // will show, with the SAME uuid (no duplicate repair bubble on restart).
    const syntheticEvent = logOf(session).events.find((e) => JSON.stringify(e).includes('tool result missing')) as unknown as { uuid: string }
    const syntheticFrame = frames.find((f) => f.type === 'user' && JSON.stringify(f).includes('tool result missing'))!
    expect(syntheticFrame.uuid).toBe(syntheticEvent.uuid)
    await session.destroy()
  })

  it('does not persist a queued turn that is never consumed', async () => {
    const dir = await tempDir('native-queued-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      // Mirrors a real fetch: an already-aborted signal rejects immediately
      // (the interrupt can land while the consumed turn's write is in flight).
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted')
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 'queued', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('first') as never)
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(session.queueDepth).toBe(1))
    // The pump arms the per-turn abort controller before persisting the
    // consumed turn; wait until it is armed so interrupt() targets a live turn.
    await vi.waitFor(() => {
      expect((session as unknown as { turnAbort: unknown }).turnAbort).not.toBeNull()
    })
    await session.interrupt?.({ cancelQueued: true })
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))
    expect(userTexts(session)).toEqual(['first'])
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    await session.destroy()
  })

  it('a plain interrupt keeps the queued turn for the next turn', async () => {
    const dir = await tempDir('native-keep-queued-')
    const provider = new NativeProvider({ stateDir: dir })
    let streamStarted!: () => void
    const started = new Promise<void>((resolve) => { streamStarted = resolve })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      streamStarted()
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted')
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 'keep', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('first') as never)
    await started
    session.enqueueUserMessage(userMsg('second') as never)
    // The next turn gets a normal script; the plain interrupt must leave it
    // queued rather than splicing the input queue.
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('second-done')) yield ev
    }
    await session.interrupt?.()
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(2)
      expect(results[1].result).toBe('second-done')
    })
    expect(userTexts(session)).toEqual(['first', 'second'])
    await session.destroy()
  })

  it('reports identical per-model usage live and after resume (multi-round turn)', async () => {
    const dir = await tempDir('native-usage-parity-')
    const provider = providerWithStreamer([toolTurn('t1'), textTurn('done')], dir)
    const session = provider.createSession({
      id: 'usage-parity',
      cwd: dir,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: { file_path: 'package.json' } }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'done')).toBe(true))
    const live = await session.getUsage?.()
    // Concrete totals for the two scripted rounds (10+10 input, 5+5 output):
    // equality alone would let a last-round-only regression pass on both sides.
    expect(live).toEqual({
      session: {
        model_usage: {
          'claude-sonnet-4-5': { inputTokens: 20, outputTokens: 10 },
        },
      },
      rate_limits_available: false,
      cost_available: false,
    })
    await session.destroy()

    const resumed = provider.createSession({ id: 'usage-parity', cwd: dir, resume: 'usage-parity' })
    // The live total must sum BOTH assistant rounds; a restart rebuilds from
    // the same persisted frames and must produce the same shape.
    expect(await resumed.getUsage?.()).toEqual(live)
    await resumed.destroy()
  })

  it('repairs an interrupted tool turn on resume', async () => {
    const dir = await tempDir('native-repair-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of toolTurn('t1')) yield ev
    }
    const session = provider.createSession({
      id: 'repair',
      cwd: dir,
      canUseTool: async () => {
        // A broker crash AFTER the assistant frame was persisted and BEFORE
        // any tool_result — exactly the crash-shape repair exists for.
        throw new Error('permission broker crashed')
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('use a tool') as never)
    await vi.waitFor(() => {
      expect(logOf(session).events.some((e) => e.type === 'turn/end' && e.reason === 'error')).toBe(true)
    })
    await session.destroy()

    const resumed = provider.createSession({ id: 'repair', cwd: dir, resume: 'repair' })
    const synthetic = logOf(resumed).events.find((e) => JSON.stringify(e).includes('tool result missing'))
    expect(synthetic).toBeDefined()
    expect(JSON.stringify(synthetic)).toContain('t1')
    // The live turn-error repair already persisted the result, so resume reads
    // it back instead of appending a second copy at the log tail.
    expect(logOf(resumed).events.filter((e) => JSON.stringify(e).includes('tool result missing'))).toHaveLength(1)
    const history = (resumed as unknown as { history: unknown[] }).history
    expect(JSON.stringify(history)).toContain('tool result missing')
    await resumed.destroy()

    const snapshot = loadNativeSessionLogSync(dir, 'repair')!
    expect(snapshot.events.some((e) => JSON.stringify(e).includes('tool result missing'))).toBe(true)
  })

  it('appends synthetic results and an interrupted turn/end when resuming an open turn', async () => {
    const dir = await tempDir('native-open-turn-')
    // Simulate a hard crash: the log ends with an unanswered tool_use and no
    // turn/end, exactly what a process death mid-tool leaves behind.
    const seed = NativeSessionLog.open({ stateDir: dir, id: 'open', cwd: dir, resume: false })
    seed.append({ type: 'session/context', text: 'ctx' })
    seed.append({ type: 'user', uuid: 'u', session_id: 'open', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
    seed.append({ type: 'assistant', uuid: 'a', session_id: 'open', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } })
    await seed.flush(); await seed.close()

    const provider = new NativeProvider({ stateDir: dir })
    const resumed = provider.createSession({ id: 'open', cwd: dir, resume: 'open' })
    expect(logOf(resumed).events.some((e) => JSON.stringify(e).includes('tool result missing'))).toBe(true)
    expect(logOf(resumed).events.some((e) => e.type === 'turn/end' && e.reason === 'interrupted')).toBe(true)
    await resumed.destroy()

    const snapshot = loadNativeSessionLogSync(dir, 'open')!
    expect(snapshot.events.some((e) => JSON.stringify(e).includes('tool result missing'))).toBe(true)
    expect(snapshot.events.some((e) => e.type === 'turn/end' && e.reason === 'interrupted')).toBe(true)
  })

  it('forks from the source log and writes a seeded child log', async () => {
    const dir = await tempDir('native-fork-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('source reply')) yield ev
    }
    const source = provider.createSession({ id: 'source', cwd: dir })
    const sourceFrames: Frame[] = []
    void (async () => { for await (const f of source.messages) sourceFrames.push(f as Frame) })()
    source.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => expect(sourceFrames.some((f) => f.type === 'result')).toBe(true))
    await vi.waitFor(() => expect(logOf(source).events.some((e) => e.type === 'turn/end')).toBe(true))
    await source.destroy()
    const sourceEvents = loadNativeSessionLogSync(dir, 'source')!.events

    const forked = provider.createSession({ id: 'child', cwd: dir, resume: 'source', forkSession: true })
    const log = logOf(forked)
    expect(log.header.isSeeded).toBe(true)
    expect(log.header.inheritedEventCount).toBe(sourceEvents.length)
    expect(log.events.some((e) => e.type === 'session/end-seed')).toBe(true)
    expect(log.events.some((e) => e.type === 'turn/end' && e.reason === 'forked')).toBe(true)
    expect(log.events.some((e) => e.type === 'session/context' && (e.text ?? '').includes(dir))).toBe(true)
    const history = (forked as unknown as { history: unknown[] }).history
    expect(history[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(history)).toContain('source reply')
    // Copied events are re-owned by the child (never the source id).
    expect(
      log.events
        .filter((e) => JSON.stringify(e).includes('"session_id"'))
        .every((e) => JSON.stringify(e).includes('"session_id":"child"')),
    ).toBe(true)
    // Usage is restored from the copied prefix, matching a restart of the child.
    expect(await forked.getUsage?.()).toEqual({
      session: {
        model_usage: {
          'claude-sonnet-4-5': { inputTokens: 10, outputTokens: 5 },
        },
      },
      rate_limits_available: false,
      cost_available: false,
    })
    await forked.destroy()

    const child = loadNativeSessionLogSync(dir, 'child')!
    expect(child.header.id).toBe('child')
    expect(child.header.isSeeded).toBe(true)
  })

  it('persists the compact control seed, normalizing string content', async () => {
    const dir = await tempDir('native-compact-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'compact', cwd: dir })
    // seedCompactSummary sends a string-content message.
    session.sendControlMessage(stringUserMsg('compact summary') as never)
    const compact = logOf(session).events.find((e) => JSON.stringify(e).includes('compact summary'))
    expect(compact).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(compact?.message?.content).toEqual([{ type: 'text', text: 'compact summary' }])
    const history = (session as unknown as { history: unknown[] }).history
    expect(JSON.stringify(history)).toContain('compact summary')
    await session.destroy()

    const snapshot = loadNativeSessionLogSync(dir, 'compact')!
    const persisted = snapshot.events.find((e) => JSON.stringify(e).includes('compact summary'))
    expect(persisted).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(persisted?.type === 'user' ? persisted.message.content : undefined).toEqual([
      { type: 'text', text: 'compact summary' },
    ])
  })

  it('exposes history, existence and deletion over the state dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-prov-'))
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('hello')) yield ev }
    const session = provider.createSession({ id: 'p1', cwd: dir })
    ;(async () => { for await (const _ of session.messages) { /* drain */ } })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      const log = (session as unknown as { log: { events: Array<{ type: string }> } }).log
      expect(log.events.some((e) => e.type === 'turn/end')).toBe(true)
    })
    await session.destroy() // flush + close before reading the file
    const meta = { id: 'p1', cwd: dir } as never
    expect(await provider.hasTranscript(meta)).toBe(true)
    const entries = await provider.readHistoryEntries!('p1', {})
    expect(entries.length).toBeGreaterThan(0)
    expect((await provider.readHistoryPage!('p1', { limit: 10 })).totalCount).toBe(entries.length)
    expect(await provider.deleteTranscript!('p1')).toBe(true)
    expect(await provider.hasTranscript(meta)).toBe(false)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('reports a corrupt log as existing, then fails loudly on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-corrupt-'))
    const provider = new NativeProvider({ stateDir: dir })
    const log = NativeSessionLog.open({ stateDir: dir, id: 'p2', cwd: dir, resume: false })
    log.append({ type: 'session/context', text: 'ctx' })
    await log.flush(); await log.close()
    const path = nativeSessionLogPath(dir, 'p2')
    const raw = await readFile(path, 'utf8')
    await writeFile(path, raw.replace('"v":1', '"v":2'))
    expect(await provider.hasTranscript({ id: 'p2', cwd: dir } as never)).toBe(true)
    await expect(provider.readHistoryEntries!('p2', {})).rejects.toThrow(/unsupported|version/i)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('compacts in place: resets model history and appends a compact event', async () => {
    const dir = await tempDir('native-inplace-')
    const provider = providerWithStreamer([textTurn('first reply'), textTurn('after')], dir)
    const session = provider.createSession({ id: 'inplace', cwd: dir })
    // `compactInPlace` is provider-specific (not on ProviderSessionHandle yet),
    // so reach it through the same narrow cast the internals reads use.
    const compactable = session as unknown as {
      compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('OLD-PROMPT') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'first reply')).toBe(true))
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))

    await compactable.compactInPlace('SUMMARY', { uuid: 'c1', timestamp: '2026-11-09T00:00:00.000Z' })

    const compactEvent = logOf(session).events.find((e) => e.type === 'session/compact') as unknown as {
      text: string
      context: string
      uuid: string
      timestamp: string
    }
    expect(compactEvent).toMatchObject({
      text: 'SUMMARY',
      uuid: 'c1',
      timestamp: '2026-11-09T00:00:00.000Z',
    })
    expect(compactEvent.context).toContain('Working directory')
    // The model history now starts from the captured context + summary; the
    // pre-compact conversation is gone from what the next request sends.
    const history = (session as unknown as { history: unknown[] }).history
    expect(history).toEqual([
      { role: 'user', content: [{ type: 'text', text: compactEvent.context }] },
      { role: 'user', content: [{ type: 'text', text: 'SUMMARY' }] },
    ])
    expect(JSON.stringify(history)).not.toContain('OLD-PROMPT')
    // The context bar resets; the per-model billing totals do not.
    const usage = (await session.getContextUsage?.()) as { totalTokens: number }
    expect(usage.totalTokens).toBe(0)

    // A subsequent turn runs from the compacted history; the log stays
    // append-only (old events plus the compact boundary plus the new turn).
    session.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'after')).toBe(true))
    await vi.waitFor(() => expect(logOf(session).events.filter((e) => e.type === 'turn/end')).toHaveLength(2))
    expect(userTexts(session)).toEqual(['OLD-PROMPT', 'next'])
    expect(logOf(session).events.some((e) => e.type === 'session/compact')).toBe(true)
    const afterHistory = JSON.stringify((session as unknown as { history: unknown[] }).history)
    expect(afterHistory).toContain('SUMMARY')
    expect(afterHistory).toContain('next')
    expect(afterHistory).toContain('after')
    expect(afterHistory).not.toContain('OLD-PROMPT')
    await session.destroy()
  })

  it('refuses to compact while a turn is in flight or input is queued', async () => {
    const dir = await tempDir('native-inplace-refuse-')
    const provider = new NativeProvider({ stateDir: dir })
    let streamStarted!: () => void
    const started = new Promise<void>((resolve) => { streamStarted = resolve })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      streamStarted()
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 'refuse', cwd: dir })
    const compactable = session as unknown as {
      compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const opts = { uuid: 'c1', timestamp: '2026-11-09T00:00:00.000Z' }
    session.enqueueUserMessage(userMsg('first') as never)
    session.enqueueUserMessage(userMsg('second') as never)
    await started
    // In flight AND one queued message.
    expect(session.queueDepth).toBe(1)
    await expect(compactable.compactInPlace('SUMMARY', opts)).rejects.toThrow()
    // Drain the queue: the in-flight turn alone must still refuse.
    session.clearQueuedInput()
    expect(session.queueDepth).toBe(0)
    await expect(compactable.compactInPlace('SUMMARY', opts)).rejects.toThrow()
    // Nothing was appended by the refused calls.
    expect(logOf(session).events.some((e) => e.type === 'session/compact')).toBe(false)

    await session.interrupt?.()
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result')).toBe(true))
    await session.destroy()
    // A closed session refuses too.
    await expect(compactable.compactInPlace('SUMMARY', opts)).rejects.toThrow()
  })

  it('refuses to compact with an empty or whitespace summary', async () => {
    const dir = await tempDir('native-inplace-empty-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'empty', cwd: dir })
    const compactable = session as unknown as {
      compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
    }
    const opts = { uuid: 'c1', timestamp: '2026-11-09T00:00:00.000Z' }
    // An empty `text` would be persisted and then rejected by the parser on
    // the next resume, so the refusal must happen BEFORE the append.
    await expect(compactable.compactInPlace('', opts)).rejects.toThrow(/empty/i)
    await expect(compactable.compactInPlace('  \n\t', opts)).rejects.toThrow(/empty/i)
    expect(logOf(session).events.some((e) => e.type === 'session/compact')).toBe(false)
    await session.destroy()
  })

  it('resume after a compact reports zero context usage but keeps cumulative billing', async () => {
    const dir = await tempDir('native-inplace-resume-')
    const provider = providerWithStreamer([textTurn('first')], dir)
    const session = provider.createSession({ id: 'compact-resume', cwd: dir })
    const compactable = session as unknown as {
      compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('OLD-PROMPT') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'first')).toBe(true))
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))
    await compactable.compactInPlace('SUMMARY', { uuid: 'c1', timestamp: '2026-11-09T00:00:00.000Z' })
    await session.destroy()

    const resumed = provider.createSession({ id: 'compact-resume', cwd: dir, resume: 'compact-resume' })
    // The compact floor drops the pre-compact prompt tokens from the LAST
    // reading (the live path reset them in compactInPlace)...
    const usage = (await resumed.getContextUsage?.()) as { totalTokens: number }
    expect(usage.totalTokens).toBe(0)
    // ...while the billing totals still sum the pre-compact assistant round.
    expect(await resumed.getUsage?.()).toEqual({
      session: {
        model_usage: {
          'claude-sonnet-4-5': { inputTokens: 10, outputTokens: 5 },
        },
      },
      rate_limits_available: false,
      cost_available: false,
    })
    const history = JSON.stringify((resumed as unknown as { history: unknown[] }).history)
    expect(history).toContain('SUMMARY')
    expect(history).not.toContain('OLD-PROMPT')
    await resumed.destroy()
  })

  it('orders the compact boundary before a turn enqueued during its flush', async () => {
    const dir = await tempDir('native-inplace-race-')
    const provider = providerWithStreamer([textTurn('after')], dir)
    const session = provider.createSession({ id: 'race', cwd: dir })
    const internals = session as unknown as {
      log: { flush: () => Promise<void>; events: LogEventLike[] }
      compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    // Defer every flush until the release: the real log's serialized write
    // chain then resolves the compact write BEFORE the pump's, so the spliced
    // history is in place when the new turn runs.
    const sessionLog = internals.log
    const originalFlush = sessionLog.flush.bind(sessionLog)
    let releaseFlush!: () => void
    const gate = new Promise<void>((resolve) => { releaseFlush = resolve })
    let flushCalls = 0
    sessionLog.flush = () => {
      flushCalls++
      return gate.then(() => originalFlush())
    }

    const compacting = internals.compactInPlace('SUMMARY', { uuid: 'c1', timestamp: '2026-11-09T00:00:00.000Z' })
    // The guard already passed; the message lands while the compact write is
    // still in flight.
    session.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(flushCalls).toBeGreaterThanOrEqual(2))
    releaseFlush()
    await compacting
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'after')).toBe(true))

    const events = logOf(session).events
    const compactIndex = events.findIndex((e) => e.type === 'session/compact')
    const promptIndex = events.findIndex((e) => e.type === 'user' && JSON.stringify(e).includes('next'))
    expect(compactIndex).toBeGreaterThanOrEqual(0)
    expect(promptIndex).toBeGreaterThan(compactIndex)
    const history = JSON.stringify((session as unknown as { history: unknown[] }).history)
    expect(history).toContain('next')
    expect(history).toContain('after')
    expect(history.indexOf('SUMMARY')).toBeLessThan(history.indexOf('next'))
    await session.destroy()
  })

  it('defaultStream suppresses api_retry frames for nested streams', async () => {
    const dir = await tempDir('native-retry-')
    const origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
    streamAnthropicMessagesMock.mockImplementation(async function* (
      _req: unknown,
      onRetry: (info: { attempt: number; maxRetries: number; delayMs: number }) => Promise<void>,
    ) {
      await onRetry({ attempt: 1, maxRetries: 10, delayMs: 250 })
      yield { kind: 'message_start' } satisfies CanonicalEvent
    })
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'retry', cwd: dir })
    try {
      const internals = session as unknown as {
        output: { drainQueue(): Frame[] }
        defaultStream(
          req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
          opts?: { suppressRetryFrames?: boolean },
        ): AsyncIterable<CanonicalEvent>
      }
      const req = { model: 'm', system: 's', tools: [], messages: [], signal: new AbortController().signal }

      for await (const _event of internals.defaultStream(req, { suppressRetryFrames: true })) { /* drain */ }
      expect(internals.output.drainQueue().filter((f) => f.subtype === 'api_retry')).toHaveLength(0)

      for await (const _event of internals.defaultStream(req)) { /* drain */ }
      const retries = internals.output.drainQueue().filter((f) => f.subtype === 'api_retry')
      expect(retries).toHaveLength(1)
      expect(retries[0]).toMatchObject({ type: 'system', subtype: 'api_retry', attempt: 1 })
    } finally {
      await session.destroy()
      streamAnthropicMessagesMock.mockReset()
      streamAnthropicMessagesMock.mockImplementation(originalStreamAnthropicMessages.fn)
      __setConfigForTest(origConfig)
    }
  })

  it('refuses to resume a corrupt log', async () => {
    const dir = await tempDir('native-corrupt-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'corrupt', cwd: dir })
    await session.destroy()
    const path = nativeSessionLogPath(dir, 'corrupt')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"v":1', '"v":2'))
    let caught: unknown
    try {
      provider.createSession({ id: 'corrupt', cwd: dir, resume: 'corrupt' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NativeSessionStorageError)
    expect((caught as NativeSessionStorageError).kind).toBe('unsupported-version')
  })

  it('closes queued MCP connections when the session constructor throws', async () => {
    const dir = await tempDir('native-create-fail-')
    const provider = new NativeProvider({ stateDir: dir })
    const seed = provider.createSession({ id: 'leak', cwd: dir })
    await seed.destroy()
    const path = nativeSessionLogPath(dir, 'leak')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"v":1', '"v":2'))

    // The connect is queued by `load` before the resume throw; without the
    // provider's teardown it would run forever with no owner.
    const instance = echoServer()
    const closeSpy = vi.spyOn(instance, 'close')
    let caught: unknown
    try {
      provider.createSession({
        id: 'leak',
        cwd: dir,
        resume: 'leak',
        mcpServers: { a: { type: 'sdk', instance } },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NativeSessionStorageError)
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled())
  })
})