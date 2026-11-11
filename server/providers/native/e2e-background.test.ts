// server/providers/native/e2e-background.test.ts
//
// Acceptance coverage for native mid-flight background tasks. Lifecycle
// controls are invoked on the live provider handle to exercise the capability's
// acceptance scenarios directly; a separate case covers the existing REST
// routes. The manager remains in the fixture so its pump folds exactly the
// TasksPanel state and durable task-result sidecar that production serves.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRecordUi } from '../../../shared/tasks.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { buildApiRouter } from '../../routes/index.js'
import { ProviderRegistry } from '../registry.js'
import type { ProviderSessionHandle } from '../types.js'
import type { CanonicalEvent } from './canonical.js'
import { NativeProvider } from './native-provider.js'

type Frame = Record<string, any>

type StreamRequest = {
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
  signal: AbortSignal
}

type StreamHandler = (req: StreamRequest, round: number) => CanonicalEvent[] | Promise<CanonicalEvent[]>

type LiveSession = {
  handle: ProviderSessionHandle
  tasks: Map<string, TaskRecordUi>
  subagentHistory: Frame[]
}

type Fixture = {
  provider: NativeProvider
  sm: SessionManager
  requests: StreamRequest[]
  setStream(handler: StreamHandler): void
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

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

function allowingCanUseTool(): NonNullable<Parameters<SessionManager['create']>[0]['canUseTool']> {
  const handler = async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  })
  return handler as unknown as NonNullable<Parameters<SessionManager['create']>[0]['canUseTool']>
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir })
  const requests: StreamRequest[] = []
  let handler: StreamHandler = () => textTurn('unscripted response')
  provider._testStream = (async function* (req: StreamRequest) {
    requests.push({
      tools: req.tools,
      messages: structuredClone(req.messages),
      signal: req.signal,
    })
    for (const event of await handler(req, requests.length)) yield event
  }) as unknown as NativeProvider['_testStream']
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { provider, sm, requests, setStream: (next) => { handler = next } }
}

async function createSession(fx: Fixture, cwd: string, title: string): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title,
    canUseTool: allowingCanUseTool(),
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function liveSession(sm: SessionManager, id: string): LiveSession {
  return (sm as unknown as { sessions: Map<string, LiveSession> }).sessions.get(id)!
}

function collectFrames(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe(): void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const frame of sub.iterable) frames.push(frame as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

function toolResultBlocks(frames: Frame[], toolUseId: string): Array<Record<string, any>> {
  return frames.flatMap((frame) => {
    if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) return []
    return frame.message.content.filter((block: Record<string, unknown>) =>
      block.type === 'tool_result' && block.tool_use_id === toolUseId,
    )
  })
}

function toolResultText(block: Record<string, any>): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return block.content.map((part: { text?: string }) => part.text ?? '').join('\n')
}

function topLevelResults(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'result' && frame.parent_tool_use_id == null)
}

function taskNotifications(frames: Frame[], taskId: string): Frame[] {
  return frames.filter((frame) => frame.subtype === 'task_notification' && frame.task_id === taskId)
}

function isNestedRequest(req: StreamRequest): boolean {
  return !req.tools.some((tool) => tool.name === 'Agent')
}

