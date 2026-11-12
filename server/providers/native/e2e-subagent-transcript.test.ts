// Stage B acceptance through the real manager, provider registry, native log,
// permission broker, REST router, provider-neutral transcript source and WS
// SessionConnection. Only Anthropic model rounds are scripted; no provider,
// route, log, permission or transcript component is replaced by a fixture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AgentDefinitionStore, type StoredAgentDefinition } from '../../agent-definition-store.js'
import type { NativeAgentProfile } from './agent-profile.js'
import { SessionConnection, type FrameSink } from '../../frame-bridge.js'
import { SessionStore, type SessionMeta } from '../../persistence.js'
import { buildApiRouter } from '../../routes/index.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderSubagentTranscriptHub } from '../../subagent-transcript-source.js'
import { SubagentTranscriptHub } from '../../subagent-transcript-hub.js'
import type { WsServerFrame } from '../../ws-protocol.js'
import { ClaudeProvider } from '../claude/claude-provider.js'
import { ProviderRegistry } from '../registry.js'
import type { ProviderSessionHandle } from '../types.js'
import type { CanonicalEvent } from './canonical.js'
import { NativeProvider } from './native-provider.js'
import { nativeHistoryCache } from './session-log/cache.js'
import type { NativeEventInput } from './session-log/format.js'
import { loadNativeSessionLogSync, NativeSessionLog } from './session-log/log.js'
import { NativeSubagentTranscriptSource } from './subagent-transcript-source.js'

type Frame = Record<string, any>
type CreateOptions = Parameters<SessionManager['create']>[0]

interface StreamRequest {
  model: string
  system: string
  tools: Array<{ name: string }>
  messages: unknown[]
}

type StreamHandler = (req: StreamRequest, round: number) => CanonicalEvent[] | Promise<CanonicalEvent[]>

interface Fixture {
  stateDir: string
  store: SessionStore
  agentStore: AgentDefinitionStore
  provider: NativeProvider
  claude?: ClaudeProvider
  sm: SessionManager
  requests: StreamRequest[]
  scripts: Array<CanonicalEvent[] | Error>
  setStream(handler: StreamHandler): void
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []
const hubs: ProviderSubagentTranscriptHub[] = []
const connections: SessionConnection[] = []
let previousConfigDir: string | undefined
let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'native-subagent-transcript-config-'))
  dirs.push(configDir)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const connection of connections.splice(0)) connection.close()
  for (const hub of hubs.splice(0)) hub.close()
  for (const { sm, id } of sessionIds.splice(0)) {
    try { await sm.delete(id) } catch { /* already deleted or manager shut down */ }
  }
  for (const sm of managers.splice(0)) await sm.shutdown()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
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

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

function agentTurn(
  id: string,
  input: Record<string, unknown>,
  toolName: 'Agent' | 'Task' = 'Agent',
): CanonicalEvent[] {
  return toolUseTurn(id, toolName, input)
}

async function makeEnv(prefix: string): Promise<{ cwd: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(root)
  const cwd = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(cwd, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(cwd, 'package.json'), '{"name":"native-subagent-transcript-e2e"}\n', 'utf8')
  return { cwd, stateDir }
}

async function makeFixture(stateDir: string, opts: { claude?: boolean } = {}): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const agentStore = new AgentDefinitionStore({ stateDir })
  await agentStore.load()
  const provider = new NativeProvider({ stateDir, agentStore })
  const claude = opts.claude ? new ClaudeProvider() : undefined
  const requests: StreamRequest[] = []
  const scripts: Array<CanonicalEvent[] | Error> = []
  let handler: StreamHandler = () => {
    const script = scripts.shift()
    if (!script) throw new Error('unexpected native stream request: no scripted round queued')
    if (script instanceof Error) throw script
    return script
  }
  provider._testStream = (async function* (req: StreamRequest) {
    requests.push({
      model: req.model,
      system: req.system,
      tools: [...req.tools],
      messages: structuredClone(req.messages),
    })
    for (const event of await handler(req, requests.length)) yield event
  }) as unknown as NativeProvider['_testStream']
  const registry = new ProviderRegistry()
  registry.register(provider)
  if (claude) registry.register(claude)
  const sm = new SessionManager({ store, providers: registry, agentStore })
  managers.push(sm)
  return {
    stateDir, store, agentStore, provider, claude, sm, requests, scripts,
    setStream: (next) => { handler = next },
  }
}

