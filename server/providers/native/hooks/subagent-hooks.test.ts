// server/providers/native/hooks/subagent-hooks.test.ts
// T18: the SubagentStart / SubagentStop dispatch seams in the nested agent
// runner. SubagentStart fires once the descriptor is durable (agent_id /
// agent_type input, matcher target = agent_type); it has NO conversation
// context (RS §12.2: prompt/agent hooks report a non-blocking availability
// error) and its additionalContext routes INTO the subagent prompt.
// SubagentStop fires at the final report (stop_hook_active / agent_id /
// agent_type / last_assistant_message); exit-2 / decision block makes the
// subagent CONTINUE with the stderr feedback (capped, stop_hook_active set on
// the next dispatch), additionalContext is the non-error continuation channel.
// Both seams attribute their hook/run activity to the SIDECHAIN parent (the
// spawning Agent tool_use id), never the main thread.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import type { CanonicalEvent } from '../canonical.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'
import type { Frame } from '../../native-frames.js'

const AGENT_TOOL_ID = 'agent-call-1'

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
 *  real ~/.claude/skills can never leak in (same fixture as stop.test.ts). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-subagent-hooks-config-'))
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

function toolUseTurn(id: string, name: string, inputJson = '{}'): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** The standard launch script: the parent's Agent round, the nested text
 *  rounds (one per continuation the SubagentStop seam lets through), then the
 *  parent's closing round. */
function launchScripts(nestedTexts: string[], agentInput: Record<string, unknown> = { description: 'd', prompt: 'nested-task' }): CanonicalEvent[][] {
  return [
    toolUseTurn(AGENT_TOOL_ID, 'Agent', JSON.stringify(agentInput)),
    ...nestedTexts.map(textTurn),
    textTurn('parent-done'),
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

/** A command hook that records its stdin JSON (one line per dispatch) into
 *  `file` under the session cwd. Explicit bash shell so the command is
 *  identical on win32 (Git Bash) and posix. */
function recordCommand(file: string): string {
  return `input=$(cat)
printf '%s\\n' "$input" >> ${file}`
}

/** The JSON a command hook echoes to emit a hookSpecificOutput payload. */
function hsoJson(event: string, fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } })}'`
}

interface RecordedRequest {
  /** A nested (subagent) request never sees the Agent tool — depth is capped
   *  by filtering it out of the tool list. */
  nested: boolean
  messages: unknown[]
}

interface TurnOutcome {
  dir: string
  frames: Frame[]
  requests: RecordedRequest[]
}

/** Drive one Agent launch through the real provider + nested runner with the
 *  given hooks config and scripted rounds. */