async function controlledBash(cwd: string, name: string) {
  const script = join(cwd, `${name}.cjs`)
  const started = join(cwd, `${name}.started`)
  const releasePath = join(cwd, `${name}.release`)
  const output = `${name.toUpperCase()}-FINAL-OUTPUT`
  await writeFile(script, [
    "const fs = require('node:fs')",
    'const [started, release, output] = process.argv.slice(2)',
    "fs.writeFileSync(started, 'started')",
    'const timer = setInterval(() => {',
    '  if (!fs.existsSync(release)) return',
    '  clearInterval(timer)',
    '  console.log(output)',
    '}, 10)',
  ].join('\n'), 'utf8')
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`
  return {
    command: `node ${quote(script)} ${quote(started)} ${quote(releasePath)} ${quote(output)}`,
    started,
    output,
    async release() { await writeFile(releasePath, 'release', 'utf8') },
  }
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 5000 })
}

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already removed by shutdown */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  dirs.length = 0
})

describe('native background task acceptance through direct provider handles', () => {
  it('detaches Bash, continues the parent, and agrees on final output in TasksPanel and TaskOutput', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-background-bash-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'bash-detach')
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('bash-detach', 'Bash', { command: bash.command })
      if (round === 2) {
        return toolUseTurn('read-bash-output', 'TaskOutput', {
          task_id: 'bash-detach', block: true, timeout: 5000,
        })
      }
      return textTurn('PARENT-AFTER-BASH')
    })
    const id = await createSession(fx, dir, 'bash-detach')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'run and retrieve a command')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('bash-detach')).resolves.toBe(true)
      await vi.waitFor(() => expect(fx.requests).toHaveLength(2), { timeout: 5000 })
      const acknowledgements = toolResultBlocks(frames, 'bash-detach')
      expect(acknowledgements).toHaveLength(1)
      expect(acknowledgements[0].is_error).toBe(false)
      expect(toolResultText(acknowledgements[0])).toContain('TaskOutput')
      await bash.release()
      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(1)
        expect(taskNotifications(frames, 'bash-detach')).toHaveLength(1)
      }, { timeout: 5000 })

      const panel = liveSession(fx.sm, id).tasks.get('bash-detach')
      expect(panel).toMatchObject({ status: 'completed', isBackgrounded: true })
      expect(panel?.result).toContain(bash.output)
      const outputResults = toolResultBlocks(frames, 'read-bash-output')
      expect(outputResults).toHaveLength(1)
      expect(outputResults[0].is_error).toBe(false)
      expect(toolResultText(outputResults[0])).toContain(panel!.result!)
      expect(toolResultBlocks(frames, 'bash-detach')).toHaveLength(1)
      expect(topLevelResults(frames)).toHaveLength(1)
      expect(topLevelResults(frames)[0].result).toBe('PARENT-AFTER-BASH')
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('detaches Agent, preserves sidechain parentage, and publishes its real report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-background-agent-'))
    dirs.push(dir)
    const fx = await makeFixture(dir)
    let nestedRounds = 0
    let markNestedStarted!: () => void
    const nestedStarted = new Promise<void>((resolve) => { markNestedStarted = resolve })
    let releaseNested!: () => void
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
    fx.setStream(async (req) => {
      if (isNestedRequest(req)) {
        nestedRounds++
        markNestedStarted()
        await nestedGate
        return textTurn('REAL-AGENT-REPORT')
      }
      return nestedRounds === 0
        ? toolUseTurn('agent-detach', 'Agent', { description: 'background research', prompt: 'inspect' })
        : textTurn('PARENT-AFTER-AGENT')
    })
    const id = await createSession(fx, dir, 'agent-detach')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'delegate research')
      await nestedStarted
      await expect(handle.backgroundTasks!('agent-detach')).resolves.toBe(true)
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(1), { timeout: 5000 })
      const acknowledgements = toolResultBlocks(frames, 'agent-detach')
      expect(acknowledgements).toHaveLength(1)
      expect(acknowledgements[0].is_error).toBe(false)
      expect(toolResultText(acknowledgements[0])).toContain('TaskOutput')
      releaseNested()
      await vi.waitFor(() => {
        expect(taskNotifications(frames, 'agent-detach')).toHaveLength(1)
      }, { timeout: 5000 })

      const notifications = taskNotifications(frames, 'agent-detach')
      expect(notifications[0].result).toBe('REAL-AGENT-REPORT')
      expect(notifications[0].result).not.toContain('running in the background')
      const sidechain = frames.filter((frame) => frame.parent_tool_use_id != null)
      expect(sidechain.length).toBeGreaterThan(0)
      expect(sidechain.every((frame) => frame.parent_tool_use_id === 'agent-detach')).toBe(true)
      expect(liveSession(fx.sm, id).subagentHistory.every(
        (frame) => frame.parent_tool_use_id === 'agent-detach',
      )).toBe(true)
      expect(toolResultBlocks(frames, 'agent-detach')).toHaveLength(1)
      expect(topLevelResults(frames)).toHaveLength(1)
      expect(topLevelResults(frames)[0].result).toBe('PARENT-AFTER-AGENT')
    } finally {
      releaseNested()
      unsubscribe()
    }
  }, 30000)

  it('detaches nested Bash without detaching the foreground outer Agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-background-nested-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'nested-bash')
    const fx = await makeFixture(dir)
    let parentRounds = 0
    let nestedRounds = 0
    fx.setStream((req) => {
      if (isNestedRequest(req)) {
        nestedRounds++
        return nestedRounds === 1
          ? toolUseTurn('nested-bash', 'Bash', { command: bash.command })
          : textTurn('OUTER-AGENT-REPORT')
      }
      parentRounds++
      return parentRounds === 1
        ? toolUseTurn('outer-agent', 'Agent', { description: 'nested command', prompt: 'run one command' })
        : textTurn('PARENT-AFTER-NESTED')
    })
    const id = await createSession(fx, dir, 'nested-detach')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'run a nested command')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('nested-bash')).resolves.toBe(true)
      await vi.waitFor(() => expect(nestedRounds).toBe(2), { timeout: 5000 })
      await expect(handle.stopTask!('outer-agent')).rejects.toThrow('not backgrounded')
      expect(liveSession(fx.sm, id).tasks.has('outer-agent')).toBe(false)
      expect(toolResultBlocks(frames, 'outer-agent')).toHaveLength(0)
      const acknowledgements = toolResultBlocks(frames, 'nested-bash')
      expect(acknowledgements).toHaveLength(1)
      expect(toolResultText(acknowledgements[0])).toContain('TaskOutput')
      await bash.release()
      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(1)
        expect(taskNotifications(frames, 'nested-bash')).toHaveLength(1)
      }, { timeout: 5000 })

      const outerResults = toolResultBlocks(frames, 'outer-agent')
      expect(outerResults).toHaveLength(1)
      expect(toolResultText(outerResults[0])).toBe('OUTER-AGENT-REPORT')
      expect(toolResultBlocks(frames, 'nested-bash')).toHaveLength(1)
      const nestedResults = frames.filter((frame) =>
        frame.type === 'user' && frame.message?.content?.[0]?.tool_use_id === 'nested-bash',
      )
      expect(nestedResults).toHaveLength(1)
      expect(nestedResults[0].parent_tool_use_id).toBe('outer-agent')
      expect(topLevelResults(frames)).toHaveLength(1)
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('keeps detached work alive across parent interrupt and terminates it with task Stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-background-stop-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'interrupt-stop')
    const fx = await makeFixture(dir)
    fx.setStream(async (req, round) => {
      if (round === 1) return toolUseTurn('interrupt-stop', 'Bash', { command: bash.command })
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve()
        else req.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('parent stream interrupted')
    })
    const id = await createSession(fx, dir, 'interrupt-stop')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'detach then interrupt')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('interrupt-stop')).resolves.toBe(true)
      await vi.waitFor(() => expect(fx.requests).toHaveLength(2), { timeout: 5000 })
      await handle.interrupt!()
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(1), { timeout: 5000 })
      expect(topLevelResults(frames)[0].result).toBe('interrupted by user')
      expect(liveSession(fx.sm, id).tasks.get('interrupt-stop')?.status).toBe('running')
      expect(taskNotifications(frames, 'interrupt-stop')).toHaveLength(0)

      await handle.stopTask!('interrupt-stop')
      await vi.waitFor(() => {
        expect(liveSession(fx.sm, id).tasks.get('interrupt-stop')?.status).toBe('stopped')
      }, { timeout: 5000 })
      const notifications = taskNotifications(frames, 'interrupt-stop')
      expect(notifications).toHaveLength(1)
      expect(notifications[0].status).toBe('stopped')
      expect(toolResultBlocks(frames, 'interrupt-stop')).toHaveLength(1)
      expect(toolResultText(toolResultBlocks(frames, 'interrupt-stop')[0])).toContain('TaskOutput')
      expect(topLevelResults(frames)).toHaveLength(1)
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('settles detached work on destroy, hides never-detached calls, and forgets old TaskOutput ids on resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-background-restart-'))
    dirs.push(dir)
    const detached = await controlledBash(dir, 'restart-detached')
    const foreground = await controlledBash(dir, 'restart-foreground')
    const first = await makeFixture(dir)
    first.setStream((_req, round) => round === 1
      ? toolUseTurn('restart-detached', 'Bash', { command: detached.command })
      : textTurn('unused detached follow-up'))
    const detachedId = await createSession(first, dir, 'restart-detached')
    const detachedFrames = collectFrames(first.sm, detachedId)
    await first.sm.send(detachedId, 'detach before restart')
    await waitForFile(detached.started)
    const detachedHandle = liveSession(first.sm, detachedId).handle
    await expect(detachedHandle.backgroundTasks!('restart-detached')).resolves.toBe(true)
    expect(toolResultBlocks(detachedFrames.frames, 'restart-detached')).toHaveLength(1)
    await vi.waitFor(() => {
      expect(liveSession(first.sm, detachedId).tasks.get('restart-detached')).toMatchObject({
        status: 'running',
        isBackgrounded: true,
      })
      expect(topLevelResults(detachedFrames.frames)).toHaveLength(1)
    }, { timeout: 5000 })

    first.requests.length = 0
    first.setStream((_req, round) => round === 1
      ? toolUseTurn('restart-foreground', 'Bash', { command: foreground.command })
      : textTurn('unused foreground follow-up'))
    const foregroundId = await createSession(first, dir, 'restart-foreground')
    const foregroundFrames = collectFrames(first.sm, foregroundId)
    await first.sm.send(foregroundId, 'destroy a foreground call')
    await waitForFile(foreground.started)
    expect(liveSession(first.sm, foregroundId).tasks).toHaveLength(0)

    await first.sm.shutdown()
    detachedFrames.unsubscribe()
    foregroundFrames.unsubscribe()
    expect(toolResultBlocks(foregroundFrames.frames, 'restart-foreground')).toHaveLength(0)
    expect(topLevelResults(detachedFrames.frames)).toHaveLength(1)
    expect(topLevelResults(foregroundFrames.frames).length).toBeLessThanOrEqual(1)

    const resumed = await makeFixture(dir)
    let resumedRounds = 0
    resumed.setStream(() => {
      resumedRounds++
      return resumedRounds === 1
        ? toolUseTurn('old-task-output', 'TaskOutput', { task_id: 'restart-detached' })
        : textTurn('RESTART-LOOKUP-DONE')
    })
    const resumedInfo = await resumed.sm.resume(detachedId, { permissionMode: 'bypassPermissions' })
    sessionIds.push({ sm: resumed.sm, id: resumedInfo.id })
    const resumedForeground = await resumed.sm.resume(foregroundId)
    sessionIds.push({ sm: resumed.sm, id: resumedForeground.id })
    expect(liveSession(resumed.sm, foregroundId).tasks).toHaveLength(0)
    await vi.waitFor(() => {
      expect(liveSession(resumed.sm, detachedId).tasks.get('restart-detached')).toBeDefined()
    }, { timeout: 5000 })
    const historical = liveSession(resumed.sm, detachedId).tasks.get('restart-detached')
    expect(historical?.status).toBe('stopped')
    expect([...liveSession(resumed.sm, detachedId).tasks.values()].every(
      (task) => ['completed', 'failed', 'killed', 'stopped'].includes(task.status),
    )).toBe(true)

    const afterRestart = collectFrames(resumed.sm, detachedId)
    await resumed.sm.send(detachedId, 'read the old task')
    await vi.waitFor(() => expect(topLevelResults(afterRestart.frames)).toHaveLength(1), { timeout: 5000 })
    const oldOutput = toolResultBlocks(afterRestart.frames, 'old-task-output')
    expect(oldOutput).toHaveLength(1)
    expect(oldOutput[0].is_error).toBe(true)
    expect(toolResultText(oldOutput[0])).toContain('Unknown or expired task restart-detached')
    expect(liveSession(resumed.sm, detachedId).tasks.get('restart-detached')).toEqual(historical)
    expect(toolResultBlocks(
      [...detachedFrames.frames, ...afterRestart.frames],
      'restart-detached',
    )).toHaveLength(1)
    expect(topLevelResults(afterRestart.frames)).toHaveLength(1)
    expect(liveSession(resumed.sm, foregroundId).tasks).toHaveLength(0)
    afterRestart.unsubscribe()
  }, 30000)

  it('enables the existing background and stop routes without changing their response shapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-background-routes-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'route-stop')
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => round === 1
      ? toolUseTurn('route-stop', 'Bash', { command: bash.command })
      : textTurn('ROUTE-PARENT-DONE'))
    const id = await createSession(fx, dir, 'route-stop')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const app = buildApiRouter(fx.sm)

    try {
      await fx.sm.send(id, 'detach and stop through REST')
      await waitForFile(bash.started)
      const backgroundResponse = await app.request(`/sessions/${id}/tasks/background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolUseId: 'route-stop' }),
      })
      const stopResponse = await app.request(`/sessions/${id}/tasks/route-stop/stop`, { method: 'POST' })
      expect({
        backgroundStatus: backgroundResponse.status,
        stopStatus: stopResponse.status,
      }).toEqual({ backgroundStatus: 200, stopStatus: 200 })
      expect(await backgroundResponse.json()).toEqual({ ok: true, backgrounded: true })
      expect(await stopResponse.json()).toEqual({ ok: true })

      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(1)
        expect(taskNotifications(frames, 'route-stop')).toHaveLength(1)
      }, { timeout: 5000 })
      expect(taskNotifications(frames, 'route-stop')[0].status).toBe('stopped')
      expect(toolResultBlocks(frames, 'route-stop')).toHaveLength(1)
      expect(toolResultText(toolResultBlocks(frames, 'route-stop')[0])).toContain('TaskOutput')
      expect(topLevelResults(frames)).toHaveLength(1)
      expect(topLevelResults(frames)[0].result).toBe('ROUTE-PARENT-DONE')
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)
})
