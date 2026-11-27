// Native Claude-plugin parity end to end through the real SessionManager,
// PermissionBroker, MpStore, host plugin-contribution loader and NativeProvider.
// Only the Anthropic stream is scripted (`_testStream` plays canonical rounds at
// the API boundary); plugin discovery, the marketplace store, the permission
// flow, the hook engine and the MCP connections are all the production paths.
//
// A committed fixture plugin (fixtures/plugin-parity/) carries the four static
// contribution types — a command, an agent, a skill and a hooks.json matcher
// pair. The test copies it into a temp marketplace clone and writes the fifth
// (a .mcp.json stdio server) per run, because the stdio fixture path and its
// bye-marker are temp-dir absolute. The same enabled set the claude path injects
// (MpStore.getEnabledPluginAbsolutePathsFor) is asserted to resolve the same dir
// the native loader scanned — one marketplace, one resolution, both providers.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AgentDefinitionStore } from '../../agent-definition-store.js'
import { MpStore } from '../../mp-store.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { applyPluginToggleToLiveSessions } from '../../mp-ops.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import type { CanonicalEvent } from './canonical.js'

const FIXTURE_PLUGIN = fileURLToPath(new URL('./fixtures/plugin-parity', import.meta.url))
const stdioFixturePath = fileURLToPath(new URL('./mcp/fixtures/stdio-server.mjs', import.meta.url))
const PLUGIN_KEY = MpStore.keyOf('parity', 'mp-parity')
const COMMAND_ROW = 'parity:about'
const SKILL_ROW = 'parity:helper'
const AGENT_ROW = 'parity:reviewer'
const PLUG_ECHO_FQN = 'mcp__plug__echo'
const USER_ECHO_FQN = 'mcp__user__echo'

type Frame = Record<string, any>
type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

interface Fixture {
  sm: SessionManager
  provider: NativeProvider
  mpStore: MpStore
  pluginDir: string
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
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
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor probe
  // still holding the temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
}, 20000)

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** A real in-process MCP server with one `echo` tool — the user-driven dynamic
 *  server the durability half adds and removes. */
function echoServer(): McpServer {
  const server = new McpServer({ name: 'user-echo', version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo the given text back.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  return server
}

function allowingCanUseTool(): ToolPermission {
  const handler = async (_name: string, input: Record<string, unknown>) =>
    ({ behavior: 'allow' as const, updatedInput: input })
  return handler as unknown as ToolPermission
}

/** Copy the committed fixture plugin into a temp marketplace clone and seed a
 *  real MpStore with one in-repo plugin entry. `enabled` sets the initial global
 *  flag (the pinned-session tests start disabled and enable mid-test). The
 *  per-run .mcp.json carries the stdio echo fixture with a bye-marker in the
 *  state dir. */
async function makeEnv(opts: { enabled?: boolean } = {}): Promise<{ cwd: string; stateDir: string; pluginDir: string; mpStore: MpStore }> {
  const root = await mkdtemp(join(tmpdir(), 'sm-native-plugin-parity-'))
  dirs.push(root)
  const cwd = join(root, 'project')
  const stateDir = join(root, 'state')
  const pluginDir = join(root, 'mp-clone', 'plugins', 'parity')
  await mkdir(cwd, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await cp(FIXTURE_PLUGIN, pluginDir, { recursive: true })
  const byePath = join(stateDir, 'bye-plug.txt')
  await writeFile(join(pluginDir, '.mcp.json'), JSON.stringify({
    mcpServers: { plug: { type: 'stdio', command: 'node', args: [stdioFixturePath, byePath] } },
  }), 'utf8')

  const mpStore = new MpStore({ stateDir })
  await mpStore.load()
  mpStore.upsert({
    id: 'mp-parity',
    displayName: 'mp-parity',
    source: { type: 'https', url: 'https://example.com/mp-parity.git' },
    cloneDir: join(root, 'mp-clone'),
    addedAt: 1, lastRefreshedAt: 1, lastSha: 'a'.repeat(40),
    manifest: { name: 'mp-parity', plugins: [{ name: 'parity', dir: pluginDir }] },
  })
  mpStore.setEnabled('parity', 'mp-parity', opts.enabled ?? true)
  await mpStore.flush()
  return { cwd, stateDir, pluginDir, mpStore }
}

async function makeFixture(stateDir: string, mpStore: MpStore, pluginDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const agentStore = new AgentDefinitionStore({ stateDir })
  await agentStore.load()
  const provider = new NativeProvider({ stateDir, agentStore, ports: makeNativePorts({ stateDir, mpStore }) })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  provider._testStream = async function* (req: { system: string; tools: unknown[]; messages: unknown[] }) {
    // Snapshot the request: `req.messages` is the session's live history array,
    // mutated by later rounds, so a captured reference would show the FINAL
    // transcript instead of what this request actually sent.
    requests.push({
      system: req.system,
      tools: [...req.tools] as Array<{ name: string }>,
      messages: structuredClone(req.messages) as Array<{ role: string; content: unknown }>,
    })
    const script = scripts.shift()
    if (!script) throw new Error('unexpected native stream request: no scripted round queued')
    for (const event of script) yield event
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry, mpStore, agentStore })
  managers.push(sm)
  return { sm, provider, mpStore, pluginDir, requests, scripts }
}

async function createSession(fx: Fixture, cwd: string, extra: Partial<CreateOptions> = {}): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'plugin-parity-e2e',
    canUseTool: allowingCanUseTool(),
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function collect(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const frame of sub.iterable) frames.push(frame as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

async function sendAndWait(fx: Fixture, id: string, frames: Frame[], text: string): Promise<Frame> {
  const resultCount = frames.filter((frame) => frame.type === 'result').length
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((frame) => frame.type === 'result').length).toBe(resultCount + 1)
  }, { timeout: 8000 })
  return frames.filter((frame) => frame.type === 'result').at(-1)!
}