async function runAgentTurn(opts: { hooks?: SessionHooksConfig; scripts: CanonicalEvent[][] }): Promise<TurnOutcome> {
  const dir = await tempDir('subagent-hooks-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: RecordedRequest[] = []
  const scripts = [...opts.scripts]
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (
    req: { tools: Array<{ name: string }>; messages: unknown[] },
  ) {
    requests.push({
      nested: !req.tools.some((t) => t.name === 'Agent'),
      messages: structuredClone(req.messages),
    })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const session = provider.createSession({
    id: 'subagent-hooks',
    cwd: dir,
    ...(opts.hooks ? { providerExtras: { sdkOptions: { settings: { hooks: opts.hooks } } } } : {}),
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  try {
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 15_000 })
  } finally {
    await session.destroy()
  }
  return { dir, frames, requests }
}

/** The hook inputs recorded by a recording command, one parsed JSON per dispatch. */
async function recordedInputs(dir: string, file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dir, file), 'utf8')
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The hook events dispatched this turn, read from the hook_started activity
 *  frames (one per matched hook, stamped with its event name). */
function hookEvents(frames: Frame[]): string[] {
  return frames
    .filter((f) => (f as { type?: string }).type === 'system' && (f as { subtype?: string }).subtype === 'hook_started')
    .map((f) => (f as { hook_event?: string }).hook_event as string)
}

/** The parent's Agent tool_result frame (main-thread user frame answering the
 *  spawning tool_use id). */
function agentToolResult(frames: Frame[]): { content?: Array<{ text?: string }>; is_error?: boolean } | undefined {
  const frame = frames.find(
    (f) => (f as { type?: string }).type === 'user'
      && (f as { parent_tool_use_id?: string | null }).parent_tool_use_id == null
      && Array.isArray((f as { message?: { content?: unknown } }).message?.content)
      && ((f as { message: { content: Array<{ type?: string; tool_use_id?: string }> } }).message.content[0]?.type === 'tool_result')
      && ((f as { message: { content: Array<{ tool_use_id?: string }> } }).message.content[0]?.tool_use_id === AGENT_TOOL_ID),
  ) as { message?: { content?: Array<{ content?: Array<{ text?: string }>; is_error?: boolean }> } } | undefined
  return frame?.message?.content?.[0]
}

describe('SubagentStart seam (RS §3/§9: descriptor append → runTurn)', () => {
  it('fires with agent_id/agent_type and matches on agent_type', async () => {
    const hooks: SessionHooksConfig = {
      SubagentStart: [
        { matcher: 'Explore', hooks: [{ type: 'command', command: recordCommand('explore.jsonl'), shell: 'bash' }] },
        { matcher: 'general-purpose', hooks: [{ type: 'command', command: recordCommand('start.jsonl'), shell: 'bash' }] },
      ],
    }
    const { dir, frames } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-report']) })
    // Only the general-purpose group matched — the Explore group never ran.
    expect(hookEvents(frames)).toEqual(['SubagentStart'])
    const inputs = await recordedInputs(dir, 'start.jsonl')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].hook_event_name).toBe('SubagentStart')
    expect(inputs[0].agent_type).toBe('general-purpose')
    expect(inputs[0].agent_id).toBe(AGENT_TOOL_ID)
  }, 30_000)

  it('an Explore launch matches the Explore matcher group', async () => {
    const hooks: SessionHooksConfig = {
      SubagentStart: [
        { matcher: 'general-purpose', hooks: [{ type: 'command', command: recordCommand('general.jsonl'), shell: 'bash' }] },
        { matcher: 'Explore', hooks: [{ type: 'command', command: recordCommand('explore.jsonl'), shell: 'bash' }] },
      ],
    }
    const { dir, frames } = await runAgentTurn({
      hooks,
      scripts: launchScripts(['nested-report'], { description: 'd', prompt: 'nested-task', subagent_type: 'Explore' }),
    })
    expect(hookEvents(frames)).toEqual(['SubagentStart'])
    const inputs = await recordedInputs(dir, 'explore.jsonl')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].agent_type).toBe('Explore')
  }, 30_000)

  it('additionalContext injects into the subagent prompt, never the parent thread', async () => {
    const hooks: SessionHooksConfig = {
      SubagentStart: [{
        matcher: '',
        hooks: [{ type: 'command', command: hsoJson('SubagentStart', { additionalContext: 'start-context-marker' }), shell: 'bash' }],
      }],
    }
    const { requests } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-report']) })
    const nested = requests.filter((r) => r.nested)
    expect(nested).toHaveLength(1)
    expect(JSON.stringify(nested[0].messages)).toContain('nested-task')
    expect(JSON.stringify(nested[0].messages)).toContain('start-context-marker')
    // The context belongs to the subagent — no parent round ever sees it.
    for (const r of requests.filter((r) => !r.nested)) {
      expect(JSON.stringify(r.messages)).not.toContain('start-context-marker')
    }
  }, 30_000)

  it('a prompt hook reports the no-context availability error and the subagent still runs (RS §12.2)', async () => {
    const hooks: SessionHooksConfig = {
      SubagentStart: [{ matcher: '', hooks: [{ type: 'prompt', prompt: 'Is this subagent okay?' }] }],
    }
    const { frames } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-report']) })
    const responses = frames.filter(
      (f) => (f as { type?: string }).type === 'system'
        && (f as { subtype?: string }).subtype === 'hook_response'
        && (f as { hook_event?: string }).hook_event === 'SubagentStart',
    ) as Array<{ outcome?: string; output?: string }>
    expect(responses).toHaveLength(1)
    expect(responses[0].outcome).toBe('error')
    expect(responses[0].output).toContain('no conversation context is available')
    // Non-blocking: the launch proceeded and the report was delivered.
    const result = agentToolResult(frames)
    expect(result?.is_error).toBeFalsy()
    expect(JSON.stringify(result?.content)).toContain('nested-report')
  }, 30_000)
})

