// server/providers/native/hooks/stopfailure.test.ts
// T21: the StopFailure dispatch seam in the pump catch (RS §3, §9.1). A turn
// that THROWS lands in the pump catch, which pushes the single terminal error
// result frame. StopFailure dispatches there fire-and-forget: the hook's output
// AND exit code are ALL ignored (RS §3) — the error result is already final and
// the decision can never change it, force a continuation, or emit a second
// terminal frame. The dispatch is awaited only so its hook/run activity emits.
//
// CLI parity (binary-verified `T9r`/`vXe`): the CLI fires StopFailure only on
// API-error assistant messages (`error = e.error ?? "unknown"`), NEVER on an
// aborted turn. So an interrupt — the pump catch's existing `interrupted`
// classification — skips the dispatch and keeps its 'interrupted by user'
// result. The matcher target is `error` (matcher.ts maps StopFailure→error).
// hasContext:false — StopFailure is a non-REPL event (RS §12.2): prompt/agent
// hooks report a non-blocking availability error, which fire-and-forget ignores.
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
 *  real ~/.claude/skills can never leak in (same fixture as stop.test.ts). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-stopfailure-config-'))
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

/** A round carrying BOTH a text block and a tool call, so the settled assistant
 *  message has text (the StopFailure last_assistant_message source) AND the loop
 *  makes another request (where the scripted error then lands). */
function textAndToolTurn(text: string, toolUseId: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'block_start', index: 1, block: { type: 'tool_use', id: toolUseId, name } },
    { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 1 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
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

/** A command hook for StopFailure. Explicit bash shell so the command is
 *  identical on win32 (Git Bash) and posix. */
function commandHook(command: string) {
  return { type: 'command' as const, command, shell: 'bash' as const }
}

function stopFailureHooks(matcher: string, command: string): SessionHooksConfig {
  return { StopFailure: [{ matcher, hooks: [commandHook(command)] }] }
}

/** Record the hook's stdin JSON (one line per dispatch) into
 *  stopfailure-inputs.jsonl so the test can read the error classification. */
const RECORD_INPUT = `input=$(cat)
printf '%s\\n' "$input" >> stopfailure-inputs.jsonl`

interface TurnOutcome {
  dir: string
  frames: Frame[]
  requests: Array<{ messages: unknown[] }>
}

/** Drive a turn through the real provider + loop whose stream THROWS after the
 *  scripted `rounds` (each a successful API round). With no rounds the very
 *  first request throws. The throw lands in the pump catch — the StopFailure
 *  seam under test. */
async function runErrorTurn(opts: {
  hooks?: SessionHooksConfig
  rounds?: CanonicalEvent[][]
  errorMessage?: string
}): Promise<TurnOutcome> {
  const dir = await tempDir('stopfailure-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const scripts: CanonicalEvent[][] = [...(opts.rounds ?? [])]
  const errorMessage = opts.errorMessage ?? 'boom-api-failure'
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    const script = scripts.shift()
    if (script) {
      for (const ev of script) yield ev
      return
    }
    throw new Error(errorMessage)
  }
  const session = provider.createSession({
    id: 'stopfailure',
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
      // The dispatch is awaited after the result frame; don't tear down until
      // the hook has actually run (else destroy aborts it mid-flight).
      if (opts.hooks) expect(hookCompleted(frames, 'StopFailure')).toBe(true)
    }, { timeout: 15_000 })
  } finally {
    await session.destroy()
  }
  return { dir, frames, requests }
}

