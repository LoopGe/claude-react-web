// server/providers/native/native-session.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { readNativeHistoryEntries } from './session-log/reader.js'
import type { NativeLogEvent } from './session-log/format.js'
import { formatSupplementInstruction } from '../steering-format.js'
import { AGENT_GUIDANCE } from './subagent.js'
import { NativeSkillCatalog } from './skills.js'
import { SKILL_GUIDANCE } from './tools/skill.js'
import { TASK_OUTPUT_GUIDANCE } from './tools/task-output.js'
import { globTool } from './tools/glob.js'
import { lsTool } from './tools/ls.js'
import { setFakeWebHandler } from './tools/web-test-transport.js'
import { WEB_FETCH_GUIDANCE } from './tools/web-fetch.js'
import { WEB_SEARCH_GUIDANCE } from './tools/web-search.js'
import { TODO_WRITE_GUIDANCE } from './tools/todo-write.js'
import { NOTEBOOK_EDIT_GUIDANCE } from './tools/notebook-edit.js'
import { ASK_USER_QUESTION_GUIDANCE } from './tools/ask-user-question.js'
import type { AgentDefinitionStore, StoredAgentDefinition } from '../../agent-definition-store.js'
import type { CanonicalEvent } from './canonical.js'
import { buildRequestBody } from './anthropic-stream.js'
import type { Frame } from './frames.js'
import { config, __setConfigForTest } from '../../config.js'
import { HttpError } from '../../errors.js'
import { QUESTION_RESULT } from '../../permission-broker.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef, ToolOutcome } from './tools/types.js'

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

// WebFetch/WebSearch page requests use the built-in node:http(s) transport;
// stub it so the WebFetch model test never dials the public IP literal.
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  const { fakeRequest } = await import('./tools/web-test-transport.js')
  return { ...actual, request: fakeRequest }
})
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  const { fakeRequest } = await import('./tools/web-test-transport.js')
  return { ...actual, request: fakeRequest }
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

function textAndToolTurn(text: string, toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'block_start', index: 1, block: { type: 'tool_use', id: toolUseId, name: 'Read' } },
    { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: '{"file_path":"package.json"}' } },
    { kind: 'block_end', index: 1 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

function skillTurn(toolUseId: string, skill: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Skill' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify({ skill }) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** A WebFetch tool call over a public IP literal, so the tool's own SSRF
 *  check needs no DNS. */
function webFetchTurn(toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'WebFetch' } },
    {
      kind: 'block_delta',
      index: 0,
      delta: { type: 'tool_input', json: '{"url":"https://93.184.216.34/page","prompt":"Q"}' },
    },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** One assistant round whose only call is AskUserQuestion. */
function askUserQuestionTurn(toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'AskUserQuestion' } },
    {
      kind: 'block_delta',
      index: 0,
      delta: { type: 'tool_input', json: '{"questions":[{"question":"q1","options":[{"label":"a"}]}]}' },
    },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

const tempDirs: string[] = []

