// server/providers/native/hooks/rewake.test.ts
// T23: async / asyncRewake background execution + idle wake delivery (RS §4.4).
// Two layers:
//   1. Engine/scheduler unit pins (fake executors): an async hook returns
//      immediately (the action proceeds) and runs in the background; an
//      asyncRewake exit-2 enqueues a wake carrying the RS facts; exit-0 (and
//      any non-2 exit) does NOT wake; a runtime {async:true} stdout conversion
//      discards the decision from the current merge.
//   2. Session integration pins (real provider + real bash hooks): the wake is
//      delivered as a system turn when the session is NEXT IDLE — a mid-turn
//      completion waits for the active turn to settle, the model is re-invoked
//      with the hook's stderr/stdout as feedback, and the wake turn's Stop
//      dispatch carries stop_hook_active:true (the notification's
//      stopHookActive fact — a well-behaved rewake Stop hook must terminate).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHookConfig, HookConfig, HookMatcherConfig, HookRuntimeEvent } from '../../../../shared/hooks.js'
import { HookEngine, type HookExecutor } from './engine.js'
import type { HookExecResult } from './output.js'
import type { HookSource } from './types.js'
import {
  asyncDispatchResult,
  asyncTimeoutOf,
  hookWakeOf,
  isAsyncHook,
  type HookWake,
} from './rewake.js'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import type { CanonicalEvent } from '../canonical.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'
import type { Frame } from '../../native-frames.js'
import type { NativeHostPorts } from '../ports.js'
import { nativeSessionLogPath } from '../session-log/paths.js'

// ── unit fixtures ────────────────────────────────────────────────────────────

function ctx(hasContext = true) {
  return { signal: new AbortController().signal, hasContext }
}

function command(commandText: string, extra: Partial<CommandHookConfig> = {}): CommandHookConfig {
  return { type: 'command', command: commandText, ...extra }
}

function sourceOf(groups: HookMatcherConfig[]): HookSource {
  return { kind: 'flag', collect: () => groups }
}

/** An executor whose single result is parked until the test resolves it. */
function deferredExecutor() {
  let resolve!: (result: HookExecResult) => void
  const parked = new Promise<HookExecResult>((r) => { resolve = r })
  const calls: Array<{ hook: HookConfig; input: Record<string, unknown> }> = []
  const executor: HookExecutor = (hook, input) => {
    calls.push({ hook, input })
    return parked
  }
  return { executor, resolve, calls }
}

function fixedExecutor(result: HookExecResult) {
  const executor: HookExecutor = async () => result
  return executor
}

