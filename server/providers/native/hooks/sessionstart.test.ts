// server/providers/native/hooks/sessionstart.test.ts
// T17: the SessionStart dispatch seams (RS §3, §13.2). Init fires with source
// mapped from the spawn mode — fresh → 'startup', resume → 'resume', fork →
// 'fork'; CRW's /clear is a host-driven fresh spawn, so it surfaces as
// 'startup' and there is NO 'clear' source. After the compact splice a second
// dispatch fires with source 'compact' (ordered after PostCompact per m0o —
// the PostCompact dispatch lands immediately before the SessionStart(compact)
// call; the full PreCompact → summarize → compactInPlace → PostCompact →
// SessionStart(compact) order is pinned by the compact-hooks suite). Specific
// output: additionalContext / initialUserMessage
// lead the next turn's messages (the first turn for init, the first post-compact
// turn for 'compact'), sessionTitle is applied to the durable log, reloadSkills
// triggers the manual-reload path, watchPaths is accepted but inert (native has
// no fs watcher — layer-2). exit-2 never blocks the session (stderr user-only).
// EVERY source (compact included) is a no-conversation-context dispatch
// (RS §12.2/§13.2 ivr): prompt/agent hooks yield the non-blocking availability
// error, never an LLM round. The pending consumption is exactly-once across
// turn failures: a post-append failure restores the injected prefix once, a
// pre-append failure parks the prompt and the retry re-reads the same pending.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { nativeCoreOf } from '../../native-host-frame-adapter.js'
import { nativeSessionLogPath } from '../session-log/paths.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'
import type { CanonicalEvent } from '../canonical.js'
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
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-ss-config-'))
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
    uuid: `ss-u-${++userMsgSeq}`,
  }
}

/** A SessionStart hooks config. Explicit bash shell so the command is identical
 *  on win32 and posix (same fixture as userpromptsubmit.test.ts). */