describe('SubagentStop seam (RS §3/§9: finalReport)', () => {
  it('fires on completion with stop_hook_active/agent_id/agent_type/last_assistant_message', async () => {
    const hooks: SessionHooksConfig = {
      SubagentStop: [{ matcher: 'general-purpose', hooks: [{ type: 'command', command: recordCommand('stop.jsonl'), shell: 'bash' }] }],
    }
    const { dir, frames } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-report']) })
    expect(hookEvents(frames)).toEqual(['SubagentStop'])
    const inputs = await recordedInputs(dir, 'stop.jsonl')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].hook_event_name).toBe('SubagentStop')
    expect(inputs[0].stop_hook_active).toBe(false)
    expect(inputs[0].agent_id).toBe(AGENT_TOOL_ID)
    expect(inputs[0].agent_type).toBe('general-purpose')
    expect(inputs[0].last_assistant_message).toBe('nested-report')
    // The report still reaches the parent as the Agent tool_result.
    expect(JSON.stringify(agentToolResult(frames)?.content)).toContain('nested-report')
  }, 30_000)

  it('exit-2 feeds stderr to the subagent and forces a continuation round', async () => {
    // Block once (flag file), then succeed — the subagent continues exactly
    // one extra round and settles on the second SubagentStop dispatch.
    const command = `${recordCommand('stop.jsonl')}
if [ -f stop-blocked.flag ]; then exit 0; fi
touch stop-blocked.flag
echo subagent-continue-stderr >&2
exit 2`
    const hooks: SessionHooksConfig = {
      SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command, shell: 'bash' }] }],
    }
    const { dir, frames, requests } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-round-1', 'nested-round-2']) })
    expect(hookEvents(frames)).toEqual(['SubagentStop', 'SubagentStop'])
    const nested = requests.filter((r) => r.nested)
    expect(nested).toHaveLength(2)
    expect(JSON.stringify(nested[1].messages)).toContain('subagent-continue-stderr')
    // The continuation's report is the one delivered to the parent.
    const result = agentToolResult(frames)
    expect(result?.is_error).toBeFalsy()
    expect(JSON.stringify(result?.content)).toContain('nested-round-2')
    // stop_hook_active: false on the first dispatch, true on the next.
    const inputs = await recordedInputs(dir, 'stop.jsonl')
    expect(inputs).toHaveLength(2)
    expect(inputs[0].stop_hook_active).toBe(false)
    expect(inputs[1].stop_hook_active).toBe(true)
    expect(inputs[0].last_assistant_message).toBe('nested-round-1')
    expect(inputs[1].last_assistant_message).toBe('nested-round-2')
  }, 30_000)

  it('additionalContext routes to the subagent continuation', async () => {
    const command = `${recordCommand('stop.jsonl')}
if [ -f stop-context.flag ]; then exit 0; fi
touch stop-context.flag
${hsoJson('SubagentStop', { additionalContext: 'stop-context-marker' })}`
    const hooks: SessionHooksConfig = {
      SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command, shell: 'bash' }] }],
    }
    const { requests } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-round-1', 'nested-round-2']) })
    const nested = requests.filter((r) => r.nested)
    expect(nested).toHaveLength(2)
    expect(JSON.stringify(nested[1].messages)).toContain('stop-context-marker')
    for (const r of requests.filter((r) => !r.nested)) {
      expect(JSON.stringify(r.messages)).not.toContain('stop-context-marker')
    }
  }, 30_000)
})

describe('sidechain parent attribution (T7 carry-forward)', () => {
  it('subagent hook activity carries the spawning tool_use id; main-thread Stop stays null', async () => {
    const hooks: SessionHooksConfig = {
      SubagentStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo start-ok', shell: 'bash' }] }],
      SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo stop-ok', shell: 'bash' }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo main-ok', shell: 'bash' }] }],
    }
    const { frames } = await runAgentTurn({ hooks, scripts: launchScripts(['nested-report']) })
    const hookFrames = frames.filter(
      (f) => (f as { type?: string }).type === 'system'
        && ['hook_started', 'hook_response'].includes((f as { subtype?: string }).subtype as string),
    ) as Array<{ subtype?: string; hook_event?: string; parent_tool_use_id?: string | null }>
    const subagentFrames = hookFrames.filter((f) => f.hook_event === 'SubagentStart' || f.hook_event === 'SubagentStop')
    // started + completed for each of the two subagent events.
    expect(subagentFrames).toHaveLength(4)
    expect(subagentFrames.every((f) => f.parent_tool_use_id === AGENT_TOOL_ID)).toBe(true)
    const stopFrames = hookFrames.filter((f) => f.hook_event === 'Stop')
    expect(stopFrames).toHaveLength(2)
    expect(stopFrames.every((f) => f.parent_tool_use_id == null)).toBe(true)
  }, 30_000)
})