function commandNames(sm: SessionManager, id: string): Promise<string[]> {
  return (sm.supportedCommands(id) as Promise<Array<{ name: string }>>).then((rows) => rows.map((r) => r.name))
}

function agentNames(sm: SessionManager, id: string): Promise<string[]> {
  return (sm.supportedAgents(id) as Promise<Array<{ name: string }>>).then((rows) => rows.map((r) => r.name))
}

function toolNames(request: StreamRequest): string[] {
  return request.tools.map((t) => t.name)
}

/** The last user message's joined text in a request (the expansion target). */
function lastUserText(request: StreamRequest): string {
  const last = request.messages.at(-1)!
  const content = last.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Frame[]).filter((b) => b?.type === 'text').map((b) => b.text as string).join('\n')
}

/** Every tool_result block across a request's messages, narrowed to one id. */
function toolResultOf(request: StreamRequest, toolUseId: string): { text: string; isError: boolean } | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Frame[]) {
      if (block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue
      return {
        text: Array.isArray(block.content) ? block.content.map((p: Frame) => p.text ?? '').join('\n') : String(block.content ?? ''),
        isError: block.is_error === true,
      }
    }
  }
  return undefined
}

async function waitConnected(fx: Fixture, id: string, name: string): Promise<void> {
  await vi.waitFor(async () => {
    const statuses = (await fx.sm.mcpServerStatus(id)) as Array<{ name: string; status: string }>
    expect(statuses.find((s) => s.name === name)?.status).toBe('connected')
  }, { timeout: 8000 })
}