function ssHooks(command: string, matcher = ''): SessionHooksConfig {
  return { SessionStart: [{ matcher, hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

/** Capture the hook's stdin (the event JSON) one line per dispatch into the
 *  session cwd, so the test reads the REAL dispatched input end-to-end. */
const CAPTURE_COMMAND = 'input=$(cat)\nprintf \'%s\\n\' "$input" >> ss-inputs.jsonl'

/** The JSON a command hook echoes to emit a SessionStart hookSpecificOutput. */
function ssHsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', ...fields } })}'`
}

interface CapturedInput {
  session_id: string
  cwd: string
  hook_event_name: string
  source: string
  model?: string
}

/** Read the captured dispatch inputs (one JSON line per dispatch). */
async function capturedInputs(dir: string): Promise<CapturedInput[]> {
  let text: string
  try {
    text = await readFile(join(dir, 'ss-inputs.jsonl'), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as CapturedInput)
}

/** Wait for at least `count` captured dispatches and return them. */
async function waitForInputs(dir: string, count: number): Promise<CapturedInput[]> {
  let inputs: CapturedInput[] = []
  await vi.waitFor(async () => {
    inputs = await capturedInputs(dir)
    expect(inputs.length).toBeGreaterThanOrEqual(count)
  }, { timeout: 10_000 })
  return inputs
}

interface SessionOutcome {
  dir: string
  frames: Frame[]
  requests: Array<{ messages: unknown[]; system?: unknown }>
}

/** Create a session with the given SessionStart hooks and drive text turns
 *  through the real provider (each prompt waits for its terminal result). */
async function runSession(opts: {
  hooks?: SessionHooksConfig
  prompts?: string[]
  id?: string
}): Promise<SessionOutcome> {
  const dir = await tempDir('ss-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[]; system?: unknown }> = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of textTurn('answer')) yield ev
  }
  const session = provider.createSession({
    id: opts.id ?? 'ss',
    cwd: dir,
    ...(opts.hooks ? { providerExtras: { sdkOptions: { settings: { hooks: opts.hooks } } } } : {}),
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  try {
    for (const prompt of opts.prompts ?? []) {
      const before = frames.filter((f) => f.type === 'result').length
      session.enqueueUserMessage(userMsg(prompt) as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result').length).toBe(before + 1)
      }, { timeout: 15_000 })
    }
  } finally {
    await session.destroy()
  }
  return { dir, frames, requests }
}

describe('SessionStart source mapping (RS §13.2: {startup, resume, fork, compact}, NOT clear)', () => {
  it('a fresh session fires SessionStart with source startup at init', async () => {
    const dir = await tempDir('ss-fresh-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const session = provider.createSession({
      id: 'ss', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(CAPTURE_COMMAND) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      // No turn needed — the dispatch fires at init. Wait for the capture
      // BEFORE destroy (destroy aborts the in-flight hook subprocess).
      const inputs = await waitForInputs(dir, 1)
      expect(inputs).toHaveLength(1)
      expect(inputs[0].hook_event_name).toBe('SessionStart')
      expect(inputs[0].source).toBe('startup')
      expect(inputs[0].session_id).toBe('ss')
      expect(inputs[0].cwd).toBe(dir)
      expect(inputs[0].model).toBeTruthy()
    } finally {
      await session.destroy()
    }
  }, 30_000)

  it('a resume fires SessionStart with source resume', async () => {
    const dir = await tempDir('ss-resume-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const source = provider.createSession({ id: 'ss-resume-source', cwd: dir })
    await source.destroy()
    const resumed = provider.createSession({
      id: 'ss-resume-source',
      cwd: dir,
      resume: 'ss-resume-source',
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(CAPTURE_COMMAND) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      const inputs = await waitForInputs(dir, 1)
      expect(inputs).toHaveLength(1)
      expect(inputs[0].source).toBe('resume')
    } finally {
      await resumed.destroy()
    }
  }, 30_000)

  it('a fork fires SessionStart with source fork', async () => {
    const dir = await tempDir('ss-fork-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const source = provider.createSession({ id: 'ss-fork-source', cwd: dir })
    await source.destroy()
    const forked = provider.createSession({
      id: 'ss-fork-target',
      cwd: dir,
      resume: 'ss-fork-source',
      forkSession: true,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(CAPTURE_COMMAND) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      const inputs = await waitForInputs(dir, 1)
      expect(inputs).toHaveLength(1)
      expect(inputs[0].source).toBe('fork')
    } finally {
      await forked.destroy()
    }
  }, 30_000)

  it('a /clear-style fresh spawn surfaces as startup — never clear', async () => {
    // CRW /clear = host-driven fresh spawn under a new id (RS §13.2): the new
    // session fires startup; no dispatch anywhere carries source 'clear'.
    const dir = await tempDir('ss-clear-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const hooks = ssHooks(CAPTURE_COMMAND)
    const first = provider.createSession({
      id: 'ss-clear-before', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    await waitForInputs(dir, 1)
    await first.destroy()
    const second = provider.createSession({
      id: 'ss-clear-after', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      const inputs = await waitForInputs(dir, 2)
      expect(inputs.map((i) => i.source)).toEqual(['startup', 'startup'])
      expect(inputs.some((i) => i.source === 'clear')).toBe(false)
    } finally {
      await second.destroy()
    }
  }, 30_000)

  it('the matcher target is the source (a resume-only matcher does not fire on startup)', async () => {
    const dir = await tempDir('ss-matcher-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const hooks: SessionHooksConfig = {
      SessionStart: [
        { matcher: 'resume', hooks: [{ type: 'command', command: 'echo resume-matched >> ss-match.txt', shell: 'bash' }] },
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo startup-matched >> ss-match.txt', shell: 'bash' }] },
      ],
    }
    const session = provider.createSession({
      id: 'ss-matcher', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      await vi.waitFor(async () => {
        expect(await readFile(join(dir, 'ss-match.txt'), 'utf8')).toContain('startup-matched')
      }, { timeout: 10_000 })
      expect(await readFile(join(dir, 'ss-match.txt'), 'utf8')).not.toContain('resume-matched')
    } finally {
      await session.destroy()
    }
  }, 30_000)
})

describe('SessionStart(compact) after the compact splice (RS §13.2 m0o)', () => {
  it('fires once with source compact after compactInPlace, and its context seeds the next turn', async () => {
    const dir = await tempDir('ss-compact-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('answer')) yield ev
    }
    // Capture every dispatch; emit additionalContext ONLY for the compact
    // source so the init dispatch leaves no pending context behind.
    const command = `${CAPTURE_COMMAND}\ncase "$input" in *'"source":"compact"'*) echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'post-compact-ctx' } })}';; esac`
    const session = provider.createSession({
      id: 'ss-compact', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(command) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      // The init dispatch fired before any compact; exactly one entry so far.
      const initInputs = await waitForInputs(dir, 1)
      expect(initInputs.map((i) => i.source)).toEqual(['startup'])
      const core = nativeCoreOf(session)!
      // Optional on the core contract; the concrete NativeSession implements it.
      expect(core.compactInPlace).toBeDefined()
      await core.compactInPlace!('compact summary text', { uuid: 'ss-compact-uuid', timestamp: new Date().toISOString() })
      // The compact dispatch fires after the splice (the call above returned).
      // T19 pins its ordering AFTER PostCompact; here we pin source + count.
      const inputs = await waitForInputs(dir, 2)
      expect(inputs.map((i) => i.source)).toEqual(['startup', 'compact'])
      // The compact hook's additionalContext seeds the first post-compact turn.
      session.enqueueUserMessage(userMsg('after-compact') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      }, { timeout: 15_000 })
      expect(requests).toHaveLength(1)
      const wire = JSON.stringify(requests[0].messages)
      expect(wire).toContain('post-compact-ctx')
      expect(wire).toContain('after-compact')
      // The compact context LEADS the post-compact prompt (same ordering as init).
      expect(wire.indexOf('post-compact-ctx')).toBeLessThan(wire.indexOf('after-compact'))
    } finally {
      await session.destroy()
    }
  }, 30_000)
})

