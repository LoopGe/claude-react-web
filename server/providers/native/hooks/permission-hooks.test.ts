// server/providers/native/hooks/permission-hooks.test.ts
// T20: the PermissionRequest / PermissionDenied dispatch seams inside the
// neutral permission flow (native-session decidePermission). RS §13.1: the SDK
// main path (`qMt`) honors a PermissionRequest hook allow for any NON-personOnly
// ask WITHOUT a `hooksMayAllow` gate (that field is a narrow plugin-ask wrapper,
// undefined for normal asks). The real safety boundary is the personOnly floor:
// safety / plan-mode asks are never hook-allowed — the CLI skips `qMt` entirely
// for them (`c.personOnly===!0 ? … : qMt`), so native skips the dispatch and the
// ask always reaches the user prompt. PermissionDenied fires on deny resolution
// with a `retry` flag that tells the model it may retry (RS §3 / §5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import type { CanonicalEvent } from '../canonical.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'
import type { Frame } from '../../native-frames.js'

const tempDirs: string[] = []

/** A fresh temp state dir per test; the project skills root is created so
 *  construction-time discovery never logs an ENOENT warning (pristine output). */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

/** Redirect user-scope skill discovery at a temp empty dir so the developer's
 *  real ~/.claude/skills can never leak in (same fixture as pretooluse.test.ts). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-permission-config-'))
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

/** One assistant round whose only call is Bash running `command`. */
function bashTurn(toolUseId: string, command: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Bash' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify({ command }) } },
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

/** The JSON a command hook echoes to emit a PermissionRequest decision. */
function prHsoJson(decision: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}'`
}

