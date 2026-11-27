// server/providers/native/agent-lookup.test.ts
//
// Plugin parity T3: plugin agents resolve through a merged READ-ONLY lookup
// (user AgentDefinitionStore + qualified plugin defs) without ever writing the
// user store. The lookup unit tests drive a real on-disk store; the integration
// tests drive the real host loader over a stub marketplace source and a real
// NativeSession, then the /agents route union — the same end-to-end shape the
// plugin-command tests use.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDefinitionStore } from '../../agent-definition-store.js'
import { agentUnusableReason, type StoredAgentDefinition } from '../../../shared/agent-definitions.js'
import { listPluginContributions } from '../../plugin-contributions.js'
import type { EnabledPluginEntry } from '../../mp-store.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { NativeProvider } from './native-provider.js'
import type { NativeHostPorts } from './ports.js'
import type { CanonicalEvent } from './canonical.js'
import { buildSessionRouter } from '../../routes/sessions.js'
import type { SessionManager } from '../../session-manager.js'
import {
  PluginAgentLookup,
  pluginAgentDefs,
  enabledAgentDefinition,
  type AgentStoreReadSurface,
} from './agent-lookup.js'

// ── fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'agent-lookup-config-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(skillsConfigDir, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function def(name: string, over: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    name,
    description: `${name} description`,
    prompt: `${name}-PROMPT`,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

async function makeStore(dir: string, defs: StoredAgentDefinition[]): Promise<AgentDefinitionStore> {
  const store = new AgentDefinitionStore({ stateDir: dir })
  for (const d of defs) store.upsert(d)
  await store.flush()
  return store
}

function contribution(name: string, agents: StoredAgentDefinition[]) {
  return { key: `${name}@mp`, name, dir: `/plugins/${name}`, commands: [], agents, hooks: {}, mcpServers: {}, errors: [] }
}

// ── PluginAgentLookup unit surface ──────────────────────────────────────────

