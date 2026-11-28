// server/providers/native/hooks/remaining-events.test.ts
//
// The events added after the layer-1 thirteen: Notification (permission
// prompts), InstructionsLoaded (CLAUDE.md chain), TaskCreated / TaskCompleted
// (the Task tools), WorktreeCreate / WorktreeRemove (the worktree tools). Tool
// seams are covered in tools/tool-hooks.test.ts; this file pins the ENGINE
// semantics (matcher targets, block audience, WorktreeCreate's path/failure
// facts, Notification context) and the two SESSION seams that have no tool.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHookConfig, HookConfig, HookMatcherConfig, SessionHooksConfig } from '../../../../shared/hooks.js'
import { HookEngine, type HookExecutor } from './engine.js'
import type { HookExecResult } from './output.js'
import type { HookSource } from './types.js'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { createMemoryReader } from '../../native-host-memory.js'
import type { CanonicalEvent } from '../canonical.js'
import type { Frame } from '../../native-frames.js'
import { QUESTION_RESULT } from '../../../permission-broker.js'

function ctx(hasContext = true) {
  return { signal: new AbortController().signal, hasContext }
}

function command(commandText: string, extra: Partial<CommandHookConfig> = {}): CommandHookConfig {
  return { type: 'command', command: commandText, ...extra }
}

function sourceOf(groups: HookMatcherConfig[]): HookSource {
  return { kind: 'flag', collect: () => groups }
}

function fixedExecutor(result: HookExecResult) {
  const calls: Array<{ hook: HookConfig; input: Record<string, unknown> }> = []
  const executor: HookExecutor = async (hook, input) => {
    calls.push({ hook, input })
    return result
  }
  return { executor, calls }
}

function engineWith(executor: HookExecutor, groups: HookMatcherConfig[]): HookEngine {
  return new HookEngine({
    sources: () => [sourceOf(groups)],
    emit: () => {},
    executors: { command: executor },
    cwd: '/tmp/project',
    sessionId: 'session-1',
  })
}

function withHso(hookSpecificOutput: Record<string, unknown>): HookExecResult {
  return { outcome: 'success', exitCode: 0, stdout: '', stderr: '', decision: { hookSpecificOutput } }
}

function group(matcher: string | undefined, hook: CommandHookConfig): HookMatcherConfig {
  return { ...(matcher !== undefined ? { matcher } : {}), hooks: [hook] }
}

