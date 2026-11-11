// server/providers/native/e2e-agent-profile.test.ts
//
// Stage A agent-profile proof through the real SessionManager, PermissionBroker,
// NativeProvider, and native JSONL logs. The only replaced boundary is the
// Anthropic stream: `_testStream` plays scripted canonical rounds, so no network
// or CLI subprocess is involved. Fixture shape follows the sibling native e2e
// suites; helpers stay local because those suites do not export theirs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AgentDefinitionStore, type StoredAgentDefinition } from '../../agent-definition-store.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { buildRestartSessionBody } from '../../../src/utils/new-like-this.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'
import { loadNativeSessionLogSync } from './session-log/log.js'

type Frame = Record<string, any>
type CreateOptions = Parameters<SessionManager['create']>[0]

interface StreamRequest {
  model: string
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

interface Fixture {
  sm: SessionManager
  store: SessionStore
  agentStore: AgentDefinitionStore
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []
let previousConfigDir: string | undefined

beforeEach(async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'sm-native-agent-profile-config-'))
  dirs.push(configDir)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already deleted or manager shut down */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  dirs.length = 0
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

function agentTurn(id: string, input: Record<string, unknown>): CanonicalEvent[] {
  return toolUseTurn(id, 'Agent', input)
}

function definition(
  name: string,
  overrides: Partial<StoredAgentDefinition> = {},
): StoredAgentDefinition {
  return {
    name,
    description: `${name} description`,
    prompt: `${name.toUpperCase()}-PROMPT`,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as StoredAgentDefinition
}

function echoServer(name: string): McpServer {
  const server = new McpServer({ name, version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo text.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  return server
}

async function makeEnv(prefix: string): Promise<{ cwd: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(root)
  const cwd = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(cwd, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(cwd, 'package.json'), '{"name":"agent-profile-e2e"}\n', 'utf8')
  return { cwd, stateDir }
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const agentStore = new AgentDefinitionStore({ stateDir })
  await agentStore.load()
  const provider = new NativeProvider({ stateDir, agentStore })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  provider._testStream = async function* (req: {
    model: string
    system: string
    tools: unknown[]
    messages: unknown[]
  }) {
    requests.push({
      model: req.model,
      system: req.system,
      tools: [...req.tools] as Array<{ name: string }>,
      messages: structuredClone(req.messages) as StreamRequest['messages'],
    })
    const script = scripts.shift()
    if (!script) throw new Error('unexpected native stream request: no scripted round queued')
    for (const event of script) yield event
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry, agentStore })
  managers.push(sm)
  return { sm, store, agentStore, requests, scripts }
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
    model: 'base-model',
    provider: 'native',
    title: 'agent-profile-e2e',
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
  text: string,
  expectedResults: number,
): Promise<void> {
  await sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(expectedResults)
  }, { timeout: 5000 })
}

function toolNames(request: StreamRequest): string[] {
  return request.tools.map((tool) => tool.name)
}

function toolResultBlock(frames: Frame[], toolUseId: string): Record<string, any> | undefined {
  for (const frame of frames) {
    if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) continue
    for (const block of frame.message.content as Frame[]) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) return block
    }
  }
  return undefined
}

function liveHistory(sm: SessionManager, id: string): Frame[] {
  return (sm as unknown as { sessions: Map<string, { history: Frame[] }> })
    .sessions.get(id)!.history
}

async function waitForTurnEnds(stateDir: string, id: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    const events = loadNativeSessionLogSync(stateDir, id)?.events ?? []
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(count)
  }, { timeout: 5000 })
}

async function writeProjectSkill(cwd: string, name: string): Promise<void> {
  const dir = join(cwd, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
    'utf8',
  )
}

