// server/providers/native/e2e-notification-injection.test.ts
//
// Acceptance coverage for background-completion notification injection (the
// CLI's <task-notification> user-injection parity). A backgrounded task's
// settle must emit a USER conversation frame whose leading text is the
// content-classified XML injection, wake the model at the next idle window,
// and reach the next round's request messages — while a hook-rewake wake in
// the same session stays banner-only with its stop_hook_active:true Stop
// guard. The manager stays in the fixture so the host pump's real
// classification / turn stamping / task fold run exactly as in production.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRecordUi } from '../../../shared/tasks.js'
import type { SessionHooksConfig } from '../../../shared/hooks.js'
import { isTaskNotificationUserMessage, parseTaskNotificationInjection } from '../../../shared/user-frames.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import type { ProviderSessionHandle } from '../types.js'
import type { CanonicalEvent } from './canonical.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'

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
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
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

async function createSession(fx: Fixture, cwd: string, title: string, hooks?: SessionHooksConfig): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title,
    canUseTool: allowingCanUseTool(),
    ...(hooks ? { settings: { hooks } } : {}),
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

function topLevelResults(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'result' && frame.parent_tool_use_id == null)
}

function taskNotifications(frames: Frame[], taskId: string): Frame[] {
  return frames.filter((frame) => frame.subtype === 'task_notification' && frame.task_id === taskId)
}

/** The host's own content classifier is the oracle: a frame it recognizes IS
 *  a deliverable injection (no synthetic marker needed). */
function injectionFrames(frames: Frame[]): Frame[] {
  return frames.filter((frame) => isTaskNotificationUserMessage(frame))
}

function informationalBanners(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'system' && frame.subtype === 'informational')
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

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** A round-2 stream that parks until its signal aborts, then throws — the
 *  interrupted-turn fixture (the parent turn never settles on its own). */