/** The JSON a command hook echoes to emit a PermissionDenied hookSpecificOutput. */
function pdHsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', ...fields } })}'`
}

function prHook(command: string): SessionHooksConfig {
  return { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

function pdHook(command: string): SessionHooksConfig {
  return { PermissionDenied: [{ matcher: 'Bash', hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

interface TurnOutcome {
  dir: string
  frames: Frame[]
  canUseToolCalls: Array<{ toolName: string; input: unknown }>
  requests: Array<{ messages: unknown[] }>
}

/** Drive one Bash tool turn through the real provider + loop with the given
 *  hooks config. The canUseTool spy stands in for the user prompt: it records
 *  every call and either allows or denies. A PermissionRequest hook that
 *  auto-allows/denies must leave it uncalled; the personOnly floor must always
 *  reach it. The Bash command writes marker.txt into the cwd, so "tool ran" /
 *  "tool not run" is a disk fact. */
async function runBashTurn(
  hooks: SessionHooksConfig | undefined,
  command: string,
  opts: { permissionMode?: string; canUseTool?: 'allow' | 'deny' } = {},
): Promise<TurnOutcome> {
  const dir = await tempDir('permission-hooks-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const scripts: CanonicalEvent[][] = [bashTurn('tu-1', command), textTurn('done')]
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const canUseToolCalls: Array<{ toolName: string; input: unknown }> = []
  const session = provider.createSession({
    id: 'permission-hooks',
    cwd: dir,
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(hooks ? { providerExtras: { sdkOptions: { settings: { hooks } } } } : {}),
    canUseTool: async (toolName: unknown, input: unknown) => {
      canUseToolCalls.push({ toolName: toolName as string, input })
      return opts.canUseTool === 'deny'
        ? { behavior: 'deny', message: 'user denied the request', interrupt: false }
        : { behavior: 'allow', updatedInput: input }
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
  return { dir, frames, canUseToolCalls, requests }
}

/** marker.txt content, or null when the tool never ran (file absent). */
async function markerText(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, 'marker.txt'), 'utf8')
  } catch {
    return null
  }
}

/** The tool_result frames (role-'user' messages carrying a tool_use_id). */
function toolResults(frames: Frame[]): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  return frames
    .filter((f) => f.type === 'user')
    .map((f) => (f as Frame).message.content[0] as { tool_use_id: string; content: unknown; is_error?: boolean })
    .filter((c) => c.tool_use_id !== undefined)
}

/** The hook_response system frames for a given hook event (proves dispatch). */
function hookResponses(frames: Frame[], event: string): Array<Record<string, unknown>> {
  return frames.filter(
    (f) => f.type === 'system'
      && (f as unknown as { subtype?: string }).subtype === 'hook_response'
      && (f as unknown as { hook_event?: string }).hook_event === event,
  ) as unknown as Array<Record<string, unknown>>
}

const WRITE_ORIGINAL = 'echo original > marker.txt'
const WRITE_MUTATED = 'echo mutated > marker.txt'

describe('PermissionRequest seam — main-path allow + personOnly floor (RS §13.1)', () => {
  it('an allow hook auto-allows a normal ask without a user prompt', async () => {
    const hooks = prHook(prHsoJson({ behavior: 'allow' }))
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    // The user prompt was short-circuited: the hook allowed the non-personOnly ask.
    expect(canUseToolCalls).toEqual([])
    expect(await markerText(dir)).toContain('original')
  }, 20_000)

  it('a personOnly (plan-mode) ask is NOT hook-allowed — the floor reaches the user prompt', async () => {
    const hooks = prHook(prHsoJson({ behavior: 'allow' }))
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL, { permissionMode: 'plan' })
    // The allow hook is skipped for a personOnly ask: the user prompt is still consulted.
    expect(canUseToolCalls.map((c) => c.toolName)).toEqual(['Bash'])
    expect(await markerText(dir)).toContain('original')
  }, 20_000)

  it('a deny hook denies with its message and short-circuits the user prompt', async () => {
    const hooks = prHook(prHsoJson({ behavior: 'deny', message: 'hook says no' }))
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls).toEqual([])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('hook says no')
  }, 20_000)

  it('a deny hook with interrupt:true aborts the turn (no recovery round)', async () => {
    const hooks = prHook(prHsoJson({ behavior: 'deny', message: 'stop now', interrupt: true }))
    const { dir, frames, canUseToolCalls, requests } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls).toEqual([])
    // The interrupt ended the turn after the tool round — no model recovery round.
    expect(requests).toHaveLength(1)
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('stop now')
  }, 20_000)

  it('an agent-type hook on PermissionRequest is rejected (non-blocking) — the ask proceeds', async () => {
    const hooks: SessionHooksConfig = {
      PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'agent', prompt: 'Verify it' }] }],
    }
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    // T12 availability rejects agent on PermissionRequest; the ask reaches the user prompt.
    expect(canUseToolCalls.map((c) => c.toolName)).toEqual(['Bash'])
    expect(await markerText(dir)).toContain('original')
  }, 20_000)
})

describe('PermissionRequest updatedInput validation (RS §13.1 / §5)', () => {
  it('rejects an internal _-prefixed key — deny, tool NOT run', async () => {
    const hooks = prHook(prHsoJson({ behavior: 'allow', updatedInput: { command: WRITE_MUTATED, _internal: 'x' } }))
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls).toEqual([])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('The tool was not run')
  }, 20_000)

  it('a valid updatedInput replaces the tool input (no user prompt)', async () => {
    const hooks = prHook(prHsoJson({ behavior: 'allow', updatedInput: { command: WRITE_MUTATED } }))
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(canUseToolCalls).toEqual([])
    const marker = await markerText(dir)
    expect(marker).toContain('mutated')
    expect(marker).not.toContain('original')
  }, 20_000)
})

describe('PermissionDenied seam — fires on deny resolution with retry (RS §3 / §5)', () => {
  it('fires on a user denial and a retry:true hook tells the model it may retry', async () => {
    const hooks = pdHook(pdHsoJson({ retry: true }))
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL, { canUseTool: 'deny' })
    // The tool never ran; the user prompt was consulted (no PermissionRequest allow hook).
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls.map((c) => c.toolName)).toEqual(['Bash'])
    // PermissionDenied dispatched.
    expect(hookResponses(frames, 'PermissionDenied').length).toBeGreaterThanOrEqual(1)
    // The denial reaches the model with the retry permission appended.
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    const text = JSON.stringify(results[0].content)
    expect(text).toContain('user denied the request')
    expect(text).toContain('retry')
  }, 20_000)

  it('a denial without a retry hook carries no retry permission', async () => {
    const { frames } = await runBashTurn(undefined, WRITE_ORIGINAL, { canUseTool: 'deny' })
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    const text = JSON.stringify(results[0].content)
    expect(text).toContain('user denied the request')
    expect(text).not.toContain('retry')
  }, 20_000)
})