function remember(sm: SessionManager, id: string): string {
  sessionIds.push({ sm, id })
  return id
}

async function createSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'parent-model',
    provider: 'native',
    title: 'subagent-transcript-e2e',
    ...extra,
  })
  return remember(fx.sm, info.id)
}

function collect(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const frame of sub.iterable) frames.push(frame as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

async function sendAndWait(
  sm: SessionManager,
  id: string,
  frames: Frame[],
  text = 'delegate through the real manager',
  expectedResults = 1,
): Promise<void> {
  await sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(expectedResults)
  }, { timeout: 5000 })
}

function liveSession(sm: SessionManager, id: string): { handle: ProviderSessionHandle } {
  return (sm as unknown as { sessions: Map<string, { handle: ProviderSessionHandle }> })
    .sessions.get(id)!
}

function isNestedRequest(req: StreamRequest): boolean {
  return !req.tools.some((tool) => tool.name === 'Agent')
}

function toolNames(req: StreamRequest): string[] {
  return req.tools.map((tool) => tool.name)
}

async function waitForTurnEnds(stateDir: string, id: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    const events = loadNativeSessionLogSync(stateDir, id)?.events ?? []
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(count)
  }, { timeout: 5000 })
}

function transcriptShape(messages: unknown[]): unknown[] {
  return (messages as Frame[]).map((frame) => ({
    type: frame.type,
    uuid: frame.uuid,
    parent_tool_use_id: frame.parent_tool_use_id,
    message: frame.message,
  }))
}

function makeHub(fx: Fixture): ProviderSubagentTranscriptHub {
  const hub = new ProviderSubagentTranscriptHub({
    resolveProvider: (id) => fx.sm.resolveSubagentTranscriptProvider(id),
    claude: new SubagentTranscriptHub(),
    native: new NativeSubagentTranscriptSource({
      stateDir: fx.stateDir,
      subscribeLive: (id, emit, onTermination) =>
        fx.sm.subscribeLiveSubagentFrames(id, emit, onTermination),
    }),
  })
  hubs.push(hub)
  return hub
}

function connect(
  fx: Fixture,
  hub: ProviderSubagentTranscriptHub,
  sessionId: string,
  agentId: string,
): { connection: SessionConnection; frames: WsServerFrame[] } {
  const frames: WsServerFrame[] = []
  const sink: FrameSink = {
    send: (frame) => { frames.push(frame) },
    sendRaw: (data) => { frames.push(JSON.parse(data) as WsServerFrame) },
    close: () => {},
  }
  const connection = new SessionConnection({ sm: fx.sm, subagentTranscripts: hub }, sink)
  connections.push(connection)
  connection.handleClientFrame({ kind: 'subagent-transcript-subscribe', sessionId, agentId })
  return { connection, frames }
}

function transcriptUuids(frames: WsServerFrame[]): unknown[] {
  return frames.flatMap((frame) => frame.kind === 'subagent-transcript'
    ? frame.frames.map((item) => (item as { uuid?: unknown }).uuid)
    : [])
}

async function waitForTranscriptText(frames: WsServerFrame[], marker: string): Promise<void> {
  await vi.waitFor(() => {
    expect(frames.some((frame) => frame.kind === 'subagent-transcript'
      && JSON.stringify(frame.frames).includes(marker))).toBe(true)
  }, { timeout: 5000 })
}

