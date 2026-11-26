// server/providers/native/e2e-structured.test.ts
//
// End-to-end proof of G2 Task 2 through SessionManager: an Agent/Task call with
// `outputSchema` attaches the terminal StructuredOutput runtime to the nested
// run, and the captured value reaches the PARENT as the Agent tool_result.
// Native ToolOutcome is {text, content?, isError?} — there is no `structured`
// field — so the projection is the captured value serialized as the tool-result
// text (JSON), exactly what the parent continuation reads. These tests assert
// that real projection (JSON.parse of the parent's tool_result), never a
// literal `.structured` property.
//
// Fixture shape copied from e2e-plan-mode.test.ts (temp-dir SessionStore +
// custom ProviderRegistry + scripted `_testStream`). Nested (subagent) rounds
// ride the same scripted seam, so their tools/system/tool_results are captured
// too. Network is never touched: the scripted stream bypasses defaultStream and
// auto-title only fires from the HTTP route (never a direct sm.send), so no
// fetch/DNS stub is needed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigForTest, config } from '../../config.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { STRUCTURED_OUTPUT_GUIDANCE } from './structured.js'
import type { CanonicalEvent } from './canonical.js'

const TEST_PROFILE = {
  id: 'e2e-structured',
  name: 'E2E Structured',
  authToken: 'profile-token',
  baseUrl: 'https://api.example.test',
  modelList: ['test-model'],
  recapModel: '',
  commitMessageModel: '',
}

/** The caller's output contract: a supported object schema with one required
 *  string property. */
const RESULT_SCHEMA = {
  type: 'object',
  properties: { result: { type: 'string' } },
  required: ['result'],
}

type Frame = Record<string, any>

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, inputJson = '{}'): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** `canUseTool` that allows every request, so a nested tool case never parks in
 *  the broker. The terminal-guard test relies on this: with every permission
 *  allowed, ONLY the structured guard can deny a post-capture call. */
function allowingCanUseTool(): ToolPermission {
  const handler = async (
    _name: string,
    input: Record<string, unknown>,
  ) => ({ behavior: 'allow' as const, updatedInput: input })
  return handler as unknown as ToolPermission
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

let root: string
let configDir: string
let previousConfigDir: string | undefined
const origConfig = { ...config }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sm-native-structured-e2e-'))
  configDir = join(root, 'config')
  await mkdir(join(configDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  __setConfigForTest({
    profiles: [TEST_PROFILE],
    activeProfileId: TEST_PROFILE.id,
    authToken: 'structured-global-token',
    baseUrl: TEST_PROFILE.baseUrl,
  })
})

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  __setConfigForTest(origConfig)
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding a temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

interface Fixture {
  sm: SessionManager
  store: SessionStore
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

async function makeEnv(): Promise<{ project: string; stateDir: string }> {
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(project, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  dirs.push(root)
  return { project, stateDir }
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
    // Snapshot the request: `req.messages` is the live history array, so a
    // captured reference would show the FINAL transcript instead of what this
    // round actually sent. Nested (subagent) rounds ride this same seam.
    requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, store, requests, scripts }
}

async function createAllowedSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'structured-e2e',
    canUseTool: allowingCanUseTool(),
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function collectFrames(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

/** Send one turn and wait for its (and only its) result frame. */
async function sendAndWait(
  fx: Fixture,
  id: string,
  frames: Frame[],
  text: string,
  expectedResults: number,
): Promise<void> {
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(expectedResults)
  }, { timeout: 5000 })
}

interface CapturedToolResult {
  tool_use_id: string
  text: string
  is_error: boolean
}

/** Every tool_result block across a request's messages, in order (the wire
 *  projection groups them into user messages). */
function toolResultsOf(request: StreamRequest): CapturedToolResult[] {
  const out: CapturedToolResult[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue
      const content = Array.isArray(block.content)
        ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
        : ''
      out.push({
        tool_use_id: String(block.tool_use_id),
        text: content,
        is_error: block.is_error === true,
      })
    }
  }
  return out
}

function toolResultOf(request: StreamRequest, id: string): CapturedToolResult {
  const result = toolResultsOf(request).find((r) => r.tool_use_id === id)
  if (!result) throw new Error(`no tool_result for ${id}`)
  return result
}

/** The tool_result for a call id, scanned across every captured round (the
 *  result lands in the round AFTER the call, so the index is not fixed). */
function toolResultAcross(requests: StreamRequest[], id: string): CapturedToolResult {
  for (const req of requests) {
    const found = toolResultsOf(req).find((r) => r.tool_use_id === id)
    if (found) return found
  }
  throw new Error(`no tool_result for ${id}`)
}

/** The Agent tool_result the PARENT continuation reads, with its captured
 *  structured value parsed from the projection text. */
function parentAgentResult(requests: StreamRequest[], id: string): {
  result: CapturedToolResult
  value: unknown
} {
  const result = toolResultAcross(requests, id)
  return { result, value: JSON.parse(result.text) }
}

