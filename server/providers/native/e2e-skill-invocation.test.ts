// Stage C integration proof through the real SessionManager, PermissionBroker,
// NativeProvider and native JSONL log. Only the Anthropic stream and compact
// summarizer are replaced: `_testStream` plays scripted canonical rounds and
// the summarizer records the exact input it receives without calling a network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDefinitionStore, type StoredAgentDefinition } from '../../agent-definition-store.js'
import { summarizeForCompact } from '../../compact-summary.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'
import { loadNativeSessionLogSync, NativeSessionLog } from './session-log/log.js'
import type { NativeLogEvent } from './session-log/format.js'

vi.mock('../../compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => 'COMPACT SUMMARY'),
}))

type Frame = Record<string, any>
type CreateOptions = Parameters<SessionManager['create']>[0]
type ModelMessage = { role: string; content: unknown }

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: ModelMessage[]
}

interface Fixture {
  sm: SessionManager
  provider: NativeProvider
  agentStore: AgentDefinitionStore
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []
let previousConfigDir: string | undefined

beforeEach(async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'sm-native-skill-recovery-config-'))
  dirs.push(configDir)
  await mkdir(join(configDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  vi.mocked(summarizeForCompact).mockReset()
  vi.mocked(summarizeForCompact).mockResolvedValue('COMPACT SUMMARY')
}, 20000)

afterEach(async () => {
  vi.restoreAllMocks()
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already deleted or manager shut down */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
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

async function makeEnv(): Promise<{ cwd: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sm-native-skill-recovery-'))
  dirs.push(root)
  const cwd = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(cwd, { recursive: true })
  await mkdir(stateDir, { recursive: true })
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
    system: string
    tools: unknown[]
    messages: unknown[]
  }) {
    requests.push({
      system: req.system,
      tools: [...req.tools] as Array<{ name: string }>,
      messages: structuredClone(req.messages) as ModelMessage[],
    })
    const script = scripts.shift()
    if (!script) throw new Error('unexpected native stream request: no scripted round queued')
    for (const event of script) yield event
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  // No canUseTool override: sessions exercise the manager's real PermissionBroker.
  const sm = new SessionManager({
    store,
    providers: registry,
    agentStore,
    forwardSubagentText: true,
  })
  managers.push(sm)
  return { sm, provider, agentStore, requests, scripts }
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
    model: 'test-model',
    provider: 'native',
    title: 'skill-invocation-recovery-e2e',
    permissionMode: 'dontAsk',
    ...extra,
  })
  return remember(fx.sm, info.id)
}

async function commandNames(sm: SessionManager, id: string): Promise<string[]> {
  const commands = await sm.supportedCommands(id) as Array<{ name: string }>
  return commands.map((command) => command.name)
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
  fx: Fixture,
  id: string,
  frames: Frame[],
  text: string,
): Promise<Frame> {
  const resultCount = frames.filter((frame) => frame.type === 'result').length
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((frame) => frame.type === 'result').length).toBe(resultCount + 1)
  }, { timeout: 5000 })
  return frames.filter((frame) => frame.type === 'result').at(-1)!
}

async function writeSkill(
  cwd: string,
  name: string,
  body: string,
  frontmatter: string[] = [],
): Promise<void> {
  const dir = join(cwd, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    ...frontmatter,
    '---',
    '',
    body,
  ].join('\n'), 'utf8')
}

function canonicalBody(cwd: string, name: string, body: string): string {
  return `Base directory for this skill: ${join(cwd, '.claude', 'skills', name)}\n\n${body}`
}

function normalizedContent(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    const record = block as Frame
    return typeof record.text === 'string' ? record.text : contentText(record.content)
  }).join('\n')
}

function frameText(frame: unknown): string {
  if (!frame || typeof frame !== 'object') return ''
  const record = frame as Frame
  return contentText(record.message?.content ?? record.content)
}

function userText(frame: unknown): string {
  if (!frame || typeof frame !== 'object') return ''
  const content = (frame as Frame).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text')
    .map((block) => block.text as string).join('\n')
}

function framesText(frames: unknown): string {
  return Array.isArray(frames) ? frames.map(frameText).join('\n') : frameText(frames)
}

function userFramesText(frames: unknown): string {
  return Array.isArray(frames) ? frames.map(userText).join('\n') : userText(frames)
}