describe('SessionStart specific output (RS §3)', () => {
  it('additionalContext injects into the FIRST turn only', async () => {
    const { requests } = await runSession({
      hooks: ssHooks(`${CAPTURE_COMMAND}\n${ssHsoJson({ additionalContext: 'ss-context-xyz' })}`),
      prompts: ['first-prompt', 'second-prompt'],
    })
    expect(requests).toHaveLength(2)
    const first = JSON.stringify(requests[0].messages)
    expect(first).toContain('ss-context-xyz')
    expect(first).toContain('first-prompt')
    // The context leads the turn (before the user prompt).
    expect(first.indexOf('ss-context-xyz')).toBeLessThan(first.indexOf('first-prompt'))
    // Consumed exactly once: the second request carries the full live history
    // (the first turn's context message included), but no SECOND copy is
    // re-injected into the new turn.
    const second = JSON.stringify(requests[1].messages)
    expect(second.split('ss-context-xyz').length - 1).toBe(1)
  }, 30_000)

  it('exit-0 plain stdout feeds the first turn context (RS §2.2)', async () => {
    const { requests } = await runSession({
      hooks: ssHooks('echo ss-plain-stdout-context'),
      prompts: ['plain-prompt'],
    })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain('ss-plain-stdout-context')
  }, 30_000)

  it('initialUserMessage seeds the first user turn (leads the prompt)', async () => {
    const { requests } = await runSession({
      hooks: ssHooks(ssHsoJson({ initialUserMessage: 'ss-seed-xyz' })),
      prompts: ['hello-prompt'],
    })
    expect(requests).toHaveLength(1)
    const wire = JSON.stringify(requests[0].messages)
    expect(wire).toContain('ss-seed-xyz')
    expect(wire).toContain('hello-prompt')
    expect(wire.indexOf('ss-seed-xyz')).toBeLessThan(wire.indexOf('hello-prompt'))
  }, 30_000)

  it('sessionTitle is applied to the durable log; watchPaths is accepted (inert)', async () => {
    const dir = await tempDir('ss-title-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const session = provider.createSession({
      id: 'ss-title', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(ssHsoJson({ sessionTitle: 'ss-hook-title', watchPaths: ['/nonexistent-watch-path'] })) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      await vi.waitFor(async () => {
        expect(await readFile(nativeSessionLogPath(dir, 'ss-title'), 'utf8')).toContain('ss-hook-title')
      }, { timeout: 10_000 })
    } finally {
      await session.destroy()
    }
  }, 30_000)

  it('reloadSkills triggers the skill reload path', async () => {
    const dir = await tempDir('ss-reload-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const session = provider.createSession({
      id: 'ss-reload', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(ssHsoJson({ reloadSkills: true })) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    try {
      const core = nativeCoreOf(session)!
      // Installed synchronously right after createSession — before the init
      // dispatch's subprocess can settle — so the trigger is observed directly.
      const reload = vi.spyOn(core, 'reloadSkills')
      await vi.waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 10_000 })
    } finally {
      await session.destroy()
    }
  }, 30_000)

  it('exit-2 never blocks the session (stderr user-only, RS §3)', async () => {
    const { frames, requests } = await runSession({
      hooks: ssHooks('echo ss-start-stderr >&2\nexit 2'),
      prompts: ['unblocked-prompt'],
    })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain('unblocked-prompt')
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
  }, 30_000)
})