describe('PluginAgentLookup — merged read-only resolution', () => {
  it('resolves a plugin agent by its qualified name', async () => {
    const dir = await tempDir('lookup-get-')
    const store = await makeStore(dir, [])
    const lookup = new PluginAgentLookup(store, () => [def('demo:reviewer', { prompt: 'PLUGIN-REVIEW' })])
    expect(lookup.get('demo:reviewer')).toMatchObject({ name: 'demo:reviewer', prompt: 'PLUGIN-REVIEW' })
    expect(lookup.get('reviewer')).toBeUndefined()
  })

  it('user store wins a bare-name collision; the plugin stays qualified', async () => {
    const dir = await tempDir('lookup-collision-')
    const store = await makeStore(dir, [def('foo', { prompt: 'USER-FOO' })])
    const lookup = new PluginAgentLookup(store, () => [def('demo:foo', { prompt: 'PLUGIN-FOO' })])
    expect(lookup.get('foo')).toMatchObject({ prompt: 'USER-FOO' })
    expect(lookup.get('demo:foo')).toMatchObject({ prompt: 'PLUGIN-FOO' })
  })

  it('user store wins even on a literal qualified-key collision', async () => {
    const dir = await tempDir('lookup-qualified-collision-')
    const store = await makeStore(dir, [def('demo:foo', { prompt: 'USER-QUALIFIED' })])
    const lookup = new PluginAgentLookup(store, () => [def('demo:foo', { prompt: 'PLUGIN-QUALIFIED' })])
    expect(lookup.get('demo:foo')).toMatchObject({ prompt: 'USER-QUALIFIED' })
  })

  it('getEnabledDefinitions unions user + plugin, strips bookkeeping, filters disabled', async () => {
    const dir = await tempDir('lookup-enabled-')
    const store = await makeStore(dir, [
      def('reviewer', { model: 'user-model' }),
      def('off', { enabled: false }),
    ])
    const lookup = new PluginAgentLookup(store, () => [
      def('demo:reviewer', { model: 'plugin-model' }),
      def('demo:off', { enabled: false }),
    ])
    const enabled = lookup.getEnabledDefinitions()
    expect(Object.keys(enabled).sort()).toEqual(['demo:reviewer', 'reviewer'])
    expect(enabled.reviewer).toMatchObject({ description: 'reviewer description', prompt: 'reviewer-PROMPT', model: 'user-model' })
    expect(enabled['demo:reviewer']).toMatchObject({ prompt: 'demo:reviewer-PROMPT', model: 'plugin-model' })
    for (const value of Object.values(enabled)) {
      expect(value).not.toHaveProperty('name')
      expect(value).not.toHaveProperty('enabled')
      expect(value).not.toHaveProperty('createdAt')
      expect(value).not.toHaveProperty('updatedAt')
    }
  })

  it('list returns user defs plus qualified plugin defs, user-wins on collision', async () => {
    const dir = await tempDir('lookup-list-')
    const store = await makeStore(dir, [def('reviewer'), def('off', { enabled: false })])
    const lookup = new PluginAgentLookup(store, () => [def('demo:reviewer'), def('reviewer', { prompt: 'PLUGIN-SHADOW' })])
    const names = lookup.list().map((d) => d.name)
    expect(names).toContain('reviewer')
    expect(names).toContain('off')
    expect(names).toContain('demo:reviewer')
    // The colliding bare plugin def is dropped, the user def kept verbatim.
    expect(lookup.list().filter((d) => d.name === 'reviewer')).toHaveLength(1)
    expect(lookup.get('reviewer')).toMatchObject({ prompt: 'reviewer-PROMPT' })
  })

  it('has + agentUnusableReason distinguish disabled from undefined', async () => {
    const dir = await tempDir('lookup-has-')
    const store = await makeStore(dir, [def('reviewer'), def('off', { enabled: false })])
    const lookup = new PluginAgentLookup(store, () => [def('demo:reviewer')])
    expect(lookup.has('reviewer')).toBe(true)
    expect(lookup.has('off')).toBe(true)
    expect(lookup.has('demo:reviewer')).toBe(true)
    expect(lookup.has('ghost')).toBe(false)
    expect(agentUnusableReason(lookup, 'reviewer')).toBeNull()
    expect(agentUnusableReason(lookup, 'demo:reviewer')).toBeNull()
    expect(agentUnusableReason(lookup, 'off')).toBe('agent "off" is disabled')
    expect(agentUnusableReason(lookup, 'ghost')).toBe('agent "ghost" is not defined')
  })

  it('never writes the user store file across resolution', async () => {
    const dir = await tempDir('lookup-no-pollution-')
    const store = await makeStore(dir, [def('reviewer')])
    const file = join(dir, 'agent-definitions.json')
    const before = await readFile(file, 'utf8')
    const lookup = new PluginAgentLookup(store, () => [def('demo:reviewer'), def('demo:extra')])
    lookup.get('reviewer')
    lookup.get('demo:reviewer')
    lookup.get('ghost')
    lookup.has('demo:extra')
    lookup.list()
    lookup.getEnabledDefinitions()
    agentUnusableReason(lookup, 'demo:reviewer')
    await store.flush()
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('reads the CURRENT plugin defs per call (live refresh without reconstruction)', async () => {
    const dir = await tempDir('lookup-live-')
    const store = await makeStore(dir, [])
    let current: StoredAgentDefinition[] = [def('demo:reviewer')]
    const lookup = new PluginAgentLookup(store, () => current)
    expect(lookup.get('demo:reviewer')).toBeDefined()
    expect(lookup.get('demo:extra')).toBeUndefined()
    current = [def('demo:extra')]
    expect(lookup.get('demo:reviewer')).toBeUndefined()
    expect(lookup.get('demo:extra')).toBeDefined()
    expect(lookup.getEnabledDefinitions()).toHaveProperty('demo:extra')
  })

  it('works with no user store (plugin-only)', async () => {
    const lookup = new PluginAgentLookup(undefined, () => [def('demo:reviewer')])
    expect(lookup.get('demo:reviewer')).toBeDefined()
    expect(lookup.get('reviewer')).toBeUndefined()
    expect(lookup.list().map((d) => d.name)).toEqual(['demo:reviewer'])
    expect(Object.keys(lookup.getEnabledDefinitions())).toEqual(['demo:reviewer'])
    expect(agentUnusableReason(lookup, 'reviewer')).toBe('agent "reviewer" is not defined')
  })
})

describe('pluginAgentDefs — qualification', () => {
  it('qualifies bare and nested names, copies (never mutates) the source def', () => {
    const source = def('reviewer')
    const nested = def('frontend:component')
    const out = pluginAgentDefs([contribution('demo', [source, nested])])
    expect(out.map((d) => d.name)).toEqual(['demo:frontend:component', 'demo:reviewer'])
    expect(out.find((d) => d.name === 'demo:reviewer')).toMatchObject({ prompt: 'reviewer-PROMPT' })
    expect(source.name).toBe('reviewer')
    expect(nested.name).toBe('frontend:component')
  })

  it('first plugin wins a same-qualified-name collision', () => {
    const out = pluginAgentDefs([
      contribution('demo', [def('reviewer', { prompt: 'FIRST' })]),
      contribution('demo', [def('reviewer', { prompt: 'SECOND' })]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'demo:reviewer', prompt: 'FIRST' })
  })

  it('empty contributions yield no defs', () => {
    expect(pluginAgentDefs([])).toEqual([])
  })
})

describe('enabledAgentDefinition — bookkeeping strip', () => {
  it('removes exactly the app bookkeeping keys', () => {
    const stripped = enabledAgentDefinition(def('reviewer', { model: 'm', tools: ['Read'] }))
    expect(stripped).toEqual({ description: 'reviewer description', prompt: 'reviewer-PROMPT', model: 'm', tools: ['Read'] })
  })
})

// ── real-loader coerce pipeline ─────────────────────────────────────────────

describe('plugin agent coerce pipeline (real loader)', () => {
  async function makePluginEntry(root: string, name: string): Promise<EnabledPluginEntry> {
    const dir = join(root, 'plugins', name)
    await mkdir(dir, { recursive: true })
    return { key: `${name}@mp`, name, dir, cloneDir: join(root, 'mp-clone') }
  }

  async function writeAgent(entry: EnabledPluginEntry, rel: string, fields: Record<string, string>, body: string): Promise<void> {
    const file = join(entry.dir, 'agents', rel)
    await mkdir(join(file, '..'), { recursive: true })
    const frontmatter = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
    await writeFile(file, `${frontmatter}${body}\n`, 'utf8')
  }

  it('strips unsupported / illegal fields through the closed-field coerce', async () => {
    const dir = await tempDir('lookup-coerce-')
    const entry = await makePluginEntry(dir, 'demo')
    await writeAgent(entry, 'reviewer.md', {
      description: 'Reviews code',
      tools: 'Read, Grep',
      model: 'sonnet',
      maxTurns: 'abc',
      effort: 'ultra',
      bogusField: 'x',
    }, 'You are a reviewer.')
    const contributions = await listPluginContributions({ getEnabledPluginEntries: () => [entry] })
    const lookup = new PluginAgentLookup(undefined, () => pluginAgentDefs(contributions))
    const resolved = lookup.get('demo:reviewer')!
    expect(resolved).toMatchObject({ tools: ['Read', 'Grep'], model: 'sonnet' })
    expect(resolved.prompt).toContain('You are a reviewer.')
    expect(resolved.maxTurns).toBeUndefined()
    expect(resolved.effort).toBeUndefined()
    expect(resolved).not.toHaveProperty('bogusField')
  })
})

// ── NativeSession integration ───────────────────────────────────────────────

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function agentTurn(toolUseId: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Agent' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

type CapturedRequest = { messages: unknown[]; system: string; model: string; tools: Array<{ name: string }> }

function capturingStreamer(scripts: CanonicalEvent[][], requests: CapturedRequest[]) {
  return async function* (req: CapturedRequest) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
}

let userMsgSeq = 0
function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: `u-${++userMsgSeq}`,
  }
}

function portsWithPlugins(stateDir: string, entries: EnabledPluginEntry[]): NativeHostPorts {
  const source = {
    getEnabledPluginEntries: (keys?: string[]) =>
      keys === undefined ? entries : entries.filter((e) => keys.includes(e.key)),
  }
  return { ...makeNativePorts({ stateDir }), plugin: { listContributions: (enabled) => listPluginContributions(source, enabled) } }
}

async function makePluginEntry(root: string, name: string): Promise<EnabledPluginEntry> {
  const dir = join(root, 'plugins', name)
  await mkdir(dir, { recursive: true })
  return { key: `${name}@mp`, name, dir, cloneDir: join(root, 'mp-clone') }
}

async function writePluginAgent(entry: EnabledPluginEntry, rel: string, description: string, body: string, fields: Record<string, string> = {}): Promise<void> {
  const file = join(entry.dir, 'agents', rel)
  await mkdir(join(file, '..'), { recursive: true })
  const frontmatter = ['---', `description: ${description}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
  await writeFile(file, `${frontmatter}${body}\n`, 'utf8')
}

const allowTool = async (_name: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })

describe('NativeSession plugin agents', () => {
  it('supportedAgents lists qualified plugin defs alongside builtins and user defs', async () => {
    const dir = await tempDir('native-plugin-agents-list-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-REVIEW-PROMPT')
    const store = await makeStore(dir, [def('reviewer', { description: 'User reviewer' })])
    const provider = new NativeProvider({ stateDir: dir, agentStore: store, ports: portsWithPlugins(dir, [entry]) })
    const session = provider.createSession({ id: 'plugin-agents-list', cwd: dir })
    try {
      const agents = (await session.supportedAgents?.()) as Array<{ name: string; description?: string; prompt?: string }>
      const names = agents.map((a) => a.name)
      expect(names).toContain('general-purpose')
      expect(names).toContain('Explore')
      expect(names).toContain('reviewer')
      expect(names).toContain('demo:reviewer')
      expect(names.filter((n) => n === 'reviewer')).toHaveLength(1)
      const pluginRow = agents.find((a) => a.name === 'demo:reviewer')!
      expect(pluginRow.description).toBe('Plugin reviewer')
      expect(pluginRow.prompt).toContain('PLUGIN-REVIEW-PROMPT')
    } finally {
      await session.destroy()
    }
  })

  it('the Agent tool resolves a plugin subagent_type end to end', async () => {
    const dir = await tempDir('native-plugin-agents-subagent-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-REVIEW-PROMPT')
    const provider = new NativeProvider({ stateDir: dir, ports: portsWithPlugins(dir, [entry]) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('a1', { description: 'd', prompt: 'p', subagent_type: 'demo:reviewer' }),
      textTurn('NESTED-REPORT'),
      textTurn('DONE'),
    ], requests)
    const session = provider.createSession({ id: 'plugin-agents-subagent', cwd: dir, canUseTool: allowTool })
    const frames: Array<{ type: string }> = []
    void (async () => { for await (const f of session.messages) frames.push(f as { type: string }) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
      const nested = requests.find((r) => !r.tools.some((t) => t.name === 'Agent'))
      expect(nested, 'a nested subagent request must be captured').toBeDefined()
      expect(nested!.system).toContain('PLUGIN-REVIEW-PROMPT')
    } finally {
      await session.destroy()
    }
  })

  it('an unknown plugin subagent_type is a loud error result', async () => {
    const dir = await tempDir('native-plugin-agents-unknown-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-REVIEW-PROMPT')
    const provider = new NativeProvider({ stateDir: dir, ports: portsWithPlugins(dir, [entry]) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('a1', { description: 'd', prompt: 'p', subagent_type: 'demo:ghost' }),
      textTurn('DONE'),
    ], requests)
    const session = provider.createSession({ id: 'plugin-agents-unknown', cwd: dir, canUseTool: allowTool })
    const frames: Array<{ type: string; message?: { content: Array<{ is_error?: boolean; content?: unknown }> } }> = []
    void (async () => { for await (const f of session.messages) frames.push(f as never) })()
    try {
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
      const toolResult = frames.find((f) => f.type === 'user' && f.message?.content?.[0]?.is_error === true)
      expect(toolResult).toBeDefined()
      expect(JSON.stringify(toolResult!.message!.content[0]!.content)).toContain('unknown subagent_type: demo:ghost')
    } finally {
      await session.destroy()
    }
  })

  it('applyFlagSettings switches the main persona to a plugin agent for the next turn', async () => {
    const dir = await tempDir('native-plugin-agents-persona-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-PERSONA', { model: 'plugin-model' })
    const provider = new NativeProvider({ stateDir: dir, ports: portsWithPlugins(dir, [entry]) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([textTurn('first'), textTurn('second')], requests)
    const session = provider.createSession({ id: 'plugin-agents-persona', cwd: dir, model: 'base-model' })
    const frames: Array<{ type: string }> = []
    void (async () => { for await (const f of session.messages) frames.push(f as { type: string }) })()
    try {
      session.enqueueUserMessage(userMsg('first') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
      await session.applyFlagSettings?.({ agent: 'demo:reviewer' })
      session.enqueueUserMessage(userMsg('second') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(2))
      expect(requests[0].system).not.toContain('PLUGIN-PERSONA')
      expect(requests[1].system).toContain('PLUGIN-PERSONA')
      expect(requests[1].model).toBe('plugin-model')
    } finally {
      await session.destroy()
    }
  })

  it('applyFlagSettings rejects an unknown plugin persona name', async () => {
    const dir = await tempDir('native-plugin-agents-persona-unknown-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-PERSONA')
    const provider = new NativeProvider({ stateDir: dir, ports: portsWithPlugins(dir, [entry]) })
    const session = provider.createSession({ id: 'plugin-agents-persona-unknown', cwd: dir })
    try {
      await expect(session.applyFlagSettings?.({ agent: 'demo:ghost' })).rejects.toThrow('agent "demo:ghost" is not defined')
    } finally {
      await session.destroy()
    }
  })

  it('reloadSkills refreshes plugin agents live (listing + subagent resolution, no respawn)', async () => {
    const dir = await tempDir('native-plugin-agents-reload-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-REVIEW-PROMPT')
    const provider = new NativeProvider({ stateDir: dir, ports: portsWithPlugins(dir, [entry]) })
    const requests: CapturedRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = capturingStreamer([
      agentTurn('a1', { description: 'd', prompt: 'p', subagent_type: 'demo:extra' }),
      textTurn('NESTED-EXTRA'),
      textTurn('DONE'),
    ], requests)
    const session = provider.createSession({ id: 'plugin-agents-reload', cwd: dir, canUseTool: allowTool })
    const frames: Array<{ type: string }> = []
    void (async () => { for await (const f of session.messages) frames.push(f as { type: string }) })()
    try {
      expect(((await session.supportedAgents?.()) as Array<{ name: string }>).map((a) => a.name)).not.toContain('demo:extra')
      await writePluginAgent(entry, 'extra.md', 'Plugin extra', 'PLUGIN-EXTRA-PROMPT')
      await session.reloadSkills?.()
      expect(((await session.supportedAgents?.()) as Array<{ name: string }>).map((a) => a.name)).toContain('demo:extra')
      session.enqueueUserMessage(userMsg('delegate') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
      const nested = requests.find((r) => !r.tools.some((t) => t.name === 'Agent'))
      expect(nested!.system).toContain('PLUGIN-EXTRA-PROMPT')
    } finally {
      await session.destroy()
    }
  })
})

// ── /agents route union ─────────────────────────────────────────────────────

describe('GET /sessions/:id/agents — plugin union', () => {
  it('lists plugin defs from native supportedAgents once, unioned with user defs', async () => {
    const dir = await tempDir('native-plugin-agents-route-')
    const entry = await makePluginEntry(dir, 'demo')
    await writePluginAgent(entry, 'reviewer.md', 'Plugin reviewer', 'PLUGIN-REVIEW-PROMPT')
    const store = await makeStore(dir, [def('reviewer', { description: 'User reviewer' })])
    const provider = new NativeProvider({ stateDir: dir, agentStore: store, ports: portsWithPlugins(dir, [entry]) })
    const session = provider.createSession({ id: 'plugin-agents-route', cwd: dir })
    try {
      const sm = { supportedAgents: vi.fn(async () => session.supportedAgents?.()) }
      const app = buildSessionRouter(sm as unknown as SessionManager, undefined, store)
      const res = await app.request('/sessions/plugin-agents-route/agents')
      expect(res.status).toBe(200)
      const { agents } = await res.json() as { agents: Array<{ name: string }> }
      const names = agents.map((a) => a.name)
      expect(names).toContain('demo:reviewer')
      expect(names).toContain('reviewer')
      expect(names).toContain('general-purpose')
      expect(names.filter((n) => n === 'demo:reviewer')).toHaveLength(1)
      expect(names.filter((n) => n === 'reviewer')).toHaveLength(1)
    } finally {
      await session.destroy()
    }
  })
})

// The structural surface the lookup satisfies is the one the host store provides.
describe('AgentStoreReadSurface assignability', () => {
  it('a real AgentDefinitionStore satisfies the read surface', async () => {
    const dir = await tempDir('lookup-surface-')
    const store = await makeStore(dir, [def('reviewer')])
    const surface: AgentStoreReadSurface = store
    expect(surface.get('reviewer')).toMatchObject({ name: 'reviewer' })
    expect(surface.has('reviewer')).toBe(true)
    expect(surface.list()).toHaveLength(1)
    expect(surface.getEnabledDefinitions()).toHaveProperty('reviewer')
  })
})