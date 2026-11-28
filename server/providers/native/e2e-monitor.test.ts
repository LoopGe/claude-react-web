// server/providers/native/e2e-monitor.test.ts
//
// Acceptance coverage for MID-TURN round-boundary injection delivery (Task 10).
// A Monitor event (or any backgrounded-task completion) arriving while a turn is
// still running must join the NEXT round's request messages at the round
// boundary — before the turn settles — not wait for the next idle window.
// Hook-rewake wakes stay idle-only (never drained mid-turn). User input queued
// mid-turn keeps its priority over a pending injection at the next idle window.
// Monitor expiry injects a status notification and settles the task; a second
// Monitor call (re-arm) works after the first expires. A persisted injection
// rebuilds into the model history after resume, and the host disk replay hides
// the foldable completion via classifyTaskNotificationInjection.
//
// The manager stays in the fixture so the host pump's real content
// classification / task fold / turn stamping run exactly as in production.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRecordUi } from '../../../shared/tasks.js'
import type { SessionHooksConfig } from '../../../shared/hooks.js'
import {
  classifyTaskNotificationInjection,
  isTaskNotificationUserMessage,
  parseTaskNotificationInjection,
} from '../../../shared/user-frames.js'
import { shouldHideByDefault } from '../../../shared/message-visibility.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import type { ProviderSessionHandle } from '../types.js'
import { nativeCoreOf } from '../native-host-frame-adapter.js'
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

/** The neutral core's pending-injection queue (private by design) — the
 *  deterministic observation point for "queued mid-turn, not yet delivered". */
function injectionQueue(handle: ProviderSessionHandle): Array<{ kind: string }> {
  return (nativeCoreOf(handle) as unknown as { systemInjections: Array<{ kind: string }> }).systemInjections
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

function injectionFrames(frames: Frame[]): Frame[] {
  return frames.filter((frame) => isTaskNotificationUserMessage(frame))
}

function informationalBanners(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'system' && frame.subtype === 'informational')
}

function toolResultBlocks(frames: Frame[], toolUseId: string): Array<Record<string, any>> {
  return frames.flatMap((frame) => {
    if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) return []
    return frame.message.content.filter((block: Record<string, unknown>) =>
      block.type === 'tool_result' && block.tool_use_id === toolUseId,
    )
  })
}