/** The SessionStart hook_response activity frames (the adapter projects the
 *  neutral hook/run completion to system/hook_response). */
function sessionStartHookResponses(frames: Frame[]): Array<{ outcome?: string; output?: string }> {
  return frames.filter((f) => f.type === 'system'
    && (f as { subtype?: string }).subtype === 'hook_response'
    && (f as { hook_event?: string }).hook_event === 'SessionStart') as Array<{ outcome?: string; output?: string }>
}

describe('SessionStart prompt/agent availability (RS §12.2/§13.2: NO context on ANY source)', () => {
  // Every SessionStart source rides the CLI's no-toolUseContext generator
  // (ivr) — compact included. A prompt-type hook must yield the non-blocking
  // availability error, never an LLM round (the hook round would route through
  // the same _testStream and show up as an extra request).
  const promptHooks: SessionHooksConfig = {
    SessionStart: [{ matcher: '', hooks: [{ type: 'prompt', prompt: 'Is this session okay?' }] }],
  }

  it('a prompt-type SessionStart hook is a non-blocking availability error at init', async () => {
    const dir = await tempDir('ss-avail-init-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('answer')) yield ev
    }
    const session = provider.createSession({
      id: 'ss-avail-init', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: promptHooks } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('go') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      }, { timeout: 15_000 })
      const responses = sessionStartHookResponses(frames)
      expect(responses).toHaveLength(1)
      expect(responses[0].outcome).toBe('error')
      expect(responses[0].output).toContain('no conversation context is available')
      // No hook LLM round ran — only the turn's own API request.
      expect(requests).toHaveLength(1)
      // Non-blocking: the turn processed normally.
      expect((frames.find((f) => f.type === 'result') as { is_error?: boolean }).is_error).toBeFalsy()
    } finally {
      await session.destroy()
    }
  }, 30_000)

  it('a prompt-type SessionStart hook is a non-blocking availability error on compact too', async () => {
    const dir = await tempDir('ss-avail-compact-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('answer')) yield ev
    }
    const session = provider.createSession({
      id: 'ss-avail-compact', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: promptHooks } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      // The init dispatch's availability error lands first.
      await vi.waitFor(() => expect(sessionStartHookResponses(frames)).toHaveLength(1), { timeout: 10_000 })
      const core = nativeCoreOf(session)!
      expect(core.compactInPlace).toBeDefined()
      await core.compactInPlace!('compact summary text', { uuid: 'ss-avail-compact-uuid', timestamp: new Date().toISOString() })
      // The compact dispatch reports the SAME availability error — not an LLM round.
      await vi.waitFor(() => expect(sessionStartHookResponses(frames)).toHaveLength(2), { timeout: 10_000 })
      const responses = sessionStartHookResponses(frames)
      expect(responses[1].outcome).toBe('error')
      expect(responses[1].output).toContain('no conversation context is available')
      expect(requests).toHaveLength(0)
      // The session still turns normally afterwards.
      session.enqueueUserMessage(userMsg('after-compact') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      }, { timeout: 15_000 })
      expect(requests).toHaveLength(1)
    } finally {
      await session.destroy()
    }
  }, 30_000)
})

