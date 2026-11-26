// server/providers/native/hooks/stop.test.ts
// T10: the Stop dispatch seam in the neutral turn loop. At the zero-tool turn
// end the loop dispatches Stop BEFORE settling (RS §5): exit-2 / decision block
// feeds the block reason to the model and forces another API round, with
// stop_hook_active set on the next Stop input; forced continuations are capped
// at 8 (the 9th block ends the turn with a warning — CLI `Da`: the incremented
// count is compared `> cap`). continue:false overrides exit-2 (RS §2.3) and
// ends the turn; additionalContext is the non-error feedback continuation
// channel (it rides the same capped continuation path). No Stop hook (or an
// inert one) → normal turn end.
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
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-stop-config-'))
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

/** A command hook for Stop (no matcher target — any matcher matches). Explicit
 *  bash shell so the command is identical on win32 (Git Bash) and posix. */
function stopHooks(command: string): SessionHooksConfig {
  return { Stop: [{ matcher: '', hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

/** The JSON a command hook echoes to emit a Stop hookSpecificOutput. */
function stopHsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', ...fields } })}'`
}

/** Record the hook's stdin JSON (one line per dispatch) into stop-inputs.jsonl
 *  so the test can read the stop_hook_active progression across rounds. */
const RECORD_INPUT = `input=$(cat)
printf '%s\\n' "$input" >> stop-inputs.jsonl`

interface TurnOutcome {
  dir: string
  frames: Frame[]
  requests: Array<{ messages: unknown[] }>
}

/** Drive a text-only turn through the real provider + loop with the given Stop
 *  hooks config. `rounds` text rounds are scripted (each ends end_turn with no
 *  tool calls); the loop consumes only as many as the Stop seam lets it. */
async function runStopTurn(opts: { hooks?: SessionHooksConfig; rounds?: number }): Promise<TurnOutcome> {
  const dir = await tempDir('stop-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const rounds = opts.rounds ?? 2
  const scripts: CanonicalEvent[][] = Array.from({ length: rounds }, (_, i) => textTurn(`round-${i + 1}`))
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const session = provider.createSession({
    id: 'stop',
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

/** The Stop inputs recorded by the hook, one parsed JSON per dispatch. */
async function recordedInputs(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dir, 'stop-inputs.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The hook events dispatched this turn, read from the hook_started activity
 *  frames (one per matched hook, stamped with its event name). */
function hookEvents(frames: Frame[]): string[] {
  return frames
    .filter((f) => (f as { type?: string }).type === 'system' && (f as { subtype?: string }).subtype === 'hook_started')
    .map((f) => (f as { hook_event?: string }).hook_event as string)
}

describe('Stop exit-2 forced continuation (RS §5)', () => {
  it('exit-2 feeds stderr to the model, forces another round, and sets stop_hook_active', async () => {
    // Block once (flag file), then succeed — so the turn continues exactly one
    // extra round and ends normally on the second Stop dispatch.
    const command = `${RECORD_INPUT}
if [ -f stop-blocked.flag ]; then exit 0; fi
touch stop-blocked.flag
echo stop-block-stderr >&2
exit 2`
    const { dir, frames, requests } = await runStopTurn({ hooks: stopHooks(command), rounds: 3 })
    // The block forced a second API round carrying the stderr feedback.
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).toContain('stop-block-stderr')
    // The turn ended normally after the second (successful) Stop dispatch.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
    expect(hookEvents(frames)).toEqual(['Stop', 'Stop'])
    // stop_hook_active: false on the first dispatch, true on the next.
    const inputs = await recordedInputs(dir)
    expect(inputs).toHaveLength(2)
    expect(inputs[0].stop_hook_active).toBe(false)
    expect(inputs[1].stop_hook_active).toBe(true)
    expect(inputs[0].hook_event_name).toBe('Stop')
    expect(inputs[0].last_assistant_message).toBe('round-1')
  }, 30_000)
})

describe('Stop block cap (RS §5: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8)', () => {
  it('after 8 forced continuations the 9th block ends the turn with a warning', async () => {
    const command = `${RECORD_INPUT}
echo cap-stderr >&2
exit 2`
    const { dir, frames, requests } = await runStopTurn({ hooks: stopHooks(command), rounds: 12 })
    // 1 initial round + 8 forced continuations; the 9th block hits the cap.
    expect(requests).toHaveLength(9)
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
    expect((results[0] as { num_turns?: number }).num_turns).toBe(9)
    expect((results[0] as { result?: string }).result).toBe('round-9')
    // Every dispatch saw stop_hook_active except the first.
    const inputs = await recordedInputs(dir)
    expect(inputs).toHaveLength(9)
    expect(inputs[0].stop_hook_active).toBe(false)
    for (const input of inputs.slice(1)) expect(input.stop_hook_active).toBe(true)
    // The cap warning is user-visible (the informational banner frame).
    const warning = frames.find(
      (f) => (f as { type?: string }).type === 'system' && (f as { subtype?: string }).subtype === 'informational',
    ) as { content?: string } | undefined
    expect(warning?.content).toContain('9 consecutive times')
  }, 60_000)
})

describe('Stop continue:false override (RS §2.3)', () => {
  it('continue:false ends the turn despite exit-2', async () => {
    const command = `echo '{"continue":false,"stopReason":"stop-now"}'
echo overridden-stderr >&2
exit 2`
    const { frames, requests } = await runStopTurn({ hooks: stopHooks(command), rounds: 3 })
    // The hook ran, but no continuation round happened and the block stderr
    // never reached the model — continue:false overrides exit-2 on Stop.
    expect(hookEvents(frames)).toEqual(['Stop'])
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).not.toContain('overridden-stderr')
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
  }, 30_000)
})

describe('Stop additionalContext (RS §3: non-error feedback continuation)', () => {
  it('injects additionalContext and continues the conversation', async () => {
    // The first dispatch returns additionalContext (exit 0) and forces one
    // continuation; the second finds the flag and exits inertly, so the turn
    // settles after exactly one context round.
    const command = `${RECORD_INPUT}
if [ -f stop-context.flag ]; then exit 0; fi
touch stop-context.flag
${stopHsoJson({ additionalContext: 'stop-context-xyz' })}`
    const { dir, frames, requests } = await runStopTurn({ hooks: stopHooks(command), rounds: 3 })
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).toContain('stop-context-xyz')
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
    // The context continuation also marks the turn Stop-active (CLI parity:
    // any forced continuation sets the guard).
    const inputs = await recordedInputs(dir)
    expect(inputs).toHaveLength(2)
    expect(inputs[0].stop_hook_active).toBe(false)
    expect(inputs[1].stop_hook_active).toBe(true)
  }, 30_000)
})

describe('Stop with no blocking decision', () => {
  it('no Stop hook → normal turn end', async () => {
    const { frames, requests } = await runStopTurn({ rounds: 2 })
    expect(requests).toHaveLength(1)
    expect(hookEvents(frames)).toEqual([])
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { result?: string }).result).toBe('round-1')
  }, 30_000)

  it('an exit-0 Stop hook with no decision → normal turn end', async () => {
    const { frames, requests } = await runStopTurn({ hooks: stopHooks('echo stop-ok'), rounds: 2 })
    expect(requests).toHaveLength(1)
    expect(hookEvents(frames)).toEqual(['Stop'])
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
  }, 30_000)
})