describe('native Agent/Task outputSchema end to end through SessionManager', () => {
  it('returns the captured structured value to the parent as the Agent tool_result', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // Main round 1 launches the subagent with an outputSchema; the nested run
    // calls StructuredOutput then settles; main round 2 reads the Agent result.
    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p', outputSchema: RESULT_SCHEMA })),
      toolUseTurn('s1', 'StructuredOutput', JSON.stringify({ result: 'done' })),
      textTurn('structured report'),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    // The nested surface carries the terminal tool and the finish demand reads
    // LAST in the system prompt (after the instruction), independent of any MCP
    // guidance ordering.
    expect(fx.requests[1].tools.map((t) => t.name)).toContain('StructuredOutput')
    expect(fx.requests[1].system).toContain(STRUCTURED_OUTPUT_GUIDANCE)
    expect(fx.requests[1].system.endsWith(STRUCTURED_OUTPUT_GUIDANCE)).toBe(true)

    // The capture committed as a non-error nested tool_result.
    expect(toolResultOf(fx.requests[2], 's1').is_error).toBe(false)

    // THE projection: the parent's Agent tool_result IS the captured value.
    const { result, value } = parentAgentResult(fx.requests, 'a1')
    expect(result.is_error).toBe(false)
    expect(value).toEqual({ result: 'done' })
    unsubscribe()
  })

  it('keeps the text-report behavior when no outputSchema is given', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p' })),
      textTurn('nested report'),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    // No terminal tool, no finish demand: the nested surface is unchanged.
    expect(fx.requests[1].tools.map((t) => t.name)).not.toContain('StructuredOutput')
    expect(fx.requests[1].system).not.toContain(STRUCTURED_OUTPUT_GUIDANCE)

    // The parent reads the last assistant text verbatim (not a JSON value).
    const result = toolResultOf(fx.requests[2], 'a1')
    expect(result.is_error).toBe(false)
    expect(result.text).toBe('nested report')
    unsubscribe()
  })

  it('retries a StructuredOutput arg violation within the nested turn', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // Nested round 1 violates the schema (result:123); round 2 corrects it.
    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p', outputSchema: RESULT_SCHEMA })),
      toolUseTurn('s1', 'StructuredOutput', JSON.stringify({ result: 123 })),
      toolUseTurn('s2', 'StructuredOutput', JSON.stringify({ result: 'ok' })),
      textTurn('corrected'),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    // The violation is a retryable error result naming the mismatch.
    const violation = toolResultOf(fx.requests[2], 's1')
    expect(violation.is_error).toBe(true)
    expect(violation.text).toContain('do not match the parameter schema')
    expect(violation.text).toContain('expected string, got number')
    // The corrected call commits.
    expect(toolResultOf(fx.requests[3], 's2').is_error).toBe(false)

    // The parent receives the CORRECTED captured value.
    const { result, value } = parentAgentResult(fx.requests, 'a1')
    expect(result.is_error).toBe(false)
    expect(value).toEqual({ result: 'ok' })
    unsubscribe()
  })

  it('denies post-capture tool calls and preserves the first capture', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // After the capture, the nested run tries a mutating Bash call and a second
    // StructuredOutput. With every permission allowed, ONLY the terminal guard
    // can deny them — and the Bash body must never run (no file created).
    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p', outputSchema: RESULT_SCHEMA })),
      toolUseTurn('s1', 'StructuredOutput', JSON.stringify({ result: 'done' })),
      toolUseTurn('b1', 'Bash', JSON.stringify({ command: 'echo guard-broken > guard.txt' })),
      toolUseTurn('s2', 'StructuredOutput', JSON.stringify({ result: 'second' })),
      textTurn('after guard'),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    const bash = toolResultAcross(fx.requests, 'b1')
    expect(bash.is_error).toBe(true)
    expect(bash.text).toContain('Structured output already recorded')
    expect(existsSync(join(project, 'guard.txt'))).toBe(false)

    // A second capture cannot reopen the run.
    expect(toolResultAcross(fx.requests, 's2').is_error).toBe(true)

    // The parent still reads the FIRST captured value.
    const { result, value } = parentAgentResult(fx.requests, 'a1')
    expect(result.is_error).toBe(false)
    expect(value).toEqual({ result: 'done' })
    unsubscribe()
  })

  it('fails the Agent result when the nested run ends without a capture', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // The subagent ignores the finish demand and answers in plain text.
    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p', outputSchema: RESULT_SCHEMA })),
      textTurn('just a plain text answer'),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    // No-capture is a failure (not a silent text success); the partial report
    // still rides along so the parent sees what the subagent said.
    const result = toolResultAcross(fx.requests, 'a1')
    expect(result.is_error).toBe(true)
    expect(result.text).toContain('without calling StructuredOutput')
    expect(result.text).toContain('just a plain text answer')
    unsubscribe()
  })

  it('surfaces an unsupported outputSchema as a loud error before any nested run', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // `anyOf` is outside the supported subset: attach throws, the Agent call
    // returns an error result naming the construct, and NO nested round runs.
    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({
        description: 'd',
        prompt: 'p',
        outputSchema: { type: 'object', properties: { x: { anyOf: [{ type: 'string' }] } } },
      })),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    expect(fx.requests).toHaveLength(2) // main round 1 + main round 2, no nested round
    const result = toolResultOf(fx.requests[1], 'a1')
    expect(result.is_error).toBe(true)
    expect(result.text).toContain('Unsupported structured-output schema')
    expect(result.text).toContain('anyOf')
    unsubscribe()
  })

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['an array', [{ type: 'string' }]],
  ])('rejects a malformed non-object outputSchema (%s) loudly', async (_label, schema) => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p', outputSchema: schema })),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)

    expect(fx.requests).toHaveLength(2)
    const result = toolResultOf(fx.requests[1], 'a1')
    expect(result.is_error).toBe(true)
    expect(result.text).toContain('schema must be an object')
    unsubscribe()
  })
})