describe('SessionStart pending consumption on turn failure (exactly-once)', () => {
  it('a post-append flush failure restores seed + context once; the next turn does not re-inject', async () => {
    const dir = await tempDir('ss-fail-post-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('answer')) yield ev
    }
    const session = provider.createSession({
      id: 'ss-fail-post', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(ssHsoJson({ additionalContext: 'ss-fail-ctx', initialUserMessage: 'ss-fail-seed' })) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      const core = nativeCoreOf(session)!
      const sessionLog = (core as unknown as { log: { flush(): Promise<void> } }).log
      // The FIRST flush of the session is the turn's post-append flush (the
      // SessionStart decision here carries no title/reload, so nothing flushed
      // earlier). Rejecting it fails the turn AFTER the raw append and AFTER
      // the pending was consumed at the no-return point.
      vi.spyOn(sessionLog, 'flush').mockRejectedValueOnce(new Error('flush failed'))
      session.enqueueUserMessage(userMsg('first-prompt') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      }, { timeout: 15_000 })
      const first = frames.find((f) => f.type === 'result') as { is_error?: boolean; result?: string }
      expect(first.is_error).toBe(true)
      expect(first.result).toContain('flush failed')
      // The failed turn never reached the API.
      expect(requests).toHaveLength(0)
      // The next turn runs against the restored history: seed + context were
      // pushed back exactly once (the catch restoration), and the cleared
      // pending is NOT re-injected.
      session.enqueueUserMessage(userMsg('second-prompt') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(2)
      }, { timeout: 15_000 })
      expect(requests).toHaveLength(1)
      const wire = JSON.stringify(requests[0].messages)
      expect(wire.split('ss-fail-seed').length - 1).toBe(1)
      expect(wire.split('ss-fail-ctx').length - 1).toBe(1)
      expect(wire).toContain('first-prompt')
      expect(wire).toContain('second-prompt')
      // Restored prefix order: seed, context, first prompt — then the new turn.
      expect(wire.indexOf('ss-fail-seed')).toBeLessThan(wire.indexOf('ss-fail-ctx'))
      expect(wire.indexOf('ss-fail-ctx')).toBeLessThan(wire.indexOf('first-prompt'))
      expect(wire.indexOf('first-prompt')).toBeLessThan(wire.indexOf('second-prompt'))
      const results = frames.filter((f) => f.type === 'result')
      expect((results[1] as { is_error?: boolean }).is_error).toBeFalsy()
    } finally {
      await session.destroy()
    }
  }, 30_000)

  it('a pre-append failure parks the prompt; the durable retry re-reads the same pending (no loss)', async () => {
    const dir = await tempDir('ss-fail-pre-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const requests: Array<{ messages: unknown[] }> = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
      requests.push(structuredClone(req))
      for (const ev of textTurn('answer')) yield ev
    }
    const session = provider.createSession({
      id: 'ss-fail-pre', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: ssHooks(ssHsoJson({ additionalContext: 'ss-retry-ctx' })) } } },
      canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      const core = nativeCoreOf(session)!
      const sessionLog = (core as unknown as { log: { append(input: unknown): unknown } }).log
      // The FIRST append of the session is the raw user/message append (fresh
      // seed writes synchronously at open; no title event here). Throwing on it
      // parks the head WITH the SessionStart pending unconsumed.
      vi.spyOn(sessionLog, 'append').mockImplementationOnce(() => { throw new Error('append failed') })
      session.enqueueUserMessage(userMsg('parked-prompt') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      }, { timeout: 15_000 })
      const first = frames.find((f) => f.type === 'result') as { is_error?: boolean; result?: string }
      expect(first.is_error).toBe(true)
      expect(first.result).toContain('append failed')
      expect(requests).toHaveLength(0)
      // Explicit input releases the pause and retries the parked head first;
      // the retry re-reads the SAME pending context (read-only projection).
      session.enqueueUserMessage(userMsg('retry-trigger') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(3)
      }, { timeout: 15_000 })
      expect(requests).toHaveLength(2)
      const wire1 = JSON.stringify(requests[0].messages)
      expect(wire1.split('ss-retry-ctx').length - 1).toBe(1)
      expect(wire1).toContain('parked-prompt')
      expect(wire1.indexOf('ss-retry-ctx')).toBeLessThan(wire1.indexOf('parked-prompt'))
      // The second turn carries the history copy exactly once — no re-injection.
      const wire2 = JSON.stringify(requests[1].messages)
      expect(wire2.split('ss-retry-ctx').length - 1).toBe(1)
      expect(wire2).toContain('retry-trigger')
      const results = frames.filter((f) => f.type === 'result')
      expect((results[1] as { is_error?: boolean }).is_error).toBeFalsy()
      expect((results[2] as { is_error?: boolean }).is_error).toBeFalsy()
    } finally {
      await session.destroy()
    }
  }, 30_000)
})
