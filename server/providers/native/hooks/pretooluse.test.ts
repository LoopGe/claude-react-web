// server/providers/native/hooks/pretooluse.test.ts
// T8: the PreToolUse dispatch seam in the neutral turn loop. The hook runs
// BEFORE the permission request (RS §5): allow/deny short-circuit canUseTool,
// ask/defer/no-decision enter the normal permission flow, exit-2 blocks the
// tool, and a denied/blocked tool is NEVER run. `updatedInput` is validated
// against the tool input schema and internal `_`-prefixed keys are rejected
// (RS §5 Man/EWe; Review Focus 5). additionalContext is injected into the
// conversation for the next model round.
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
 *  real ~/.claude/skills can never leak in (same fixture as native-session.test.ts). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-pretooluse-config-'))
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

/** A single PreToolUse command hook matched on Bash. Explicit bash shell so the
 *  command is identical on win32 (Git Bash) and posix (command-executor convention). */
function bashHook(command: string): SessionHooksConfig {
  return { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

/** The JSON a command hook echoes to emit a PreToolUse hookSpecificOutput. */
function hsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } })}'`
}

interface TurnOutcome {
  dir: string
  frames: Frame[]
  canUseToolCalls: Array<{ toolName: string; input: unknown }>
  requests: Array<{ messages: unknown[] }>
}

/** Drive one Bash tool turn through the real provider + loop with the given
 *  hooks config. The canUseTool spy records every permission prompt and allows;
 *  a hook that short-circuits permission must leave it uncalled. The Bash command
 *  writes marker.txt into the cwd, so "tool ran" / "tool not run" is a disk fact. */
async function runBashTurn(hooks: SessionHooksConfig | undefined, command: string): Promise<TurnOutcome> {
  const dir = await tempDir('pretooluse-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const scripts: CanonicalEvent[][] = [bashTurn('tu-1', command), textTurn('done')]
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const canUseToolCalls: Array<{ toolName: string; input: unknown }> = []
  const session = provider.createSession({
    id: 'pretooluse',
    cwd: dir,
    ...(hooks ? { providerExtras: { sdkOptions: { settings: { hooks } } } } : {}),
    canUseTool: async (toolName: unknown, input: unknown) => {
      canUseToolCalls.push({ toolName: toolName as string, input })
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

const WRITE_ORIGINAL = 'echo original > marker.txt'
const WRITE_MUTATED = 'echo mutated > marker.txt'

describe('PreToolUse seam — ordering & short-circuit (RS §5)', () => {
  it('a deny hook prevents tool execution and short-circuits the permission prompt', async () => {
    const hooks = bashHook(hsoJson({ permissionDecision: 'deny', permissionDecisionReason: 'hook says no' }))
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    // The tool never ran: no marker file.
    expect(await markerText(dir)).toBeNull()
    // The permission prompt was short-circuited.
    expect(canUseToolCalls).toEqual([])
    // An error tool_result carries the deny reason.
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('hook says no')
  }, 20_000)

  it('an allow hook short-circuits the permission prompt and the tool runs', async () => {
    const hooks = bashHook(hsoJson({ permissionDecision: 'allow' }))
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(canUseToolCalls).toEqual([])
    expect(await markerText(dir)).toContain('original')
  }, 20_000)

  it('an ask hook enters the normal permission flow (canUseTool is called)', async () => {
    const hooks = bashHook(hsoJson({ permissionDecision: 'ask' }))
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(canUseToolCalls.map((c) => c.toolName)).toEqual(['Bash'])
    expect(await markerText(dir)).toContain('original')
  }, 20_000)

  it('exit-2 blocks the tool with stderr fed to the model as an error result', async () => {
    const hooks = bashHook('echo blocked-by-exit2 >&2; exit 2')
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls).toEqual([])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('blocked-by-exit2')
  }, 20_000)
})

describe('PreToolUse updatedInput validation (RS §5 Man/EWe)', () => {
  it('rejects an internal _-prefixed key — deny, tool NOT run [Review Focus 5]', async () => {
    const hooks = bashHook(hsoJson({
      permissionDecision: 'allow',
      updatedInput: { command: WRITE_MUTATED, _internal: 'x' },
    }))
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    // Neither the original nor the mutated command ran.
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls).toEqual([])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('The tool was not run')
  }, 20_000)

  it('a valid updatedInput replaces the tool input (tool receives the mutated command)', async () => {
    const hooks = bashHook(hsoJson({
      permissionDecision: 'allow',
      updatedInput: { command: WRITE_MUTATED },
    }))
    const { dir, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(canUseToolCalls).toEqual([])
    const marker = await markerText(dir)
    expect(marker).toContain('mutated')
    expect(marker).not.toContain('original')
  }, 20_000)

  it('an updatedInput that fails the tool input schema is denied (tool not run)', async () => {
    // Bash requires `command` (string); a number is schema-invalid.
    const hooks = bashHook(hsoJson({
      permissionDecision: 'allow',
      updatedInput: { command: 42 },
    }))
    const { dir, frames, canUseToolCalls } = await runBashTurn(hooks, WRITE_ORIGINAL)
    expect(await markerText(dir)).toBeNull()
    expect(canUseToolCalls).toEqual([])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(JSON.stringify(results[0].content)).toContain('schema')
  }, 20_000)
})

describe('PreToolUse additionalContext', () => {
  it('injects collected context into the conversation for the next model round', async () => {
    const hooks = bashHook(hsoJson({ permissionDecision: 'allow', additionalContext: 'extra-context-from-hook' }))
    const { requests } = await runBashTurn(hooks, WRITE_ORIGINAL)
    // Round 2 (after the tool) must carry the injected context.
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(requests[1].messages)).toContain('extra-context-from-hook')
  }, 20_000)
})