describe('native agent profiles end to end through SessionManager', () => {
  it('applies every supported create profile field to the first request and durable selection', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-create-')
    await writeProjectSkill(cwd, 'demo')
    await writeProjectSkill(cwd, 'other')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert(definition('reviewer', {
      prompt: 'REVIEWER-FULL-PROMPT',
      model: 'reviewer-model',
      tools: ['Read', 'Skill', 'Bash', 'mcp__a__echo', 'mcp__b__echo'],
      disallowedTools: ['Bash'],
      mcpServers: ['a'],
      skills: ['demo'],
      permissionMode: 'plan',
      maxTurns: 2,
      effort: 'xhigh',
    }))
    const id = await createSession(fx, cwd, {
      agent: 'reviewer',
      permissionMode: 'default',
      effort: 'high',
      tools: ['Read', 'Write', 'Skill'],
      disallowedTools: ['Write'],
      skills: 'all',
      mcpServers: {
        a: { type: 'sdk', name: 'a', instance: echoServer('a') },
        b: { type: 'sdk', name: 'b', instance: echoServer('b') },
      } as CreateOptions['mcpServers'],
    })
    const seen = collect(fx.sm, id)
    fx.scripts.push(textTurn('profile applied'))
    await sendAndWait(fx.sm, id, seen.frames, 'review this', 1)
    seen.unsubscribe()

    expect(fx.requests).toHaveLength(1)
    const request = fx.requests[0]
    expect(request.model).toBe('reviewer-model')
    expect(request.system).toContain('REVIEWER-FULL-PROMPT')
    expect(request.system).toContain('- demo: demo description')
    expect(request.system).not.toContain('other description')
    expect([...toolNames(request)].sort()).toEqual(['Read', 'Skill', 'mcp__a__echo'].sort())
    expect(fx.sm.get(id)).toMatchObject({
      agent: 'reviewer',
      model: 'reviewer-model',
      permissionMode: 'plan',
      effortLevel: 'xhigh',
    })
    expect(seen.frames.some((frame) => frame.type === 'session/agent')).toBe(false)

    const selection = loadNativeSessionLogSync(stateDir, id)?.events
      .find((event) => event.type === 'session/agent')
    expect(selection).toMatchObject({
      type: 'session/agent',
      name: 'reviewer',
      definition: {
        prompt: 'REVIEWER-FULL-PROMPT',
        model: 'reviewer-model',
        tools: ['Read', 'Skill', 'Bash', 'mcp__a__echo', 'mcp__b__echo'],
        disallowedTools: ['Bash'],
        mcpServers: ['a'],
        skills: ['demo'],
        permissionMode: 'plan',
        maxTurns: 2,
        effort: 'xhigh',
      },
      base: {
        model: 'base-model',
        permissionMode: 'default',
        effortLevel: 'high',
        skillPolicy: 'all',
        toolProfile: { tools: ['Read', 'Write', 'Skill'], disallowedTools: ['Write'] },
      },
    })
  }, 30_000)

  it('switches between turns and clears back to the latest base model, permission, effort, and tools', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-switch-')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert(definition('reviewer', {
      prompt: 'NEXT-TURN-PERSONA',
      model: 'persona-model',
      tools: ['Write'],
      permissionMode: 'bypassPermissions',
      effort: 'max',
    }))
    const id = await createSession(fx, cwd, {
      permissionMode: 'acceptEdits',
      effort: 'high',
      tools: ['Read', 'Bash'],
    })
    const seen = collect(fx.sm, id)
    fx.scripts.push(textTurn('plain'), textTurn('persona'), textTurn('cleared'))

    await sendAndWait(fx.sm, id, seen.frames, 'plain turn', 1)
    expect(fx.requests[0].model).toBe('base-model')
    expect([...toolNames(fx.requests[0])].sort()).toEqual(['Bash', 'Read'])

    await fx.sm.setAgent(id, 'reviewer')
    await fx.sm.setModel(id, 'base-next')
    await fx.sm.setPermissionMode(id, 'default')
    await fx.sm.setEffortLevel(id, 'low')
    expect(fx.sm.get(id)).toMatchObject({
      agent: 'reviewer',
      model: 'persona-model',
      permissionMode: 'bypassPermissions',
      effortLevel: 'max',
    })

    await sendAndWait(fx.sm, id, seen.frames, 'persona turn', 2)
    expect(fx.requests[1].model).toBe('persona-model')
    expect(fx.requests[1].system).toContain('NEXT-TURN-PERSONA')
    expect(toolNames(fx.requests[1])).toEqual(['Write'])

    await fx.sm.setAgent(id, null)
    expect(fx.sm.get(id)).toMatchObject({
      model: 'base-next',
      permissionMode: 'default',
      effortLevel: 'low',
    })
    expect(fx.sm.get(id).agent).toBeUndefined()
    await sendAndWait(fx.sm, id, seen.frames, 'cleared turn', 3)
    expect(fx.requests[2].model).toBe('base-next')
    expect(fx.requests[2].system).not.toContain('NEXT-TURN-PERSONA')
    expect([...toolNames(fx.requests[2])].sort()).toEqual(['Bash', 'Read'])
    seen.unsubscribe()

    const selections = loadNativeSessionLogSync(stateDir, id)!.events
      .filter((event) => event.type === 'session/agent')
    expect(selections.at(-1)).toMatchObject({
      name: null,
      base: {
        model: 'base-next',
        permissionMode: 'default',
        effortLevel: 'low',
        toolProfile: { tools: ['Read', 'Bash'] },
      },
    })
  }, 30_000)

  it('uses the pre-persona base for a real manager clear while keeping the persona selected', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-manager-clear-')
    await writeProjectSkill(cwd, 'demo')
    await writeProjectSkill(cwd, 'other')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert(definition('reviewer', {
      prompt: 'CLEAR-PERSONA-PROMPT',
      model: 'persona-model',
      tools: ['Write'],
      skills: ['other'],
      permissionMode: 'bypassPermissions',
      effort: 'max',
    }))
    const id = await createSession(fx, cwd, {
      permissionMode: 'default',
      effort: 'high',
      tools: ['Read', 'Skill'],
      skills: ['demo'],
    })
    await fx.sm.setAgent(id, 'reviewer')
    await fx.sm.setSkillOverride(id, { kind: 'disabled' })
    expect(fx.sm.get(id)).toMatchObject({
      agent: 'reviewer', model: 'persona-model', permissionMode: 'bypassPermissions', effortLevel: 'max',
    })

    const next = await fx.sm.clear(id)
    remember(fx.sm, next.id)
    expect(next.id).not.toBe(id)
    expect(next).toMatchObject({
      agent: 'reviewer', model: 'persona-model', permissionMode: 'bypassPermissions', effortLevel: 'max',
    })
    expect(await fx.sm.supportedCommands(next.id)).toEqual([])
    const selection = loadNativeSessionLogSync(stateDir, next.id)!.events
      .find((event) => event.type === 'session/agent')
    expect(selection).toMatchObject({
      name: 'reviewer',
      definition: {
        prompt: 'CLEAR-PERSONA-PROMPT', model: 'persona-model', tools: ['Write'], skills: ['other'],
        permissionMode: 'bypassPermissions', effort: 'max',
      },
      base: {
        model: 'base-model', permissionMode: 'default', effortLevel: 'high',
        skillPolicy: ['demo'], toolProfile: { tools: ['Read', 'Skill'] },
      },
    })

    await fx.sm.setSkillOverride(next.id, undefined)
    await fx.sm.setAgent(next.id, null)
    expect(fx.sm.get(next.id)).toMatchObject({
      model: 'base-model', permissionMode: 'default', effortLevel: 'high',
    })
    expect(fx.sm.get(next.id).agent).toBeUndefined()
    const seen = collect(fx.sm, next.id)
    fx.scripts.push(textTurn('base restored after manager clear'))
    await sendAndWait(fx.sm, next.id, seen.frames, 'plain after clear', 1)
    seen.unsubscribe()
    expect(fx.requests[0].model).toBe('base-model')
    expect(fx.requests[0].system).not.toContain('CLEAR-PERSONA-PROMPT')
    expect(fx.requests[0].system).toContain('- demo: demo description')
    expect(fx.requests[0].system).not.toContain('other description')
    expect([...toolNames(fx.requests[0])].sort()).toEqual(['Read', 'Skill'])
  }, 30_000)

  it('keeps a nested read-only profile read-only and asks under nested default despite parent bypass', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-nested-')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert(definition('reader', {
      prompt: 'READ-ONLY-NESTED',
      model: 'nested-reader-model',
      tools: ['Read', 'Write'],
      disallowedTools: ['Write'],
      permissionMode: 'default',
    }))
    const id = await createSession(fx, cwd, { permissionMode: 'bypassPermissions' })
    const seen = collect(fx.sm, id)
    fx.scripts.push(
      agentTurn('agent-read', { description: 'read', prompt: 'inspect', subagent_type: 'reader' }),
      toolUseTurn('nested-read', 'Read', { file_path: 'package.json' }),
      textTurn('nested report'),
      textTurn('parent done'),
    )

    await fx.sm.send(id, 'delegate a read')
    await vi.waitFor(() => expect(fx.sm.listPending(id)).toHaveLength(1), { timeout: 5000 })
    const pending = fx.sm.listPending(id)[0]
    expect(pending).toMatchObject({ kind: 'permission', toolName: 'Read', toolUseID: 'nested-read' })
    expect(fx.requests).toHaveLength(2)
    expect(fx.requests[1].model).toBe('nested-reader-model')
    expect(fx.requests[1].system).toContain('READ-ONLY-NESTED')
    expect(toolNames(fx.requests[1])).toEqual(['Read'])
    expect(fx.sm.get(id).permissionMode).toBe('bypassPermissions')

    await fx.sm.decide(id, pending.id, { behavior: 'allow' })
    await vi.waitFor(() => {
      expect(seen.frames.filter((frame) => frame.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
    seen.unsubscribe()

    expect(fx.requests).toHaveLength(4)
    expect(toolResultBlock(seen.frames, 'nested-read')).toMatchObject({ is_error: false })
    expect(toolResultBlock(seen.frames, 'agent-read')).toMatchObject({ is_error: false })
    expect(fx.sm.listPending(id)).toEqual([])
    expect(fx.sm.get(id).permissionMode).toBe('bypassPermissions')
  }, 30_000)

  it('suppresses final-round writes at maxTurns and accepts a later main-session prompt', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-max-turns-')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert(definition('limited', {
      tools: ['Write'],
      permissionMode: 'bypassPermissions',
      maxTurns: 1,
    }))
    const id = await createSession(fx, cwd, { agent: 'limited' })
    const seen = collect(fx.sm, id)
    const target = join(cwd, 'must-not-exist.txt')
    fx.scripts.push(
      toolUseTurn('capped-write', 'Write', { file_path: target, content: 'must not be written' }),
      textTurn('later prompt accepted'),
    )

    await sendAndWait(fx.sm, id, seen.frames, 'capped turn', 1)
    await waitForTurnEnds(stateDir, id, 1)
    expect(seen.frames.find((frame) => frame.type === 'result')).toMatchObject({ is_error: true })
    expect(toolResultBlock(seen.frames, 'capped-write')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'capped-write',
      is_error: true,
      content: [{ type: 'text', text: 'max turns reached (1); tool not executed' }],
    })
    expect(existsSync(target)).toBe(false)
    expect(fx.sm.listPending(id)).toEqual([])
    expect(loadNativeSessionLogSync(stateDir, id)!.events.at(-1)).toMatchObject({
      type: 'turn/end', reason: 'error',
    })

    await sendAndWait(fx.sm, id, seen.frames, 'next turn', 2)
    await waitForTurnEnds(stateDir, id, 2)
    const results = seen.frames.filter((frame) => frame.type === 'result')
    expect(results[1]).toMatchObject({ subtype: 'success', result: 'later prompt accepted' })
    expect(loadNativeSessionLogSync(stateDir, id)!.events
      .filter((event) => event.type === 'turn/end')
      .map((event) => event.reason)).toEqual(['error', 'completed'])
    seen.unsubscribe()
  }, 30_000)

  it('uses logged snapshots on resume and fork, and visibly drops an unsupported legacy preset', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-recovery-')
    const first = await makeFixture(stateDir)
    first.agentStore.upsert(definition('reviewer', {
      prompt: 'LOGGED-SNAPSHOT-PROMPT',
      model: 'logged-model',
      tools: ['Read'],
      permissionMode: 'plan',
      effort: 'xhigh',
    }))
    const sourceId = await createSession(first, cwd, { agent: 'reviewer' })
    const sourceSeen = collect(first.sm, sourceId)
    first.scripts.push(textTurn('source reply'))
    await sendAndWait(first.sm, sourceId, sourceSeen.frames, 'source turn', 1)
    sourceSeen.unsubscribe()
    await waitForTurnEnds(stateDir, sourceId, 1)

    first.agentStore.upsert(definition('reviewer', {
      prompt: 'EDITED-STORE-PROMPT',
      model: 'edited-model',
      tools: ['Write'],
      permissionMode: 'bypassPermissions',
      effort: 'low',
    }))
    await first.agentStore.flush()
    await first.sm.shutdown()

    const second = await makeFixture(stateDir)
    await second.sm.resume(sourceId)
    remember(second.sm, sourceId)
    expect(second.sm.get(sourceId)).toMatchObject({
      agent: 'reviewer', model: 'logged-model', permissionMode: 'plan', effortLevel: 'xhigh',
    })
    const resumedSeen = collect(second.sm, sourceId)
    second.scripts.push(textTurn('resumed snapshot'))
    await sendAndWait(second.sm, sourceId, resumedSeen.frames, 'resumed turn', 1)
    resumedSeen.unsubscribe()
    expect(second.requests[0].model).toBe('logged-model')
    expect(second.requests[0].system).toContain('LOGGED-SNAPSHOT-PROMPT')
    expect(second.requests[0].system).not.toContain('EDITED-STORE-PROMPT')
    expect(toolNames(second.requests[0])).toEqual(['Read'])

    const fork = await second.sm.fork(sourceId)
    remember(second.sm, fork.id)
    const forkSeen = collect(second.sm, fork.id)
    second.scripts.push(textTurn('forked snapshot'))
    await sendAndWait(second.sm, fork.id, forkSeen.frames, 'forked turn', 1)
    forkSeen.unsubscribe()
    expect(second.requests[1].model).toBe('logged-model')
    expect(second.requests[1].system).toContain('LOGGED-SNAPSHOT-PROMPT')
    expect(second.requests[1].system).not.toContain('EDITED-STORE-PROMPT')
    expect(toolNames(second.requests[1])).toEqual(['Read'])

    // A real pre-event native session supplies the legacy metadata path: its
    // log has no session/agent event, then its persisted meta gains an agent.
    const legacyId = await createSession(second, cwd, { model: 'legacy-base-model' })
    const legacySeen = collect(second.sm, legacyId)
    second.scripts.push(textTurn('legacy reply'))
    await sendAndWait(second.sm, legacyId, legacySeen.frames, 'legacy turn', 1)
    legacySeen.unsubscribe()
    await second.sm.shutdown()

    const legacyMeta = second.store.get(legacyId)!
    expect(legacyMeta.agent).toBeUndefined()
    second.store.upsert({ ...legacyMeta, agent: 'reviewer' })
    second.agentStore.upsert(definition('reviewer', {
      prompt: 'PARTIAL-PERSONA-MUST-NOT-APPLY',
      model: 'unsupported-model',
      tools: ['Write'],
      background: true,
      memory: 'project',
      effort: 3,
    }))
    await Promise.all([second.store.flush(), second.agentStore.flush()])

    const third = await makeFixture(stateDir)
    await third.sm.resume(legacyId)
    remember(third.sm, legacyId)
    expect(third.sm.get(legacyId).agent).toBeUndefined()
    expect(third.sm.get(legacyId).model).toBe('legacy-base-model')
    const migratedSeen = collect(third.sm, legacyId)
    await vi.waitFor(() => {
      expect(liveHistory(third.sm, legacyId).some((frame) => frame.subtype === 'informational')).toBe(true)
    }, { timeout: 5000 })
    const notice = liveHistory(third.sm, legacyId)
      .find((frame) => frame.subtype === 'informational')?.content
    expect(notice).toContain('reviewer')
    for (const field of ['background', 'memory', 'effort']) expect(notice).toContain(field)

    await vi.waitFor(() => {
      const selection = loadNativeSessionLogSync(stateDir, legacyId)?.events
        .find((event) => event.type === 'session/agent')
      expect(selection).toMatchObject({
        name: null,
        droppedAgent: { name: 'reviewer', unsupportedFields: ['background', 'memory', 'effort'] },
      })
    }, { timeout: 5000 })
    third.scripts.push(textTurn('legacy plain continuation'))
    await sendAndWait(third.sm, legacyId, migratedSeen.frames, 'after legacy migration', 1)
    migratedSeen.unsubscribe()
    expect(third.requests[0].model).toBe('legacy-base-model')
    expect(third.requests[0].system).not.toContain('PARTIAL-PERSONA-MUST-NOT-APPLY')
  }, 40_000)

  it('preserves the agent through restart and rejects unsupported creates without partial state', async () => {
    const { cwd, stateDir } = await makeEnv('sm-native-agent-restart-')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert(definition('reviewer', {
      prompt: 'RESTARTED-PERSONA', model: 'reviewer-model', tools: ['Read'],
    }))
    const sourceId = await createSession(fx, cwd, { agent: 'reviewer' })
    const body = buildRestartSessionBody(fx.sm.get(sourceId))
    expect(body.agent).toBe('reviewer')

    const { joinGroupOf, evictingSource, ...createBody } = body
    const replacement = await fx.sm.create(createBody as CreateOptions, undefined, joinGroupOf, evictingSource)
    remember(fx.sm, replacement.id)
    await fx.sm.delete(sourceId)
    expect(fx.sm.get(replacement.id)).toMatchObject({ agent: 'reviewer', model: 'reviewer-model' })
    const restartedSeen = collect(fx.sm, replacement.id)
    fx.scripts.push(textTurn('restart preserved'))
    await sendAndWait(fx.sm, replacement.id, restartedSeen.frames, 'after restart', 1)
    restartedSeen.unsubscribe()
    expect(fx.requests[0].model).toBe('reviewer-model')
    expect(fx.requests[0].system).toContain('RESTARTED-PERSONA')
    expect(toolNames(fx.requests[0])).toEqual(['Read'])

    fx.agentStore.upsert(definition('invalid', { background: true, memory: 'project' }))
    const beforeIds = fx.sm.list().map((session) => session.id).sort()
    const beforeStoredIds = fx.store.list().map((session) => session.id).sort()
    const nativeRoot = join(stateDir, 'native-sessions')
    const beforeLogs = (await readdir(nativeRoot)).sort()
    const beforeRequests = fx.requests.length

    await expect(fx.sm.create({
      cwd,
      model: 'base-model',
      provider: 'native',
      title: 'must not exist',
      agent: 'invalid',
    })).rejects.toThrow(/background/)

    expect(fx.sm.list().map((session) => session.id).sort()).toEqual(beforeIds)
    expect(fx.store.list().map((session) => session.id).sort()).toEqual(beforeStoredIds)
    expect((await readdir(nativeRoot)).sort()).toEqual(beforeLogs)
    expect(fx.requests).toHaveLength(beforeRequests)
  }, 30_000)
})