function parkUntilAborted(req: StreamRequest): Promise<CanonicalEvent[]> {
  return new Promise<void>((resolve) => {
    if (req.signal.aborted) resolve()
    else req.signal.addEventListener('abort', () => resolve(), { once: true })
  }).then(() => { throw new Error('parent stream interrupted') })
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

describe('native background-completion notification injection', () => {
  it('a backgrounded Bash settling while idle injects a task-notification user frame and wakes the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-notif-idle-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'notif-idle')
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('notif-idle', 'Bash', { command: bash.command })
      if (round === 2) return textTurn('PARENT-IDLE-DONE')
      return textTurn('NOTIF-TURN-DONE')
    })
    const id = await createSession(fx, dir, 'notif-idle')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'run a background command')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('notif-idle')).resolves.toBe(true)
      // The parent turn settles BEFORE the task completes: the settle lands
      // on an idle session.
      await vi.waitFor(() => {
        expect(fx.requests).toHaveLength(2)
        expect(topLevelResults(frames)).toHaveLength(1)
      }, { timeout: 5000 })
      expect(injectionFrames(frames)).toHaveLength(0)

      await bash.release()
      await vi.waitFor(() => {
        expect(injectionFrames(frames)).toHaveLength(1)
        expect(topLevelResults(frames)).toHaveLength(2)
      }, { timeout: 5000 })

      // The injection is a top-level USER frame the host classifier recognizes
      // by content, carrying the real completion facts.
      const injection = injectionFrames(frames)[0]
      expect(injection.type).toBe('user')
      expect(injection.parent_tool_use_id).toBeNull()
      expect(typeof injection.uuid).toBe('string')
      const parsed = parseTaskNotificationInjection(injection)
      expect(parsed).toMatchObject({
        taskId: 'notif-idle',
        toolUseId: 'notif-idle',
        status: 'completed',
        summary: bash.command,
      })
      expect(parsed!.result).toContain(bash.output)

      // The continuation turn's request carries the XML verbatim.
      expect(fx.requests).toHaveLength(3)
      const continuation = JSON.stringify(fx.requests[2].messages)
      expect(continuation).toContain('<task-notification>')
      expect(continuation).toContain(bash.output)
      expect(topLevelResults(frames)[1].result).toBe('NOTIF-TURN-DONE')
      expect(topLevelResults(frames)[1].is_error).toBeFalsy()

      // The live operational task/notification frame STILL emits (TasksPanel
      // roster); the two host folds agree on ONE record.
      expect(taskNotifications(frames, 'notif-idle')).toHaveLength(1)
      const tasks = liveSession(fx.sm, id).tasks
      expect(tasks.size).toBe(1)
      expect(tasks.get('notif-idle')).toMatchObject({ status: 'completed', isBackgrounded: true })
      expect(tasks.get('notif-idle')?.result).toContain(bash.output)

      // No informational banner for the notification kind, and exactly-once
      // delivery (no stray second turn after stabilization).
      expect(informationalBanners(frames)).toHaveLength(0)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(topLevelResults(frames)).toHaveLength(2)
      expect(injectionFrames(frames)).toHaveLength(1)
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('a hook-rewake wake in the same session stays banner-only; the Stop guards differ per injection kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-notif-vs-wake-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'notif-vs-wake')
    // One-shot rewake (flag) + recorders on both events, mirroring the rewake
    // session pin: the wake turn must not re-dispatch UserPromptSubmit, and
    // its Stop input carries stop_hook_active:true.
    const upsCommand = 'input=$(cat)\nprintf \'%s\\n\' "$input" >> ups-inputs.jsonl\nif [ -f rewake.flag ]; then exit 0; fi\ntouch rewake.flag\necho seed-wake >&2\nexit 2'
    const stopCommand = 'input=$(cat)\nprintf \'%s\\n\' "$input" >> stop-inputs.jsonl'
    const hooks: SessionHooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: upsCommand, shell: 'bash', asyncRewake: true }] }],
      Stop: [{ hooks: [{ type: 'command', command: stopCommand, shell: 'bash' }] }],
    }
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('notif-vs-wake', 'Bash', { command: bash.command })
      if (round === 2) return textTurn('PARENT-DONE')
      if (round === 3) return textTurn('WAKE-TURN-DONE')
      return textTurn('NOTIF-TURN-DONE')
    })
    const id = await createSession(fx, dir, 'notif-vs-wake', hooks)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'go')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('notif-vs-wake')).resolves.toBe(true)
      // Turn 1 (user) settles, then the hook wake delivers as turn 2 — the
      // bash task is still running, so no notification exists yet.
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(2), { timeout: 15000 })
      expect(fx.requests).toHaveLength(3)
      expect(injectionFrames(frames)).toHaveLength(0)
      const banners = informationalBanners(frames)
      expect(banners).toHaveLength(1)
      expect(banners[0].content).toContain('Stop hook feedback')
      // The wake turn's request carries the hook feedback, never the XML.
      const wakeRequest = JSON.stringify(fx.requests[2].messages)
      expect(wakeRequest).toContain('Stop hook blocking error from command')
      expect(wakeRequest).not.toContain('<task-notification>')

      const stopInputs = await readJsonl(join(dir, 'stop-inputs.jsonl'))
      expect(stopInputs).toHaveLength(2)
      expect(stopInputs[0].stop_hook_active).toBe(false)
      expect(stopInputs[1].stop_hook_active).toBe(true)

      // Now the task settles: the notification delivers as turn 3 with a
      // FRESH Stop guard (it is not stop-hook feedback).
      await bash.release()
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(3), { timeout: 5000 })
      expect(injectionFrames(frames)).toHaveLength(1)
      expect(informationalBanners(frames)).toHaveLength(1)
      const notifRequest = JSON.stringify(fx.requests[3].messages)
      expect(notifRequest).toContain('<task-notification>')
      expect(notifRequest).toContain(bash.output)
      const finalStopInputs = await readJsonl(join(dir, 'stop-inputs.jsonl'))
      expect(finalStopInputs).toHaveLength(3)
      expect(finalStopInputs[2].stop_hook_active).toBe(false)
      // Neither system turn re-fed the prompt hooks.
      const upsInputs = await readJsonl(join(dir, 'ups-inputs.jsonl'))
      expect(upsInputs).toHaveLength(1)
      expect(upsInputs[0].prompt).toBe('go')
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('a notification pending behind an interrupted turn delivers at the next idle window (not withdrawn)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-notif-interrupt-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'notif-interrupt')
    const fx = await makeFixture(dir)
    fx.setStream((req, round) => {
      if (round === 1) return toolUseTurn('notif-interrupt', 'Bash', { command: bash.command })
      if (round === 2) return parkUntilAborted(req)
      return textTurn('POST-INTERRUPT-NOTIF')
    })
    const id = await createSession(fx, dir, 'notif-interrupt')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'detach then interrupt')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('notif-interrupt')).resolves.toBe(true)
      await vi.waitFor(() => expect(fx.requests).toHaveLength(2), { timeout: 5000 })
      // The task settles while the parent turn is still parked: the
      // notification queues behind the active turn.
      await bash.release()
      await vi.waitFor(() => expect(taskNotifications(frames, 'notif-interrupt')).toHaveLength(1), { timeout: 5000 })
      expect(injectionFrames(frames)).toHaveLength(0)

      // cancelQueued drains USER input only — the injection queue is untouched.
      await handle.interrupt!({ cancelQueued: true })
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(2), { timeout: 5000 })
      expect(topLevelResults(frames)[0].result).toBe('interrupted by user')
      expect(topLevelResults(frames)[1].result).toBe('POST-INTERRUPT-NOTIF')
      expect(topLevelResults(frames)[1].is_error).toBeFalsy()
      expect(injectionFrames(frames)).toHaveLength(1)
      expect(fx.requests).toHaveLength(3)
      expect(JSON.stringify(fx.requests[2].messages)).toContain('<task-notification>')
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('destroy() with a pending notification drops it and resolves without hanging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-notif-destroy-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'notif-destroy')
    const fx = await makeFixture(dir)
    fx.setStream((req, round) => {
      if (round === 1) return toolUseTurn('notif-destroy', 'Bash', { command: bash.command })
      return parkUntilAborted(req)
    })
    const id = await createSession(fx, dir, 'notif-destroy')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'detach then destroy')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('notif-destroy')).resolves.toBe(true)
      await vi.waitFor(() => expect(fx.requests).toHaveLength(2), { timeout: 5000 })
      // Settle behind the parked turn so a notification is genuinely pending
      // in the idle-injection queue at destroy time.
      await bash.release()
      await vi.waitFor(() => expect(taskNotifications(frames, 'notif-destroy')).toHaveLength(1), { timeout: 5000 })

      let cap: NodeJS.Timeout | undefined
      await expect(Promise.race([
        handle.destroy!(),
        new Promise<void>((_resolve, reject) => {
          cap = setTimeout(() => reject(new Error('destroy hung with a pending notification')), 5000)
          cap.unref()
        }),
      ])).resolves.toBeUndefined()
      clearTimeout(cap)

      // The pending notification never became a turn or a frame.
      expect(fx.requests).toHaveLength(2)
      expect(injectionFrames(frames)).toHaveLength(0)
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('a foreground Bash settle does NOT inject (the parent already holds the result)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-notif-foreground-'))
    dirs.push(dir)
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('fg-no-notif', 'Bash', { command: 'echo FG-OUTPUT' })
      return textTurn('FG-DONE')
    })
    const id = await createSession(fx, dir, 'fg-no-notif')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    try {
      await fx.sm.send(id, 'run a foreground command')
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(1), { timeout: 5000 })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(topLevelResults(frames)).toHaveLength(1)
      expect(fx.requests).toHaveLength(2)
      expect(injectionFrames(frames)).toHaveLength(0)
      expect(taskNotifications(frames, 'fg-no-notif')).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  }, 30000)
})