function originEvent(
  sessionId: string,
  agentId: string,
  prompt: string,
  toolName: 'Agent' | 'Task' | 'Explore' = 'Agent',
): NativeEventInput {
  return {
    type: 'assistant',
    uuid: `origin-${agentId}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    timestamp: '2026-11-12T01:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: agentId, name: toolName,
        input: { description: `label ${agentId}`, prompt },
      }],
    },
  }
}

function descriptorEvent(
  agentId: string,
  profile: NativeAgentProfile | null = null,
): NativeEventInput {
  return {
    type: 'subagent/descriptor',
    toolUseId: agentId,
    parentToolUseId: null,
    kind: 'agent',
    toolName: 'Agent',
    label: `label ${agentId}`,
    depth: 1,
    profile,
    timestamp: '2026-11-12T01:00:01.000Z',
  }
}

function sidechainAssistant(sessionId: string, agentId: string, uuid: string, text: string): NativeEventInput {
  return {
    type: 'assistant',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: agentId,
    timestamp: '2026-11-12T01:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function dormantMeta(id: string, provider: 'native' | 'claude', cwd: string): SessionMeta {
  return {
    id, provider, cwd, createdAt: 1, lastActivityAt: 1, lastTurnAt: 1,
    model: 'test-model', messageCount: 1, terminated: false,
  }
}

describe('native subagent transcripts end to end', () => {
  it('keeps descriptor and legacy ids, profiles and direct transcripts stable through REST, resume and fork', async () => {
    const { cwd, stateDir } = await makeEnv('native-subagent-catalog-e2e-')
    const first = await makeFixture(stateDir)
    first.agentStore.upsert({
      name: 'reviewer', description: 'Reviews code', prompt: 'REVIEWER-SNAPSHOT',
      model: 'reviewer-model', tools: ['Read'], permissionMode: 'bypassPermissions',
      enabled: true, createdAt: 1, updatedAt: 1,
    } as StoredAgentDefinition)
    const id = await createSession(first, cwd, { permissionMode: 'bypassPermissions' })
    const seen = collect(first.sm, id)
    first.scripts.push(
      agentTurn('agent-stable', {
        description: 'stable agent', prompt: 'inspect the stable subtree', subagent_type: 'reviewer',
      }),
      toolUseTurn('nested-read', 'Read', { file_path: 'package.json' }),
      textTurn('STABLE-REPORT'),
      textTurn('PARENT-DONE'),
    )
    await sendAndWait(first.sm, id, seen.frames)
    seen.unsubscribe()
    await waitForTurnEnds(stateDir, id, 1)

    expect(first.requests).toHaveLength(4)
    for (const nested of first.requests.slice(1, 3)) {
      expect(toolNames(nested)).not.toContain('Agent')
      expect(toolNames(nested)).not.toContain('Task')
    }
    const descriptor = loadNativeSessionLogSync(stateDir, id)?.events
      .find((event) => event.type === 'subagent/descriptor')
    expect(descriptor).toMatchObject({
      toolUseId: 'agent-stable', parentToolUseId: null, toolName: 'Agent', depth: 1,
      profile: {
        name: 'reviewer', instruction: 'REVIEWER-SNAPSHOT', model: 'reviewer-model',
        tools: ['Read'], permissionMode: 'bypassPermissions',
      },
    })

    const app = buildApiRouter(first.sm)
    const list = await app.request(`/sessions/${id}/subagents`)
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ subagents: ['agent-stable'] })
    const originalRead = await app.request(`/sessions/${id}/subagents/agent-stable`)
    expect(originalRead.status).toBe(200)
    const originalMessages = (await originalRead.json() as { messages: unknown[] }).messages
    expect((originalMessages as Frame[]).map((frame) => frame.type))
      .toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(JSON.stringify(originalMessages)).toContain('inspect the stable subtree')
    expect(JSON.stringify(originalMessages)).toContain('STABLE-REPORT')
    expect((originalMessages as Frame[]).filter((frame) => JSON.stringify(frame).includes('STABLE-REPORT')))
      .toHaveLength(1)
    expect((originalMessages as Frame[])[2].parent_tool_use_id).toBe('nested-read')

    await first.sm.shutdown()
    const legacy = NativeSessionLog.open({ stateDir, id, cwd, resume: true })
    legacy.append(originEvent(id, 'legacy-agent', 'read the legacy subtree'))
    legacy.append(sidechainAssistant(id, 'legacy-agent', 'legacy-report', 'LEGACY-REPORT'))
    await legacy.flush()
    await legacy.close()

    const second = await makeFixture(stateDir)
    const dormantApp = buildApiRouter(second.sm)
    const resume = vi.spyOn(second.sm, 'resume')
    const dormantList = await dormantApp.request(`/sessions/${id}/subagents`)
    expect(dormantList.status).toBe(200)
    expect(await dormantList.json()).toEqual({ subagents: ['agent-stable', 'legacy-agent'] })
    const dormantRead = await dormantApp.request(`/sessions/${id}/subagents/agent-stable`)
    expect(transcriptShape((await dormantRead.json() as { messages: unknown[] }).messages))
      .toEqual(transcriptShape(originalMessages))
    const legacyRead = await dormantApp.request(`/sessions/${id}/subagents/legacy-agent`)
    const legacyMessages = (await legacyRead.json() as { messages: Frame[] }).messages
    expect(legacyMessages.map((frame) => frame.uuid))
      .toEqual(['native-subagent-prompt:legacy-agent', 'legacy-report'])
    expect(resume).not.toHaveBeenCalled()
    const unknown = await dormantApp.request(`/sessions/${id}/subagents/not-an-agent`)
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ messages: [] })

    await second.sm.resume(id)
    remember(second.sm, id)
    expect(await second.sm.listSubagents(id)).toEqual(['agent-stable', 'legacy-agent'])
    const fork = await second.sm.fork(id)
    remember(second.sm, fork.id)
    expect(await second.sm.listSubagents(fork.id)).toEqual(['agent-stable', 'legacy-agent'])
    expect(transcriptShape(await second.sm.readSubagentTranscript(fork.id, 'agent-stable')))
      .toEqual(transcriptShape(originalMessages))
    expect(transcriptShape(await second.sm.readSubagentTranscript(fork.id, 'legacy-agent')))
      .toEqual(transcriptShape(legacyMessages))
    const forkDescriptor = loadNativeSessionLogSync(stateDir, fork.id)?.events
      .find((event) => event.type === 'subagent/descriptor')
    expect(forkDescriptor).toEqual(descriptor)
  }, 30_000)

  it('subscribes before the snapshot and deduplicates overlapping live and disk frames', async () => {
    const { cwd, stateDir } = await makeEnv('native-subagent-watch-race-')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd, { permissionMode: 'bypassPermissions' })
    const hub = makeHub(fx)
    const events: string[] = []
    const subscribeLive = fx.sm.subscribeLiveSubagentFrames.bind(fx.sm)
    vi.spyOn(fx.sm, 'subscribeLiveSubagentFrames').mockImplementation((...args) => {
      events.push('subscribe')
      return subscribeLive(...args)
    })
    const realLoad = nativeHistoryCache.load.bind(nativeHistoryCache)
    let releaseSnapshot!: () => void
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    let firstLoad = true
    vi.spyOn(nativeHistoryCache, 'load').mockImplementation(async (...args) => {
      events.push('snapshot')
      if (firstLoad) {
        firstLoad = false
        await snapshotGate
      }
      return realLoad(...args)
    })
    const firstConnection = connect(fx, hub, id, 'agent-race')
    await vi.waitFor(() => expect(events).toEqual(['subscribe', 'snapshot']))
    const seen = collect(fx.sm, id)
    fx.scripts.push(
      agentTurn('agent-race', { description: 'race', prompt: 'race prompt' }),
      textTurn('RACE-REPORT'),
      textTurn('RACE-PARENT-DONE'),
    )
    await fx.sm.send(id, 'start the overlapping watch')
    await vi.waitFor(() => {
      expect(JSON.stringify(loadNativeSessionLogSync(stateDir, id)?.events)).toContain('RACE-REPORT')
    })
    releaseSnapshot()
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'result')).toBe(true))
    seen.unsubscribe()
    await waitForTranscriptText(firstConnection.frames, 'RACE-REPORT')

    const liveUuids = transcriptUuids(firstConnection.frames)
    expect(liveUuids[0]).toBe('native-subagent-prompt:agent-race')
    expect(new Set(liveUuids).size).toBe(liveUuids.length)
    expect(liveUuids.filter((uuid) => uuid === 'native-subagent-prompt:agent-race')).toHaveLength(1)
    expect(events.slice(0, 2)).toEqual(['subscribe', 'snapshot'])

    firstConnection.connection.close()
    const reconnected = connect(fx, hub, id, 'agent-race')
    await waitForTranscriptText(reconnected.frames, 'RACE-REPORT')
    expect(transcriptUuids(reconnected.frames)).toEqual(liveUuids)
  }, 30_000)

  it('recovers one descriptor-only prompt from an outer error and keeps reconnects empty of duplicates', async () => {
    const { cwd, stateDir } = await makeEnv('native-subagent-outer-error-')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd, { permissionMode: 'bypassPermissions' })
    const hub = makeHub(fx)
    const firstConnection = connect(fx, hub, id, 'agent-outer-error')
    await vi.waitFor(() => {
      expect(firstConnection.frames.some((frame) => frame.kind === 'subagent-transcript' && frame.reset)).toBe(true)
    })
    const seen = collect(fx.sm, id)
    fx.scripts.push(
      agentTurn('agent-outer-error', { description: 'outer error', prompt: 'prompt without sidechain output' }),
      new Error('nested stream failed before output'),
      textTurn('PARENT-AFTER-OUTER-ERROR'),
    )
    await sendAndWait(fx.sm, id, seen.frames)
    seen.unsubscribe()
    await waitForTurnEnds(stateDir, id, 1)
    await vi.waitFor(() => {
      expect(transcriptUuids(firstConnection.frames))
        .toEqual(['native-subagent-prompt:agent-outer-error'])
    })

    const messages = await fx.sm.readSubagentTranscript(id, 'agent-outer-error') as Frame[]
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'user', uuid: 'native-subagent-prompt:agent-outer-error', parent_tool_use_id: null,
    })
    expect(JSON.stringify(messages)).toContain('prompt without sidechain output')
    const events = loadNativeSessionLogSync(stateDir, id)!.events
    expect(events.some((event) => event.type === 'subagent/descriptor'
      && event.toolUseId === 'agent-outer-error')).toBe(true)
    expect(events.some((event) => event.type === 'assistant'
      && event.parent_tool_use_id === 'agent-outer-error')).toBe(false)

    firstConnection.connection.close()
    const reconnected = connect(fx, hub, id, 'agent-outer-error')
    await vi.waitFor(() => {
      expect(transcriptUuids(reconnected.frames))
        .toEqual(['native-subagent-prompt:agent-outer-error'])
    })
    expect(reconnected.frames.filter((frame) => frame.kind === 'subagent-transcript'))
      .toHaveLength(1)
  }, 30_000)

  it('serves dormant native and Claude routes through their own providers without resuming either session', async () => {
    const { cwd, stateDir } = await makeEnv('native-subagent-provider-routes-')
    const fx = await makeFixture(stateDir, { claude: true })
    const nativeId = 'native-dormant'
    const nativeAgent = 'native-agent'
    const log = NativeSessionLog.open({ stateDir, id: nativeId, cwd, resume: false })
    log.append(originEvent(nativeId, nativeAgent, 'native dormant prompt'))
    log.append(descriptorEvent(nativeAgent))
    log.append(sidechainAssistant(nativeId, nativeAgent, 'native-dormant-report', 'NATIVE-DORMANT-REPORT'))
    await log.flush()
    await log.close()
    fx.store.upsert(dormantMeta(nativeId, 'native', cwd))

    const claudeId = '123e4567-e89b-42d3-a456-426614174000'
    const claudeAgent = 'claude-agent'
    const canonicalCwd = await realpath(cwd)
    const project = join(configDir, 'projects', canonicalCwd.replace(/[^a-zA-Z0-9]/g, '-'))
    const subagents = join(project, claudeId, 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(join(project, `${claudeId}.jsonl`), `${JSON.stringify({
      type: 'user', uuid: 'claude-main', timestamp: '2026-11-12T01:00:00.000Z',
      message: { role: 'user', content: 'main' },
    })}\n`, 'utf8')
    await writeFile(join(subagents, `agent-${claudeAgent}.jsonl`), [
      JSON.stringify({
        type: 'user', uuid: 'claude-prompt', isSidechain: true, timestamp: '2026-11-12T01:00:01.000Z',
        message: { role: 'user', content: 'claude dormant prompt' },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'claude-report', isSidechain: true, timestamp: '2026-11-12T01:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE-DORMANT-REPORT' }] },
      }),
    ].join('\n') + '\n', 'utf8')
    fx.store.upsert(dormantMeta(claudeId, 'claude', cwd))

    const app = buildApiRouter(fx.sm)
    const resume = vi.spyOn(fx.sm, 'resume')
    const claudeList = vi.spyOn(fx.claude!.subagentTranscripts, 'listSubagents')
    const claudeRead = vi.spyOn(fx.claude!.subagentTranscripts, 'readTranscript')
    const nativeList = await app.request(`/sessions/${nativeId}/subagents`)
    expect(nativeList.status).toBe(200)
    expect(await nativeList.json()).toEqual({ subagents: [nativeAgent] })
    const nativeRead = await app.request(`/sessions/${nativeId}/subagents/${nativeAgent}`)
    expect(nativeRead.status).toBe(200)
    expect(JSON.stringify(await nativeRead.json())).toContain('NATIVE-DORMANT-REPORT')
    expect(claudeList).not.toHaveBeenCalled()
    expect(claudeRead).not.toHaveBeenCalled()

    const claudeListResponse = await app.request(`/sessions/${claudeId}/subagents`)
    expect(claudeListResponse.status).toBe(200)
    expect(await claudeListResponse.json()).toEqual({ subagents: [claudeAgent] })
    const claudeReadResponse = await app.request(`/sessions/${claudeId}/subagents/${claudeAgent}`)
    expect(claudeReadResponse.status).toBe(200)
    const claudeMessages = (await claudeReadResponse.json() as { messages: Frame[] }).messages
    expect(claudeMessages.map((frame) => frame.uuid)).toEqual(['claude-prompt', 'claude-report'])
    expect(resume).not.toHaveBeenCalled()
    expect(fx.sm.get(nativeId).phase).toBe('dormant')
    expect(fx.sm.get(claudeId).phase).toBe('dormant')
  }, 30_000)

  it('continues a detached Task transcript and keeps Task from restoring nested delegation', async () => {
    const { cwd, stateDir } = await makeEnv('native-subagent-task-detach-')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd, { permissionMode: 'bypassPermissions' })
    const hub = makeHub(fx)
    const connection = connect(fx, hub, id, 'task-detach')
    let nestedStarted = false
    let markNestedStarted!: () => void
    const started = new Promise<void>((resolve) => { markNestedStarted = resolve })
    let releaseNested!: () => void
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
    fx.setStream(async (req) => {
      if (isNestedRequest(req)) {
        nestedStarted = true
        markNestedStarted()
        await nestedGate
        return textTurn('DETACHED-TASK-REPORT')
      }
      return nestedStarted
        ? textTurn('PARENT-AFTER-DETACH')
        : agentTurn('task-detach', { description: 'detached task', prompt: 'continue after detach' }, 'Task')
    })
    const seen = collect(fx.sm, id)
    const app = buildApiRouter(fx.sm)
    try {
      await fx.sm.send(id, 'detach the Task')
      await started
      const background = await app.request(`/sessions/${id}/tasks/background`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolUseId: 'task-detach' }),
      })
      expect(background.status).toBe(200)
      expect(await background.json()).toEqual({ ok: true, backgrounded: true })
      await vi.waitFor(() => {
        expect(seen.frames.filter((frame) => frame.type === 'result')).toHaveLength(1)
      })
      expect(fx.requests.filter(isNestedRequest)).toHaveLength(1)
      expect(toolNames(fx.requests.find(isNestedRequest)!)).not.toContain('Agent')
      expect(toolNames(fx.requests.find(isNestedRequest)!)).not.toContain('Task')
      releaseNested()
      await waitForTranscriptText(connection.frames, 'DETACHED-TASK-REPORT')
      await vi.waitFor(() => {
        expect(seen.frames.some((frame) => frame.subtype === 'task_notification'
          && frame.result === 'DETACHED-TASK-REPORT')).toBe(true)
      })

      expect(await fx.sm.listSubagents(id)).toEqual(['task-detach'])
      const transcript = await fx.sm.readSubagentTranscript(id, 'task-detach') as Frame[]
      expect(transcript.map((frame) => frame.type)).toEqual(['user', 'assistant'])
      expect(JSON.stringify(transcript)).toContain('continue after detach')
      expect(JSON.stringify(transcript)).toContain('DETACHED-TASK-REPORT')
      expect(loadNativeSessionLogSync(stateDir, id)?.events.find(
        (event) => event.type === 'subagent/descriptor',
      )).toMatchObject({ toolUseId: 'task-detach', toolName: 'Task', depth: 1 })
      expect(seen.frames.filter((frame) => frame.type === 'result')).toHaveLength(1)
      expect(seen.frames.filter((frame) => frame.type === 'user'
        && frame.parent_tool_use_id == null
        && frame.message?.content?.[0]?.tool_use_id === 'task-detach')).toHaveLength(1)
    } finally {
      releaseNested()
      seen.unsubscribe()
    }
  }, 30_000)

  it('keeps Explore read-only through bypass and mixed real MCP tools', async () => {
    const { cwd, stateDir } = await makeEnv('native-subagent-explore-mcp-')
    const fx = await makeFixture(stateDir)
    const server = new McpServer({ name: 'mixed', version: '1.0.0' })
    server.registerTool('readonly', {
      description: 'Read-only MCP tool', inputSchema: {}, annotations: { readOnlyHint: true },
    }, async () => ({ content: [{ type: 'text', text: 'read' }] }))
    server.registerTool('writable', {
      description: 'Writable MCP tool', inputSchema: {}, annotations: { readOnlyHint: false },
    }, async () => ({ content: [{ type: 'text', text: 'write' }] }))
    server.registerTool('undeclared', {
      description: 'MCP tool without safety metadata', inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: 'unknown' }] }))
    const id = await createSession(fx, cwd, {
      permissionMode: 'bypassPermissions',
      mcpServers: { mixed: { type: 'sdk', name: 'mixed', instance: server } } as CreateOptions['mcpServers'],
    })
    const seen = collect(fx.sm, id)
    fx.scripts.push(
      agentTurn('explore-read-only', {
        description: 'explore', prompt: 'inspect without writes', subagent_type: 'Explore',
      }),
      textTurn('EXPLORE-REPORT'),
      textTurn('PARENT-AFTER-EXPLORE'),
    )
    await sendAndWait(fx.sm, id, seen.frames)
    seen.unsubscribe()

    const nested = fx.requests.find(isNestedRequest)!
    const names = toolNames(nested)
    expect(names).toContain('mcp__mixed__readonly')
    expect(names).not.toContain('mcp__mixed__writable')
    expect(names).not.toContain('mcp__mixed__undeclared')
    for (const writeTool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task']) {
      expect(names).not.toContain(writeTool)
    }
    for (const readTool of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Skill', 'TaskOutput']) {
      expect(names).toContain(readTool)
    }
    expect(nested.system).toContain('Explore the codebase read-only.')
    expect(loadNativeSessionLogSync(stateDir, id)?.events.find(
      (event) => event.type === 'subagent/descriptor',
    )).toMatchObject({
      toolUseId: 'explore-read-only', toolName: 'Agent',
      profile: { name: 'Explore', instruction: expect.stringContaining('read-only') },
    })
  }, 30_000)

  it.each(['descriptor-write', 'unknown-agent', 'permission-denial'] as const)(
    'does not create a phantom catalog entry after %s',
    async (failure) => {
      const { cwd, stateDir } = await makeEnv(`native-subagent-${failure}-`)
      const fx = await makeFixture(stateDir)
      const id = await createSession(fx, cwd, failure === 'permission-denial'
        ? {}
        : { permissionMode: 'bypassPermissions' })
      const agentId = `agent-${failure}`
      if (failure === 'descriptor-write') {
        const log = (liveSession(fx.sm, id).handle as unknown as { log: NativeSessionLog }).log
        vi.spyOn(log, 'appendDurable').mockRejectedValueOnce(new Error('descriptor write failed'))
      }
      const seen = collect(fx.sm, id)
      fx.scripts.push(
        agentTurn(agentId, {
          description: failure, prompt: 'must not execute',
          ...(failure === 'unknown-agent' ? { subagent_type: 'missing-agent' } : {}),
        }),
        textTurn(`PARENT-AFTER-${failure}`),
      )
      await fx.sm.send(id, `trigger ${failure}`)
      if (failure === 'permission-denial') {
        await vi.waitFor(() => expect(fx.sm.listPending(id)).toHaveLength(1))
        expect(fx.sm.listPending(id)[0]).toMatchObject({ toolName: 'Agent', toolUseID: agentId })
        await fx.sm.decide(id, fx.sm.listPending(id)[0].id, {
          behavior: 'deny', message: 'denied by E2E',
        })
      }
      await vi.waitFor(() => {
        expect(seen.frames.filter((frame) => frame.type === 'result')).toHaveLength(1)
      })
      seen.unsubscribe()
      await waitForTurnEnds(stateDir, id, 1)

      expect(fx.requests).toHaveLength(2)
      expect(fx.requests.some(isNestedRequest)).toBe(false)
      expect(fx.sm.listPending(id)).toEqual([])
      const outerResult = seen.frames.find((frame) => frame.type === 'user'
        && frame.parent_tool_use_id == null
        && frame.message?.content?.[0]?.tool_use_id === agentId)
      expect(outerResult?.message.content[0].is_error).toBe(true)
      expect(loadNativeSessionLogSync(stateDir, id)?.events.some(
        (event) => event.type === 'subagent/descriptor' && event.toolUseId === agentId,
      )).toBe(false)
      expect(await fx.sm.listSubagents(id)).toEqual([])
      expect((await nativeHistoryCache.load(stateDir, id))?.subagents.entries).toEqual([])
    },
    30_000,
  )
})