/** The StopFailure inputs recorded by the hook, one parsed JSON per dispatch. */
async function recordedInputs(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dir, 'stopfailure-inputs.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The hook events dispatched this turn, read from the hook_started activity
 *  frames (one per matched hook, stamped with its event name). */
function hookEvents(frames: Frame[]): string[] {
  return frames
    .filter((f) => (f as { type?: string }).type === 'system' && (f as { subtype?: string }).subtype === 'hook_started')
    .map((f) => (f as { hook_event?: string }).hook_event as string)
}

/** Whether a hook's terminal activity (hook_response) for `event` has landed.
 *  The StopFailure dispatch is awaited AFTER the error result frame is pushed,
 *  so a harness that tears down on the result frame alone would race the hook;
 *  waiting for hook_response guarantees the hook ran and recorded its input. */
function hookCompleted(frames: Frame[], event: string): boolean {
  return frames.some((f) => (f as { type?: string }).type === 'system'
    && (f as { subtype?: string }).subtype === 'hook_response'
    && (f as { hook_event?: string }).hook_event === event)
}

describe('StopFailure fires on a turn error (RS §3 / §9.1)', () => {
  it('a throwing turn dispatches StopFailure with the error classification and details', async () => {
    const { dir, frames, requests } = await runErrorTurn({
      hooks: stopFailureHooks('', RECORD_INPUT),
      errorMessage: 'boom-api-failure',
    })
    // Exactly one terminal error result carrying the thrown message.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBe(true)
    expect((results[0] as { result?: string }).result).toBe('boom-api-failure')
    expect(requests).toHaveLength(1)
    // The StopFailure hook ran and saw the error classification + details.
    expect(hookEvents(frames)).toEqual(['StopFailure'])
    const inputs = await recordedInputs(dir)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].hook_event_name).toBe('StopFailure')
    expect(inputs[0].error).toBe('unknown')
    expect(inputs[0].error_details).toBe('boom-api-failure')
  }, 30_000)

  it('matcher target is the error value — a matching matcher fires, a non-matching one does not', async () => {
    const dir = await tempDir('stopfailure-matcher-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      throw new Error('boom-api-failure')
    }
    // error classifies as 'unknown': the 'unknown' matcher fires, 'rate_limit' does not.
    const hooks: SessionHooksConfig = {
      StopFailure: [
        { matcher: 'unknown', hooks: [commandHook(RECORD_INPUT)] },
        { matcher: 'rate_limit', hooks: [commandHook(`input=$(cat)\nprintf '%s\\n' "$input" >> unmatched.jsonl`)] },
      ],
    }
    const session = provider.createSession({
      id: 'stopfailure-matcher',
      cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('go') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
        expect(hookCompleted(frames, 'StopFailure')).toBe(true)
      }, { timeout: 15_000 })
    } finally {
      await session.destroy()
    }
    expect(hookEvents(frames)).toEqual(['StopFailure'])
    expect(await recordedInputs(dir)).toHaveLength(1)
    await expect(readFile(join(dir, 'unmatched.jsonl'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it('last_assistant_message carries the last assistant text when a round preceded the error', async () => {
    const { dir } = await runErrorTurn({
      hooks: stopFailureHooks('', RECORD_INPUT),
      rounds: [textAndToolTurn('assistant-round-1-text', 'tu-1', 'TodoWrite', {
        todos: [{ content: 'task', status: 'pending', activeForm: 'Doing task' }],
      })],
    })
    const inputs = await recordedInputs(dir)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].last_assistant_message).toBe('assistant-round-1-text')
  }, 30_000)
})

describe('StopFailure is fire-and-forget (RS §3: output + exit code ALL ignored)', () => {
  it('an exit-2 decision:block hook does NOT change the error result or force a continuation', async () => {
    // On Stop this exact output would force another API round. On StopFailure
    // the block decision and the exit code must both be ignored.
    const command = `${RECORD_INPUT}
echo '{"decision":"block","reason":"hook-block-reason"}'
echo stopfailure-block-stderr >&2
exit 2`
    const { dir, frames, requests } = await runErrorTurn({ hooks: stopFailureHooks('', command) })
    // The error result is byte-identical to the no-hook case: one terminal
    // frame, the original thrown message, no continuation round.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBe(true)
    expect((results[0] as { result?: string }).result).toBe('boom-api-failure')
    expect(requests).toHaveLength(1)
    // The hook DID run (its activity emitted) — the block was simply ignored.
    expect(hookEvents(frames)).toEqual(['StopFailure'])
    expect(await recordedInputs(dir)).toHaveLength(1)
    // The block reason / stderr never reached the model in any round.
    expect(requests.every((r) => !JSON.stringify(r.messages).includes('stopfailure-block-stderr'))).toBe(true)
    expect(requests.every((r) => !JSON.stringify(r.messages).includes('hook-block-reason'))).toBe(true)
  }, 30_000)

  it('an exit-0 continue:false hook does NOT resurrect or alter the errored turn', async () => {
    const command = `${RECORD_INPUT}
echo '{"continue":false,"stopReason":"hook-wants-stop"}'`
    const { frames, requests } = await runErrorTurn({ hooks: stopFailureHooks('', command) })
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { result?: string }).result).toBe('boom-api-failure')
    expect((results[0] as { is_error?: boolean }).is_error).toBe(true)
    expect(requests).toHaveLength(1)
    expect(hookEvents(frames)).toEqual(['StopFailure'])
  }, 30_000)
})

describe('interrupted turns classify correctly (CLI parity: no StopFailure on abort)', () => {
  it('an interrupt keeps the interrupted result and fires NO StopFailure', async () => {
    const dir = await tempDir('stopfailure-interrupt-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    // Streamer that hangs until its signal aborts (same seam as the
    // native-session interrupt test): the turn is in flight when interrupted.
    let streamStarted!: () => void
    const started = new Promise<void>((resolve) => { streamStarted = resolve })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      streamStarted()
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({
      id: 'stopfailure-interrupt',
      cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: stopFailureHooks('', RECORD_INPUT) } } },
      canUseTool: async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('go') as never)
      await started
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(0)
      await session.interrupt?.()
      await vi.waitFor(() => {
        const results = frames.filter((f) => f.type === 'result')
        expect(results).toHaveLength(1)
        expect((results[0] as { result?: string }).result).toBe('interrupted by user')
        expect((results[0] as { is_error?: boolean }).is_error).toBe(true)
      }, { timeout: 15_000 })
      // The CLI never fires StopFailure on an aborted turn; native parity keeps
      // the interrupt classification and skips the dispatch entirely.
      expect(hookEvents(frames)).toEqual([])
      await expect(readFile(join(dir, 'stopfailure-inputs.jsonl'), 'utf8')).rejects.toThrow()
    } finally {
      await session.destroy()
    }
  }, 30_000)
})
