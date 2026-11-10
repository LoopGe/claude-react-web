// server/providers/native/e2e-mcp.test.ts
//
// End-to-end proof of P1.2 through SessionManager: a native session created
// through the manager's real spawn path (first-party `injectAll` included)
// exposes the in-process git-tools server AND user-supplied MCP servers to the
// model, routes their calls, honours permission decisions, and applies
// replace / toggle mutations on the next turn. Fixture shape copied from
// e2e.test.ts (temp-dir SessionStore + custom ProviderRegistry + scripted
// `_testStream`); the tool-call scripting mirrors native-session.test.ts's MCP
// test. The temp dir is a real git repo so the first-party git-tools server
// has a working tree to report on.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'

const execFileAsync = promisify(execFile)

const GIT_STATUS_FQN = 'mcp__git-tools__git_status'
const ECHO_FQN = 'mcp__a__echo'

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

/** A real in-process MCP server with one `echo` tool — the same fixture the
 *  connection manager's and provider's own tests use. */
function echoServer(name = 'echo-server'): McpServer {
  const server = new McpServer({ name, version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo the given text back.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  return server
}

type Frame = Record<string, any>

interface StreamRequest {
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

interface CapturedToolResult {
  tool_use_id: string
  text: string
  is_error: boolean
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>
interface SeenPermission {
  name: string
  options: Record<string, unknown>
}

/** `canUseTool` that records every request and allows it. The default
 *  permission mode keeps the request flowing (a bypass session would skip the
 *  handler entirely). */
function allowingCanUseTool(seen: SeenPermission[]): ToolPermission {
  const handler = async (
    name: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    seen.push({ name, options })
    return { behavior: 'allow' as const, updatedInput: input }
  }
  return handler as unknown as ToolPermission
}

function denyingCanUseTool(message: string): ToolPermission {
  const handler = async () => ({ behavior: 'deny' as const, message })
  return handler as unknown as ToolPermission
}

/** Every tool_result block across a request's messages, in order. Tool results
 *  are the `user` message the turn loop pushes before the follow-up round. */
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

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding the temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

/** A session cwd that is a real git work tree, plus a SEPARATE temp state dir
 *  — the production layout (`~/.claude-react-web` vs. the project repo).
 *  Keeping the state dir outside the work tree also keeps the snapshot
 *  sidecar's shadow repo out of the tree it captures. */
async function makeEnv(): Promise<{ cwd: string; stateDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'sm-native-mcp-e2e-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'sm-native-mcp-state-'))
  dirs.push(cwd, stateDir)
  await execFileAsync('git', ['init', '--quiet'], { cwd })
  return { cwd, stateDir }
}

interface Fixture {
  sm: SessionManager
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
    tools: Array<{ name: string }>
    messages: Array<{ role: string; content: unknown }>
  }) {
    // Snapshot the request: `req.messages` is the session's live history array,
    // mutated by later rounds, so a captured reference would show the FINAL
    // transcript instead of what this request actually sent.
    requests.push({ tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, requests, scripts }
}

async function createSession(
  fx: Fixture,
  cwd: string,
  opts: { mcpServers?: Record<string, unknown>; canUseTool: ToolPermission },
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'mcp-e2e',
    ...(opts.mcpServers
      ? { mcpServers: opts.mcpServers as unknown as CreateOptions['mcpServers'] }
      : {}),
    canUseTool: opts.canUseTool,
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

function toolNames(request: StreamRequest): string[] {
  return request.tools.map((t) => t.name)
}

describe('native MCP end to end through SessionManager', () => {
  it('exposes the first-party git-tools server and routes its call', async () => {
    const { cwd, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    fx.scripts.push(toolUseTurn('g1', GIT_STATUS_FQN), textTurn('status reported'))
    const seen: SeenPermission[] = []
    const id = await createSession(fx, cwd, { canUseTool: allowingCanUseTool(seen) })
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    await sendAndWait(fx, id, frames, 'check the status', 1)
    unsubscribe()

    // The manager's spawn-time first-party injection reaches the model.
    expect(toolNames(fx.requests[0])).toContain(GIT_STATUS_FQN)
    // The permission request carries the server OWNED by the FQN, resolved
    // from discovery metadata (never parsed back out of the name).
    const permission = seen.find((s) => s.name === GIT_STATUS_FQN)
    expect(permission?.options).toMatchObject({
      mcpServer: { name: 'git-tools', source: 'sdk' },
    })
    // The follow-up round carries the real git status output as a tool_result.
    const gitResults = fx.requests.slice(1).flatMap(toolResultsOf).filter((r) => r.tool_use_id === 'g1')
    expect(gitResults).toHaveLength(1)
    expect(gitResults[0].is_error).toBe(false)
    expect(gitResults[0].text).toContain('branch')
    expect(frames.some((f) => f.type === 'result' && f.result === 'status reported')).toBe(true)
  })

  it('connects an external in-memory MCP server, calls it, and reports both in status', async () => {
    const { cwd, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    fx.scripts.push(
      toolUseTurn('e1', ECHO_FQN, JSON.stringify({ text: 'hi from mcp' })),
      textTurn('echoed'),
    )
    const seen: SeenPermission[] = []
    const id = await createSession(fx, cwd, {
      mcpServers: { a: { type: 'sdk', name: 'a', instance: echoServer() } },
      canUseTool: allowingCanUseTool(seen),
    })
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    await sendAndWait(fx, id, frames, 'echo something', 1)
    unsubscribe()

    // The user-supplied server's tool is advertised alongside the first-party
    // one in the very first request.
    expect(toolNames(fx.requests[0])).toContain(ECHO_FQN)
    expect(toolNames(fx.requests[0])).toContain(GIT_STATUS_FQN)
    const echoResults = toolResultsOf(fx.requests[1]).filter((r) => r.tool_use_id === 'e1')
    expect(echoResults).toEqual([{ tool_use_id: 'e1', text: 'hi from mcp', is_error: false }])
    // Both servers surface as `sdk` session-scoped entries with their tools,
    // and nothing secret leaks into the status payload.
    const statuses = (await fx.sm.mcpServerStatus(id)) as Array<Record<string, unknown>>
    expect(statuses.map((s) => s.name).sort()).toEqual(['a', 'git-tools'])
    for (const status of statuses) {
      expect(status).toMatchObject({ status: 'connected', source: 'sdk', scope: 'session' })
      expect(Array.isArray(status.tools)).toBe(true)
    }
    expect(
      (statuses.find((s) => s.name === 'a')!.tools as Array<{ name: string }>).map((t) => t.name),
    ).toEqual(['echo'])
    expect(
      (statuses.find((s) => s.name === 'git-tools')!.tools as Array<{ name: string }>).map((t) => t.name),
    ).toContain('git_status')
    expect(JSON.stringify(statuses)).not.toMatch(/"env"|"headers"/)
  })

  it('returns an error result for a denied call and keeps the turn going', async () => {
    const { cwd, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    fx.scripts.push(toolUseTurn('d1', GIT_STATUS_FQN), textTurn('denial acknowledged'))
    const id = await createSession(fx, cwd, {
      canUseTool: denyingCanUseTool('denied by test'),
    })
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    await sendAndWait(fx, id, frames, 'try a denied tool', 1)
    unsubscribe()

    const denied = toolResultsOf(fx.requests[1]).filter((r) => r.tool_use_id === 'd1')
    expect(denied).toEqual([{ tool_use_id: 'd1', text: 'denied by test', is_error: true }])
    // The model's follow-up round still ran with the error result.
    expect(fx.requests).toHaveLength(2)
    expect(frames.some((f) => f.type === 'result' && f.result === 'denial acknowledged')).toBe(true)
  })

  it('applies dynamic-server replace and first-party toggles on the next turn', async () => {
    const { cwd, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    fx.scripts.push(
      toolUseTurn('e1', ECHO_FQN, JSON.stringify({ text: 'hi' })),
      textTurn('first'),
      textTurn('after replace'),
      textTurn('after disable'),
      textTurn('after enable'),
    )
    const id = await createSession(fx, cwd, {
      mcpServers: { a: { type: 'sdk', name: 'a', instance: echoServer() } },
      canUseTool: allowingCanUseTool([]),
    })
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    await sendAndWait(fx, id, frames, 'echo', 1)
    expect(toolNames(fx.requests[0])).toContain(ECHO_FQN)
    expect(toolNames(fx.requests[0])).toContain(GIT_STATUS_FQN)

    // Replace semantics: the external server is dropped, the first-party
    // server is re-injected by the manager on the same call.
    await fx.sm.setMcpServers(id, {})
    await sendAndWait(fx, id, frames, 'after replace', 2)
    expect(toolNames(fx.requests[2])).not.toContain(ECHO_FQN)
    expect(toolNames(fx.requests[2])).toContain(GIT_STATUS_FQN)

    // First-party off: the tool disappears from the next turn's request.
    await fx.sm.setFirstPartyTool(id, 'git-tools', false)
    await sendAndWait(fx, id, frames, 'after disable', 3)
    expect(toolNames(fx.requests[3])).not.toContain(GIT_STATUS_FQN)

    // Re-enable: the next turn advertises it again.
    await fx.sm.setFirstPartyTool(id, 'git-tools', true)
    await sendAndWait(fx, id, frames, 'after enable', 4)
    expect(toolNames(fx.requests[4])).toContain(GIT_STATUS_FQN)

    unsubscribe()
  })
})