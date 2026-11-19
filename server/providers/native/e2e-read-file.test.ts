// Native readFile/read-state through the real provider and SessionManager.
// Model streams and compaction summaries are fakes; no network is used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigForTest, config } from '../../config.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import type { CanonicalEvent } from './canonical.js'

vi.mock('../../compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => 'COMPACT SUMMARY'),
}))

const TEST_PROFILE = {
  id: 'read-file-e2e',
  name: 'Read file E2E',
  authToken: 'test-token',
  baseUrl: 'https://api.example.test',
  modelList: ['test-model'],
  modelGroups: [],
  recapModel: '',
  commitMessageModel: '',
}

type Frame = Record<string, any>
type CreateOptions = Parameters<SessionManager['create']>[0]

interface Fixture {
  sm: SessionManager
  provider: NativeProvider
  scripts: CanonicalEvent[][]
  requests: Array<{ messages: unknown[] }>
  project: string
  stateDir: string
}

const managers: SessionManager[] = []
const roots: string[] = []
const subscriptions = new Map<string, { frames: Frame[]; unsubscribe: () => void }>()
let previousConfigDir: string | undefined
const originalConfig = { ...config }

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = await mkdtemp(join(tmpdir(), 'native-read-e2e-config-'))
  roots.push(configDir)
  await mkdir(join(configDir, 'skills'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  __setConfigForTest({
    profiles: [TEST_PROFILE],
    activeProfileId: TEST_PROFILE.id,
    authToken: TEST_PROFILE.authToken,
    baseUrl: TEST_PROFILE.baseUrl,
  })
})

afterEach(async () => {
  for (const subscription of subscriptions.values()) subscription.unsubscribe()
  subscriptions.clear()
  for (const sm of managers.splice(0)) await sm.shutdown()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  __setConfigForTest(originalConfig)
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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

function toolTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

function editTurn(id: string, oldString: string, newString: string): CanonicalEvent[] {
  return toolTurn(id, 'Edit', { file_path: 'a.txt', old_string: oldString, new_string: newString })
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'native-read-e2e-'))
  roots.push(root)
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(project, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(project, 'a.txt'), 'before')
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
  const scripts: CanonicalEvent[][] = []
  const requests: Array<{ messages: unknown[] }> = []
  provider._testStream = async function* (req: { messages: unknown[] }) {
    requests.push({ messages: structuredClone(req.messages) })
    for (const event of scripts.shift() ?? []) yield event
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, provider, scripts, requests, project, stateDir }
}

async function createSession(fx: Fixture, extra: Partial<CreateOptions> = {}): Promise<string> {
  const info = await fx.sm.create({
    cwd: fx.project,
    model: 'test-model',
    provider: 'native',
    title: 'read-file-e2e',
    permissionMode: 'bypassPermissions',
    ...extra,
  })
  return info.id
}

function channel(sm: SessionManager, id: string) {
  const key = `${managers.indexOf(sm)}:${id}`
  let existing = subscriptions.get(key)
  if (!existing) {
    const sub = sm.subscribe(id)
    const frames: Frame[] = []
    void (async () => { for await (const frame of sub.iterable) frames.push(frame as Frame) })()
    existing = { frames, unsubscribe: () => sub.unsubscribe() }
    subscriptions.set(key, existing)
  }
  return existing
}

function dropChannel(sm: SessionManager, id: string) {
  const key = `${managers.indexOf(sm)}:${id}`
  subscriptions.get(key)?.unsubscribe()
  subscriptions.delete(key)
}

async function sendTurn(fx: Fixture, id: string, text = 'run the scripted tools'): Promise<Frame[]> {
  const stream = channel(fx.sm, id)
  const resultCount = stream.frames.filter((frame) => frame.type === 'result').length
  const start = stream.frames.length
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(stream.frames.filter((frame) => frame.type === 'result')).toHaveLength(resultCount + 1)
  }, { timeout: 5000 })
  return stream.frames.slice(start)
}

function toolResult(frames: Frame[], toolUseId: string): Frame {
  for (const frame of frames) {
    if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) continue
    const block = frame.message.content.find((candidate: Frame) =>
      candidate.type === 'tool_result' && candidate.tool_use_id === toolUseId)
    if (block) return block
  }
  throw new Error(`missing tool result ${toolUseId}`)
}

function liveHandle(sm: SessionManager, id: string) {
  return (sm as unknown as {
    sessions: Map<string, {
      history: Frame[]
      lastContextUsage?: unknown
      handle: {
        compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
        readFile?: unknown
        seedReadState?: unknown
      }
    }>
  }).sessions.get(id)!
}