function engineWith(
  executors: Partial<Record<HookConfig['type'], HookExecutor>>,
  groups: HookMatcherConfig[],
  opts: { onWake?: (wake: HookWake) => void; events?: HookRuntimeEvent[] } = {},
): HookEngine {
  return new HookEngine({
    sources: () => [sourceOf(groups)],
    emit: (e) => opts.events?.push(e),
    executors,
    cwd: '/tmp/project',
    sessionId: 'session-1',
    ...(opts.onWake ? { onWake: opts.onWake } : {}),
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const BLOCKED_EXIT2: HookExecResult = { outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'boom' }
const SUCCESS_EXIT0: HookExecResult = { outcome: 'success', exitCode: 0, stdout: '', stderr: '' }

// ── 1. engine / scheduler unit pins ──────────────────────────────────────────

describe('async config predicates and ack facts (RS §4.4)', () => {
  it('isAsyncHook: command async / asyncRewake (rewake implies async); other types never', () => {
    expect(isAsyncHook(command('a.sh', { async: true }))).toBe(true)
    expect(isAsyncHook(command('a.sh', { asyncRewake: true }))).toBe(true)
    expect(isAsyncHook(command('a.sh'))).toBe(false)
    expect(isAsyncHook({ type: 'http', url: 'https://example.com' })).toBe(false)
    expect(isAsyncHook({ type: 'prompt', prompt: 'p' })).toBe(false)
    expect(isAsyncHook({ type: 'agent', prompt: 'p' })).toBe(false)
  })

  it('asyncTimeout = hook.timeout * 1000, else the 600000 command default', () => {
    expect(asyncTimeoutOf(command('a.sh', { timeout: 5 }))).toBe(5000)
    expect(asyncTimeoutOf(command('a.sh'))).toBe(600_000)
    const ack = asyncDispatchResult(command('a.sh', { timeout: 2 }))
    expect(ack.async).toBe(true)
    expect(ack.asyncTimeout).toBe(2000)
    // The immediate ack is a merge no-op: success, no decision, empty stdout.
    expect(ack.outcome).toBe('success')
    expect(ack.decision).toBeUndefined()
    expect(ack.stdout).toBe('')
  })

  it('hookWakeOf carries the RS §4.4 notification facts', () => {
    const wake = hookWakeOf('guard.sh', BLOCKED_EXIT2)
    expect(wake).toEqual({
      summary: 'Stop hook feedback',
      body: 'Stop hook blocking error from command "guard.sh":boom',
      priority: 'next',
      stopHookActive: true,
    })
    // rewakeSummary overrides the default; stdout is the body fallback when
    // stderr is empty.
    const custom = hookWakeOf('guard.sh', {
      outcome: 'blocked', exitCode: 2, stdout: 'out-text', stderr: '',
      decision: { rewakeSummary: 'custom summary' },
    })
    expect(custom.summary).toBe('custom summary')
    expect(custom.body).toBe('Stop hook blocking error from command "guard.sh":out-text')
  })
})

describe('HookEngine async dispatch (RS §4.4)', () => {
  it('async:true returns immediately (action proceeds) and runs in the background', async () => {
    const { executor, resolve, calls } = deferredExecutor()
    const events: HookRuntimeEvent[] = []
    const wakes: HookWake[] = []
    const engine = engineWith({ command: executor }, [{ hooks: [command('bg.sh', { async: true })] }], {
      events,
      onWake: (w) => wakes.push(w),
    })
    // The dispatch resolves while the executor is still parked — even though
    // the eventual result is a block, the current action is NOT blocked.
    const decision = await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.action).toBe('continue')
    expect(calls).toHaveLength(1)
    expect(events.map((e) => e.kind)).toEqual(['started'])
    // The background completion emits the completed activity with the REAL
    // result; a non-rewake async hook never wakes.
    resolve(BLOCKED_EXIT2)
    await waitFor(() => events.some((e) => e.kind === 'completed'))
    const completed = events.find((e) => e.kind === 'completed')!
    expect(completed.run.status).toBe('error')
    expect(completed.run.exitCode).toBe(2)
    expect(wakes).toHaveLength(0)
  })

  it('asyncRewake exit-2 enqueues a wake; the immediate dispatch still proceeds', async () => {
    const { executor, resolve } = deferredExecutor()
    const events: HookRuntimeEvent[] = []
    const wakes: HookWake[] = []
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh', { asyncRewake: true })] }], {
      events,
      onWake: (w) => wakes.push(w),
    })
    const decision = await engine.dispatch('Stop', {}, ctx())
    expect(decision.action).toBe('continue')
    expect(wakes).toHaveLength(0)
    resolve(BLOCKED_EXIT2)
    await waitFor(() => wakes.length === 1)
    expect(wakes[0]).toEqual({
      summary: 'Stop hook feedback',
      body: 'Stop hook blocking error from command "guard.sh":boom',
      priority: 'next',
      stopHookActive: true,
    })
    expect(events.map((e) => e.kind)).toEqual(['started', 'completed'])
  })

  it('asyncRewake exit-0 does NOT wake', async () => {
    const { executor, resolve } = deferredExecutor()
    const events: HookRuntimeEvent[] = []
    const wakes: HookWake[] = []
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh', { asyncRewake: true })] }], {
      events,
      onWake: (w) => wakes.push(w),
    })
    await engine.dispatch('Stop', {}, ctx())
    resolve(SUCCESS_EXIT0)
    await waitFor(() => events.some((e) => e.kind === 'completed'))
    expect(wakes).toHaveLength(0)
  })

  it('asyncRewake non-2 exit (error / cancelled) does NOT wake', async () => {
    const events: HookRuntimeEvent[] = []
    const wakes: HookWake[] = []
    for (const result of [
      { outcome: 'error', exitCode: 1, stdout: '', stderr: 'oops' },
      { outcome: 'cancelled', stdout: '', stderr: 'hook timed out' },
    ] satisfies HookExecResult[]) {
      const engine = engineWith({ command: fixedExecutor(result) }, [{ hooks: [command('guard.sh', { asyncRewake: true })] }], {
        events,
        onWake: (w) => wakes.push(w),
      })
      await engine.dispatch('Stop', {}, ctx())
      await waitFor(() => events.filter((e) => e.kind === 'completed').length >= 1)
      events.length = 0
    }
    expect(wakes).toHaveLength(0)
  })

  it('runtime {async:true} stdout conversion discards the decision from the current merge', async () => {
    // The command already settled (our executor waits for close); the async
    // response means its decision is background-owned — fire-and-forget.
    const converted: HookExecResult = {
      outcome: 'success', exitCode: 0, stdout: '{"async":true}', stderr: '',
      async: true, decision: { decision: 'block', reason: 'must not act' },
    }
    const events: HookRuntimeEvent[] = []
    const engine = engineWith({ command: fixedExecutor(converted) }, [{ hooks: [command('convert.sh')] }], { events })
    const decision = await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.action).toBe('continue')
    // The activity record still carries the REAL execution facts.
    const completed = events.find((e) => e.kind === 'completed')!
    expect(completed.run.stdout).toBe('{"async":true}')
    expect(completed.run.status).toBe('success')
  })

  it('a sync blocking hook alongside an async hook still blocks the action', async () => {
    const { executor } = deferredExecutor()
    const engine = engineWith(
      { command: (hook, input, c) => (hook as CommandHookConfig).async ? executor(hook, input, c) : Promise.resolve(BLOCKED_EXIT2) },
      [{ hooks: [command('bg.sh', { async: true }), command('sync.sh')] }],
    )
    const decision = await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.action).toBe('block')
    expect(decision.block?.reason).toBe('boom')
  })

  it('a background executor rejection surfaces as an error completion (never unhandled)', async () => {
    const events: HookRuntimeEvent[] = []
    const executor: HookExecutor = async () => { throw new Error('executor exploded') }
    const engine = engineWith({ command: executor }, [{ hooks: [command('bg.sh', { async: true })] }], { events })
    const decision = await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.action).toBe('continue')
    await waitFor(() => events.some((e) => e.kind === 'completed'))
    const completed = events.find((e) => e.kind === 'completed')!
    expect(completed.run.status).toBe('error')
    expect(completed.run.stderr).toContain('executor exploded')
  })
})