const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`

/** A long-lived Monitor command: writes a start marker, then emits ONE event
 *  line when its release file appears (writing an `emitted` marker AFTER the
 *  line so the test can gate on production), and keeps running so the watch
 *  does not settle — the event delivers without a completion notification. */
async function controlledMonitor(cwd: string, name: string) {
  const script = join(cwd, `${name}.cjs`)
  const started = join(cwd, `${name}.started`)
  const releasePath = join(cwd, `${name}.release`)
  const emitted = join(cwd, `${name}.emitted`)
  const line = `${name.toUpperCase()}-EVENT-LINE`
  await writeFile(script, [
    "const fs = require('node:fs')",
    'const [started, release, emitted, line] = process.argv.slice(2)',
    "fs.writeFileSync(started, 'started')",
    'let done = false',
    'const timer = setInterval(() => {',
    '  if (done || !fs.existsSync(release)) return',
    '  done = true',
    '  console.log(line)',
    "  fs.writeFileSync(emitted, 'emitted')",
    '}, 10)',
  ].join('\n'), 'utf8')
  return {
    command: `node ${quote(script)} ${quote(started)} ${quote(releasePath)} ${quote(emitted)} ${quote(line)}`,
    started,
    emitted,
    line,
    async release() { await writeFile(releasePath, 'release', 'utf8') },
  }
}

/** A foreground Bash that parks until its release file appears, then prints a
 *  final output and exits — the long-running tool that keeps a turn active
 *  across a round boundary while a Monitor event arrives. */
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
  return {
    command: `node ${quote(script)} ${quote(started)} ${quote(releasePath)} ${quote(output)}`,
    started,
    output,
    async release() { await writeFile(releasePath, 'release', 'utf8') },
  }
}

/** A command that stays alive indefinitely (never exits on its own) — used to
 *  drive Monitor timeout expiry. */
function aliveCommand(): string {
  return 'node -e "setInterval(() => {}, 1000)"'
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

describe('native mid-turn Monitor/task-notification delivery', () => {
  it('a Monitor event arriving mid-turn joins the NEXT round request before the turn settles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-monitor-mid-'))
    dirs.push(dir)
    const monitor = await controlledMonitor(dir, 'mon-mid')
    const bash = await controlledBash(dir, 'mon-mid-bash')
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('mon-mid', 'Monitor', { description: 'watch the feed', command: monitor.command })
      if (round === 2) return toolUseTurn('mon-mid-bash', 'Bash', { command: bash.command })
      return textTurn('MID-TURN-DONE')
    })
    const id = await createSession(fx, dir, 'mon-mid')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'watch then work')
      await waitForFile(monitor.started)
      await waitForFile(bash.started)
      // Round 2's foreground Bash parks the turn. Release the Monitor event so
      // it queues MID-TURN (the batch flushes ~200ms after the line lands).
      await monitor.release()
      await waitForFile(monitor.emitted)
      await vi.waitFor(() => {
        expect(injectionQueue(handle).some((item) => item.kind === 'task-notification')).toBe(true)
      }, { timeout: 5000 })
      // Queued, but NOT yet delivered: the turn is still active (round 2 parked),
      // no injection frame, no result, and only two requests so far.
      expect(fx.requests).toHaveLength(2)
      expect(injectionFrames(frames)).toHaveLength(0)
      expect(topLevelResults(frames)).toHaveLength(0)

      // Let the foreground Bash finish → round 3's boundary drains the event.
      await bash.release()
      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(1)
        expect(fx.requests).toHaveLength(3)
      }, { timeout: 5000 })

      // The event rode the NEXT round's request (round 3), BEFORE the turn
      // settled — exactly ONE top-level result, not a separate idle turn.
      const third = JSON.stringify(fx.requests[2].messages)
      expect(third).toContain('<task-notification>')
      expect(third).toContain('<event>')
      expect(third).toContain(monitor.line)
      expect(topLevelResults(frames)).toHaveLength(1)
      expect(topLevelResults(frames)[0].result).toBe('MID-TURN-DONE')
      expect(topLevelResults(frames)[0].is_error).toBeFalsy()

      // The event injection is a non-foldable neutral card (no tool-use-id):
      // it never settles the running watch record.
      const injections = injectionFrames(frames)
      expect(injections).toHaveLength(1)
      expect(parseTaskNotificationInjection(injections[0])).toBeNull()
      expect(classifyTaskNotificationInjection(injections[0])).toEqual({ foldable: false, hasPayload: true })
      expect(liveSession(fx.sm, id).tasks.get('mon-mid')?.status).toBe('running')
      // No informational banner (that is the hook-rewake path).
      expect(informationalBanners(frames)).toHaveLength(0)
      // No stray second turn after stabilization.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(topLevelResults(frames)).toHaveLength(1)
    } finally {
      await bash.release()
      unsubscribe()
    }
  }, 30000)

  it('a hook-rewake wake arriving mid-turn is NOT drained — it waits for idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-monitor-rewake-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'mon-rewake-bash')
    // One-shot asyncRewake UserPromptSubmit: the user turn's dispatch backgrounds
    // it, the background exit-2 enqueues a wake MID-TURN (round 1 Bash parked).
    const upsCommand = 'input=$(cat)\nprintf \'%s\\n\' "$input" >> ups-inputs.jsonl\nif [ -f rewake.flag ]; then exit 0; fi\ntouch rewake.flag\necho seed-wake >&2\nexit 2'
    const hooks: SessionHooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: upsCommand, shell: 'bash', asyncRewake: true }] }],
    }
    let releaseRound2!: () => void
    const round2Gate = new Promise<void>((resolve) => { releaseRound2 = resolve })
    const fx = await makeFixture(dir)
    fx.setStream(async (_req, round) => {
      if (round === 1) return toolUseTurn('mon-rewake-bash', 'Bash', { command: bash.command })
      if (round === 2) {
        // Park the turn's second round so the wake's idle-only delivery can be
        // observed while the turn is still active (no race past settlement).
        await round2Gate
        return textTurn('PARENT-DONE')
      }
      return textTurn('WAKE-TURN-DONE')
    })
    const id = await createSession(fx, dir, 'mon-rewake', hooks)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'go')
      await waitForFile(bash.started)
      // The wake queues while round 1's Bash parks the turn.
      await vi.waitFor(() => {
        expect(injectionQueue(handle).some((item) => item.kind === 'hook-rewake')).toBe(true)
      }, { timeout: 15000 })
      // Release the Bash → round 2 starts and parks. Its boundary must NOT drain
      // the hook-rewake: the wake stays queued while the turn is active.
      await bash.release()
      await vi.waitFor(() => expect(fx.requests).toHaveLength(2), { timeout: 5000 })
      const second = JSON.stringify(fx.requests[1].messages)
      expect(second).not.toContain('Stop hook blocking error from command')
      expect(injectionQueue(handle).some((item) => item.kind === 'hook-rewake')).toBe(true)
      expect(informationalBanners(frames)).toHaveLength(0)
      expect(topLevelResults(frames)).toHaveLength(0)

      // Let round 2 finish → the turn settles, and ONLY then does the wake
      // deliver as its own idle turn (banner + feedback).
      releaseRound2()
      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(2)
        expect(fx.requests).toHaveLength(3)
      }, { timeout: 5000 })
      expect(topLevelResults(frames)[0].result).toBe('PARENT-DONE')
      const third = JSON.stringify(fx.requests[2].messages)
      expect(third).toContain('Stop hook blocking error from command')
      expect(informationalBanners(frames)).toHaveLength(1)
      expect(topLevelResults(frames)[1].result).toBe('WAKE-TURN-DONE')
    } finally {
      await bash.release()
      releaseRound2()
      unsubscribe()
    }
  }, 30000)

  it('user input queued mid-turn takes priority over a pending injection at the next idle window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-monitor-priority-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'mon-priority-bash')
    let releaseFinal!: () => void
    const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve })
    const fx = await makeFixture(dir)
    fx.setStream(async (_req, round) => {
      if (round === 1) return toolUseTurn('mon-priority-bash', 'Bash', { command: bash.command })
      if (round === 2) {
        // The turn's FINAL round parks on a gate: a notification queued during
        // this park has no further round boundary to drain into, so it waits for
        // idle — where the queued user input must win.
        await finalGate
        return textTurn('PARENT-FINAL')
      }
      return textTurn('USER-TURN-DONE')
    })
    const id = await createSession(fx, dir, 'mon-priority')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    const handle = liveSession(fx.sm, id).handle

    try {
      await fx.sm.send(id, 'first prompt')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('mon-priority-bash')).resolves.toBe(true)
      await vi.waitFor(() => expect(fx.requests).toHaveLength(2), { timeout: 5000 })
      // Settle the background task DURING the parked final round → notification
      // queues with no round boundary left in the PARENT turn. Then queue user
      // input behind it.
      await bash.release()
      await vi.waitFor(() => {
        expect(injectionQueue(handle).some((item) => item.kind === 'task-notification')).toBe(true)
      }, { timeout: 5000 })
      await fx.sm.send(id, 'USER-SECOND')
      // Let the final round finish → the parent turn settles with BOTH the
      // notification and the user input pending.
      releaseFinal()
      await vi.waitFor(() => expect(topLevelResults(frames)).toHaveLength(2), { timeout: 5000 })

      // Idle priority: the pump selects the USER turn first (not an injection-
      // only turn). The user prompt leads the next request; the pending
      // notification then rides that user turn's round boundary (mid-turn
      // delivery), so it is delivered AFTER the user turn started — never before.
      expect(topLevelResults(frames)[0].result).toBe('PARENT-FINAL')
      expect(topLevelResults(frames)[1].result).toBe('USER-TURN-DONE')
      expect(fx.requests).toHaveLength(3)
      const userRequest = JSON.stringify(fx.requests[2].messages)
      expect(userRequest).toContain('USER-SECOND')
      expect(userRequest).toContain('<task-notification>')
      expect(userRequest).toContain(bash.output)
      // No injection-only turn preceded the user turn, and no stray turn after.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(topLevelResults(frames)).toHaveLength(2)
    } finally {
      await bash.release()
      releaseFinal()
      unsubscribe()
    }
  }, 30000)

  it('Monitor expiry injects a status notification and settles the task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-monitor-expiry-'))
    dirs.push(dir)
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('mon-expiry', 'Monitor', { description: 'short watch', command: aliveCommand(), timeout_ms: 250 })
      if (round === 2) return textTurn('AFTER-LAUNCH')
      return textTurn('AFTER-EXPIRY')
    })
    const id = await createSession(fx, dir, 'mon-expiry')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    try {
      await fx.sm.send(id, 'watch briefly')
      // The launch turn settles, then the watch expires (~250ms) and its status
      // notification delivers as an idle continuation turn.
      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(2)
        expect(taskNotifications(frames, 'mon-expiry')).toHaveLength(1)
      }, { timeout: 5000 })
      // Expiry is the designed end of a watch, not a failure → completed.
      expect(taskNotifications(frames, 'mon-expiry')[0].status).toBe('completed')
      expect(liveSession(fx.sm, id).tasks.get('mon-expiry')).toMatchObject({ status: 'completed', isBackgrounded: true })
      // The foldable status injection carries the expiry result.
      const injections = injectionFrames(frames)
      expect(injections).toHaveLength(1)
      const parsed = parseTaskNotificationInjection(injections[0])
      expect(parsed).toMatchObject({ taskId: 'mon-expiry', toolUseId: 'mon-expiry', status: 'completed' })
      expect(parsed!.result).toContain('expired')
      const continuation = JSON.stringify(fx.requests[2].messages)
      expect(continuation).toContain('<task-notification>')
      expect(continuation).toContain('expired')
      expect(topLevelResults(frames)[1].result).toBe('AFTER-EXPIRY')
    } finally {
      unsubscribe()
    }
  }, 30000)

  it('re-arms: a second Monitor call works after the first expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-monitor-rearm-'))
    dirs.push(dir)
    const second = await controlledMonitor(dir, 'mon-rearm-2')
    const fx = await makeFixture(dir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('mon-rearm-1', 'Monitor', { description: 'first watch', command: aliveCommand(), timeout_ms: 250 })
      if (round === 2) return textTurn('FIRST-DONE')
      if (round === 3) return textTurn('EXPIRY-DONE')
      if (round === 4) return toolUseTurn('mon-rearm-2', 'Monitor', { description: 'second watch', command: second.command })
      if (round === 5) return textTurn('SECOND-DONE')
      return textTurn('EVENT-DONE')
    })
    const id = await createSession(fx, dir, 'mon-rearm')
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    try {
      // Phase 1: the first watch expires and settles.
      await fx.sm.send(id, 'first watch')
      await vi.waitFor(() => {
        expect(topLevelResults(frames)).toHaveLength(2)
        expect(liveSession(fx.sm, id).tasks.get('mon-rearm-1')?.status).toBe('completed')
      }, { timeout: 5000 })

      // Phase 2: a fresh user turn launches a SECOND Monitor — re-arm works.
      await fx.sm.send(id, 'second watch')
      await waitForFile(second.started)
      await vi.waitFor(() => {
        expect(liveSession(fx.sm, id).tasks.get('mon-rearm-2')?.status).toBe('running')
        expect(toolResultBlocks(frames, 'mon-rearm-2')).toHaveLength(1)
      }, { timeout: 5000 })
      expect(liveSession(fx.sm, id).tasks.get('mon-rearm-1')?.status).toBe('completed')

      // The second watch delivers an event (idle continuation here), proving the
      // re-armed watch is live and injecting.
      await second.release()
      await waitForFile(second.emitted)
      await vi.waitFor(() => {
        expect(injectionFrames(frames).some((f) => JSON.stringify(f).includes(second.line))).toBe(true)
      }, { timeout: 5000 })
      expect(liveSession(fx.sm, id).tasks.get('mon-rearm-2')?.status).toBe('running')
    } finally {
      unsubscribe()
    }
  }, 30000)

  it('a mid-turn-persisted injection rebuilds into model history after resume; disk replay hides the foldable completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-monitor-resume-'))
    dirs.push(dir)
    const bash = await controlledBash(dir, 'mon-resume-bash')
    const first = await makeFixture(dir)
    first.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('mon-resume-bash', 'Bash', { command: bash.command })
      if (round === 2) return toolUseTurn('mon-resume-read', 'TaskOutput', { task_id: 'mon-resume-bash', block: true, timeout: 5000 })
      return textTurn('PARENT-DONE')
    })
    const id = await createSession(first, dir, 'mon-resume')
    const firstFrames = collectFrames(first.sm, id)
    const handle = liveSession(first.sm, id).handle

    try {
      await first.sm.send(id, 'detach then read')
      await waitForFile(bash.started)
      await expect(handle.backgroundTasks!('mon-resume-bash')).resolves.toBe(true)
      await vi.waitFor(() => expect(first.requests).toHaveLength(2), { timeout: 5000 })
      // The task settles while round 2's TaskOutput blocks → the foldable
      // completion injects MID-TURN (round 3) and persists as a user/message.
      await bash.release()
      await vi.waitFor(() => expect(topLevelResults(firstFrames.frames)).toHaveLength(1), { timeout: 5000 })
      expect(injectionFrames(firstFrames.frames)).toHaveLength(1)
      const midTurn = JSON.stringify(first.requests[2].messages)
      expect(midTurn).toContain('<task-notification>')
      expect(midTurn).toContain(bash.output)
      firstFrames.unsubscribe()

      // Restart: a fresh provider/manager over the same state dir resumes the
      // session. The persisted injection must rebuild into the model history.
      await first.sm.shutdown()
      const resumed = await makeFixture(dir)
      resumed.setStream(() => textTurn('RESUMED-DONE'))
      const resumedInfo = await resumed.sm.resume(id, { permissionMode: 'bypassPermissions' })
      sessionIds.push({ sm: resumed.sm, id: resumedInfo.id })
      const resumedFrames = collectFrames(resumed.sm, id)
      await resumed.sm.send(id, 'after resume')
      await vi.waitFor(() => expect(topLevelResults(resumedFrames.frames)).toHaveLength(1), { timeout: 5000 })
      const resumedRequest = JSON.stringify(resumed.requests[0].messages)
      expect(resumedRequest).toContain('<task-notification>')
      expect(resumedRequest).toContain(bash.output)
      resumedFrames.unsubscribe()

      // The host disk replay hides the foldable completion via the shared
      // content classifier (its output routes to the TasksPanel, not the row set).
      const page = await resumed.provider.readHistoryPage(id, { limit: 50 })
      const diskInjection = (page.messages as Frame[]).find((m) => isTaskNotificationUserMessage(m))
      expect(diskInjection).toBeDefined()
      expect(classifyTaskNotificationInjection(diskInjection!)).toEqual({ foldable: true, hasPayload: true })
      expect(shouldHideByDefault(diskInjection!)).toBe(true)
    } finally {
      await bash.release()
    }
  }, 30000)
})