describe('native Claude-plugin parity end to end through SessionManager', () => {
  it('resolves all five contribution types from one enabled plugin and keeps its MCP server across user-driven replaces', async () => {
    const { cwd, stateDir, pluginDir, mpStore } = await makeEnv()
    const fx = await makeFixture(stateDir, mpStore, pluginDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)

    // The same enabled set the claude path injects resolves the dir the native
    // loader scanned — one marketplace resolution feeds both providers.
    expect(mpStore.getEnabledPluginAbsolutePathsFor([PLUGIN_KEY])).toEqual([pluginDir])

    // Command + skill rows in the slash catalog; agent in the merged lookup.
    expect(await commandNames(fx.sm, id)).toContain(COMMAND_ROW)
    expect(await commandNames(fx.sm, id)).toContain(SKILL_ROW)
    expect(await agentNames(fx.sm, id)).toContain(AGENT_ROW)

    // The plugin SessionStart hook fired at init (the spawn awaits plugin
    // discovery before firing SessionStart), writing its marker into the cwd.
    await vi.waitFor(() => expect(existsSync(join(cwd, 'session-start-marker.txt'))).toBe(true), { timeout: 8000 })

    // The plugin MCP server connects through the real stdio transport.
    await waitConnected(fx, id, 'plug')

    // 1. Plugin command invocable: the slash expands the command body + args.
    fx.scripts.push(textTurn('COMMAND DONE'))
    await sendAndWait(fx, id, seen.frames, '/parity:about hello')
    const cmdText = lastUserText(fx.requests[0])
    expect(cmdText).toContain('PLUGIN-COMMAND-BODY')
    expect(cmdText).toContain('ARGUMENTS: hello')
    expect(cmdText).not.toContain('description:')

    // 2. Plugin skill invocable: the canonical base-dir body + args.
    fx.scripts.push(textTurn('SKILL DONE'))
    await sendAndWait(fx, id, seen.frames, '/parity:helper world')
    const skillText = lastUserText(fx.requests[1])
    expect(skillText).toContain('Base directory for this skill:')
    expect(skillText).toContain('PLUGIN-SKILL-BODY')
    expect(skillText).toContain('ARGUMENTS: world')

    // 3. Plugin agent resolves via an Agent call: the nested request's system
    //    carries the plugin agent prompt, and its report returns to the parent.
    fx.scripts.push(
      toolUseTurn('agent1', 'Agent', { description: 'review', prompt: 'REVIEW THIS', subagent_type: AGENT_ROW }),
      textTurn('CHILD DONE'),
      textTurn('PARENT DONE'),
    )
    await sendAndWait(fx, id, seen.frames, 'delegate to the plugin reviewer')
    const nested = fx.requests.find((r) => !toolNames(r).includes('Agent'))!
    expect(nested.system).toContain('PLUGIN-AGENT-PROMPT')
    expect(toolResultOf(fx.requests[4], 'agent1')?.text).toContain('CHILD DONE')

    // 4. Plugin hook fires on its event: the PreToolUse Bash matcher blocks the
    //    scripted Bash call before it runs, surfacing the block reason.
    fx.scripts.push(
      toolUseTurn('bash1', 'Bash', { command: 'ls' }),
      textTurn('BLOCK ACK'),
    )
    await sendAndWait(fx, id, seen.frames, 'run a blocked command')
    const blocked = toolResultOf(fx.requests[6], 'bash1')!
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('plugin-block')

    // 5. Plugin MCP server routes a real call through the stdio child.
    fx.scripts.push(
      toolUseTurn('e1', PLUG_ECHO_FQN, { text: 'hi plugin' }),
      textTurn('ECHOED'),
    )
    await sendAndWait(fx, id, seen.frames, 'echo through the plugin server')
    expect(toolResultOf(fx.requests[8], 'e1')).toEqual({ text: 'hi plugin', isError: false })

    // Durability: a user-driven replace keeps the plugin server. The dynamic
    // user server is added alongside it; the plugin half is re-composed, not
    // dropped by the wholesale replace.
    await fx.sm.setMcpServers(id, { user: { type: 'sdk', name: 'user', instance: echoServer() } } as Record<string, unknown>)
    fx.scripts.push(textTurn('AFTER REPLACE'))
    await sendAndWait(fx, id, seen.frames, 'after replace')
    expect(toolNames(fx.requests[9])).toContain(PLUG_ECHO_FQN)
    expect(toolNames(fx.requests[9])).toContain(USER_ECHO_FQN)

    // Clearing the user set still keeps the plugin server.
    await fx.sm.setMcpServers(id, {})
    fx.scripts.push(textTurn('AFTER CLEAR'))
    await sendAndWait(fx, id, seen.frames, 'after clear')
    expect(toolNames(fx.requests[10])).toContain(PLUG_ECHO_FQN)
    expect(toolNames(fx.requests[10])).not.toContain(USER_ECHO_FQN)

    seen.unsubscribe()
  }, 30000)

  it('a per-session plugin toggle refreshes the picker live (commands-changed) and revokes/restores all five types', async () => {
    const { cwd, stateDir, pluginDir, mpStore } = await makeEnv()
    const fx = await makeFixture(stateDir, mpStore, pluginDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    await waitConnected(fx, id, 'plug')
    expect(await commandNames(fx.sm, id)).toContain(COMMAND_ROW)

    // The broadcast channel an open `/` picker listens on.
    const changes: Frame[] = []
    const sub = fx.sm.subscribeCommandChanges(id)!
    void (async () => {
      for await (const change of sub.iterable) changes.push(change as Frame)
    })()

    // Disable: the toggle itself emits the refresh (native has no CLI push),
    // and every contribution type revokes through the shared commit.
    const beforeDisable = changes.length
    await fx.sm.togglePlugin(id, PLUGIN_KEY, false, { materialize: true })
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(beforeDisable), { timeout: 8000 })
    expect((changes.at(-1) as { commands: Array<{ name: string }> }).commands.map((c) => c.name)).not.toContain(COMMAND_ROW)
    expect(await commandNames(fx.sm, id)).not.toContain(COMMAND_ROW)
    expect(await commandNames(fx.sm, id)).not.toContain(SKILL_ROW)
    expect(await agentNames(fx.sm, id)).not.toContain(AGENT_ROW)
    const offStatuses = (await fx.sm.mcpServerStatus(id)) as Array<{ name: string }>
    expect(offStatuses.map((s) => s.name)).not.toContain('plug')

    // Re-enable: the picker refreshes again and the surface returns.
    const beforeEnable = changes.length
    await fx.sm.togglePlugin(id, PLUGIN_KEY, true, { materialize: true })
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(beforeEnable), { timeout: 8000 })
    expect((changes.at(-1) as { commands: Array<{ name: string }> }).commands.map((c) => c.name)).toContain(COMMAND_ROW)
    expect(await commandNames(fx.sm, id)).toContain(COMMAND_ROW)
    expect(await agentNames(fx.sm, id)).toContain(AGENT_ROW)
    await waitConnected(fx, id, 'plug')

    sub.unsubscribe()
    seen.unsubscribe()
  }, 30000)

  it('a global enable reaches a PINNED native session live (claude parity) without rewriting its spawn pin', async () => {
    // Start globally disabled; the session pins an empty subset at spawn.
    const { cwd, stateDir, pluginDir, mpStore } = await makeEnv({ enabled: false })
    const fx = await makeFixture(stateDir, mpStore, pluginDir)
    const id = await createSession(fx, cwd, { enabledPlugins: [] } as Partial<CreateOptions>)
    const seen = collect(fx.sm, id)
    expect(await commandNames(fx.sm, id)).not.toContain(COMMAND_ROW)
    expect(fx.sm.get(id)?.enabledPlugins).toEqual([])

    // Global enable + ripple. The delta reaches the pinned session live (the
    // claude path forwards the same delta regardless of pin); the persisted
    // spawn pin stays [] — the live-only delta is transient until respawn.
    mpStore.setEnabled('parity', 'mp-parity', true)
    await mpStore.flush()
    await applyPluginToggleToLiveSessions(fx.sm, PLUGIN_KEY, true)
    expect(await commandNames(fx.sm, id)).toContain(COMMAND_ROW)
    expect(await agentNames(fx.sm, id)).toContain(AGENT_ROW)
    await waitConnected(fx, id, 'plug')
    expect(fx.sm.get(id)?.enabledPlugins).toEqual([])

    // Global disable revokes again on the pinned session.
    mpStore.setEnabled('parity', 'mp-parity', false)
    await mpStore.flush()
    await applyPluginToggleToLiveSessions(fx.sm, PLUGIN_KEY, false)
    expect(await commandNames(fx.sm, id)).not.toContain(COMMAND_ROW)

    seen.unsubscribe()
  }, 30000)

  it('a global enable reaches an UNPINNED native session and leaves it following the global set', async () => {
    const { cwd, stateDir, pluginDir, mpStore } = await makeEnv({ enabled: false })
    const fx = await makeFixture(stateDir, mpStore, pluginDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    expect(await commandNames(fx.sm, id)).not.toContain(COMMAND_ROW)
    expect(fx.sm.get(id)?.enabledPlugins).toBeUndefined()

    mpStore.setEnabled('parity', 'mp-parity', true)
    await mpStore.flush()
    await applyPluginToggleToLiveSessions(fx.sm, PLUGIN_KEY, true)
    expect(await commandNames(fx.sm, id)).toContain(COMMAND_ROW)
    // The no-op delta guard keeps an unpinned session unpinned.
    expect(fx.sm.get(id)?.enabledPlugins).toBeUndefined()

    seen.unsubscribe()
  }, 30000)
})