describe('native readFile and read-state through SessionManager', () => {
  it.each(['dontAsk', 'auto'] as const)('reads a complete file under %s', async (permissionMode) => {
    const fx = await makeFixture()
    const id = await createSession(fx, { permissionMode })

    await expect(fx.sm.readFile(id, 'a.txt')).resolves.toEqual({
      available: true,
      contents: 'before',
      encoding: 'utf-8',
    })
  })

  it('seeds through the manager so a model Edit needs no prior model Read', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    await fx.sm.readFile(id, 'a.txt')
    fx.scripts.push(editTurn('edit-host-seed', 'before', 'after'), textTurn('edited'))

    const frames = await sendTurn(fx, id)

    expect(toolResult(frames, 'edit-host-seed').is_error).not.toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('after')
  })

  it('rejects an external edit until a fresh complete host read', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    await fx.sm.readFile(id, 'a.txt')
    await writeFile(join(fx.project, 'a.txt'), 'external')
    fx.scripts.push(editTurn('edit-stale', 'external', 'rejected'), textTurn('stale'))

    const staleFrames = await sendTurn(fx, id)
    expect(toolResult(staleFrames, 'edit-stale').is_error).toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('external')

    await fx.sm.readFile(id, 'a.txt')
    fx.scripts.push(editTurn('edit-reread', 'external', 'accepted'), textTurn('fresh'))
    const freshFrames = await sendTurn(fx, id)
    expect(toolResult(freshFrames, 'edit-reread').is_error).not.toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('accepted')
  })

  it('does not share evidence between two live sessions from one provider', async () => {
    const fx = await makeFixture()
    const a = await createSession(fx)
    const b = await createSession(fx)
    await fx.sm.readFile(a, 'a.txt')
    fx.scripts.push(editTurn('edit-other-session', 'before', 'wrong'), textTurn('not authorized'))

    const frames = await sendTurn(fx, b)

    expect(toolResult(frames, 'edit-other-session').is_error).toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('before')
  })

  it('preserves evidence for in-place compact but clears it for plain clear', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    await fx.sm.readFile(id, 'a.txt')
    await liveHandle(fx.sm, id).handle.compactInPlace('IN-PLACE SUMMARY', {
      uuid: 'compact-in-place', timestamp: new Date().toISOString(),
    })
    fx.scripts.push(editTurn('edit-after-in-place', 'before', 'after'), textTurn('edited'))
    const compactFrames = await sendTurn(fx, id)
    expect(toolResult(compactFrames, 'edit-after-in-place').is_error).not.toBe(true)

    const cleared = await fx.sm.clear(id)
    fx.scripts.push(editTurn('edit-after-clear', 'after', 'wrong'), textTurn('not authorized'))
    const clearFrames = await sendTurn(fx, cleared.id)
    expect(toolResult(clearFrames, 'edit-after-clear').is_error).toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('after')
  })

  it('requires rereading after manual compact clear-with-seed replacement', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    fx.scripts.push(textTurn('history for compaction'))
    await sendTurn(fx, id, 'create some history')
    await fx.sm.readFile(id, 'a.txt')

    const compacted = await fx.sm.compact(id)
    expect(compacted.id).not.toBe(id)
    fx.scripts.push(editTurn('edit-after-manual-compact', 'before', 'wrong'), textTurn('not authorized'))
    const frames = await sendTurn(fx, compacted.id)

    expect(toolResult(frames, 'edit-after-manual-compact').is_error).toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('before')
  })

  it('requires rereading after resume and fork', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    fx.scripts.push(textTurn('persisted history'))
    await sendTurn(fx, id, 'create a resumable transcript')
    await fx.sm.readFile(id, 'a.txt')

    const forked = await fx.sm.fork(id)
    await fx.sm.sleep(id)
    dropChannel(fx.sm, id)
    const resumed = await fx.sm.resume(id)
    expect(resumed.id).toBe(id)

    fx.scripts.push(editTurn('edit-after-resume', 'before', 'wrong-resume'), textTurn('resume requires read'))
    const resumedFrames = await sendTurn(fx, id)
    expect(toolResult(resumedFrames, 'edit-after-resume').is_error).toBe(true)

    fx.scripts.push(editTurn('edit-after-fork', 'before', 'wrong-fork'), textTurn('fork requires read'))
    const forkFrames = await sendTurn(fx, forked.id)
    expect(toolResult(forkFrames, 'edit-after-fork').is_error).toBe(true)
    expect(await readFile(join(fx.project, 'a.txt'), 'utf8')).toBe('before')
  })

  it('emits no message, git, capacity, or durable read-state event for a host read', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    const stream = channel(fx.sm, id)
    const live = liveHandle(fx.sm, id)
    const frameCount = stream.frames.length
    const historyCount = live.history.length
    const usage = live.lastContextUsage
    const logPath = nativeSessionLogPath(fx.stateDir, id)
    const before = await readFile(logPath, 'utf8')

    await fx.sm.readFile(id, 'a.txt')

    expect(stream.frames).toHaveLength(frameCount)
    expect(live.history).toHaveLength(historyCount)
    expect(live.lastContextUsage).toBe(usage)
    const after = await readFile(logPath, 'utf8')
    expect(after).toBe(before)
    expect(after).not.toContain('read-state')
    expect(after).not.toContain('git-snapshot')
    expect(after).not.toContain('context-usage')
  })

  it('advertises readFile only with working read and seed methods', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    const handle = liveHandle(fx.sm, id).handle

    expect(fx.provider.capabilities.supportsReadFile).toBe(true)
    expect(handle.readFile).toBeTypeOf('function')
    expect(handle.seedReadState).toBeTypeOf('function')
    await expect(fx.sm.readFile(id, 'a.txt')).resolves.toMatchObject({ available: true, contents: 'before' })
  })
})