describe('HookEngine — remaining-event semantics', () => {
  it('Notification matches on notification_type and accumulates additionalContext', async () => {
    const { executor } = fixedExecutor(withHso({
      hookEventName: 'Notification',
      additionalContext: 'heads-up',
    }))
    const engine = engineWith(executor, [group('permission_prompt', command('x'))])
    const decision = await engine.dispatch('Notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    }, ctx())
    expect(decision.action).toBe('continue')
    expect(decision.additionalContext).toEqual(['heads-up'])

    // The matcher filters other notification types.
    const other = await engine.dispatch('Notification', {
      notification_type: 'idle_prompt',
      message: 'waiting',
    }, ctx())
    expect(other.additionalContext).toEqual([])
  })

  it('InstructionsLoaded matches on load_reason and never blocks', async () => {
    const { executor, calls } = fixedExecutor({
      outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'observation-only',
    })
    const engine = engineWith(executor, [group('compact', command('x'))])
    const decision = await engine.dispatch('InstructionsLoaded', {
      file_path: '/repo/CLAUDE.md',
      memory_type: 'Project',
      load_reason: 'compact',
    }, ctx())
    expect(calls).toHaveLength(1)
    // The CLI ignores decisions for this event; the engine still reports the
    // block fact, and the seam simply never acts on it.
    expect(decision.action).toBe('block')
  })

  it('TaskCreated / TaskCompleted block messages are addressed to the model', async () => {
    const { executor } = fixedExecutor({
      outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'task-hook says no',
    })
    const engine = engineWith(executor, [group(undefined, command('x'))])
    for (const event of ['TaskCreated', 'TaskCompleted'] as const) {
      const decision = await engine.dispatch(event, {
        task_id: '1', task_subject: 'Ship it',
      }, ctx())
      expect(decision.action).toBe('block')
      expect(decision.block).toEqual({ reason: 'task-hook says no', target: 'model' })
    }
  })

  it('WorktreeCreate folds a structured worktreePath', async () => {
    const { executor } = fixedExecutor(withHso({
      hookEventName: 'WorktreeCreate',
      worktreePath: '/hooks/create/wt',
    }))
    const engine = engineWith(executor, [group(undefined, command('x'))])
    const decision = await engine.dispatch('WorktreeCreate', { name: 'wt' }, ctx())
    expect(decision.worktreePath).toBe('/hooks/create/wt')
    expect(decision.failure).toBeUndefined()
  })

  it('WorktreeCreate folds a command hook stdout path', async () => {
    const { executor } = fixedExecutor({ outcome: 'success', exitCode: 0, stdout: '/tmp/wt-created\n', stderr: '' })
    const engine = engineWith(executor, [group(undefined, command('mktree'))])
    const decision = await engine.dispatch('WorktreeCreate', { name: 'wt' }, ctx())
    expect(decision.worktreePath).toBe('/tmp/wt-created')
  })

  it('WorktreeCreate carries ANY non-blocking execution failure', async () => {
    const { executor } = fixedExecutor({ outcome: 'error', exitCode: 1, stdout: '', stderr: 'mktree exploded' })
    const engine = engineWith(executor, [group(undefined, command('mktree'))])
    const decision = await engine.dispatch('WorktreeCreate', { name: 'wt' }, ctx())
    expect(decision.action).toBe('continue')
    expect(decision.failure).toBe('mktree exploded')
  })

  it('WorktreeRemove still reports a block, but not as an execution failure', async () => {
    const { executor } = fixedExecutor({
      outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'ignored',
    })
    const engine = engineWith(executor, [group(undefined, command('x'))])
    const decision = await engine.dispatch('WorktreeRemove', { worktree_path: '/repo/.claude/worktrees/wt' }, ctx())
    expect(decision.action).toBe('block')
    expect(decision.failure).toBeUndefined()
  })
})

// ── Session seams: Notification + InstructionsLoaded ────────────────────────
const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

let skillsConfigDir = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-remaining-config-'))
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

function bashTurn(toolUseId: string, command: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Bash' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify({ command }) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** One assistant round whose only call is AskUserQuestion. */
function questionTurn(toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'AskUserQuestion' } },
    {
      kind: 'block_delta',
      index: 0,
      delta: { type: 'tool_input', json: '{"questions":[{"question":"q1","options":[{"label":"a"}]}]}' },
    },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

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

function hookResponses(frames: Frame[], event: string): Array<Record<string, unknown>> {
  return frames.filter(
    (f) => f.type === 'system'
      && (f as unknown as { subtype?: string }).subtype === 'hook_response'
      && (f as unknown as { hook_event?: string }).hook_event === event,
  ) as unknown as Array<Record<string, unknown>>
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** One Bash turn (permission ask → canUseTool) in a fresh session. */
async function runBashTurn(
  hooks: SessionHooksConfig | undefined,
  opts: { canUseTool?: 'allow' } = {},
): Promise<{ frames: Frame[]; canUseToolCalls: string[] }> {
  const dir = await tempDir('remaining-notification-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const scripts: CanonicalEvent[][] = [bashTurn('tu-1', 'echo ok > marker.txt'), textTurn('done')]
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const canUseToolCalls: string[] = []
  const session = provider.createSession({
    id: 'remaining-notification',
    cwd: dir,
    ...(hooks ? { providerExtras: { sdkOptions: { settings: { hooks } } } } : {}),
    canUseTool: async (toolName: unknown, input: unknown) => {
      canUseToolCalls.push(toolName as string)
      if (opts.canUseTool === 'allow') return { behavior: 'allow', updatedInput: input }
      return { behavior: 'allow', updatedInput: input }
    },
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  try {
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
  } finally {
    await session.destroy()
  }
  return { frames, canUseToolCalls }
}

describe('Notification seam — permission prompts', () => {
  it('fires permission_prompt before a user-facing permission ask', async () => {
    const dir = await tempDir('remaining-notification-marker-')
    const marker = join(dir, 'notify.txt')
    const hooks: SessionHooksConfig = {
      Notification: [{ matcher: 'permission_prompt', hooks: [command(`echo fired >> ${marker}`, { shell: 'bash' })] }],
    }
    const { frames, canUseToolCalls } = await runBashTurn(hooks)
    expect(canUseToolCalls).toEqual(['Bash'])
    expect(await readOrNull(marker)).toContain('fired')
    // Detached from the prompt path: the run frame can land just after the turn.
    await vi.waitFor(() => expect(hookResponses(frames, 'Notification')).toHaveLength(1))
  }, 20_000)

  it('does not fire when a PermissionRequest hook short-circuits the ask', async () => {
    const dir = await tempDir('remaining-notification-skip-')
    const marker = join(dir, 'notify-skip.txt')
    const allow = `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })}'`
    const hooks: SessionHooksConfig = {
      PermissionRequest: [{ matcher: 'Bash', hooks: [command(allow, { shell: 'bash' })] }],
      Notification: [{ matcher: 'permission_prompt', hooks: [command(`echo fired >> ${marker}`, { shell: 'bash' })] }],
    }
    const { frames, canUseToolCalls } = await runBashTurn(hooks)
    expect(canUseToolCalls).toEqual([])
    expect(await readOrNull(marker)).toBeNull()
    expect(hookResponses(frames, 'Notification')).toHaveLength(0)
  }, 20_000)

  it('does not fire for an AskUserQuestion dialog', async () => {
    const dir = await tempDir('remaining-notification-question-')
    const marker = join(dir, 'notify-question.txt')
    const hooks: SessionHooksConfig = {
      Notification: [{ matcher: 'permission_prompt', hooks: [command(`echo fired >> ${marker}`, { shell: 'bash' })] }],
    }
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const scripts: CanonicalEvent[][] = [questionTurn('tu-question'), textTurn('done')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const asked: string[] = []
    const session = provider.createSession({
      id: 'remaining-notification-question',
      cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (toolName: unknown) => {
        asked.push(String(toolName))
        return {
          behavior: 'deny',
          message: JSON.stringify({ answers: [{ question: 'q1', answer: 'yes' }] }),
          [QUESTION_RESULT]: true,
        }
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('ask') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      })
      // The dialog reached the broker, yet no permission_prompt notification fired.
      expect(asked).toEqual(['AskUserQuestion'])
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await readOrNull(marker)).toBeNull()
      expect(hookResponses(frames, 'Notification')).toHaveLength(0)
    } finally {
      await session.destroy()
    }
  }, 20_000)

  it('the matcher filters notification types', async () => {
    const dir = await tempDir('remaining-notification-filter-')
    const marker = join(dir, 'notify-filter.txt')
    const hooks: SessionHooksConfig = {
      Notification: [{ matcher: 'idle_prompt', hooks: [command(`echo fired >> ${marker}`, { shell: 'bash' })] }],
    }
    const { frames } = await runBashTurn(hooks)
    expect(await readOrNull(marker)).toBeNull()
    expect(hookResponses(frames, 'Notification')).toHaveLength(0)
  }, 20_000)
})

describe('InstructionsLoaded seam — CLAUDE.md chain', () => {
  /** Build a session over a project with one CLAUDE.md and a hook that appends
   *  every InstructionsLoaded input line to `marker`. */
  async function instructionSession(prefix: string) {
    const dir = await tempDir(prefix)
    const instructionsPath = join(dir, 'CLAUDE.md')
    await writeFile(instructionsPath, '# Project notes\n', 'utf8')
    const marker = join(dir, 'instructions.txt')
    const hooks: SessionHooksConfig = {
      // Command hooks receive the JSON input on stdin; append it verbatim.
      InstructionsLoaded: [{ hooks: [command(`cat >> ${marker}`, { shell: 'bash' })] }],
    }
    // makeNativePorts stubs memory unless one is supplied; the real reader is
    // what loads `<cwd>/CLAUDE.md`, and the config dir redirect keeps the
    // developer's own user-memory files out of the chain.
    const provider = new NativeProvider({
      stateDir: dir,
      ports: makeNativePorts({ stateDir: dir, memory: createMemoryReader({ configDir: skillsConfigDir }) }),
    })
    const scripts: CanonicalEvent[][] = [textTurn('one'), textTurn('two'), textTurn('three')]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const session = provider.createSession({
      id: `remaining-instructions-${prefix}`,
      cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    return { dir, instructionsPath, marker, session, frames }
  }

  it('reports each memory file once with session_start', async () => {
    const { instructionsPath, marker, session, frames } = await instructionSession('remaining-instructions-once-')
    try {
      session.enqueueUserMessage(userMsg('one') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
      await vi.waitFor(async () => {
        expect(await readOrNull(marker)).toContain('"load_reason":"session_start"')
      })
      const first = await readOrNull(marker)
      expect(first).toContain(instructionsPath)
      expect(first).toContain('"memory_type":"Project"')

      session.enqueueUserMessage(userMsg('two') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(2))
      // Already reported: no second dispatch on the next turn.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await readOrNull(marker)).toBe(first)
    } finally {
      await session.destroy()
    }
  }, 30_000)

  it('re-reports the already-loaded files with compact after a compaction', async () => {
    const { marker, session, frames } = await instructionSession('remaining-instructions-compact-')
    try {
      session.enqueueUserMessage(userMsg('one') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
      await vi.waitFor(async () => {
        expect(await readOrNull(marker)).toContain('"load_reason":"session_start"')
      })
      const before = await readOrNull(marker)

      const compactable = session as unknown as {
        compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
      }
      await compactable.compactInPlace('Earlier turns summarized.', {
        uuid: 'compact-1',
        timestamp: new Date().toISOString(),
      })

      session.enqueueUserMessage(userMsg('two') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(2))
      await vi.waitFor(async () => {
        expect((await readOrNull(marker)) ?? '').toContain('"load_reason":"compact"')
      })
      expect(await readOrNull(marker)).not.toBe(before)
    } finally {
      await session.destroy()
    }
  }, 30_000)
})