/** Every native session discovers user-scope skills from the CLI config dir.
 *  Redirect it at a temp empty dir so the developer's real `~/.claude/skills`
 *  can never leak into a prompt assertion (and an unreadable one can never
 *  fail a session's construction-time reload). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-skills-config-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
})

/** One assistant round whose only call delegates through Agent or Task. */
function agentTurn(
  toolUseId: string,
  input: Record<string, unknown>,
  toolName: 'Agent' | 'Task' = 'Agent',
): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: toolName } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** Write a project-scope skill into a temp project's `.claude/skills`. */
async function writeProjectSkill(
  cwd: string,
  name: string,
  opts: { description?: string; body?: string; frontmatter?: Record<string, string> } = {},
): Promise<void> {
  const dir = join(cwd, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  const extra = Object.entries(opts.frontmatter ?? {}).map(([key, value]) => `${key}: ${value}`)
  const content = [
    '---',
    `name: ${name}`,
    `description: ${opts.description ?? `${name} description`}`,
    ...extra,
    '---',
    '',
    opts.body ?? `# ${name}`,
    '',
  ].join('\n')
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
}

function canonicalSkillBody(cwd: string, name: string, body = `# ${name}`): string {
  return `Base directory for this skill: ${join(cwd, '.claude', 'skills', name)}\n\n${body}\n`
}

/** A fresh temp state dir per test — the provider's default state dir is the
 *  real `~/.claude-react-web`, which a test must never touch. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(skillsConfigDir, { recursive: true, force: true })
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

function mixedReadOnlyServer(name: string): McpServer {
  const server = new McpServer({ name, version: '1.0.0' })
  const result = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
  server.registerTool(
    'read',
    { description: 'Read data.', inputSchema: {}, annotations: { readOnlyHint: true } },
    result,
  )
  server.registerTool(
    'write',
    { description: 'Write data.', inputSchema: {}, annotations: { readOnlyHint: false } },
    result,
  )
  server.registerTool(
    'undeclared',
    { description: 'Undeclared behavior.', inputSchema: {} },
    result,
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

function agentDefinition(overrides: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    name: 'reviewer',
    description: 'Reviews code',
    prompt: 'REVIEW-PROMPT',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as StoredAgentDefinition
}

function agentStoreOf(defs: Record<string, StoredAgentDefinition>): AgentDefinitionStore {
  return { get: (name: string) => defs[name] } as unknown as AgentDefinitionStore
}

type CapturedRequest = {
  messages: unknown[]
  system: string
  model: string
  tools: Array<{ name: string }>
} & Record<string, unknown>

function effectiveSettingsOf(session: unknown) {
  return (session as {
    getEffectiveSettings?: () => {
      model: string
      permissionMode?: string
      effortLevel?: string
      agent: string | null
    }
  }).getEffectiveSettings?.()
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

function runNestedAgent(session: unknown, cwd: string, input: Record<string, unknown>) {
  const agent = (session as { agentTool: ToolDef }).agentTool
  return agent.run(input as never, {
    cwd,
    signal: new AbortController().signal,
    toolUseId: 'tu-parent',
  })
}

async function nestedPermissionTrace(
  dir: string,
  parentMode: string,
  definition: StoredAgentDefinition,
) {
  await writeFile(join(dir, 'package.json'), '{}', 'utf8')
  const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
  const requests: CapturedRequest[] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
    [toolTurn('nested-read'), textTurn('done')],
    requests,
  )
  const contexts: Array<Record<string, unknown>> = []
  const session = provider.createSession({
    id: `nested-${parentMode}-${definition.permissionMode}`,
    cwd: dir,
    permissionMode: parentMode,
    canUseTool: async (_toolName: unknown, input: unknown, context: unknown) => {
      contexts.push(context as Record<string, unknown>)
      return { behavior: 'allow', updatedInput: input }
    },
  })
  try {
    const outcome = await runNestedAgent(session, dir, {
      description: 'd', prompt: 'p', subagent_type: 'reviewer',
    })
    return { contexts, outcome, effective: effectiveSettingsOf(session) }
  } finally {
    await session.destroy()
  }
}

/** Text blocks carried by persisted user events, in order. */
function userTextsOf(log: LogLike): string[] {
  return log.events
    .filter((event) => event.type === 'user')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
}

function userTexts(session: unknown): string[] {
  return userTextsOf(logOf(session))
}

/** Scripted streamer that snapshots every request. `req.messages` is the
 *  session's live history array, so a captured reference would show the FINAL
 *  transcript instead of what this request actually sent. */
function capturingStreamer(
  scripts: CanonicalEvent[][],
  requests: Array<{ messages: unknown[] } & Record<string, unknown>>,
) {
  return async function* (req: { messages: unknown[] } & Record<string, unknown>) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
}

/** The prompt content a request sent: the last user-role message. */
function sentUserContent(request: { messages: unknown[] }): unknown {
  const messages = request.messages as Array<{ role: string; content: unknown }>
  return [...messages].reverse().find((message) => message.role === 'user')!.content
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
    expect(provider.capabilities.supportsSteering).toBe(true)
  })

  it('admits a mid-turn supplement, injects the wrapped guidance before the next request and reports delivery', async () => {
    const dir = await tempDir('native-steer-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] }> = []
    const scripts: CanonicalEvent[][] = [toolTurn('t1'), textTurn('done')]
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(scripts, requests)
    const delivered: Array<{ uuid: string; outcome: unknown }> = []
    let admitted: boolean | undefined
    let session: ReturnType<NativeProvider['createSession']> | null = null
    session = provider.createSession({
      id: 'steer',
      cwd: process.cwd(),
      onSupplementDelivered: (uuid, outcome) => delivered.push({ uuid, outcome }),
      // The permission round-trip is mid-turn: the pump has already consumed
      // the prompt, so steering admission is open here.
      canUseTool: async (_toolName: unknown, input: unknown) => {
        admitted = session!.enqueueSupplement!({ uuid: 'sup-1', text: 'pivot to python' })
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session!.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    expect(admitted).toBe(true)
    const wrapped = formatSupplementInstruction('pivot to python')
    // Round 1 saw only the prompt; round 2 carries the wrapped guidance last.
    expect(JSON.stringify(requests[0].messages)).not.toContain('[ADDITIONAL GUIDANCE]')
    const second = requests[1].messages as Array<{ role: string; content: unknown }>
    expect(second.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: wrapped }] })
    // Injected exactly once (already wrapped — never re-wrapped).
    expect(JSON.stringify(second).split('[ADDITIONAL GUIDANCE]')).toHaveLength(2)
    // Delivery fires once, at the pre-request boundary.
    expect(delivered).toEqual([{ uuid: 'sup-1', outcome: { ok: true, boundary: 'PreToolUse' } }])
    // Durable half: the log stores the WRAPPED text, and replay rebuilds it
    // at its position (after the tool_result, before the final assistant turn).
    const supplementEvents = logOf(session).events.filter((e) => e.type === 'session/supplement')
    expect(supplementEvents).toEqual([
      expect.objectContaining({ type: 'session/supplement', uuid: 'sup-1', text: wrapped }),
    ])
    const rebuilt = historyFromEvents(logOf(session).events as unknown as NativeLogEvent[]) as Array<{
      role: string
      content: Array<{ text?: string }>
    }>
    expect(rebuilt.at(-2)).toEqual({ role: 'user', content: [{ type: 'text', text: wrapped }] })
    expect(rebuilt.at(-1)?.role).toBe('assistant')
    // Not a renderable line: the transcript reader excludes it.
    await (session as unknown as { log: { flush: () => Promise<void> } }).log.flush()
    const entries = await readNativeHistoryEntries(dir, 'steer')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((entry) => JSON.stringify(entry.message).includes('[ADDITIONAL GUIDANCE]'))).toBe(false)
    await session.destroy()
  })

  it('rejects supplements while idle and after the turn settles (nothing stranded)', async () => {
    const dir = await tempDir('native-steer-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [textTurn('one'), textTurn('two')],
      requests,
    )
    const session = provider.createSession({ id: 'steer-idle', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    // Idle: no turn has started, so admission is closed.
    expect(session.enqueueSupplement!({ uuid: 'sup-idle', text: 'too early' })).toBe(false)
    session.enqueueUserMessage(userMsg('one') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    // The manager closes admission on every terminal frame; a steer landing
    // now must be rejected, not queued with no round left to inject into.
    session.noteTurnSettled!()
    expect(session.enqueueSupplement!({ uuid: 'sup-late', text: 'too late' })).toBe(false)
    expect(session.drainSupplements!()).toEqual([])
    session.enqueueUserMessage(userMsg('two') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(2)
    })
    expect(JSON.stringify(requests[1].messages)).not.toContain('[ADDITIONAL GUIDANCE]')
    await session.destroy()
  })

  it('drains multiple supplements as separate user messages and separate log events', async () => {
    const dir = await tempDir('native-steer-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [toolTurn('t1'), textTurn('done')],
      requests,
    )
    const delivered: string[] = []
    let session: ReturnType<NativeProvider['createSession']> | null = null
    session = provider.createSession({
      id: 'steer-multi',
      cwd: process.cwd(),
      onSupplementDelivered: (uuid) => delivered.push(uuid),
      canUseTool: async (_toolName: unknown, input: unknown) => {
        session!.enqueueSupplement!({ uuid: 'sup-a', text: 'first steer' })
        session!.enqueueSupplement!({ uuid: 'sup-b', text: 'second steer' })
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session!.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    const wrappedA = formatSupplementInstruction('first steer')
    const wrappedB = formatSupplementInstruction('second steer')
    // One user message per supplement, in queue order, before the next request.
    const second = requests[1].messages as Array<{ role: string; content: unknown }>
    expect(second.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: wrappedA }] },
      { role: 'user', content: [{ type: 'text', text: wrappedB }] },
    ])
    // One durable event per supplement, each carrying its own wrapped text.
    const events = logOf(session).events.filter((e) => e.type === 'session/supplement')
    expect(events.map((e) => e.text)).toEqual([wrappedA, wrappedB])
    expect(delivered).toEqual(['sup-a', 'sup-b'])
    await session.destroy()
  })

  it('keeps the batch queued when the supplement flush fails (no delivery, still drainable)', async () => {
    const dir = await tempDir('native-steer-')
    const provider = providerWithStreamer([toolTurn('t1'), textTurn('done')], dir)
    const delivered: string[] = []
    let session: ReturnType<NativeProvider['createSession']> | null = null
    session = provider.createSession({
      id: 'steer-flush',
      cwd: process.cwd(),
      onSupplementDelivered: (uuid) => delivered.push(uuid),
      canUseTool: async (_toolName: unknown, input: unknown) => {
        session!.enqueueSupplement!({ uuid: 'sup-flush', text: 'keep me' })
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session!.messages) frames.push(f as Frame)
    })()
    // Fail exactly the flush that follows the supplement append; the earlier
    // frame flushes must succeed or the turn never reaches injection.
    const log = (session as unknown as { log: NativeSessionLog }).log
    const originalFlush = log.flush.bind(log)
    let failed = false
    vi.spyOn(log, 'flush').mockImplementation(async () => {
      if (!failed && log.events.some((e) => e.type === 'session/supplement')) {
        failed = true
        throw new Error('flush failed')
      }
      return originalFlush()
    })
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    expect(failed).toBe(true)
    // The turn failed loudly, but the message is NOT lost: no delivery fired
    // and the manager can still requeue it from the pending queue.
    expect((frames.at(-1) as Frame).is_error).toBe(true)
    expect(delivered).toEqual([])
    expect(session.drainSupplements!()).toEqual([{ uuid: 'sup-flush', text: 'keep me' }])
    await session.destroy()
  })

  it('drainSupplements returns leftovers and clears the queue (nothing injected, no delivery)', async () => {
    const dir = await tempDir('native-steer-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [toolTurn('t1'), textTurn('done')],
      requests,
    )
    const delivered: string[] = []
    let leftovers: Array<{ uuid: string; text?: string }> = []
    let session: ReturnType<NativeProvider['createSession']> | null = null
    session = provider.createSession({
      id: 'steer-drain',
      cwd: process.cwd(),
      onSupplementDelivered: (uuid) => delivered.push(uuid),
      canUseTool: async (_toolName: unknown, input: unknown) => {
        session!.enqueueSupplement!({ uuid: 'sup-left', text: 'leftover' })
        leftovers = session!.drainSupplements!()
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session!.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    expect(leftovers).toEqual([{ uuid: 'sup-left', text: 'leftover' }])
    expect(session.drainSupplements!()).toEqual([]) // cleared by the drain
    expect(delivered).toEqual([])
    // The next round saw no injection — the leftover left the session queue.
    expect(JSON.stringify(requests[1].messages)).not.toContain('[ADDITIONAL GUIDANCE]')
    await session.destroy()
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
      'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'NotebookEdit', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Task', 'TaskOutput', 'Skill', 'mcp__a__echo',
    ])
    // The permission request carries the server OWNED BY the tool's FQN,
    // resolved from discovery metadata (never parsed back out of the name).
    expect(permissionCtx).toEqual({
      signal: expect.anything(),
      toolUseID: 'm1',
      permissionMode: 'default',
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

  it.each(['Agent', 'Task'] as const)('runs %s as a sidechain with one outer result and no nested delegation', async (toolName) => {
    const dir = await tempDir('native-agent-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{
      tools: Array<{ name: string }>
      messages: unknown[]
      system: string
      model: string
    }> = []
    const scripts: CanonicalEvent[][] = [
      agentTurn('agent-1', { description: 'd', prompt: 'do it' }, toolName),
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

    // The parent advertises both delegation names plus the discovered MCP
    // tool; every nested request drops both (depth cap 1) but keeps MCP and Skill.
    expect(requests[0].tools.map((t) => t.name)).toEqual([
      'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'NotebookEdit', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Task', 'TaskOutput', 'Skill', 'mcp__a__echo',
    ])
    const nestedRequests = requests.filter((r) => !r.tools.some((t) => t.name === 'Agent'))
    expect(nestedRequests).toHaveLength(2)
    for (const r of nestedRequests) {
      expect(r.tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'NotebookEdit', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite', 'TaskOutput', 'Skill', 'mcp__a__echo'])
      expect(r.tools.some((tool) => tool.name === 'Task')).toBe(false)
      expect(r.system).not.toContain(AGENT_GUIDANCE)
    }
    expect(requests[0].system).toContain(AGENT_GUIDANCE)

    // Persistence: the durable identity is written before any sidechain frame.
    const events = logOf(session).events
    const descriptor = events.find((event) => event.type === 'subagent/descriptor')
    expect(descriptor).toMatchObject({
      type: 'subagent/descriptor',
      toolUseId: 'agent-1',
      parentToolUseId: null,
      kind: 'agent',
      toolName,
      label: 'd',
      depth: 1,
      profile: null,
    })
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

  it('gives Explore only explicitly read-only tools under bypass and a broad base allowlist', async () => {
    const dir = await tempDir('native-explore-read-only-')
    const maliciousExplore = agentDefinition({
      name: 'Explore', prompt: 'STORE-OVERRIDE', model: 'store-model', tools: ['Write'],
    })
    const provider = new NativeProvider({
      stateDir: dir,
      agentStore: agentStoreOf({ Explore: maliciousExplore }),
    })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('explore-1', { description: 'd', prompt: 'p', subagent_type: 'Explore' }),
      textTurn('EXPLORE-DONE'),
      textTurn('PARENT-DONE'),
    ], requests)
    const session = provider.createSession({
      id: 'explore-read-only',
      cwd: dir,
      model: 'parent-model',
      permissionMode: 'bypassPermissions',
      providerExtras: { sdkOptions: { tools: [
        'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'NotebookEdit',
        'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Task',
        'TaskOutput', 'Skill', 'mcp__a__read', 'mcp__a__write', 'mcp__a__undeclared',
        'mcp__b__read', 'mcp__b__write', 'mcp__b__undeclared',
      ] } },
      mcpServers: {
        a: { type: 'sdk', instance: mixedReadOnlyServer('a') },
        b: { type: 'sdk', instance: mixedReadOnlyServer('b') },
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('explore') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      expect(requests).toHaveLength(3)
      expect(requests[1].model).toBe('parent-model')
      expect(requests[1].system).toContain(
        'Explore the codebase read-only. Use available read-only tools to answer with concrete file references; do not modify files or run state-changing tools.',
      )
      expect(requests[1].system).not.toContain('STORE-OVERRIDE')
      expect(requests[1].tools.map((tool) => tool.name)).toEqual([
        'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TaskOutput', 'Skill',
        'mcp__a__read', 'mcp__b__read',
      ])
      expect(logOf(session).events.find((event) => event.type === 'subagent/descriptor'))
        .toMatchObject({
          toolName: 'Agent',
          profile: {
            name: 'Explore',
            instruction: 'Explore the codebase read-only. Use available read-only tools to answer with concrete file references; do not modify files or run state-changing tools.',
          },
        })
    } finally {
      await session.destroy()
    }
  })

  it('does not append a descriptor when Agent permission is denied', async () => {
    const dir = await tempDir('native-agent-denied-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts: CanonicalEvent[][] = [
      agentTurn('agent-denied', { description: 'd', prompt: 'p' }),
      textTurn('PARENT-DONE'),
    ]
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: CapturedRequest) {
      requests.push(structuredClone(req))
      for (const event of scripts.shift() ?? []) yield event
    }
    const session = provider.createSession({
      id: 'agent-denied',
      cwd: dir,
      canUseTool: async () => ({ behavior: 'deny', message: 'not allowed', interrupt: false }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      expect(requests).toHaveLength(2)
      expect(logOf(session).events.some((event) => event.type === 'subagent/descriptor')).toBe(false)
      expect(frames.some((frame) => frame.parent_tool_use_id === 'agent-denied')).toBe(false)
    } finally {
      await session.destroy()
    }
  })

  it('scopes nested profile tools and Skill view independently of parent overrides', async () => {
    const dir = await tempDir('native-nested-skills-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const definition = agentDefinition({ tools: ['Skill'], skills: ['demo'] })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [skillTurn('nested-skill', 'other'), textTurn('done')],
      requests,
    )
    const session = provider.createSession({
      id: 'nested-skills',
      cwd: dir,
      permissionMode: 'bypassPermissions',
      providerExtras: { sdkOptions: { skills: 'all' } },
    })
    try {
      await session.supportedCommands?.()
      await session.applyFlagSettings?.({ skillOverrides: { other: 'on' } })
      const outcome = await runNestedAgent(session, dir, {
        description: 'd', prompt: 'p', subagent_type: 'reviewer',
      })

      expect(outcome).toEqual({ text: 'done' })
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Skill'])
      expect(requests[0].system).toContain('REVIEW-PROMPT')
      expect(requests[0].system).toContain('- demo: demo description')
      expect(requests[0].system).not.toContain('- other')
      const skillResult = logOf(session).events.find((event) =>
        event.type === 'user' && event.parent_tool_use_id === 'tu-parent')
      expect(skillResult?.message?.content?.[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'nested-skill',
        is_error: true,
      })
      expect(JSON.stringify(skillResult)).toContain('unknown skill: other')
      const parentCommands = await session.supportedCommands?.() as Array<{ name: string }>
      expect(parentCommands.map((command) => command.name)).toContain('other')
    } finally {
      await session.destroy()
    }
  })

  it('builds a child tool profile from the full snapshot under a restrictive parent preset', async () => {
    const dir = await tempDir('native-parent-child-tools-')
    const parent = agentDefinition({ name: 'parent', tools: ['Agent', 'Read'] })
    const child = agentDefinition({ name: 'child', tools: ['Write'] })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ parent, child }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('agent-1', { description: 'd', prompt: 'p', subagent_type: 'child' }),
      textTurn('CHILD-DONE'),
      textTurn('PARENT-DONE'),
    ], requests)
    const session = provider.createSession({
      id: 'parent-child-tools', cwd: dir, agent: 'parent',
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      expect(requests).toHaveLength(3)
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read', 'Agent'])
      expect(requests[1].tools.map((tool) => tool.name)).toEqual(['Write'])
      expect(requests[2].tools.map((tool) => tool.name)).toEqual(['Read', 'Agent'])
    } finally {
      await session.destroy()
    }
  })

  it('builds a child MCP scope from all discovered servers despite parent persona exclusion', async () => {
    const dir = await tempDir('native-parent-child-mcp-')
    const parent = agentDefinition({
      name: 'parent', tools: ['Agent', 'mcp__a__echo'], mcpServers: ['a'],
    })
    const child = agentDefinition({
      name: 'child', tools: ['mcp__b__echo'], mcpServers: ['b'],
    })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ parent, child }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('agent-1', { description: 'd', prompt: 'p', subagent_type: 'child' }),
      textTurn('CHILD-DONE'),
      textTurn('PARENT-DONE'),
    ], requests)
    const session = provider.createSession({
      id: 'parent-child-mcp',
      cwd: dir,
      agent: 'parent',
      mcpServers: {
        a: { type: 'sdk', instance: echoServer() },
        b: { type: 'sdk', instance: echoServer() },
      },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      expect(requests).toHaveLength(3)
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Agent', 'mcp__a__echo'])
      expect(requests[1].tools.map((tool) => tool.name)).toEqual(['mcp__b__echo'])
      expect(requests[2].tools.map((tool) => tool.name)).toEqual(['Agent', 'mcp__a__echo'])
    } finally {
      await session.destroy()
    }
  })

  it('does not let a child profile bypass session-base tool restrictions', async () => {
    const dir = await tempDir('native-parent-child-base-tools-')
    const parent = agentDefinition({ name: 'parent', tools: ['Agent', 'Read'] })
    const child = agentDefinition({ name: 'child', tools: ['Write'] })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ parent, child }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('agent-1', { description: 'd', prompt: 'p', subagent_type: 'child' }),
      textTurn('CHILD-DONE'),
      textTurn('PARENT-DONE'),
    ], requests)
    const session = provider.createSession({
      id: 'parent-child-base-tools',
      cwd: dir,
      agent: 'parent',
      providerExtras: { sdkOptions: { tools: ['Agent', 'Read'] } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      expect(requests).toHaveLength(3)
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read', 'Agent'])
      expect(requests[1].tools.map((tool) => tool.name)).toEqual([])
      expect(requests[2].tools.map((tool) => tool.name)).toEqual(['Read', 'Agent'])
    } finally {
      await session.destroy()
    }
  })

  it('auto-allows a nested bypass profile without widening the parent default mode', async () => {
    const dir = await tempDir('native-nested-bypass-')
    const trace = await nestedPermissionTrace(
      dir,
      'default',
      agentDefinition({ permissionMode: 'bypassPermissions' }),
    )

    expect(trace.outcome).toEqual({ text: 'done' })
    expect(trace.contexts).toEqual([])
    expect(trace.effective).toMatchObject({ permissionMode: 'default', agent: null })
  })

  it('still requests permission for a nested default profile under a bypass parent', async () => {
    const dir = await tempDir('native-nested-default-')
    const trace = await nestedPermissionTrace(
      dir,
      'bypassPermissions',
      agentDefinition({ permissionMode: 'default' }),
    )

    expect(trace.outcome).toEqual({ text: 'done' })
    expect(trace.contexts).toHaveLength(1)
    expect(trace.contexts[0]).toMatchObject({ toolUseID: 'nested-read', permissionMode: 'default' })
    expect(trace.effective).toMatchObject({ permissionMode: 'bypassPermissions', agent: null })
  })

  it('returns a max-turn nested error with its partial report and paired sidechain history', async () => {
    const dir = await tempDir('native-nested-max-turns-')
    const definition = agentDefinition({ tools: ['Read'], maxTurns: 1 })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('agent-1', { description: 'd', prompt: 'p', subagent_type: 'reviewer' }),
      textAndToolTurn('PARTIAL-REPORT', 'nested-read'),
      textTurn('UNEXPECTED-SECOND-ROUND'),
      textTurn('PARENT-DONE'),
    ], requests)
    const permissionIds: string[] = []
    const session = provider.createSession({
      id: 'nested-max-turns',
      cwd: dir,
      canUseTool: async (_toolName: unknown, input: unknown, context: unknown) => {
        permissionIds.push((context as { toolUseID: string }).toolUseID)
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
      await vi.waitFor(() => expect(logOf(session).events.some((event) => event.type === 'turn/end')).toBe(true))

      const parentResult = frames.find((frame) => frame.type === 'user'
        && frame.parent_tool_use_id == null
        && (frame.message.content[0] as { tool_use_id?: string }).tool_use_id === 'agent-1')
      expect(parentResult?.message.content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'agent-1',
        is_error: true,
      })
      expect(JSON.stringify(parentResult)).toContain('max turns reached (1)')
      expect(JSON.stringify(parentResult)).toContain('PARTIAL-REPORT')
      expect(permissionIds).toEqual(['agent-1'])

      const sidechain = logOf(session).events.filter((event) => event.parent_tool_use_id === 'agent-1')
      const assistantCall = sidechain.find((event) => event.type === 'assistant')
      const syntheticResult = sidechain.find((event) => event.type === 'user')
      expect(assistantCall?.message?.content?.[1]).toMatchObject({ type: 'tool_use', id: 'nested-read' })
      expect(syntheticResult?.message?.content?.[0]).toMatchObject({
        type: 'tool_result', tool_use_id: 'nested-read', is_error: true,
      })
      expect(JSON.stringify(syntheticResult)).toContain('max turns reached (1); tool not executed')
      expect(requests).toHaveLength(3)
    } finally {
      await session.destroy()
    }
  })

  it('forwards nested effort overrides through the real stream and otherwise inherits parent effort', async () => {
    const dir = await tempDir('native-nested-effort-')
    const origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
    const efforts: unknown[] = []
    streamAnthropicMessagesMock.mockImplementation(async function* (req: { effort?: unknown }) {
      efforts.push(req.effort)
      for (const ev of textTurn('done')) yield ev
    })
    const scoped = agentDefinition({ name: 'scoped', effort: 'low' })
    const inherit = agentDefinition({ name: 'inherit' })
    const provider = new NativeProvider({
      stateDir: dir,
      agentStore: agentStoreOf({ scoped, inherit }),
    })
    const session = provider.createSession({
      id: 'nested-effort', cwd: dir, effortLevel: 'high', permissionMode: 'bypassPermissions',
    })
    try {
      await runNestedAgent(session, dir, { description: 'd', prompt: 'p', subagent_type: 'scoped' })
      await session.applyFlagSettings?.({ effortLevel: 'max' })
      await runNestedAgent(session, dir, { description: 'd', prompt: 'p', subagent_type: 'inherit' })

      expect(efforts).toEqual(['low', 'max'])
      expect(effectiveSettingsOf(session)).toMatchObject({ effortLevel: 'max', agent: null })
    } finally {
      await session.destroy()
      streamAnthropicMessagesMock.mockReset()
      streamAnthropicMessagesMock.mockImplementation(originalStreamAnthropicMessages.fn)
      __setConfigForTest(origConfig)
    }
  })

  it('applies a main agent preset before the first request and persists its history-only selection', async () => {
    const dir = await tempDir('native-main-preset-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const definition = agentDefinition({
      model: 'reviewer-model',
      tools: ['Read', 'Skill', 'Bash'],
      disallowedTools: ['Bash'],
      skills: ['demo'],
      permissionMode: 'plan',
      effort: 'xhigh',
    })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    let selectionDurableAtRequest = false
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: CapturedRequest) {
      requests.push(structuredClone(req))
      selectionDurableAtRequest = loadNativeSessionLogSync(dir, 'preset')!.events
        .some((event) => event.type === 'session/agent')
      for (const ev of textTurn('done')) yield ev
    }
    const session = provider.createSession({
      id: 'preset',
      cwd: dir,
      agent: 'reviewer',
      model: 'base-model',
      permissionMode: 'default',
      effortLevel: 'high',
      providerExtras: {
        sdkOptions: {
          skills: 'all',
          tools: ['Bash'],
          disallowedTools: ['Read'],
        },
      },
    })
    expect(loadNativeSessionLogSync(dir, 'preset')!.events.some(
      (event) => event.type === 'session/agent' && event.name === 'reviewer',
    )).toBe(true)
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()

    expect(effectiveSettingsOf(session)).toEqual({
      model: 'reviewer-model',
      permissionMode: 'plan',
      effortLevel: 'xhigh',
      agent: 'reviewer',
    })
    session.enqueueUserMessage(userMsg('review') as never)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))

    expect(requests).toHaveLength(1)
    expect(requests[0].model).toBe('reviewer-model')
    expect(requests[0].system).toContain('REVIEW-PROMPT')
    expect(requests[0].system).toContain('- demo: demo description')
    expect(requests[0].system).not.toContain('- other')
    // Persona fields win field-wise over the base tool profile: the base
    // disallowedTools ['Read'] must not remove the persona-allowed Read tool.
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read', 'Skill'])
    expect(selectionDurableAtRequest).toBe(true)

    const events = logOf(session).events
    const selectionIndex = events.findIndex((event) => event.type === 'session/agent')
    const userIndex = events.findIndex((event) => event.type === 'user')
    expect(selectionIndex).toBeGreaterThanOrEqual(0)
    expect(selectionIndex).toBeLessThan(userIndex)
    expect(events[selectionIndex]).toMatchObject({
      type: 'session/agent',
      name: 'reviewer',
      definition: { prompt: 'REVIEW-PROMPT', model: 'reviewer-model' },
      base: {
        model: 'base-model',
        permissionMode: 'default',
        effortLevel: 'high',
        skillPolicy: 'all',
        toolProfile: { tools: ['Bash'], disallowedTools: ['Read'] },
      },
    })
    expect(frames.some((frame) => (frame as unknown as { type: string }).type === 'session/agent')).toBe(false)
    await session.destroy()
  })

  it('switches the main agent only for the next turn and durably before its first request', async () => {
    const dir = await tempDir('native-preset-switch-')
    const definition = agentDefinition({ prompt: 'NEXT-PERSONA', model: 'persona-model', tools: ['Read'] })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<void>()
    let selectionDurableAtSecondRequest = false
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: CapturedRequest) {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      } else if (requests.length === 2) {
        const selections = loadNativeSessionLogSync(dir, 'preset-switch')!.events
          .filter((event) => event.type === 'session/agent')
        selectionDurableAtSecondRequest = selections.at(-1)?.name === 'reviewer'
      }
      for (const ev of textTurn(`done-${requests.length}`)) yield ev
    }
    const session = provider.createSession({
      id: 'preset-switch',
      cwd: dir,
      model: 'base-model',
      providerExtras: { sdkOptions: { tools: ['Bash'] } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('first') as never)
      await firstStarted.promise
      await session.applyFlagSettings?.({ agent: 'reviewer' })

      expect(requests[0].model).toBe('base-model')
      expect(requests[0].system).not.toContain('NEXT-PERSONA')
      expect(effectiveSettingsOf(session)).toMatchObject({ model: 'persona-model', agent: 'reviewer' })
      releaseFirst.resolve()
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      session.enqueueUserMessage(userMsg('second') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))
      expect(requests[1].model).toBe('persona-model')
      expect(requests[1].system).toContain('NEXT-PERSONA')
      expect(requests[1].tools.map((tool) => tool.name)).toEqual(['Read'])
      expect(selectionDurableAtSecondRequest).toBe(true)
    } finally {
      releaseFirst.resolve()
      await session.destroy()
    }
  })

  it('clears the main agent back to every base setting', async () => {
    const dir = await tempDir('native-preset-clear-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const definition = agentDefinition({
      prompt: 'PERSONA-PROMPT',
      model: 'persona-model',
      tools: ['Read'],
      skills: ['demo'],
      permissionMode: 'bypassPermissions',
      effort: 'xhigh',
    })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([textTurn('done')], requests)
    const session = provider.createSession({
      id: 'preset-clear',
      cwd: dir,
      agent: 'reviewer',
      model: 'base-model',
      permissionMode: 'plan',
      effortLevel: 'high',
      providerExtras: { sdkOptions: { tools: ['Bash', 'Read', 'Skill'], skills: 'all' } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      await session.applyFlagSettings?.({ agent: null })
      expect(effectiveSettingsOf(session)).toEqual({
        model: 'base-model',
        permissionMode: 'plan',
        effortLevel: 'high',
        agent: null,
      })

      session.enqueueUserMessage(userMsg('plain') as never)
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))
      expect(requests[0].model).toBe('base-model')
      expect(requests[0].system).not.toContain('PERSONA-PROMPT')
      expect(requests[0].system).toContain('- demo: demo description')
      expect(requests[0].system).toContain('- other: other description')
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Skill'])
      expect(logOf(session).events.at(-1)).toMatchObject({
        type: 'turn/end',
      })
      const selections = logOf(session).events.filter((event) => event.type === 'session/agent')
      expect(selections.at(-1)).toMatchObject({
        name: null,
        base: {
          model: 'base-model',
          permissionMode: 'plan',
          effortLevel: 'high',
          skillPolicy: 'all',
          toolProfile: { tools: ['Bash', 'Read', 'Skill'] },
        },
      })
    } finally {
      await session.destroy()
    }
  })

  it('keeps persona controls effective while recording the latest base across restart and clear', async () => {
    const dir = await tempDir('native-preset-latest-base-')
    const definition = agentDefinition({
      model: 'persona-model',
      permissionMode: 'bypassPermissions',
      effort: 'xhigh',
    })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const original = provider.createSession({
      id: 'preset-latest-base',
      cwd: dir,
      agent: 'reviewer',
      model: 'base-old',
      permissionMode: 'plan',
      effortLevel: 'high',
    })
    await original.setModel?.('base-new')
    await original.setPermissionMode?.('acceptEdits')
    await original.applyFlagSettings?.({ effortLevel: 'low' })
    expect(effectiveSettingsOf(original)).toEqual({
      model: 'persona-model',
      permissionMode: 'bypassPermissions',
      effortLevel: 'xhigh',
      agent: 'reviewer',
    })
    expect(logOf(original).events.filter((event) => event.type === 'session/agent')).toHaveLength(4)
    await original.destroy()

    const resumed = provider.createSession({ id: 'preset-latest-base', cwd: dir, resume: 'preset-latest-base' })
    try {
      expect(effectiveSettingsOf(resumed)).toEqual({
        model: 'persona-model',
        permissionMode: 'bypassPermissions',
        effortLevel: 'xhigh',
        agent: 'reviewer',
      })
      await resumed.applyFlagSettings?.({ agent: null })
      expect(effectiveSettingsOf(resumed)).toEqual({
        model: 'base-new',
        permissionMode: 'acceptEdits',
        effortLevel: 'low',
        agent: null,
      })
      const selections = logOf(resumed).events.filter((event) => event.type === 'session/agent')
      expect(selections.at(-1)).toMatchObject({
        name: null,
        base: { model: 'base-new', permissionMode: 'acceptEdits', effortLevel: 'low' },
      })
    } finally {
      await resumed.destroy()
    }
  })

  it('updates base and effective controls together when the persona does not override them', async () => {
    const dir = await tempDir('native-preset-unpinned-controls-')
    const definition = agentDefinition({ prompt: 'PROMPT-ONLY' })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const session = provider.createSession({
      id: 'preset-unpinned-controls',
      cwd: dir,
      agent: 'reviewer',
      model: 'base-old',
      permissionMode: 'plan',
      effortLevel: 'high',
    })
    try {
      await session.setModel?.('base-new')
      await session.setPermissionMode?.('acceptEdits')
      await session.applyFlagSettings?.({ effortLevel: 'low' })
      expect(effectiveSettingsOf(session)).toEqual({
        model: 'base-new',
        permissionMode: 'acceptEdits',
        effortLevel: 'low',
        agent: 'reviewer',
      })
      expect(logOf(session).events.filter((event) => event.type === 'session/agent')).toHaveLength(4)
    } finally {
      await session.destroy()
    }
  })

  it('rejects an unsupported agent switch without changing flags, base state, or the log', async () => {
    const dir = await tempDir('native-preset-switch-invalid-')
    const invalid = agentDefinition({ name: 'invalid', background: true })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ invalid }) })
    const session = provider.createSession({
      id: 'preset-switch-invalid',
      cwd: dir,
      model: 'base-model',
      permissionMode: 'plan',
      effortLevel: 'low',
    })
    try {
      const before = effectiveSettingsOf(session)
      await expect(session.applyFlagSettings?.({ agent: 'invalid', effortLevel: 'high', fastMode: true }))
        .rejects.toThrow(/background/)
      expect(effectiveSettingsOf(session)).toEqual(before)
      expect((session as unknown as { fastMode: boolean }).fastMode).toBe(false)
      expect(logOf(session).events.some((event) => event.type === 'session/agent')).toBe(false)
    } finally {
      await session.destroy()
    }
  })

  it('keeps model and effort unchanged when their base snapshot cannot become durable', async () => {
    const dir = await tempDir('native-base-durable-failure-')
    const definition = agentDefinition({ prompt: 'PROMPT-ONLY' })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const session = provider.createSession({
      id: 'base-durable-failure',
      cwd: dir,
      agent: 'reviewer',
      model: 'base-model',
      effortLevel: 'high',
    })
    const log = (session as unknown as { log: NativeSessionLog }).log
    const original = (log as unknown as { appendDurable?: unknown }).appendDurable
    ;(log as unknown as { appendDurable?: unknown }).appendDurable = async () => {
      throw new Error('durable write failed')
    }
    try {
      const before = effectiveSettingsOf(session)
      await expect(session.setModel?.('next-model')).rejects.toThrow('durable write failed')
      expect(effectiveSettingsOf(session)).toEqual(before)
      await expect(session.applyFlagSettings?.({ effortLevel: 'low' })).rejects.toThrow('durable write failed')
      expect(effectiveSettingsOf(session)).toEqual(before)
      expect(log.events.filter((event) => event.type === 'session/agent')).toHaveLength(1)
    } finally {
      ;(log as unknown as { appendDurable?: unknown }).appendDurable = original
      await session.destroy()
    }
  })

  it('keeps the create-body tool and skill policies when no main persona is selected', async () => {
    const dir = await tempDir('native-base-policy-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [textTurn('done')],
      requests,
    )
    const session = provider.createSession({
      id: 'base-policy',
      cwd: dir,
      model: 'base-model',
      permissionMode: 'acceptEdits',
      effortLevel: 'medium',
      providerExtras: { sdkOptions: { tools: ['Read'], skills: ['demo'] } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))

    expect(requests[0].model).toBe('base-model')
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read'])
    expect(requests[0].system).toContain('- demo: demo description')
    expect(requests[0].system).not.toContain('- other')
    expect(effectiveSettingsOf(session)).toEqual({
      model: 'base-model',
      permissionMode: 'acceptEdits',
      effortLevel: 'medium',
      agent: null,
    })
    expect(logOf(session).events.some((event) => event.type === 'session/agent')).toBe(false)
    await session.destroy()
  })

  it('restores the logged definition and base snapshots instead of edited store or resume options', async () => {
    const dir = await tempDir('native-preset-resume-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const definition = agentDefinition({
      prompt: 'OLD-REVIEW-PROMPT',
      model: 'reviewer-old',
      tools: ['Read'],
      permissionMode: 'plan',
      effort: 'xhigh',
    })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const original = provider.createSession({
      id: 'preset-resume',
      cwd: dir,
      agent: 'reviewer',
      model: 'base-old',
      permissionMode: 'default',
      effortLevel: 'high',
      providerExtras: { sdkOptions: { skills: ['demo'] } },
    })
    await original.destroy()

    Object.assign(definition, {
      prompt: 'NEW-REVIEW-PROMPT',
      model: 'reviewer-new',
      tools: ['Bash'],
      permissionMode: 'bypassPermissions',
      effort: 'low',
    })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [textTurn('resumed')],
      requests,
    )
    const resumed = provider.createSession({
      id: 'preset-resume',
      cwd: dir,
      resume: 'preset-resume',
      model: 'resume-option-model',
      permissionMode: 'bypassPermissions',
      effortLevel: 'low',
      providerExtras: { sdkOptions: { skills: ['other'] } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of resumed.messages) frames.push(frame as Frame) })()
    resumed.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))

    expect(requests[0].model).toBe('reviewer-old')
    expect(requests[0].system).toContain('OLD-REVIEW-PROMPT')
    expect(requests[0].system).not.toContain('NEW-REVIEW-PROMPT')
    expect(requests[0].system).toContain('- demo: demo description')
    expect(requests[0].system).not.toContain('- other')
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read'])
    expect(effectiveSettingsOf(resumed)).toEqual({
      model: 'reviewer-old',
      permissionMode: 'plan',
      effortLevel: 'xhigh',
      agent: 'reviewer',
    })
    expect(await resumed.supportedCommands?.()).toEqual([
      { name: 'demo', description: 'demo description', argumentHint: '' },
    ])
    await resumed.destroy()
  })

  it('uses only the latest agent selection at or before a fork cut', async () => {
    const dir = await tempDir('native-preset-fork-')
    const base = { model: 'base-model', permissionMode: 'default' }
    const firstDefinition = agentDefinition({ prompt: 'BEFORE-CUT', model: 'before-model', tools: ['Read'] })
    const laterDefinition = agentDefinition({ prompt: 'AFTER-CUT', model: 'after-model', tools: ['Bash'] })
    const seed = NativeSessionLog.open({ stateDir: dir, id: 'source-preset', cwd: dir, resume: false })
    seed.append({ type: 'session/context', text: 'ctx' })
    seed.append({
      type: 'session/agent',
      name: 'reviewer',
      definition: firstDefinition,
      base,
      timestamp: '2026-11-11T00:00:00.000Z',
    })
    seed.append({
      type: 'assistant',
      uuid: 'cut-assistant',
      session_id: 'source-preset',
      parent_tool_use_id: null,
      timestamp: '2026-11-11T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'cut' }] },
    })
    seed.append({
      type: 'session/agent',
      name: 'reviewer',
      definition: laterDefinition,
      base,
      timestamp: '2026-11-11T00:00:02.000Z',
    })
    await seed.flush()
    await seed.close()

    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: laterDefinition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [textTurn('forked')],
      requests,
    )
    const forked = provider.createSession({
      id: 'forked-preset',
      cwd: dir,
      resume: 'source-preset',
      forkSession: true,
      resumeSessionAt: 'cut-assistant',
      agent: 'reviewer',
      model: 'fork-option-model',
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of forked.messages) frames.push(frame as Frame) })()
    forked.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))

    expect(requests[0].model).toBe('before-model')
    expect(requests[0].system).toContain('BEFORE-CUT')
    expect(requests[0].system).not.toContain('AFTER-CUT')
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read'])
    expect(effectiveSettingsOf(forked)?.model).toBe('before-model')
    await forked.destroy()
  })

  it('seeds an explicit pre-persona clear when a fork cut precedes the first selection', async () => {
    const dir = await tempDir('native-preset-fork-before-selection-')
    const definition = agentDefinition({
      prompt: 'LATER-PERSONA', model: 'persona-model', permissionMode: 'bypassPermissions', tools: ['Bash'],
    })
    const source = NativeSessionLog.open({ stateDir: dir, id: 'source-before-selection', cwd: dir, resume: false })
    source.append({ type: 'session/context', text: 'ctx' })
    source.append({
      type: 'assistant',
      uuid: 'before-selection-cut',
      session_id: 'source-before-selection',
      parent_tool_use_id: null,
      timestamp: '2026-11-11T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'plain cut' }] },
    })
    source.append({
      type: 'session/agent',
      name: 'reviewer',
      definition,
      base: { model: 'base-model', permissionMode: 'default', effortLevel: 'high' },
      timestamp: '2026-11-11T00:00:01.000Z',
    })
    await source.flush()
    await source.close()

    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([textTurn('forked')], requests)
    const forked = provider.createSession({
      id: 'fork-before-selection',
      cwd: dir,
      resume: 'source-before-selection',
      forkSession: true,
      resumeSessionAt: 'before-selection-cut',
      agent: 'reviewer',
      model: 'fork-option-model',
      permissionMode: 'bypassPermissions',
      effortLevel: 'low',
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of forked.messages) frames.push(frame as Frame) })()
    try {
      expect(effectiveSettingsOf(forked)).toEqual({
        model: 'base-model', permissionMode: 'default', effortLevel: 'high', agent: null,
      })
      const selections = logOf(forked).events.filter((event) => event.type === 'session/agent')
      expect(selections).toHaveLength(1)
      expect(selections[0]).toMatchObject({
        name: null,
        base: { model: 'base-model', permissionMode: 'default', effortLevel: 'high' },
      })

      forked.enqueueUserMessage(userMsg('next') as never)
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))
      expect(requests[0].model).toBe('base-model')
      expect(requests[0].system).not.toContain('LATER-PERSONA')
    } finally {
      await forked.destroy()
    }
  })

  it.each([
    { label: 'resume', fork: false },
    { label: 'fork', fork: true },
  ])('migrates a supported legacy preset on $label and persists its selection snapshot', async ({ fork }) => {
    const dir = await tempDir(`native-legacy-supported-${fork ? 'fork' : 'resume'}-`)
    const sourceId = `legacy-supported-${fork ? 'source' : 'resume'}`
    const definition = agentDefinition({
      prompt: 'MIGRATED-PERSONA',
      model: 'persona-model',
      tools: ['Read'],
      permissionMode: 'plan',
      effort: 'xhigh',
    })
    const legacy = NativeSessionLog.open({ stateDir: dir, id: sourceId, cwd: dir, resume: false })
    legacy.append({ type: 'session/context', text: 'legacy context' })
    await legacy.flush()
    await legacy.close()

    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([textTurn('done')], requests)
    const session = provider.createSession({
      id: fork ? 'legacy-supported-fork' : sourceId,
      cwd: dir,
      resume: sourceId,
      forkSession: fork,
      agent: 'reviewer',
      model: 'base-model',
      permissionMode: 'acceptEdits',
      effortLevel: 'high',
      providerExtras: { sdkOptions: { tools: ['Bash'], skills: 'all' } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      expect(effectiveSettingsOf(session)).toEqual({
        model: 'persona-model',
        permissionMode: 'plan',
        effortLevel: 'xhigh',
        agent: 'reviewer',
      })
      const selections = (logOf(session).events as NativeLogEvent[])
        .filter((event) => event.type === 'session/agent')
      expect(selections).toHaveLength(1)
      expect(selections[0]).toMatchObject({
        name: 'reviewer',
        definition: { prompt: 'MIGRATED-PERSONA', model: 'persona-model', tools: ['Read'] },
        base: {
          model: 'base-model',
          permissionMode: 'acceptEdits',
          effortLevel: 'high',
          skillPolicy: 'all',
          toolProfile: { tools: ['Bash'] },
        },
      })

      session.enqueueUserMessage(userMsg('next') as never)
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))
      expect(requests[0].model).toBe('persona-model')
      expect(requests[0].system).toContain('MIGRATED-PERSONA')
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read'])
      expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
      expect(frames.filter((frame) => frame.subtype === 'informational')).toHaveLength(0)
    } finally {
      await session.destroy()
    }
  })

  it.each([
    { label: 'resume', fork: false },
    { label: 'fork', fork: true },
  ])('drops an unsupported legacy preset atomically on $label and announces every dropped field', async ({ fork }) => {
    const dir = await tempDir(`native-legacy-unsupported-${fork ? 'fork' : 'resume'}-`)
    const sourceId = `legacy-unsupported-${fork ? 'source' : 'resume'}`
    const definition = agentDefinition({
      prompt: 'MUST-NOT-APPLY',
      model: 'persona-model',
      tools: ['Read'],
      permissionMode: 'plan',
      background: true,
      memory: 'project',
      effort: 3,
    })
    const legacy = NativeSessionLog.open({ stateDir: dir, id: sourceId, cwd: dir, resume: false })
    legacy.append({ type: 'session/context', text: 'legacy context' })
    await legacy.flush()
    await legacy.close()

    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([textTurn('done')], requests)
    const session = provider.createSession({
      id: fork ? 'legacy-unsupported-fork' : sourceId,
      cwd: dir,
      resume: sourceId,
      forkSession: fork,
      agent: 'reviewer',
      model: 'base-model',
      permissionMode: 'acceptEdits',
      effortLevel: 'high',
      providerExtras: { sdkOptions: { tools: ['Bash'] } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      expect(effectiveSettingsOf(session)).toEqual({
        model: 'base-model',
        permissionMode: 'acceptEdits',
        effortLevel: 'high',
        agent: null,
      })
      const selections = (logOf(session).events as NativeLogEvent[])
        .filter((event) => event.type === 'session/agent')
      expect(selections).toHaveLength(1)
      expect(selections[0]).toMatchObject({
        name: null,
        droppedAgent: { name: 'reviewer', unsupportedFields: ['background', 'memory', 'effort'] },
        base: { model: 'base-model', permissionMode: 'acceptEdits', effortLevel: 'high' },
      })
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2))
      expect(frames.slice(0, 2).map((frame) => frame.subtype)).toEqual(['init', 'informational'])
      const notice = frames[1].content as string
      expect(notice).toContain('reviewer')
      for (const field of ['background', 'memory', 'effort']) expect(notice).toContain(field)

      session.enqueueUserMessage(userMsg('next') as never)
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))
      expect(requests[0].model).toBe('base-model')
      expect(requests[0].system).not.toContain('MUST-NOT-APPLY')
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Bash'])
    } finally {
      await session.destroy()
    }
  })

  it('does not run legacy migration when a selection event already exists', async () => {
    const dir = await tempDir('native-preset-existing-selection-')
    const definition = agentDefinition({ prompt: 'SNAPSHOT-PERSONA', model: 'snapshot-model' })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const original = provider.createSession({
      id: 'existing-selection', cwd: dir, agent: 'reviewer', model: 'base-model',
    })
    await original.destroy()
    Object.assign(definition, {
      prompt: 'CURRENT-UNSUPPORTED-PERSONA', model: 'current-model', background: true, effort: 3,
    })

    const resumed = provider.createSession({
      id: 'existing-selection', cwd: dir, resume: 'existing-selection', agent: 'reviewer',
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of resumed.messages) frames.push(frame as Frame) })()
    try {
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
      expect(effectiveSettingsOf(resumed)).toMatchObject({ model: 'snapshot-model', agent: 'reviewer' })
      const selections = (logOf(resumed).events as NativeLogEvent[])
        .filter((event) => event.type === 'session/agent')
      expect(selections).toHaveLength(1)
      expect(selections[0]).toMatchObject({ name: 'reviewer', definition: { prompt: 'SNAPSHOT-PERSONA' } })
      expect(frames.map((frame) => frame.subtype)).toEqual(['init'])
    } finally {
      await resumed.destroy()
    }
  })

  it('maps a main maxTurns cutoff to an error turn/end and keeps a natural completion completed', async () => {
    const dir = await tempDir('native-main-max-turns-')
    const definition = agentDefinition({ maxTurns: 1 })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      // The first round is capped; the second ends naturally at the same cap.
      const script = logOf(currentSession).events.some((event) => event.type === 'turn/end')
        ? textTurn('done')
        : toolTurn('capped-read')
      for (const ev of script) yield ev
    }
    const currentSession = provider.createSession({ id: 'main-max-turns', cwd: dir, agent: 'reviewer' })
    const frames: Frame[] = []
    void (async () => { for await (const frame of currentSession.messages) frames.push(frame as Frame) })()

    currentSession.enqueueUserMessage(userMsg('first') as never)
    await vi.waitFor(() => expect(logOf(currentSession).events.some(
      (event) => event.type === 'turn/end' && event.reason === 'error',
    )).toBe(true))
    currentSession.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(logOf(currentSession).events.filter(
      (event) => event.type === 'turn/end',
    )).toHaveLength(2))

    expect(logOf(currentSession).events.filter((event) => event.type === 'turn/end').map((event) => event.reason))
      .toEqual(['error', 'completed'])
    const results = frames.filter((frame) => frame.type === 'result')
    expect(results).toHaveLength(2)
    expect(results[0].is_error).toBe(true)
    expect(results[1].is_error).toBe(false)
    await currentSession.destroy()
  })

  it('keeps the turn-start permission mode until the next turn', async () => {
    const dir = await tempDir('native-turn-permission-snapshot-')
    const provider = new NativeProvider({ stateDir: dir })
    let requestCount = 0
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      requestCount++
      if (requestCount === 1) {
        await session.setPermissionMode?.('default')
        for (const ev of toolTurn('snapshot-read')) yield ev
      } else if (requestCount === 2) {
        for (const ev of textTurn('first-done')) yield ev
      } else if (requestCount === 3) {
        for (const ev of toolTurn('next-turn-read')) yield ev
      } else {
        for (const ev of textTurn('second-done')) yield ev
      }
    }
    const session = provider.createSession({
      id: 'turn-permission-snapshot',
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('first') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
      session.enqueueUserMessage(userMsg('second') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))

      const toolResults = frames.filter((frame) => frame.type === 'user')
      expect(toolResults).toHaveLength(2)
      expect(toolResults[0].message.content[0]).not.toMatchObject({ is_error: true })
      expect(toolResults[1].message.content[0]).toMatchObject({ is_error: true })
      expect(JSON.stringify(toolResults[1].message.content[0])).toContain('no permission handler')
    } finally {
      await session.destroy()
    }
  })

  it('rejects unsupported main preset fields before creating a session log', async () => {
    const dir = await tempDir('native-main-preset-invalid-')
    const definition = agentDefinition({ background: true })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })

    expect(() => provider.createSession({ id: 'invalid-preset', cwd: dir, agent: 'reviewer' }))
      .toThrow(/background/)
    expect(loadNativeSessionLogSync(dir, 'invalid-preset')).toBeNull()
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
    // No MCP server: the `!this.mcp` branch of rebuildTools must still offer delegation.
    const session = provider.createSession({
      id: 'agent-def',
      cwd: dir,
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(userMsg('review') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'DONE')).toBe(true))

    expect(requests[0].tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'NotebookEdit', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Task', 'TaskOutput', 'Skill'])
    const nested = requests.find((r) => !r.tools.some((t) => t.name === 'Agent'))!
    // The definition's prompt is the nested instruction suffix and its model the
    // default nested model...
    expect(nested.system.endsWith('REVIEW-PROMPT')).toBe(true)
    expect(nested.model).toBe('reviewer-model')
    // ...while the delegation guidance is in the PARENT prompt only: the
    // subagent cannot call Agent or Task, so advertising it would be misleading.
    expect(requests[0].system).toContain(AGENT_GUIDANCE)
    expect(nested.system).not.toContain(AGENT_GUIDANCE)
    // TaskOutput remains available at both depths and shares one guidance constant.
    expect(requests[0].system).toContain(TASK_OUTPUT_GUIDANCE)
    expect(nested.system).toContain(TASK_OUTPUT_GUIDANCE)
    // Glob/LS are offered at both depths, and their guidance is registered as
    // a prompt section from the same constant as the tool def.
    expect(requests[0].system).toContain(globTool.guidance)
    expect(requests[0].system).toContain(lsTool.guidance)
    expect(nested.system).toContain(globTool.guidance)
    expect(nested.system).toContain(lsTool.guidance)
    // The two web tools are per-session factories, so their sections are
    // registered manually — also at both depths.
    expect(requests[0].system).toContain(WEB_FETCH_GUIDANCE)
    expect(requests[0].system).toContain(WEB_SEARCH_GUIDANCE)
    expect(nested.system).toContain(WEB_FETCH_GUIDANCE)
    expect(nested.system).toContain(WEB_SEARCH_GUIDANCE)
    // TodoWrite is also session-owned, and NotebookEdit is static; both prompt
    // sections must reach parent and nested requests.
    expect(requests[0].system).toContain(TODO_WRITE_GUIDANCE)
    expect(requests[0].system).toContain(NOTEBOOK_EDIT_GUIDANCE)
    expect(nested.system).toContain(TODO_WRITE_GUIDANCE)
    expect(nested.system).toContain(NOTEBOOK_EDIT_GUIDANCE)
    // AskUserQuestion is static too, and its section rides the same TOOLS loop.
    expect(requests[0].system).toContain(ASK_USER_QUESTION_GUIDANCE)
    expect(nested.system).toContain(ASK_USER_QUESTION_GUIDANCE)
    await session.destroy()
  })

  it('reads the session model at Agent call time, not at construction', async () => {
    const dir = await tempDir('native-agent-model-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ tools: Array<{ name: string }>; model: string }> = []
    const scripts: CanonicalEvent[][] = [
      agentTurn('agent-3', { description: 'd', prompt: 'p' }),
      textTurn('INNER'),
      textTurn('OUTER'),
    ]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
      tools: Array<{ name: string }>
      model: string
    }) {
      requests.push(structuredClone(req))
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: 'agent-model',
      cwd: dir,
      model: 'm1',
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    // The switch happens AFTER the Agent tool was constructed: a snapshotted
    // `model: this.model` would leave the nested run on m1.
    await session.setModel?.('m2')
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'OUTER')).toBe(true))

    expect(requests[0].model).toBe('m2')
    const nested = requests.filter((r) => !r.tools.some((t) => t.name === 'Agent'))
    expect(nested).toHaveLength(1)
    expect(nested[0].model).toBe('m2')
    await session.destroy()
  })

  it('reads the session model at WebFetch call time, not at construction', async () => {
    const dir = await tempDir('native-web-fetch-model-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts: CanonicalEvent[][] = [webFetchTurn('web-1'), textTurn('DONE')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const auxRequests: Array<Record<string, unknown>> = []
    setFakeWebHandler(() => new Response('<p>page text</p>', { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith('/v1/messages')) {
          throw new Error(`unexpected global fetch ${String(input)}`)
        }
        auxRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'AUX' }] }), {
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const session = provider.createSession({
      id: 'web-model',
      cwd: dir,
      model: 'm1',
      profile: {
        id: 'p1',
        name: 'Profile 1',
        authToken: 'tok',
        baseUrl: 'https://api.example.test',
        modelList: [],
        modelGroups: [],
        recapModel: '',
        commitMessageModel: '',
      },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      // The switch happens AFTER the tool was constructed: a snapshotted model
      // would leave the summarization call on m1.
      await session.setModel?.('m2')
      const frames: Frame[] = []
      void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

      session.enqueueUserMessage(userMsg('go') as never)
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'DONE')).toBe(true))

      expect(auxRequests).toHaveLength(1)
      expect(auxRequests[0].model).toBe('m2')
    } finally {
      await session.destroy()
      vi.unstubAllGlobals()
    }
  })

  it('routes AskUserQuestion to the tool in bypassPermissions, where it fails loudly', async () => {
    const dir = await tempDir('native-ask-bypass-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts: CanonicalEvent[][] = [askUserQuestionTurn('ask-1'), textTurn('DONE')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    // No canUseTool: requestPermission short-circuits bypass BEFORE the
    // broker, so this is the one path that reaches the tool's own `run`.
    const session = provider.createSession({ id: 'ask-bypass', cwd: dir, permissionMode: 'bypassPermissions' })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('ask') as never)
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'DONE')).toBe(true))
      const toolResult = frames.find((f) => f.type === 'user'
        && f.parent_tool_use_id == null
        && (f.message.content[0] as { tool_use_id?: string }).tool_use_id === 'ask-1')
      expect(toolResult?.message.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'ask-1',
        content: [{ type: 'text', text: 'AskUserQuestion requires an interactive dialog; bypassPermissions has no dialog' }],
        is_error: true,
      })
    } finally {
      await session.destroy()
    }
  })

  it('threads the broker question-result marker into a non-error tool_result', async () => {
    const dir = await tempDir('native-ask-answered-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts: CanonicalEvent[][] = [askUserQuestionTurn('ask-1'), textTurn('DONE')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: 'ask-answered',
      cwd: dir,
      canUseTool: async (_toolName: unknown, _input: unknown) => ({
        behavior: 'deny',
        message: JSON.stringify({ note: 'ok', answers: [{ question: 'q1', answer: 'a' }] }),
        interrupt: false,
        [QUESTION_RESULT]: true,
      }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('ask') as never)
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'DONE')).toBe(true))
      const toolResult = frames.find((f) => f.type === 'user'
        && f.parent_tool_use_id == null
        && (f.message.content[0] as { tool_use_id?: string }).tool_use_id === 'ask-1')
      expect(toolResult?.message.content[0]).toMatchObject({ is_error: false })
    } finally {
      await session.destroy()
    }
  })

  it('keeps an unmarked AskUserQuestion denial an error through NativeSession', async () => {
    const dir = await tempDir('native-ask-denied-')
    const provider = new NativeProvider({ stateDir: dir })
    const scripts: CanonicalEvent[][] = [askUserQuestionTurn('ask-1'), textTurn('DONE')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: 'ask-denied',
      cwd: dir,
      canUseTool: async (_toolName: unknown, _input: unknown) => ({
        behavior: 'deny',
        message: 'aborted',
        interrupt: false,
      }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('ask') as never)
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'DONE')).toBe(true))
      const toolResult = frames.find((f) => f.type === 'user'
        && f.parent_tool_use_id == null
        && (f.message.content[0] as { tool_use_id?: string }).tool_use_id === 'ask-1')
      expect(toolResult?.message.content[0]).toMatchObject({ is_error: true })
    } finally {
      await session.destroy()
    }
  })

  it('declares Agent support and lists the built-in general-purpose and Explore agents', async () => {
    const dir = await tempDir('native-agents-cap-')
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.capabilities.supportsAgents).toBe(true)
    expect(provider.capabilities.supportsTaskControl).toBe(true)
    // Standalone subagent transcripts are projected from the same session log.
    expect(provider.capabilities.supportsSubagentTranscripts).toBe(true)
    const session = provider.createSession({ id: 'agents-cap', cwd: dir })
    // The effective tool list holds from construction (rebuildTools runs in the
    // constructor), not builtins-only until the first turn.
    expect((session as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name))
      .toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'NotebookEdit', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Task', 'TaskOutput', 'Skill'])
    const other = provider.createSession({ id: 'agents-cap-other', cwd: dir })
    expect((session as unknown as { todoWriteTool: unknown }).todoWriteTool)
      .not.toBe((other as unknown as { todoWriteTool: unknown }).todoWriteTool)
    await other.destroy()
    expect(await session.supportedAgents?.()).toEqual([
      { name: 'general-purpose', description: 'General-purpose subagent for self-contained tasks.' },
      { name: 'Explore', description: 'Read-only codebase exploration with concrete file references.' },
    ])
    await session.destroy()
  })

  it('exposes the skill catalog as commands and declares command support', async () => {
    const dir = await tempDir('native-skill-commands-')
    await writeProjectSkill(dir, 'demo', { frontmatter: { 'argument-hint': "'[topic]'" } })
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.capabilities.supportsCommands).toBe(true)
    // Plugins stay unsupported — only the skill command catalog is exposed.
    expect(provider.capabilities.supportsPlugins).toBe(false)
    const session = provider.createSession({ id: 'skill-commands', cwd: dir })
    expect(await session.supportedCommands?.()).toEqual([
      { name: 'demo', description: 'demo description', argumentHint: '[topic]' },
    ])
    await session.destroy()
  })

  it('reloadSkills re-reads the skill roots and can empty the catalog', async () => {
    const dir = await tempDir('native-skill-reload-')
    await writeProjectSkill(dir, 'demo', { body: '# demo v1' })
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'skill-reload', cwd: dir })
    const catalog = session as unknown as { skills: { bodyOf(name: string): { text: string } } }
    expect(await session.reloadSkills?.()).toEqual({
      skills: [{ name: 'demo', description: 'demo description', argumentHint: '' }],
    })

    // A file edit is picked up only by a reload — the catalog caches bodies.
    await writeProjectSkill(dir, 'demo', { body: '# demo v2' })
    await session.reloadSkills?.()
    expect(catalog.skills.bodyOf('demo').text).toContain('# demo v2')

    // A fully deleted catalog answers an empty list (the manager relays that
    // to the client so the picker clears).
    await rm(join(dir, '.claude', 'skills', 'demo'), { recursive: true, force: true })
    expect(await session.reloadSkills?.()).toEqual({ skills: [] })
    expect(await session.supportedCommands?.()).toEqual([])
    await session.destroy()
  })

  it('applyFlagSettings drives the skill catalog and rejects unknown keys', async () => {
    const dir = await tempDir('native-skill-overrides-')
    await writeProjectSkill(dir, 'demo')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'skill-overrides', cwd: dir })
    const catalog = session as unknown as {
      skills: { section(): string; bodyOf(name: string): { text: string; isError?: boolean } }
    }
    // `supportedCommands` awaits the construction-time discovery, so the
    // catalog is populated before the first synchronous read.
    expect(await session.supportedCommands?.()).toEqual([
      { name: 'demo', description: 'demo description', argumentHint: '' },
    ])

    await session.applyFlagSettings?.({ skillOverrides: { demo: 'off' } })
    expect(catalog.skills.section()).toBe('')
    expect(catalog.skills.bodyOf('demo')).toEqual({ text: 'unknown skill: demo', isError: true })

    // An empty map restores the spawn default (undefined = name-only).
    await session.applyFlagSettings?.({ skillOverrides: {} })
    expect(catalog.skills.section()).toBe('<available_skills>\n- demo\n</available_skills>')
    expect(catalog.skills.bodyOf('demo').text).toContain('# demo')

    // Any other key throws, and applies nothing.
    await expect(session.applyFlagSettings?.({ plugins: {} })).rejects.toThrow(/plugins/)
    await expect(session.applyFlagSettings?.({ model: 'claude-opus-4-8' })).rejects.toThrow(/model/)
    expect(catalog.skills.section()).toBe('<available_skills>\n- demo\n</available_skills>')
    await session.destroy()
  })

  it.each(['switch', 'clear'] as const)('keeps the turn-start Skill view during a mid-turn %s', async (action) => {
    const dir = await tempDir(`native-skill-turn-${action}-`)
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const definition = agentDefinition({ skills: [action === 'switch' ? 'other' : 'demo'] })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    let requests = 0
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      requests++
      if (requests === 1) {
        await session.applyFlagSettings?.({ agent: action === 'switch' ? 'reviewer' : null })
        for (const ev of skillTurn('skill-current', 'demo')) yield ev
      } else if (requests === 2) {
        for (const ev of textTurn('current-done')) yield ev
      } else if (requests === 3) {
        for (const ev of skillTurn('skill-next', 'other')) yield ev
      } else {
        for (const ev of textTurn('next-done')) yield ev
      }
    }
    const session = provider.createSession({
      id: `skill-turn-${action}`,
      cwd: dir,
      agent: action === 'clear' ? 'reviewer' : undefined,
      providerExtras: { sdkOptions: { skills: [action === 'switch' ? 'demo' : 'other'] } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('current') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
      session.enqueueUserMessage(userMsg('next') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))

      const results = frames.filter((frame) => frame.type === 'user')
      expect(results).toHaveLength(2)
      expect(JSON.stringify(results[0].message.content)).toContain('# demo')
      expect(JSON.stringify(results[0].message.content)).not.toContain('unknown skill')
      expect(JSON.stringify(results[1].message.content)).toContain('# other')
      expect(JSON.stringify(results[1].message.content)).not.toContain('unknown skill')
    } finally {
      await session.destroy()
    }
  })

  it('scopes slash expansion and supported commands to the active persona', async () => {
    const dir = await tempDir('native-skill-persona-view-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const definition = agentDefinition({ skills: ['demo'] })
    const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf({ reviewer: definition }) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [textTurn('blocked'), textTurn('allowed')],
      requests,
    )
    const session = provider.createSession({
      id: 'skill-persona-view',
      cwd: dir,
      agent: 'reviewer',
      providerExtras: { sdkOptions: { skills: 'all' } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    try {
      expect(await session.supportedCommands?.()).toEqual([
        { name: 'demo', description: 'demo description', argumentHint: '' },
      ])

      session.enqueueUserMessage(userMsg('/other keep this') as never)
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result' && frame.result === 'blocked')).toBe(true))
      expect(sentUserContent(requests[0])).toEqual([{ type: 'text', text: '/other keep this' }])

      await session.applyFlagSettings?.({ agent: null })
      expect((await session.supportedCommands?.() as Array<{ name: string }>).map((command) => command.name))
        .toEqual(['demo', 'other'])
      session.enqueueUserMessage(userMsg('/other keep this') as never)
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result' && frame.result === 'allowed')).toBe(true))
      expect(requests[1].messages.slice(-2)).toEqual([
        { role: 'user', content: [{ type: 'text', text: '/other keep this' }] },
        { role: 'user', content: [{ type: 'text', text: canonicalSkillBody(dir, 'other') }] },
      ])
    } finally {
      await session.destroy()
    }
  })

  it('freezes every execution field and effective tool when a persona switches pre-request', async () => {
    const dir = await tempDir('native-turn-profile-snapshot-')
    await writeProjectSkill(dir, 'demo')
    await writeProjectSkill(dir, 'other')
    const first = agentDefinition({
      prompt: 'FIRST-PERSONA', model: 'first-model', tools: ['Read', 'Skill'], skills: ['demo'],
      permissionMode: 'plan', effort: 'low',
    })
    const second = agentDefinition({
      name: 'second', prompt: 'SECOND-PERSONA', model: 'second-model', tools: ['Bash'], skills: ['other'],
      permissionMode: 'bypassPermissions', effort: 'xhigh',
    })
    const provider = new NativeProvider({
      stateDir: dir,
      agentStore: agentStoreOf({ reviewer: first, second }),
    })
    const requests: CapturedRequest[] = []
    const permissionModes: Array<string | undefined> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [toolTurn('read-under-first'), textTurn('done')], requests,
    )
    const session = provider.createSession({
      id: 'turn-profile-snapshot', cwd: dir, agent: 'reviewer',
      providerExtras: { sdkOptions: { tools: ['Read', 'Skill', 'Bash'], skills: 'all' } },
      canUseTool: async (_name: unknown, input: unknown, ctx: unknown) => {
        permissionModes.push((ctx as { permissionMode?: string }).permissionMode)
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    const mcpGate = deferred<void>()
    const efforts: Array<string | undefined> = []
    const internals = session as unknown as {
      mcp: unknown
      streamFor: (
        req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
        opts?: { effortLevel?: () => 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined },
      ) => AsyncIterable<CanonicalEvent>
    }
    internals.mcp = {
      whenReady: () => mcpGate.promise,
      tools: () => [],
      statuses: () => [],
      closeAll: async () => {},
    }
    const streamFor = internals.streamFor.bind(session)
    internals.streamFor = (req, opts) => {
      efforts.push(opts?.effortLevel?.())
      return streamFor(req, opts)
    }
    try {
      expect(await session.supportedCommands?.()).toEqual([
        { name: 'demo', description: 'demo description', argumentHint: '' },
      ])
      session.enqueueUserMessage(userMsg('/demo do this') as never)
      await vi.waitFor(() => expect(logOf(session).events.some((event) => event.type === 'session/skill')).toBe(true))
      await session.applyFlagSettings?.({ agent: 'second' })
      expect(effectiveSettingsOf(session)).toMatchObject({ model: 'second-model', agent: 'second' })
      mcpGate.resolve()
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      expect(requests[0].model).toBe('first-model')
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(['Read', 'Skill'])
      expect(requests[0].system).toContain('FIRST-PERSONA')
      expect(requests[0].system).toContain('- demo: demo description')
      expect(requests[0].system).not.toContain('SECOND-PERSONA')
      expect(requests[0].system).not.toContain('- other')
      expect(permissionModes).toEqual(['plan'])
      expect(efforts).toEqual(['low', 'low'])
    } finally {
      mcpGate.resolve()
      await session.destroy()
    }
  })

  it('keeps invocation, prompt section, and Skill tool on one reload-isolated snapshot', async () => {
    const dir = await tempDir('native-turn-skill-snapshot-')
    await writeProjectSkill(dir, 'demo', { body: '# demo v1', description: 'demo v1' })
    const provider = new NativeProvider({ stateDir: dir })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer(
      [skillTurn('skill-snapshot', 'demo'), textTurn('done')], requests,
    )
    const session = provider.createSession({
      id: 'turn-skill-snapshot', cwd: dir, permissionMode: 'bypassPermissions',
      providerExtras: { sdkOptions: { skills: 'all' } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    const mcpGate = deferred<void>()
    ;(session as unknown as { mcp: unknown }).mcp = {
      whenReady: () => mcpGate.promise,
      tools: () => [],
      statuses: () => [],
      closeAll: async () => {},
    }
    try {
      await session.supportedCommands?.()
      session.enqueueUserMessage(userMsg('/demo do this') as never)
      await vi.waitFor(() => expect(logOf(session).events.some((event) => event.type === 'session/skill')).toBe(true))
      await writeProjectSkill(dir, 'demo', { body: '# demo v2', description: 'demo v2' })
      await session.reloadSkills?.()
      mcpGate.resolve()
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))

      const v1 = canonicalSkillBody(dir, 'demo', '# demo v1')
      expect(logOf(session).events.find((event) => event.type === 'session/skill')).toMatchObject({ body: v1 })
      expect(requests[0].system).toContain('- demo: demo v1')
      expect(requests[0].system).not.toContain('demo v2')
      expect(requests[0].messages.slice(-2)).toEqual([
        { role: 'user', content: [{ type: 'text', text: '/demo do this' }] },
        { role: 'user', content: [{ type: 'text', text: v1 }] },
      ])
      const toolResult = (requests[1].messages.at(-1) as { content: Array<{ content: Array<{ text: string }> }> })
        .content[0]
      expect(toolResult.content[0].text).toBe(v1)
    } finally {
      mcpGate.resolve()
      await session.destroy()
    }
  })

  it('preserves a raw `/name args` turn and appends one canonical skill instruction', async () => {
    const dir = await tempDir('native-skill-expand-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('ok')], requests)
    const session = provider.createSession({ id: 'skill-expand', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    const queued = userMsg('/demo do this')
    session.enqueueUserMessage(queued as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'ok')).toBe(true))

    const expected = canonicalSkillBody(dir, 'demo', '# demo body')
    const raw = { role: 'user', content: [{ type: 'text', text: '/demo do this' }] }
    const instruction = { role: 'user', content: [{ type: 'text', text: expected }] }
    // The model receives the original invocation followed by its canonical
    // body. Disk stores the same pair as raw user + history-only session/skill.
    expect(requests[0].messages.slice(-2)).toEqual([raw, instruction])
    expect(userTexts(session)).toEqual(['/demo do this'])
    expect(logOf(session).events.filter((event) => event.type === 'session/skill')).toEqual([
      expect.objectContaining({ type: 'session/skill', name: 'demo', body: expected }),
    ])
    expect(expected).not.toContain('do this')
    expect(expected).not.toContain('description: demo description')

    // A later file edit and catalog reload cannot rewrite the captured turn.
    await writeProjectSkill(dir, 'demo', { body: '# demo replacement' })
    await session.reloadSkills?.()
    expect(logOf(session).events.find((event) => event.type === 'session/skill')).toMatchObject({ body: expected })
    // The queued message is never mutated: the manager's ring and broadcast
    // keep the `/name args` text the user typed.
    expect(queued.message.content).toEqual([{ type: 'text', text: '/demo do this' }])
    await session.destroy()
  })

  it('exposes durable skill bodies across catalog reload and resume for compaction', async () => {
    const dir = await tempDir('native-skill-compaction-entries-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('ok')], [])
    const session = provider.createSession({ id: 'skill-compaction-entries', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage({ ...userMsg('/demo do this'), uuid: 'skill-anchor' } as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'ok')).toBe(true))

    const expected = canonicalSkillBody(dir, 'demo', '# demo body')
    const getEntries = () => (session as unknown as {
      getSkillCompactionEntries(): readonly { afterUserUuid: string; body: string }[]
    }).getSkillCompactionEntries()
    expect(getEntries()).toEqual([{ afterUserUuid: 'skill-anchor', body: expected }])

    // The durable body, not a later catalog rendering, is the compaction input.
    await writeProjectSkill(dir, 'demo', { body: '# replacement body' })
    await session.reloadSkills?.()
    expect(getEntries()).toEqual([{ afterUserUuid: 'skill-anchor', body: expected }])

    await session.destroy()
    const resumed = provider.createSession({ id: 'skill-compaction-entries', cwd: dir, resume: 'skill-compaction-entries' })
    expect((resumed as unknown as { getSkillCompactionEntries(): unknown }).getSkillCompactionEntries())
      .toEqual([{ afterUserUuid: 'skill-anchor', body: expected }])
    await resumed.destroy()
  })

  it('persists the consumed prompt when skill discovery fails, then replays it exactly once', async () => {
    const dir = await tempDir('native-skill-expand-fail-')
    // Fail the constructor's discovery pass; the session is otherwise healthy.
    const reload = vi.spyOn(NativeSkillCatalog.prototype, 'reload')
    reload.mockRejectedValueOnce(new Error('skill discovery exploded'))
    const provider = new NativeProvider({ stateDir: dir })
    const requests: unknown[][] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push(structuredClone(req.messages))
      for (const ev of textTurn('recovered')) yield ev
    }
    let session: ReturnType<NativeProvider['createSession']>
    try {
      session = provider.createSession({ id: 'skill-expand-fail', cwd: dir })
    } finally {
      reload.mockRestore()
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('/demo do this') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))

    const result = frames.find((f) => f.type === 'result') as Frame
    expect(result.is_error).toBe(true)
    expect(result.result).toContain('skill discovery exploded')
    // The client already marked the turn "sent", so the ORIGINAL text must be
    // durable even though the turn never reached the model. Read the FILE, not
    // the in-memory events: this proves the flush resolved before the throw.
    const onDisk = loadNativeSessionLogSync(dir, 'skill-expand-fail') as unknown as LogLike
    expect(userTextsOf(onDisk)).toEqual(['/demo do this'])
    expect(requests).toEqual([])

    // Recovery must make the failed raw prompt visible to the NEXT live
    // request exactly once; the pre-run failure had no runTurn to append it.
    await session.reloadSkills?.()
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(2))
    expect(requests).toHaveLength(1)
    const replayed = historyFromEvents(logOf(session).events as unknown as NativeLogEvent[])
    expect(requests[0]).toEqual(replayed.slice(0, -1))

    await session.destroy()
    const resumed = provider.createSession({ id: 'skill-expand-fail', cwd: dir, resume: 'skill-expand-fail' })
    expect((resumed as unknown as { history: unknown[] }).history).toEqual(replayed)
    await resumed.destroy()
  })

  it('passes `/unknown` and non-skill `/clear` turns through unchanged', async () => {
    const dir = await tempDir('native-skill-passthrough-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('one'), textTurn('two')], requests)
    const session = provider.createSession({ id: 'skill-passthrough', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(userMsg('/unknown') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'one')).toBe(true))
    session.enqueueUserMessage(userMsg('/clear') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'two')).toBe(true))

    expect(userTexts(session)).toEqual(['/unknown', '/clear'])
    expect(sentUserContent(requests[0])).toEqual([{ type: 'text', text: '/unknown' }])
    expect(sentUserContent(requests[1])).toEqual([{ type: 'text', text: '/clear' }])
    await session.destroy()
  })

  it('expands name-only and user-invocable-only skills, but never an `off` one', async () => {
    const dir = await tempDir('native-skill-states-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    await writeProjectSkill(dir, 'hidden', {
      body: '# hidden body',
      frontmatter: { 'disable-model-invocation': 'true' },
    })
    const demoBody = canonicalSkillBody(dir, 'demo', '# demo body')
    const hiddenBody = canonicalSkillBody(dir, 'hidden', '# hidden body')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[]; system: string } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('one'), textTurn('two'), textTurn('three')], requests)
    const session = provider.createSession({ id: 'skill-states', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const runTurnOnce = async (n: number, text: string) => {
      session.enqueueUserMessage(userMsg(text) as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(n))
    }

    // Default (name-only): listed by name and expanded.
    await runTurnOnce(1, '/demo one')
    expect(requests[0].system).toContain('<available_skills>\n- demo\n</available_skills>')
    expect(sentUserContent(requests[0])).toEqual([{ type: 'text', text: demoBody }])

    // `disable-model-invocation` clamps the skill to user-invocable-only: it is
    // absent from the prompt section but `/hidden` still expands.
    await runTurnOnce(2, '/hidden two')
    expect(requests[1].system).toContain('<available_skills>\n- demo\n</available_skills>')
    expect(requests[1].system).not.toContain('- hidden')
    expect(sentUserContent(requests[1])).toEqual([{ type: 'text', text: hiddenBody }])

    // `off` hides it from the user surface too: the turn passes through.
    await session.applyFlagSettings?.({ skillOverrides: { demo: 'off' } })
    await runTurnOnce(3, '/demo three')
    expect(sentUserContent(requests[2])).toEqual([{ type: 'text', text: '/demo three' }])
    expect(userTexts(session)).toEqual([
      '/demo one',
      '/hidden two',
      '/demo three',
    ])
    await session.destroy()
  })

  it('preserves every block of an image-bearing `/name` turn and appends the instruction', async () => {
    const dir = await tempDir('native-skill-image-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const body = canonicalSkillBody(dir, 'demo', '# demo body')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('ok')], requests)
    const session = provider.createSession({ id: 'skill-image', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
    const queued = {
      ...userMsg('/demo look'),
      uuid: 'u-image',
      message: { role: 'user' as const, content: [{ type: 'text', text: '/demo look' }, image] },
    }
    session.enqueueUserMessage(queued as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'ok')).toBe(true))

    const raw = [{ type: 'text', text: '/demo look' }, image]
    // The raw user event and request keep the image block untouched; the
    // canonical body is a separate text-only instruction immediately after it.
    expect(logOf(session).events.find((e) => e.type === 'user')?.message?.content).toEqual(raw)
    expect(requests[0].messages.slice(-2)).toEqual([
      { role: 'user', content: raw },
      { role: 'user', content: [{ type: 'text', text: body }] },
    ])
    // The queued message the manager broadcasts is unmodified.
    expect(queued.message.content).toEqual([{ type: 'text', text: '/demo look' }, image])
    await session.destroy()
  })

  it('does not append multiline `/name` arguments to the expanded body', async () => {
    const dir = await tempDir('native-skill-multiline-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const body = canonicalSkillBody(dir, 'demo', '# demo body')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('ok')], requests)
    const session = provider.createSession({ id: 'skill-multiline', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(userMsg('/demo line1\nline2') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'ok')).toBe(true))

    const expected = body
    expect(expected).not.toContain('line1\nline2')
    expect(userTexts(session)).toEqual(['/demo line1\nline2'])
    expect(sentUserContent(requests[0])).toEqual([{ type: 'text', text: expected }])
    await session.destroy()
  })

  it('keeps a string-content `/name` turn raw and normalizes only its log event to blocks', async () => {
    const dir = await tempDir('native-skill-string-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const body = canonicalSkillBody(dir, 'demo', '# demo body')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('ok')], requests)
    const session = provider.createSession({ id: 'skill-string', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    session.enqueueUserMessage(stringUserMsg('/demo from string') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'ok')).toBe(true))

    const expected = body
    // The in-memory history keeps the caller's raw string shape, followed by
    // the instruction's block array...
    expect(requests[0].messages.slice(-2)).toEqual([
      { role: 'user', content: '/demo from string' },
      { role: 'user', content: [{ type: 'text', text: expected }] },
    ])
    // ...while the log normalizes only the raw user event to blocks (the
    // parser rejects a bare string).
    expect(logOf(session).events.find((e) => e.type === 'user')?.message?.content)
      .toEqual([{ type: 'text', text: '/demo from string' }])
    await session.destroy()
  })

  it('rebuilds the per-turn skills section from the live overrides', async () => {
    const dir = await tempDir('native-skill-section-')
    await writeProjectSkill(dir, 'demo')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ system: string }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { system: string }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('ok')) yield ev
    }
    const session = provider.createSession({ id: 'skill-section', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const runTurnOnce = async (n: number) => {
      session.enqueueUserMessage(userMsg(`turn ${n}`) as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(n))
    }

    // Default (Options.skills undefined) = name-only: the name, no
    // description, as its own `\n\n`-separated trailing block.
    await runTurnOnce(1)
    expect(requests[0].system).toContain('\n\n<available_skills>\n- demo\n</available_skills>')
    expect(requests[0].system.endsWith('<available_skills>\n- demo\n</available_skills>')).toBe(true)
    // The provider's static `tool:Skill` section travels with every prompt.
    expect(requests[0].system).toContain(SKILL_GUIDANCE)

    // 'on' brings the description back.
    await session.applyFlagSettings?.({ skillOverrides: { demo: 'on' } })
    await runTurnOnce(2)
    expect(requests[1].system).toContain('- demo: demo description')

    // 'user-invocable-only' leaves the model listing but keeps `/demo`.
    await session.applyFlagSettings?.({ skillOverrides: { demo: 'user-invocable-only' } })
    await runTurnOnce(3)
    expect(requests[2].system).not.toContain('<available_skills>')
    expect(await session.supportedCommands?.()).toEqual([
      { name: 'demo', description: 'demo description', argumentHint: '' },
    ])

    // 'off' removes it everywhere. With nothing listable the system prompt is
    // the static one — no empty section and no appended blank line (identical
    // to the 'user-invocable-only' turn above, which is also unlistable).
    await session.applyFlagSettings?.({ skillOverrides: { demo: 'off' } })
    await runTurnOnce(4)
    expect(requests[3].system).not.toContain('<available_skills>')
    expect(requests[3].system).toBe(requests[2].system)
    expect(await session.supportedCommands?.()).toEqual([])
    await session.destroy()
  })

  it('the nested Agent system reads the current skills section through its live getter', async () => {
    const dir = await tempDir('native-skill-nested-')
    await writeProjectSkill(dir, 'demo')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ tools: Array<{ name: string }>; system: string }> = []
    const scripts = [
      agentTurn('agent-skill-1', { description: 'd', prompt: 'p' }),
      textTurn('INNER-1'),
      textTurn('OUTER-1'),
      agentTurn('agent-skill-2', { description: 'd', prompt: 'p' }),
      textTurn('INNER-2'),
      textTurn('OUTER-2'),
    ]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
      tools: Array<{ name: string }>
      system: string
    }) {
      requests.push(structuredClone(req))
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: 'skill-nested',
      cwd: dir,
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('first') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'OUTER-1')).toBe(true))

    const isParent = (r: { tools: Array<{ name: string }> }) => r.tools.some((t) => t.name === 'Agent')
    // The first nested run sees the section (its prompt comes from the
    // session-level subagent system, which has no per-turn string of its own).
    expect(requests.filter(isParent)[0].system).toContain('<available_skills>\n- demo\n</available_skills>')
    expect(requests.filter((r) => !isParent(r))[0].system).toContain('<available_skills>\n- demo\n</available_skills>')

    // An override landed AFTER the Agent tool was built must reach the next
    // nested run — a snapshot taken at construction would keep the section.
    await session.applyFlagSettings?.({ skillOverrides: { demo: 'off' } })
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'OUTER-2')).toBe(true))
    const nestedRuns = requests.filter((r) => !isParent(r))
    expect(nestedRuns).toHaveLength(2)
    expect(nestedRuns[0].system).toContain('<available_skills>')
    expect(nestedRuns[1].system).not.toContain('<available_skills>')
    await session.destroy()
  })

  it('a failed construction-time skill discovery fails the turn loudly', async () => {
    const dir = await tempDir('native-skill-discovery-fail-')
    // Fail the constructor's `reload()` (the first call on the prototype),
    // then restore so later explicit reloads behave normally.
    const reload = vi.spyOn(NativeSkillCatalog.prototype, 'reload')
    reload.mockRejectedValueOnce(new Error('skill discovery exploded'))
    const provider = new NativeProvider({ stateDir: dir })
    const streamed: string[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      streamed.push('called')
      for (const ev of textTurn('unreachable')) yield ev
    }
    let session: ReturnType<NativeProvider['createSession']>
    try {
      session = provider.createSession({ id: 'skill-fail', cwd: dir })
    } finally {
      reload.mockRestore()
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))

    const result = frames.find((f) => f.type === 'result') as Frame
    expect(result.is_error).toBe(true)
    expect(result.result).toContain('skill discovery exploded')
    // The turn died BEFORE the model was called — the failure is not masked
    // as an empty catalog.
    expect(streamed).toEqual([])
    await session.destroy()
  })

  it('reloadSkills recovers a session whose construction discovery failed', async () => {
    const dir = await tempDir('native-skill-recover-')
    await writeProjectSkill(dir, 'demo')
    const reload = vi.spyOn(NativeSkillCatalog.prototype, 'reload')
    reload.mockRejectedValueOnce(new Error('skill discovery exploded'))
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ system: string }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { system: string }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('ok')) yield ev
    }
    let session: ReturnType<NativeProvider['createSession']>
    try {
      session = provider.createSession({ id: 'skill-recover', cwd: dir })
    } finally {
      reload.mockRestore()
    }
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('first') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    expect((frames.find((f) => f.type === 'result') as Frame).is_error).toBe(true)

    // The manual reload supersedes the failed construction pass, so the NEXT
    // turn awaits the fresh one and sees the discovered skill.
    expect(await session.reloadSkills?.()).toEqual({
      skills: [{ name: 'demo', description: 'demo description', argumentHint: '' }],
    })
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(2)
      expect(results[1].subtype).toBe('success')
    })
    expect((frames.filter((f) => f.type === 'result')[1] as Frame).result).toBe('ok')
    expect(requests[0].system).toContain('<available_skills>\n- demo\n</available_skills>')
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

  it('delegates exact-id, no-id, and stop controls to the same task manager', async () => {
    const dir = await tempDir('native-task-controls-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'task-controls', cwd: dir })
    const tasks = (session as unknown as { tasks: NativeTaskManager }).tasks
    const background = vi.spyOn(tasks, 'background')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const stop = vi.spyOn(tasks, 'stop').mockResolvedValue(undefined)

    try {
      await expect(session.backgroundTasks!('tu-exact')).resolves.toBe(true)
      await expect(session.backgroundTasks!()).resolves.toBe(false)
      await session.stopTask!('tu-exact')

      expect(background).toHaveBeenNthCalledWith(1, 'tu-exact')
      expect(background).toHaveBeenNthCalledWith(2)
      expect(stop).toHaveBeenCalledWith('tu-exact')
    } finally {
      await session.destroy()
    }
  })

  it('destroy aborts detached work and waits for its real execution to settle', async () => {
    const dir = await tempDir('native-task-destroy-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'task-destroy', cwd: dir })
    const tasks = (session as unknown as { tasks: NativeTaskManager }).tasks
    const execution = deferred<ToolOutcome>()
    let taskSignal!: AbortSignal

    try {
      const waiting = tasks.runForeground(
        { toolUseId: 'tu-detached', taskType: 'shell', description: 'detached command' },
        (signal) => {
          taskSignal = signal
          return execution.promise
        },
        new AbortController().signal,
      )
      await expect(session.backgroundTasks!('tu-detached')).resolves.toBe(true)
      await expect(waiting).resolves.toMatchObject({ isError: false })

      let destroyReturned = false
      const destroying = Promise.resolve(session.destroy()).then(() => { destroyReturned = true })
      await vi.waitFor(() => expect(taskSignal.aborted).toBe(true))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(destroyReturned).toBe(false)

      execution.resolve({ text: 'stopped output', isError: true })
      await destroying
      expect(destroyReturned).toBe(true)
    } finally {
      execution.resolve({ text: 'cleanup', isError: true })
      await session.destroy()
    }
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

  it('restores raw and skill messages exactly once after a pre-request flush failure', async () => {
    const dir = await tempDir('native-flush-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('after failure')], requests)
    const session = provider.createSession({ id: 'flush', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    const internals = session as unknown as {
      pumpLoop: () => Promise<void>
      pumping: boolean
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
    // Fail the turn's pre-run raw+instruction write exactly once.
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

    session.enqueueUserMessage(userMsg('/demo do this') as never)
    await expect(pumpPromise!).resolves.toBeUndefined()
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    expect((frames.find((f) => f.type === 'result') as Frame).result).toBe('disk full')
    expect(internals.log.events.filter((e) => e.type === 'turn/end')).toHaveLength(1)
    expect(requests).toEqual([])
    await vi.waitFor(() => expect(internals.pumping).toBe(false))

    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(2))
    expect(requests).toHaveLength(1)
    const replayed = historyFromEvents(logOf(session).events as unknown as NativeLogEvent[])
    expect(requests[0].messages).toEqual(replayed.slice(0, -1))

    await session.destroy()
    const resumed = provider.createSession({ id: 'flush', cwd: dir, resume: 'flush' })
    expect((resumed as unknown as { history: unknown[] }).history).toEqual(replayed)
    await resumed.destroy()
  })

  it('restores raw and skill messages exactly once after an MCP readiness failure', async () => {
    const dir = await tempDir('native-mcp-history-')
    await writeProjectSkill(dir, 'demo', { body: '# demo body' })
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('recovered')], requests)
    const session = provider.createSession({ id: 'mcp-history', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    const internals = session as unknown as { mcp: unknown; pumping: boolean }
    internals.mcp = { whenReady: async () => { throw new Error('MCP not ready') } }

    session.enqueueUserMessage(userMsg('/demo do this') as never)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
    expect((frames.find((frame) => frame.type === 'result') as Frame).result).toBe('MCP not ready')
    expect(requests).toEqual([])
    await vi.waitFor(() => expect(internals.pumping).toBe(false))

    const expected = canonicalSkillBody(dir, 'demo', '# demo body')
    expect((session as unknown as {
      getSkillCompactionEntries(): readonly { afterUserUuid: string; body: string }[]
    }).getSkillCompactionEntries()).toEqual([
      { afterUserUuid: 'u1', body: expected },
    ])
    expect(JSON.stringify((session as unknown as { history: unknown[] }).history)
      .match(/# demo body/g)).toHaveLength(1)

    internals.mcp = undefined
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))
    const replayed = historyFromEvents(logOf(session).events as unknown as NativeLogEvent[])
    expect(requests).toHaveLength(1)
    expect(requests[0].messages).toEqual(replayed.slice(0, -1))
    await session.destroy()
  })

  it('restores the initial prompt when runTurn rejects validation before taking ownership', async () => {
    const dir = await tempDir('native-validation-history-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] } & Record<string, unknown>> = []
    ;(provider as unknown as { _testStream: unknown })._testStream =
      capturingStreamer([textTurn('recovered')], requests)
    const session = provider.createSession({ id: 'validation-history', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    const internals = session as unknown as {
      currentProfile: { name: string; maxTurns: number } | null
      pumping: boolean
    }
    internals.currentProfile = { name: 'invalid', maxTurns: 0 }

    session.enqueueUserMessage(userMsg('first') as never)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
    expect((frames.find((frame) => frame.type === 'result') as Frame).result).toContain('maxTurns')
    expect(requests).toEqual([])
    await vi.waitFor(() => expect(internals.pumping).toBe(false))

    internals.currentProfile = null
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))
    const replayed = historyFromEvents(logOf(session).events as unknown as NativeLogEvent[])
    expect(requests).toHaveLength(1)
    expect(requests[0].messages).toEqual(replayed.slice(0, -1))
    await session.destroy()
  })

  it('does not duplicate the initial prompt after a post-ownership stream failure', async () => {
    const dir = await tempDir('native-stream-history-')
    const provider = new NativeProvider({ stateDir: dir })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push({ messages: structuredClone(req.messages) })
      if (requests.length === 1) throw new Error('stream exploded')
      for (const ev of textTurn('recovered')) yield ev
    }
    const session = provider.createSession({ id: 'stream-history', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()

    session.enqueueUserMessage(userMsg('first') as never)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
    expect((frames.find((frame) => frame.type === 'result') as Frame).result).toBe('stream exploded')
    await vi.waitFor(() => expect((session as unknown as { pumping: boolean }).pumping).toBe(false))

    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))
    const replayed = historyFromEvents(logOf(session).events as unknown as NativeLogEvent[])
    expect(requests).toHaveLength(2)
    expect(requests[1].messages).toEqual(replayed.slice(0, -1))
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

  it('sends the persisted thinking config and follows live setMaxThinkingTokens', async () => {
    const dir = await tempDir('native-thinking-')
    const origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
    const requests: Array<{ thinking?: unknown }> = []
    streamAnthropicMessagesMock.mockImplementation(async function* (req: { thinking?: unknown }) {
      requests.push(req)
      for (const ev of textTurn('ok')) yield ev
    })
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.capabilities.supportsThinkingControl).toBe(true)
    const session = provider.createSession({
      id: 'thinking',
      cwd: dir,
      thinking: { type: 'enabled', budgetTokens: 4096 },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const nextRequest = async (text: string, count: number): Promise<void> => {
      session.enqueueUserMessage(userMsg(text) as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(count))
    }
    try {
      await nextRequest('first', 1)
      expect(requests[0].thinking).toEqual({ type: 'enabled', budgetTokens: 4096 })

      // The live field, not the create-time opts value: the NEXT request reads it.
      await session.setMaxThinkingTokens?.(8192)
      await nextRequest('second', 2)
      expect(requests[1].thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })

      await session.setMaxThinkingTokens?.(null)
      await nextRequest('third', 3)
      expect(requests[2].thinking).toEqual({ type: 'adaptive' })

      await session.setMaxThinkingTokens?.(0)
      await nextRequest('fourth', 4)
      expect(requests[3].thinking).toEqual({ type: 'disabled' })
    } finally {
      await session.destroy()
      streamAnthropicMessagesMock.mockReset()
      streamAnthropicMessagesMock.mockImplementation(originalStreamAnthropicMessages.fn)
      __setConfigForTest(origConfig)
    }
  })

  it('tracks the thinking display separately from the token config', async () => {
    const dir = await tempDir('native-thinking-display-')
    const origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
    const requests: Array<Parameters<typeof buildRequestBody>[0]> = []
    streamAnthropicMessagesMock.mockImplementation(async function* (req: Parameters<typeof buildRequestBody>[0]) {
      requests.push(req)
      for (const ev of textTurn('ok')) yield ev
    })
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({
      id: 'thinking-display',
      cwd: dir,
      thinking: { type: 'enabled', budgetTokens: 4096, display: 'summarized' },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const nextRequest = async (text: string, count: number): Promise<void> => {
      session.enqueueUserMessage(userMsg(text) as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(count))
    }
    const wireThinking = (i: number): unknown =>
      (buildRequestBody(requests[i]) as { thinking?: unknown }).thinking
    try {
      await nextRequest('first', 1)
      // The create-time display seeds the tracked field.
      expect(wireThinking(0)).toEqual({ type: 'enabled', budget_tokens: 4096, display: 'summarized' })

      // An ABSENT display keeps the session mode — it is not a reset.
      await session.setMaxThinkingTokens?.(8192)
      await nextRequest('second', 2)
      expect(wireThinking(1)).toEqual({ type: 'enabled', budget_tokens: 8192, display: 'summarized' })

      // null resets to the API default.
      await session.setMaxThinkingTokens?.(4096, null)
      await nextRequest('third', 3)
      expect(wireThinking(2)).toEqual({ type: 'enabled', budget_tokens: 4096 })

      await session.setMaxThinkingTokens?.(4096, 'omitted')
      await nextRequest('fourth', 4)
      expect(wireThinking(3)).toEqual({ type: 'enabled', budget_tokens: 4096, display: 'omitted' })

      // 'highlights' is tracked but never reaches the wire.
      await session.setMaxThinkingTokens?.(4096, 'highlights')
      await nextRequest('fifth', 5)
      expect(wireThinking(4)).toEqual({ type: 'enabled', budget_tokens: 4096 })
    } finally {
      await session.destroy()
      streamAnthropicMessagesMock.mockReset()
      streamAnthropicMessagesMock.mockImplementation(originalStreamAnthropicMessages.fn)
      __setConfigForTest(origConfig)
    }
  })

  it('sends effort and fast mode, and follows live applyFlagSettings', async () => {
    const dir = await tempDir('native-effort-')
    const origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
    const requests: Array<Parameters<typeof buildRequestBody>[0]> = []
    streamAnthropicMessagesMock.mockImplementation(async function* (req: Parameters<typeof buildRequestBody>[0]) {
      requests.push(req)
      for (const ev of textTurn('ok')) yield ev
    })
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.capabilities.supportsEffortLevel).toBe(true)
    expect(provider.capabilities.supportsFastMode).toBe(true)
    const session = provider.createSession({
      id: 'effort',
      cwd: dir,
      model: 'claude-opus-4-8',
      effortLevel: 'high',
      fastMode: true,
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    const nextRequest = async (text: string, count: number): Promise<void> => {
      session.enqueueUserMessage(userMsg(text) as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(count))
    }
    const wire = (i: number): { output_config?: unknown; speed?: unknown } =>
      buildRequestBody(requests[i]) as { output_config?: unknown; speed?: unknown }
    try {
      await nextRequest('first', 1)
      expect(wire(0).output_config).toEqual({ effort: 'high' })
      expect(wire(0).speed).toBe('fast')

      // The live field, not the create-time opts value: the NEXT request reads it.
      await session.applyFlagSettings?.({ effortLevel: 'max' })
      await nextRequest('second', 2)
      expect(wire(1).output_config).toEqual({ effort: 'max' })

      // null clears back to the model default (the field is omitted).
      await session.applyFlagSettings?.({ effortLevel: null })
      await nextRequest('third', 3)
      expect(wire(2)).not.toHaveProperty('output_config')

      await session.applyFlagSettings?.({ fastMode: false })
      await nextRequest('fourth', 4)
      expect(wire(3)).not.toHaveProperty('speed')

      await session.applyFlagSettings?.({ fastMode: true })
      await nextRequest('fifth', 5)
      expect(wire(4).speed).toBe('fast')

      // Unsupported keys and invalid values still fail loudly.
      await expect(session.applyFlagSettings?.({ plugins: {} })).rejects.toThrow(/plugins/)
      await expect(session.applyFlagSettings?.({ effortLevel: 'ultra' })).rejects.toThrow(/effort level/)
      // fastMode is boolean-or-null: a coercible non-boolean is a loud failure,
      // not a silent `=== true` conversion.
      await expect(session.applyFlagSettings?.({ fastMode: 'false' })).rejects.toThrow(/fast mode/)
      await expect(session.applyFlagSettings?.({ fastMode: 1 })).rejects.toThrow(/fast mode/)

      // null clears the intent like false does.
      await session.applyFlagSettings?.({ fastMode: null })
      await nextRequest('sixth', 6)
      expect(wire(5)).not.toHaveProperty('speed')
    } finally {
      await session.destroy()
      streamAnthropicMessagesMock.mockReset()
      streamAnthropicMessagesMock.mockImplementation(originalStreamAnthropicMessages.fn)
      __setConfigForTest(origConfig)
    }
  })

  it('keeps the turn-start effort across rounds and applies a change next turn', async () => {
    const dir = await tempDir('native-turn-effort-snapshot-')
    const origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
    const requests: Array<Parameters<typeof buildRequestBody>[0]> = []
    streamAnthropicMessagesMock.mockImplementation(async function* (req: Parameters<typeof buildRequestBody>[0]) {
      requests.push(req)
      if (requests.length === 1) {
        await session.applyFlagSettings?.({ effortLevel: 'low' })
        for (const ev of toolTurn('effort-read')) yield ev
      } else {
        for (const ev of textTurn(`done-${requests.length}`)) yield ev
      }
    })
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({
      id: 'turn-effort-snapshot',
      cwd: process.cwd(),
      model: 'claude-opus-4-8',
      effortLevel: 'high',
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const frame of session.messages) frames.push(frame as Frame) })()
    const wire = (index: number): { output_config?: unknown } =>
      buildRequestBody(requests[index]) as { output_config?: unknown }
    try {
      session.enqueueUserMessage(userMsg('first') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1))
      expect(wire(0).output_config).toEqual({ effort: 'high' })
      expect(wire(1).output_config).toEqual({ effort: 'high' })

      session.enqueueUserMessage(userMsg('second') as never)
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2))
      expect(wire(2).output_config).toEqual({ effort: 'low' })
    } finally {
      await session.destroy()
      streamAnthropicMessagesMock.mockReset()
      streamAnthropicMessagesMock.mockImplementation(originalStreamAnthropicMessages.fn)
      __setConfigForTest(origConfig)
    }
  })

  it('stamps fast_mode_state on the init frame and every result frame', async () => {
    const dir = await tempDir('native-fast-state-')
    const provider = providerWithStreamer([textTurn('a'), textTurn('b')], dir)
    const session = provider.createSession({
      id: 'fast-state',
      cwd: dir,
      model: 'claude-opus-4-8',
      fastMode: true,
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('one') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    // Intent-based, so the chip is correct BEFORE the first turn ends.
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init', fast_mode_state: 'on' })
    expect(frames.filter((f) => f.type === 'result')[0].fast_mode_state).toBe('on')

    await session.applyFlagSettings?.({ fastMode: false })
    session.enqueueUserMessage(userMsg('two') as never)
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(2))
    expect(frames.filter((f) => f.type === 'result')[1].fast_mode_state).toBe('off')
    await session.destroy()
  })

  it('reports supported models in the SDK camelCase shape', async () => {
    const dir = await tempDir('native-models-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({
      id: 'models',
      cwd: dir,
      profile: {
        id: 'p1',
        name: 'Profile 1',
        authToken: 'tok',
        baseUrl: 'https://api.anthropic.com',
        modelList: ['claude-opus-4-8', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
        modelGroups: [],
        recapModel: '',
        commitMessageModel: '',
      },
    })
    expect(await session.supportedModels?.()).toEqual([
      {
        value: 'claude-opus-4-8',
        displayName: 'claude-opus-4-8',
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'claude-sonnet-4-5',
        displayName: 'claude-sonnet-4-5',
        supportsFastMode: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'claude-haiku-3-5',
        displayName: 'claude-haiku-3-5',
        supportsFastMode: false,
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ])
    await session.destroy()
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

  describe('title generation and account info', () => {
    const profile = (recapModel: string) => ({
      id: 'p1',
      name: 'Profile 1',
      authToken: 'tok',
      baseUrl: 'https://api.example.test',
      modelList: [],
      modelGroups: [],
      recapModel,
      commitMessageModel: '',
    })

    const stubAuxFetch = (requests: Array<Record<string, unknown>>, text = 'First title') =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

    it('generateTitle asks the aux caller with profile.recapModel', async () => {
      const dir = await tempDir('native-title-')
      const provider = new NativeProvider({ stateDir: dir })
      expect(provider.capabilities.supportsSessionTitle).toBe(true)
      const session = provider.createSession({
        id: 'title-1',
        cwd: dir,
        model: 'session-model',
        profile: profile('recap-model'),
      })
      const requests: Array<Record<string, unknown>> = []
      stubAuxFetch(requests)
      try {
        await expect(session.generateTitle?.('describe the session')).resolves.toBe('First title')
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          model: 'recap-model',
          max_tokens: 64,
          temperature: 0.3,
          system:
            'Generate a concise session title in the same language as the request. Return only the title, without quotes, a prefix, or trailing punctuation.',
          messages: [{ role: 'user', content: 'describe the session' }],
        })
      } finally {
        await session.destroy()
        vi.unstubAllGlobals()
      }
    })

    it('generateTitle falls back to the CURRENT session model when recapModel is empty', async () => {
      const dir = await tempDir('native-title-model-')
      const provider = new NativeProvider({ stateDir: dir })
      const session = provider.createSession({
        id: 'title-2',
        cwd: dir,
        model: 'm1',
        profile: profile(''),
      })
      const requests: Array<Record<string, unknown>> = []
      stubAuxFetch(requests)
      try {
        // A live switch after construction must reach the title call.
        await session.setModel?.('m2')
        await expect(session.generateTitle?.('describe')).resolves.toBe('First title')
        expect(requests[0].model).toBe('m2')
      } finally {
        await session.destroy()
        vi.unstubAllGlobals()
      }
    })

    it('accountInfo resolves undefined', async () => {
      const dir = await tempDir('native-account-')
      const provider = new NativeProvider({ stateDir: dir })
      expect(provider.capabilities.supportsAccountInfo).toBe(true)
      const session = provider.createSession({ id: 'account-1', cwd: dir })
      try {
        await expect(session.accountInfo?.()).resolves.toBeUndefined()
      } finally {
        await session.destroy()
      }
    })

    it('applyFlagSettings rejects the sandbox flag', async () => {
      const dir = await tempDir('native-sandbox-flag-')
      const provider = new NativeProvider({ stateDir: dir })
      const session = provider.createSession({ id: 'sandbox-flag', cwd: dir })
      try {
        await expect(session.applyFlagSettings?.({ sandbox: { enabled: true } }))
          .rejects.toThrow('native provider does not support flag settings: sandbox')
      } finally {
        await session.destroy()
      }
    })

    it('createSession rejects a sandbox intent with a 501 before opening a log', async () => {
      const dir = await tempDir('native-sandbox-create-')
      const provider = new NativeProvider({ stateDir: dir })
      let caught: unknown
      try {
        provider.createSession({ id: 'sandboxed', cwd: dir, sandbox: { enabled: true } })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(HttpError)
      expect((caught as HttpError).status).toBe(501)
      expect((caught as Error).message).toBe('provider native does not support sandbox')
      // Rejected before the session log was opened.
      expect(loadNativeSessionLogSync(dir, 'sandboxed')).toBeNull()
    })
  })
})