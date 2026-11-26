// server/providers/native/hooks/userpromptsubmit.test.ts
// T11: the UserPromptSubmit dispatch seam at prompt consumption (RS §3). The
// session dispatches UserPromptSubmit BEFORE the prompt joins the conversation.
// exit-2 / decision block erases the prompt from native's OWN log only (the
// durable user/message append is skipped) — the host bubble stays (the manager
// broadcast + seq-stored it before the provider saw the prompt), so the blocked
// turn still fires a consumption ack + a result frame and the bubble settles
// instead of hanging 'queued'. The block reason is user-only (RS §3), surfaced
// via the result. additionalContext joins the turn; suppressOriginalPrompt
// removes the original prompt from the model turn (the context replaces it);
// sessionTitle is applied. No hook / continue → normal processing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { nativeSessionLogPath } from '../session-log/paths.js'
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
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-ups-config-'))
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

/** A command hook for UserPromptSubmit (no matcher target — any matcher
 *  matches). Explicit bash shell so the command is identical on win32 and posix. */
function promptHooks(command: string): SessionHooksConfig {
  return { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

/** The JSON a command hook echoes to emit a UserPromptSubmit hookSpecificOutput. */
function promptHsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...fields } })}'`
}

interface PromptOutcome {
  dir: string
  frames: Frame[]
  requests: Array<{ messages: unknown[] }>
  /** uuids the core reported consumed (the host 'queued → sent' ack). */
  consumed: string[]
  /** terminal persistence outcomes per uuid ('failed' would signal retraction). */
  persistence: Array<{ uuid: string; outcome: string }>
  /** the enqueued prompt's uuid. */
  promptUuid: string
}

/** Drive a text-only turn through the real provider with the given
 *  UserPromptSubmit hooks config, recording the host consumption/persistence
 *  acks so the test can prove the bubble settles and is not retracted. */
async function runPromptTurn(opts: { hooks?: SessionHooksConfig; prompt?: string }): Promise<PromptOutcome> {
  const dir = await tempDir('ups-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of textTurn('answer')) yield ev
  }
  const consumed: string[] = []
  const persistence: Array<{ uuid: string; outcome: string }> = []
  const session = provider.createSession({
    id: 'ups',
    cwd: dir,
    ...(opts.hooks ? { providerExtras: { sdkOptions: { settings: { hooks: opts.hooks } } } } : {}),
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    onUserMessageConsumed: (msg: { uuid?: string }) => { if (typeof msg.uuid === 'string') consumed.push(msg.uuid) },
    onUserMessagePersistence: (msg: { uuid?: string }, outcome: string) => {
      if (typeof msg.uuid === 'string') persistence.push({ uuid: msg.uuid, outcome })
    },
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  const prompt = opts.prompt ?? 'go'
  const message = userMsg(prompt)
  try {
    session.enqueueUserMessage(message as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 15_000 })
  } finally {
    await session.destroy()
  }
  return { dir, frames, requests, consumed, persistence, promptUuid: message.uuid }
}

/** The raw native session log text (neutral v3 JSONL on disk). */
async function nativeLog(dir: string): Promise<string> {
  return readFile(nativeSessionLogPath(dir, 'ups'), 'utf8')
}

describe('UserPromptSubmit exit-2 block (RS §3: erase native log, host bubble stays)', () => {
  it('blocks processing, erases the prompt from native log, acks consumption + emits a result', async () => {
    const prompt = 'blocked-prompt-xyz'
    const { dir, frames, requests, consumed, persistence, promptUuid } = await runPromptTurn({
      hooks: promptHooks('echo ups-block-stderr >&2\nexit 2'),
      prompt,
    })
    // No API round ran — the prompt was blocked before the turn.
    expect(requests).toHaveLength(0)
    // The prompt is absent from native's own log (the durable append was skipped).
    expect(await nativeLog(dir)).not.toContain(prompt)
    // Exactly one terminal result settles the turn; the block reason is user-only.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBe(true)
    expect((results[0] as { result?: string }).result).toContain('ups-block-stderr')
    // The host bubble is NOT retracted: consumption ack fired (queued → sent)
    // and the prompt was never reported as a terminal 'failed' (withdrawal).
    expect(consumed).toContain(promptUuid)
    expect(persistence.filter((p) => p.uuid === promptUuid).every((p) => p.outcome !== 'failed')).toBe(true)
  }, 30_000)

  it('a bare exit-2 block (empty stderr) still settles with a factual marker', async () => {
    const { frames, consumed, promptUuid } = await runPromptTurn({
      hooks: promptHooks('exit 2'),
      prompt: 'bare-block-prompt',
    })
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBe(true)
    expect((results[0] as { result?: string }).result).toBeTruthy()
    expect(consumed).toContain(promptUuid)
  }, 30_000)
})

describe('UserPromptSubmit additionalContext (RS §3: context joins the turn)', () => {
  it('injects additionalContext into the model turn and processes normally', async () => {
    const { frames, requests } = await runPromptTurn({
      hooks: promptHooks(promptHsoJson({ additionalContext: 'ups-context-xyz' })),
      prompt: 'context-prompt',
    })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain('ups-context-xyz')
    // The original prompt still joins the turn (no suppression).
    expect(JSON.stringify(requests[0].messages)).toContain('context-prompt')
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
  }, 30_000)

  it('exit-0 plain stdout feeds model context (RS §2.2)', async () => {
    const { requests } = await runPromptTurn({
      hooks: promptHooks('echo plain-stdout-context'),
      prompt: 'plain-prompt',
    })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain('plain-stdout-context')
  }, 30_000)
})

describe('UserPromptSubmit suppressOriginalPrompt (RS §3)', () => {
  it('removes the original prompt from the model turn; the context replaces it', async () => {
    const prompt = 'suppressed-prompt-xyz'
    const { dir, frames, requests } = await runPromptTurn({
      hooks: promptHooks(promptHsoJson({ suppressOriginalPrompt: true, additionalContext: 'replacement-ctx' })),
      prompt,
    })
    expect(requests).toHaveLength(1)
    const wire = JSON.stringify(requests[0].messages)
    expect(wire).toContain('replacement-ctx')
    expect(wire).not.toContain(prompt)
    // The suppressed prompt does not join native's conversation log either.
    expect(await nativeLog(dir)).not.toContain(prompt)
    // The turn still runs and settles normally (suppression is not a block).
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
  }, 30_000)
})

describe('UserPromptSubmit sessionTitle (RS §3)', () => {
  it('applies sessionTitle to the durable log', async () => {
    const { dir } = await runPromptTurn({
      hooks: promptHooks(promptHsoJson({ sessionTitle: 'hook-set-title' })),
      prompt: 'title-prompt',
    })
    expect(await nativeLog(dir)).toContain('hook-set-title')
  }, 30_000)
})

describe('UserPromptSubmit with no blocking decision', () => {
  it('no hook → normal processing', async () => {
    const { frames, requests, consumed, promptUuid } = await runPromptTurn({ prompt: 'normal-prompt' })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain('normal-prompt')
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
    expect(consumed).toContain(promptUuid)
  }, 30_000)

  it('an exit-0 hook with no decision → normal processing', async () => {
    const { frames, requests } = await runPromptTurn({
      hooks: promptHooks('echo ups-ok'),
      prompt: 'inert-prompt',
    })
    expect(requests).toHaveLength(1)
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
  }, 30_000)
})