// ── 2. session idle wake delivery (real provider + real bash hooks) ─────────

const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-rewake-config-'))
  await mkdir(join(skillsConfigDir, 'skills'), { recursive: true })
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

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
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

interface WakeHarness {
  dir: string
  frames: Frame[]
  requests: Array<{ messages: unknown[] }>
  send(text: string): void
  interrupt(opts?: { cancelQueued?: boolean }): Promise<void>
  destroy(): Promise<void>
}

/** A live provider session with scripted text rounds and the given hooks.
 *  The caller drives sends / waits and destroys in a finally. `portsFor`
 *  overrides the host ports (e.g. a failing skill-discovery port). */
async function wakeHarness(
  hooks: SessionHooksConfig,
  rounds = 4,
  portsFor?: (dir: string) => NativeHostPorts,
): Promise<WakeHarness> {
  const dir = await tempDir('rewake-')
  const provider = new NativeProvider({ stateDir: dir, ports: portsFor ? portsFor(dir) : makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const scripts: CanonicalEvent[][] = Array.from({ length: rounds }, (_, i) => textTurn(`round-${i + 1}`))
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const session = provider.createSession({
    id: 'rewake',
    cwd: dir,
    providerExtras: { sdkOptions: { settings: { hooks } } },
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  return {
    dir,
    frames,
    requests,
    send: (text) => session.enqueueUserMessage(userMsg(text) as never),
    interrupt: async (opts) => { await session.interrupt!(opts) },
    destroy: async () => { await session.destroy() },
  }
}

function results(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === 'result')
}

/** Explicit bash shell so the command is identical on win32 (Git Bash) and posix. */
function upsHook(command: string, extra: Record<string, unknown> = {}): SessionHooksConfig {
  return { UserPromptSubmit: [{ hooks: [{ type: 'command', command, shell: 'bash', ...extra }] }] }
}

describe('session idle wake delivery (RS §4.4)', () => {
  it('asyncRewake exit-2 re-invokes the model with the feedback when next idle', async () => {
    const h = await wakeHarness(upsHook('echo wake-stderr >&2; exit 2', { asyncRewake: true }))
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(2)
      }, { timeout: 15_000 })
      // The wake turn carried the hook's stderr as model feedback.
      expect(h.requests).toHaveLength(2)
      expect(JSON.stringify(h.requests[1].messages)).toContain('wake-stderr')
      expect(JSON.stringify(h.requests[1].messages)).toContain('Stop hook blocking error from command')
      // The original turn settled normally; the wake turn is a second turn.
      expect((results(h.frames)[0] as { is_error?: boolean }).is_error).toBeFalsy()
      expect((results(h.frames)[1] as { is_error?: boolean }).is_error).toBeFalsy()
      // The default summary is user-visible (the informational banner).
      const banner = h.frames.find(
        (f) => (f as { type?: string }).type === 'system' && (f as { subtype?: string }).subtype === 'informational',
      ) as { content?: string } | undefined
      expect(banner?.content).toContain('Stop hook feedback')
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('a mid-turn rewake completion waits for idle (does not corrupt the active turn)', async () => {
    // The hook holds open until the test releases it AFTER the first turn's
    // result lands — the wake must not start a turn while one is active.
    const command = 'while [ ! -f release.flag ]; do sleep 0.05; done\necho late-wake >&2\nexit 2'
    const h = await wakeHarness(upsHook(command, { asyncRewake: true }))
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(1)
      }, { timeout: 15_000 })
      // The first turn settled; the hook is still running. No wake turn yet.
      expect(h.requests).toHaveLength(1)
      await writeFile(join(h.dir, 'release.flag'), '1')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(2)
      }, { timeout: 15_000 })
      expect(h.requests).toHaveLength(2)
      expect(JSON.stringify(h.requests[1].messages)).toContain('late-wake')
      // The active turn was untouched: its result is the round-1 text.
      expect((results(h.frames)[0] as { result?: string }).result).toBe('round-1')
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('multiple staggered wakes all deliver (none strands at the pump exit)', async () => {
    // Three rewake hooks completing at different times — mid-turn, around the
    // turn end, and well after it. Every wake must become its own system turn.
    const hooks: SessionHooksConfig = {
      UserPromptSubmit: [{ hooks: [
        { type: 'command', command: 'echo wake-a >&2; exit 2', shell: 'bash', asyncRewake: true },
        { type: 'command', command: 'sleep 0.15; echo wake-b >&2; exit 2', shell: 'bash', asyncRewake: true },
        { type: 'command', command: 'sleep 0.4; echo wake-c >&2; exit 2', shell: 'bash', asyncRewake: true },
      ] }],
    }
    const h = await wakeHarness(hooks, 6)
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(4)
      }, { timeout: 20_000 })
      expect(h.requests).toHaveLength(4)
      const all = JSON.stringify(h.requests.slice(1).map((r) => r.messages))
      expect(all).toContain('wake-a')
      expect(all).toContain('wake-b')
      expect(all).toContain('wake-c')
      // Stabilization: no extra turn appears (each wake delivered exactly once).
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(results(h.frames)).toHaveLength(4)
    } finally {
      await h.destroy()
    }
  }, 40_000)

  it('first-turn cancelQueued interrupt during SessionStart does not wedge the FIFO', async () => {
    // SessionStart holds open so the first turn's pump suspends at the
    // sessionStartInit await with the prompt parked. A cancelQueued interrupt
    // drains the parked head; when SessionStart settles, the iteration must
    // settle as withdrawn — NOT park a phantom {message:undefined} head from
    // the emptied FIFO (which arms a durable-retry pause on every later send
    // and wedges the session permanently).
    const hooks: SessionHooksConfig = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'touch started.flag\nwhile [ ! -f release.flag ]; do sleep 0.05; done', shell: 'bash' }] }],
    }
    const h = await wakeHarness(hooks)
    try {
      h.send('first')
      await vi.waitFor(async () => {
        await expect(readFile(join(h.dir, 'started.flag'), 'utf8')).resolves.toBe('')
      }, { timeout: 15_000 })
      // The pump is suspended at await sessionStartInit; drain the head.
      await h.interrupt({ cancelQueued: true })
      await writeFile(join(h.dir, 'release.flag'), '1')
      // The withdrawn first iteration settles with a terminal frame...
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(1)
      }, { timeout: 15_000 })
      // ...and a fresh send runs a NORMAL turn (no phantom-head wedge).
      h.send('second')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(2)
      }, { timeout: 15_000 })
      expect((results(h.frames)[1] as { is_error?: boolean }).is_error).toBeFalsy()
      expect((results(h.frames)[1] as { result?: string }).result).toBe('round-1')
      expect(h.requests).toHaveLength(1)
      expect(JSON.stringify(h.requests[0].messages)).toContain('second')
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('wake feedback is durable even when skill discovery rejects on the wake turn', async () => {
    // A failing skill port makes skillsReady reject on EVERY turn. Both turns
    // error, but both messages must be durable: the user prompt (user-branch
    // contract) and the wake feedback — the wake was already shifted off the
    // queue, so a bare skillsReady await in the wake branch would lose it
    // with no park/retry to recover it.
    const h = await wakeHarness(
      upsHook('echo skill-wake >&2; exit 2', { asyncRewake: true }),
      4,
      (dir) => {
        const ports = makeNativePorts({ stateDir: dir })
        ports.skill.listSkills = async () => { throw new Error('skill discovery exploded') }
        return ports
      },
    )
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(2)
      }, { timeout: 15_000 })
      expect(results(h.frames).every((r) => (r as { is_error?: boolean }).is_error)).toBe(true)
      const logText = await readFile(nativeSessionLogPath(h.dir, 'rewake'), 'utf8')
      const userTexts = logText.split('\n').filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { type?: string; data?: { content?: Array<{ text?: string }> } })
        .filter((e) => e.type === 'user/message')
        .map((e) => (e.data?.content ?? []).map((b) => b.text ?? '').join(''))
      expect(userTexts.some((t) => t.includes('skill-wake'))).toBe(true)
      expect(userTexts.some((t) => t === 'go')).toBe(true)
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('asyncRewake exit-0 does NOT wake the session', async () => {
    const h = await wakeHarness(upsHook('touch ran.flag; exit 0', { asyncRewake: true }))
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(1)
      }, { timeout: 15_000 })
      // Give a stray wake a window to appear before asserting it never does.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(results(h.frames)).toHaveLength(1)
      expect(h.requests).toHaveLength(1)
      await expect(readFile(join(h.dir, 'ran.flag'), 'utf8')).resolves.toBe('')
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('plain async exit-2 is fire-and-forget (no wake, action proceeds)', async () => {
    const h = await wakeHarness(upsHook('echo async-stderr >&2; touch ran.flag; exit 2', { async: true }))
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(1)
      }, { timeout: 15_000 })
      await vi.waitFor(async () => {
        await expect(readFile(join(h.dir, 'ran.flag'), 'utf8')).resolves.toBe('')
      }, { timeout: 15_000 })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(results(h.frames)).toHaveLength(1)
      expect(h.requests).toHaveLength(1)
      // The async block never reached the model.
      expect(JSON.stringify(h.requests[0].messages)).not.toContain('async-stderr')
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('the wake turn skips UserPromptSubmit and seeds stop_hook_active for its Stop dispatch', async () => {
    // One-shot rewake (flag) + a recorder on both events: the wake turn must
    // NOT re-dispatch UserPromptSubmit (no self-feeding loop), and its Stop
    // input must carry stop_hook_active:true (the notification fact).
    const upsCommand = 'input=$(cat)\nprintf \'%s\\n\' "$input" >> ups-inputs.jsonl\nif [ -f rewake.flag ]; then exit 0; fi\ntouch rewake.flag\necho seed-wake >&2\nexit 2'
    const stopCommand = 'input=$(cat)\nprintf \'%s\\n\' "$input" >> stop-inputs.jsonl'
    const hooks: SessionHooksConfig = {
      ...upsHook(upsCommand, { asyncRewake: true }),
      Stop: [{ hooks: [{ type: 'command', command: stopCommand, shell: 'bash' }] }],
    }
    const h = await wakeHarness(hooks)
    try {
      h.send('go')
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(2)
      }, { timeout: 15_000 })
      const upsInputs = (await readFile(join(h.dir, 'ups-inputs.jsonl'), 'utf8'))
        .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
      // Exactly ONE UserPromptSubmit dispatch — the wake turn is a system
      // injection, not a user prompt.
      expect(upsInputs).toHaveLength(1)
      expect(upsInputs[0].prompt).toBe('go')
      const stopInputs = (await readFile(join(h.dir, 'stop-inputs.jsonl'), 'utf8'))
        .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(stopInputs).toHaveLength(2)
      expect(stopInputs[0].stop_hook_active).toBe(false)
      expect(stopInputs[1].stop_hook_active).toBe(true)
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('a wake with no user turn at all injects a system turn when idle (SessionStart rewake)', async () => {
    const hooks: SessionHooksConfig = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo startup-wake >&2; exit 2', shell: 'bash', asyncRewake: true }] }],
    }
    const h = await wakeHarness(hooks)
    try {
      // NO user send: the background SessionStart hook's exit-2 wake must
      // start a turn on the idle session by itself.
      await vi.waitFor(() => {
        expect(results(h.frames)).toHaveLength(1)
      }, { timeout: 15_000 })
      expect(h.requests).toHaveLength(1)
      expect(JSON.stringify(h.requests[0].messages)).toContain('startup-wake')
      expect((results(h.frames)[0] as { is_error?: boolean }).is_error).toBeFalsy()
    } finally {
      await h.destroy()
    }
  }, 30_000)
})