function projectMessages(messages: readonly ModelMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((message) => ({
    role: message.role,
    content: normalizedContent(message.content),
  }))
}

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistantMessage(text: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function skillEvents(events: readonly NativeLogEvent[]): Extract<NativeLogEvent, { type: 'session/skill' }>[] {
  return events.filter((event): event is Extract<NativeLogEvent, { type: 'session/skill' }> =>
    event.type === 'session/skill')
}

function liveHandle(sm: SessionManager, id: string): { history: ModelMessage[]; log: NativeSessionLog } {
  return (sm as unknown as {
    sessions: Map<string, { handle: { history: ModelMessage[]; log: NativeSessionLog } }>
  }).sessions.get(id)!.handle
}

function toolResultsOf(request: StreamRequest, toolUseId: string): Array<{
  text: string
  isError: boolean
}> {
  const results: Array<{ text: string; isError: boolean }> = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Frame[]) {
      if (block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue
      results.push({
        text: Array.isArray(block.content)
          ? block.content.map((part: Frame) => part.text ?? '').join('\n')
          : String(block.content ?? ''),
        isError: block.is_error === true,
      })
    }
  }
  return results
}

async function appendLogEvents(stateDir: string, id: string, cwd: string, events: Parameters<NativeSessionLog['append']>[0][]): Promise<void> {
  const log = NativeSessionLog.open({ stateDir, id, cwd, resume: true })
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

async function runSlashWithSubagent(fx: Fixture, id: string, frames: Frame[], agentId: string): Promise<void> {
  fx.scripts.push(
    toolUseTurn(agentId, 'Agent', {
      description: 'child context',
      prompt: 'CHILD CONTEXT',
      subagent_type: 'general-purpose',
    }),
    textTurn('CHILD RESULT'),
    textTurn('PARENT RESULT'),
  )
  await sendAndWait(fx, id, frames, '/demo compact this')
}

describe('native skill invocation recovery end to end', () => {
  it('keeps one raw invocation across live, disk, search, raw-cut fork and resume with ordered model history', async () => {
    const { cwd, stateDir } = await makeEnv()
    const demoV1 = 'DEMO-V1\n'
    await writeSkill(cwd, 'demo', demoV1)
    const first = await makeFixture(stateDir)
    const id = await createSession(first, cwd)
    const seen = collect(first.sm, id)
    const body = canonicalBody(cwd, 'demo', demoV1)

    first.scripts.push(textTurn('SLASH REPLY'))
    await sendAndWait(first, id, seen.frames, '/demo do X')
    expect(first.requests).toHaveLength(1)
    expect(first.requests[0].messages.slice(-2)).toEqual([
      userMessage('/demo do X'),
      { role: 'user', content: [{ type: 'text', text: body }] },
    ])
    expect(JSON.stringify(first.requests[0].messages.slice(-2)).match(/do X/g)).toHaveLength(1)
    expect(body).not.toContain('name: demo')

    const sourceLog = loadNativeSessionLogSync(stateDir, id)!
    const rawIndex = sourceLog.events.findIndex((event) =>
      event.type === 'user' && JSON.stringify(event.message.content).includes('/demo do X'))
    expect(rawIndex).toBeGreaterThanOrEqual(0)
    expect(sourceLog.events[rawIndex + 1]).toMatchObject({ type: 'session/skill', name: 'demo', body })
    const rawUuid = (sourceLog.events[rawIndex] as { uuid: string }).uuid

    const diskPage = await first.provider.readHistoryPage(id, { limit: 50 })
    expect(framesText(diskPage.messages)).toContain('/demo do X')
    expect(framesText(diskPage.messages)).not.toContain(body)
    expect(await first.sm.searchMessages('/demo do X', { sessionId: id })).not.toHaveLength(0)
    expect(await first.sm.searchMessages(body, { sessionId: id })).toHaveLength(0)

    // The real broker's dontAsk read-only path allows this Skill call without a
    // test permission callback. Its result shares the slash body; only the tool
    // protocol adds the User Request suffix.
    first.scripts.push(
      toolUseTurn('skill-tool-1', 'Skill', { skill: 'demo', args: 'TOOL ARGS' }),
      textTurn('TOOL DONE'),
    )
    await sendAndWait(first, id, seen.frames, 'load demo through the tool')
    expect(toolResultsOf(first.requests[2], 'skill-tool-1')).toEqual([{
      text: `${body}\n\n## User Request\nTOOL ARGS`,
      isError: false,
    }])
    expect(userFramesText(first.sm.getHistory(id))).not.toContain(body)
    expect(seen.frames.filter((frame) =>
      frame.type === 'user' && userText(frame).includes(body))).toEqual([])

    // Cutting at the raw user uuid includes its immediately following hidden
    // instruction, but not the later assistant or Skill-tool turns.
    const fork = await first.sm.fork(id, { resumeSessionAt: rawUuid })
    remember(first.sm, fork.id)
    const forkSeen = collect(first.sm, fork.id)
    first.scripts.push(textTurn('FORK REPLY'))
    await sendAndWait(first, fork.id, forkSeen.frames, 'fork next')
    const forkRequest = first.requests[3]
    expect(projectMessages(forkRequest.messages.slice(0, first.requests[0].messages.length)))
      .toEqual(projectMessages(first.requests[0].messages))
    expect(forkRequest.messages.at(-1)).toEqual(userMessage('fork next'))
    const forkEvents = loadNativeSessionLogSync(stateDir, fork.id)!.events
    const forkRaw = forkEvents.findIndex((event) => event.type === 'user' && event.uuid === rawUuid)
    expect(forkEvents[forkRaw + 1]).toMatchObject({ type: 'session/skill', name: 'demo', body })
    expect(JSON.stringify(await first.provider.readHistoryPage(fork.id, { limit: 50 })))
      .toContain('/demo do X')
    forkSeen.unsubscribe()

    const branchHistory = [
      ...first.requests[2].messages,
      assistantMessage('TOOL DONE'),
    ]
    await first.sm.shutdown()
    const second = await makeFixture(stateDir)
    await second.sm.resume(id)
    remember(second.sm, id)
    const resumedSeen = collect(second.sm, id)
    second.scripts.push(textTurn('RESUME REPLY'))
    await sendAndWait(second, id, resumedSeen.frames, 'resume next')
    expect(projectMessages(second.requests[0].messages)).toEqual([
      ...projectMessages(branchHistory),
      ...projectMessages([userMessage('resume next')]),
    ])
    expect(framesText(second.sm.getHistory(id))).toContain('/demo do X')
    expect(userFramesText(second.sm.getHistory(id))).not.toContain(body)
    resumedSeen.unsubscribe()
    seen.unsubscribe()
  })

  it('applies persona and invocation policy, uses a reload on the next turn, and leaves unknown skills as text', async () => {
    const { cwd, stateDir } = await makeEnv()
    await writeSkill(cwd, 'demo', 'DEMO-V1\n')
    await writeSkill(cwd, 'other', 'OTHER\n')
    await writeSkill(cwd, 'model-off', 'MODEL-OFF\n', ['disable-model-invocation: true'])
    await writeSkill(cwd, 'model-only', 'MODEL-ONLY\n', ['user-invocable: false'])
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert({
      name: 'other-only',
      description: 'Allow only other',
      prompt: 'OTHER-ONLY',
      skills: ['other'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    } as StoredAgentDefinition)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)

    fx.scripts.push(textTurn('V1 DONE'))
    await sendAndWait(fx, id, seen.frames, '/demo first')
    expect(fx.requests[0].messages.at(-1)).toEqual({
      role: 'user', content: [{ type: 'text', text: canonicalBody(cwd, 'demo', 'DEMO-V1\n') }],
    })

    await fx.sm.setAgent(id, 'other-only')
    expect(await commandNames(fx.sm, id)).not.toContain('demo')
    expect(await commandNames(fx.sm, id)).toContain('other')
    fx.scripts.push(textTurn('PERSONA EXCLUDED'))
    await sendAndWait(fx, id, seen.frames, '/demo excluded')
    expect(fx.requests[1].messages.at(-1)).toEqual(userMessage('/demo excluded'))
    expect(skillEvents(loadNativeSessionLogSync(stateDir, id)!.events)).toHaveLength(1)

    await fx.sm.setAgent(id, null)
    expect(await commandNames(fx.sm, id)).toContain('demo')
    await writeSkill(cwd, 'demo', 'DEMO-V2\n')
    await fx.sm.reloadSkills(id)
    fx.scripts.push(textTurn('V2 DONE'))
    await sendAndWait(fx, id, seen.frames, '/demo second')
    expect(fx.requests[2].messages.at(-1)).toEqual({
      role: 'user', content: [{ type: 'text', text: canonicalBody(cwd, 'demo', 'DEMO-V2\n') }],
    })
    expect(skillEvents(loadNativeSessionLogSync(stateDir, id)!.events).map((event) => event.body)).toEqual([
      canonicalBody(cwd, 'demo', 'DEMO-V1\n'),
      canonicalBody(cwd, 'demo', 'DEMO-V2\n'),
    ])

    fx.scripts.push(textTurn('MODEL OFF SLASH'))
    await sendAndWait(fx, id, seen.frames, '/model-off user allowed')
    expect(fx.requests[3].messages.at(-1)).toEqual({
      role: 'user', content: [{ type: 'text', text: canonicalBody(cwd, 'model-off', 'MODEL-OFF\n') }],
    })
    fx.scripts.push(
      toolUseTurn('model-off-tool', 'Skill', { skill: 'model-off' }),
      textTurn('MODEL OFF TOOL REFUSED'),
    )
    await sendAndWait(fx, id, seen.frames, 'try model-off through the tool')
    expect(toolResultsOf(fx.requests[5], 'model-off-tool')).toEqual([{
      text: 'unknown skill: model-off', isError: true,
    }])

    fx.scripts.push(textTurn('MODEL ONLY SLASH IS TEXT'))
    await sendAndWait(fx, id, seen.frames, '/model-only slash refused')
    expect(fx.requests[6].messages.at(-1)).toEqual(userMessage('/model-only slash refused'))
    fx.scripts.push(
      toolUseTurn('model-only-tool', 'Skill', { skill: 'model-only', args: 'MODEL ARGS' }),
      textTurn('MODEL ONLY TOOL LOADED'),
    )
    await sendAndWait(fx, id, seen.frames, 'load model-only through the tool')
    expect(toolResultsOf(fx.requests[8], 'model-only-tool')).toEqual([{
      text: `${canonicalBody(cwd, 'model-only', 'MODEL-ONLY\n')}\n\n## User Request\nMODEL ARGS`,
      isError: false,
    }])

    fx.scripts.push(textTurn('UNKNOWN IS TEXT'))
    const unknownResult = await sendAndWait(fx, id, seen.frames, '/does-not-exist anything')
    expect(unknownResult.is_error).not.toBe(true)
    expect(fx.requests[9].messages.at(-1)).toEqual(userMessage('/does-not-exist anything'))
    expect(skillEvents(loadNativeSessionLogSync(stateDir, id)!.events)).toHaveLength(3)
    seen.unsubscribe()
  })

  it('scopes reloaded commands and execution to the active persona through the manager broadcast', async () => {
    const { cwd, stateDir } = await makeEnv()
    await writeSkill(cwd, 'demo', 'DEMO\n')
    await writeSkill(cwd, 'other', 'OTHER\n')
    const fx = await makeFixture(stateDir)
    fx.agentStore.upsert({
      name: 'other-only',
      description: 'Allow only other',
      prompt: 'OTHER-ONLY',
      skills: ['other'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    } as StoredAgentDefinition)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    await fx.sm.setAgent(id, 'other-only')
    const otherCommand = { name: 'other', description: 'other description', argumentHint: '' }
    expect(await fx.sm.supportedCommands(id)).toEqual([otherCommand])

    fx.scripts.push(textTurn('EXCLUDED BEFORE RELOAD'))
    await sendAndWait(fx, id, seen.frames, '/demo before reload')
    expect(fx.requests[0].messages.at(-1)).toEqual(userMessage('/demo before reload'))

    const changes: Frame[] = []
    const sub = fx.sm.subscribeCommandChanges(id)!
    void (async () => {
      for await (const change of sub.iterable) changes.push(change as Frame)
    })()
    expect(await fx.sm.reloadSkills(id)).toEqual({ skills: [otherCommand] })
    await vi.waitFor(() => expect(changes).toContainEqual({ commands: [otherCommand] }))
    expect(await fx.sm.supportedCommands(id)).toEqual([otherCommand])

    fx.scripts.push(textTurn('EXCLUDED AFTER RELOAD'))
    await sendAndWait(fx, id, seen.frames, '/demo after reload')
    expect(fx.requests[1].messages.at(-1)).toEqual(userMessage('/demo after reload'))
    fx.scripts.push(textTurn('OTHER AFTER RELOAD'))
    await sendAndWait(fx, id, seen.frames, '/other still works')
    expect(fx.requests[2].messages.slice(-2)).toEqual([
      userMessage('/other still works'),
      { role: 'user', content: [{ type: 'text', text: canonicalBody(cwd, 'other', 'OTHER\n') }] },
    ])
    expect(skillEvents(loadNativeSessionLogSync(stateDir, id)!.events).map((event) => event.name)).toEqual(['other'])
    sub.unsubscribe()
    seen.unsubscribe()
  })

  it('recovers a pre-request flush failure into identical next-live and resumed history without starting a stream', async () => {
    const { cwd, stateDir } = await makeEnv()
    await writeSkill(cwd, 'demo', 'DURABLE FAILURE BODY\n')
    const first = await makeFixture(stateDir)
    const id = await createSession(first, cwd)
    const seen = collect(first.sm, id)
    const body = canonicalBody(cwd, 'demo', 'DURABLE FAILURE BODY\n')
    const flush = vi.spyOn(liveHandle(first.sm, id).log, 'flush')
      .mockRejectedValueOnce(new Error('pre-request flush failed'))

    const failed = await sendAndWait(first, id, seen.frames, '/demo survives failure')
    expect(failed.is_error).toBe(true)
    expect(failed.result).toContain('pre-request flush failed')
    expect(first.requests).toHaveLength(0)
    flush.mockRestore()

    first.scripts.push(textTurn('RECOVERED LIVE'))
    await sendAndWait(first, id, seen.frames, 'next live')
    expect(first.requests).toHaveLength(1)
    expect(first.requests[0].messages.slice(-3)).toEqual([
      userMessage('/demo survives failure'),
      { role: 'user', content: [{ type: 'text', text: body }] },
      userMessage('next live'),
    ])
    const events = loadNativeSessionLogSync(stateDir, id)!.events
    expect(events.filter((event) => event.type === 'user' && JSON.stringify(event).includes('/demo survives failure')))
      .toHaveLength(1)
    expect(skillEvents(events).filter((event) => event.body === body)).toHaveLength(1)

    await first.sm.shutdown()
    const second = await makeFixture(stateDir)
    await second.sm.resume(id)
    remember(second.sm, id)
    const resumedSeen = collect(second.sm, id)
    second.scripts.push(textTurn('RECOVERED RESUME'))
    await sendAndWait(second, id, resumedSeen.frames, 'next resumed')
    expect(projectMessages(second.requests[0].messages)).toEqual([
      ...projectMessages(first.requests[0].messages),
      ...projectMessages([assistantMessage('RECOVERED LIVE'), userMessage('next resumed')]),
    ])
    resumedSeen.unsubscribe()
    seen.unsubscribe()
  })

  it('does not backfill a raw-only crash prefix or rewrite an old expanded user event', async () => {
    const { cwd, stateDir } = await makeEnv()
    await writeSkill(cwd, 'demo', 'CURRENT BODY\n')
    const first = await makeFixture(stateDir)
    const crashedId = await createSession(first, cwd)
    const legacyId = await createSession(first, cwd)
    await first.sm.shutdown()

    await appendLogEvents(stateDir, crashedId, cwd, [{
      type: 'user',
      uuid: randomUUID(),
      session_id: crashedId,
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '/demo crashed before injection' }] },
    }])
    const legacyDocument = [
      '---', 'name: demo', 'description: old expanded skill', '---', '', 'OLD EXPANDED BODY',
    ].join('\n')
    await appendLogEvents(stateDir, legacyId, cwd, [{
      type: 'user',
      uuid: randomUUID(),
      session_id: legacyId,
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: legacyDocument }] },
    }, { type: 'turn/end', reason: 'completed' }])

    const second = await makeFixture(stateDir)
    await second.sm.resume(crashedId)
    remember(second.sm, crashedId)
    const seen = collect(second.sm, crashedId)
    second.scripts.push(textTurn('AFTER CRASH'))
    await sendAndWait(second, crashedId, seen.frames, 'after crash')
    expect(second.requests[0].messages.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: '/demo crashed before injection' }] },
      userMessage('after crash'),
    ])
    expect(skillEvents(loadNativeSessionLogSync(stateDir, crashedId)!.events)).toEqual([])

    const legacyBefore = loadNativeSessionLogSync(stateDir, legacyId)!.events
    await second.sm.resume(legacyId)
    remember(second.sm, legacyId)
    expect(framesText(liveHandle(second.sm, legacyId).history)).toContain(legacyDocument)
    expect(framesText(liveHandle(second.sm, legacyId).history)).not.toContain('CURRENT BODY')
    const legacyPage = await second.provider.readHistoryPage(legacyId, { limit: 50 })
    expect(framesText(legacyPage.messages)).toContain(legacyDocument)
    expect(framesText(legacyPage.messages)).not.toContain('CURRENT BODY')
    expect(await second.sm.searchMessages('/demo original', { sessionId: legacyId })).toHaveLength(0)
    expect(await second.sm.searchMessages('OLD EXPANDED BODY', { sessionId: legacyId })).not.toHaveLength(0)
    expect(loadNativeSessionLogSync(stateDir, legacyId)!.events).toEqual(legacyBefore)
    expect(skillEvents(legacyBefore)).toEqual([])
    seen.unsubscribe()
  })

  it('feeds manual and automatic compaction the hidden instruction and real subagent context without exposing either projection', async () => {
    const { cwd, stateDir } = await makeEnv()
    await writeSkill(cwd, 'demo', 'COMPACT SKILL BODY\n')
    const fx = await makeFixture(stateDir)
    const body = canonicalBody(cwd, 'demo', 'COMPACT SKILL BODY\n')

    const manualId = await createSession(fx, cwd, { permissionMode: 'bypassPermissions' })
    const manualSeen = collect(fx.sm, manualId)
    await runSlashWithSubagent(fx, manualId, manualSeen.frames, 'agent-manual')
    expect(framesText(fx.sm.getHistory(manualId))).not.toContain(body)
    expect(await fx.sm.searchMessages(body, { sessionId: manualId })).toHaveLength(0)
    let manualInput: Frame[] = []
    vi.mocked(summarizeForCompact).mockImplementationOnce(async (messages) => {
      manualInput = structuredClone(messages) as Frame[]
      return 'MANUAL SUMMARY'
    })
    const manualNext = await fx.sm.compact(manualId)
    remember(fx.sm, manualNext.id)
    const manualTexts = manualInput.map(frameText)
    expect(manualTexts.join('\n')).toContain('/demo compact this')
    expect(manualTexts.join('\n')).toContain(body)
    expect(manualInput.findIndex((frame) => frameText(frame).includes('/demo compact this')))
      .toBeLessThan(manualInput.findIndex((frame) => frameText(frame).includes(body)))
    expect(manualInput.some((frame) =>
      frame.parent_tool_use_id === 'agent-manual' && frameText(frame).includes('CHILD RESULT'))).toBe(true)
    manualSeen.unsubscribe()

    const autoId = await createSession(fx, cwd, {
      permissionMode: 'bypassPermissions',
      settings: { autoCompactWindow: 1 },
    } as Partial<CreateOptions>)
    const autoSeen = collect(fx.sm, autoId)
    let autoInput: Frame[] = []
    vi.mocked(summarizeForCompact).mockImplementationOnce(async (messages) => {
      autoInput = structuredClone(messages) as Frame[]
      return 'AUTO SUMMARY'
    })
    await runSlashWithSubagent(fx, autoId, autoSeen.frames, 'agent-auto')
    await vi.waitFor(() => {
      expect(autoInput.length).toBeGreaterThan(0)
      expect(fx.sm.getHistory(autoId)?.some((frame) =>
        (frame as Frame).subtype === 'compact_boundary')).toBe(true)
    }, { timeout: 5000 })
    expect(autoInput.map(frameText).join('\n')).toContain(body)
    expect(autoInput.some((frame) =>
      frame.parent_tool_use_id === 'agent-auto' && frameText(frame).includes('CHILD RESULT'))).toBe(true)
    expect(framesText(fx.sm.getHistory(autoId))).not.toContain(body)
    expect(framesText((await fx.provider.readHistoryPage(autoId, { limit: 50 })).messages)).not.toContain(body)
    expect(await fx.sm.searchMessages(body, { sessionId: autoId })).toHaveLength(0)
    expect(skillEvents(loadNativeSessionLogSync(stateDir, autoId)!.events)).toHaveLength(1)
    autoSeen.unsubscribe()
  })
}, { timeout: 20000 })
