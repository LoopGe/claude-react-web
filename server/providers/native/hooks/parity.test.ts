// server/providers/native/hooks/parity.test.ts
// T24: the cross-provider parity harness for the native hook engine (Project 1).
//
// PARITY STRATEGY
// ---------------
// The parity reference is claude-as-embedded-in-CRW, whose hook execution happens
// inside the real CLI subprocess. The CLI's ACTUAL behavior is the contract, and
// it is source-verified against the pinned binary (SDK 0.3.311 / CLI 2.1.311) in
// docs/research/2026-11-26-cli-hook-semantics.md (cited below as RS §n). A live
// cross-provider comparison (real CLI subprocess vs native) is nondeterministic
// in a unit test — real LLM rounds, subprocess timing, and machine settings all
// vary — so this harness pins parity in two deterministic layers:
//
//   1. CONFIG-CHANNEL parity (both providers, same config). The shared
//      `validateSessionHooksConfig` is the single acceptance gate the routes apply
//      to BOTH providers, and `toSdkHooksSettings` is the single projection the
//      manager forwards. The claude provider must deliver that projected config to
//      the CLI UNCHANGED (pinned here through the SDK-stub fixture that captures
//      `query()` options — the same fixture claude-provider.test.ts uses); the
//      native provider must accept the same config and seed its flag source so the
//      engine observes it (pinned here through a real dispatch). Acceptance parity
//      (the same invalid config rejected with the same errors) is pinned too.
//
//   2. DECISION parity (native vs RS-derived CLI expectations). For each layer-1
//      event a representative config (command exit-2 block, allow, additionalContext)
//      is dispatched through the native provider's SINGLE decision point
//      (`NativeSession.dispatchHook` — the same method every trigger seam calls),
//      and the merged multi-fact decision + hook/run activity are asserted against
//      the RS-derived expectation. Because the claude provider forwards the config
//      to the CLI unchanged (layer 1) and the CLI's behavior for that config IS the
//      RS contract, matching the RS expectation is matching the claude provider's
//      observable behavior. The Review Focus failure modes (flood truncation,
//      invalid-JSON degrade, invalid-regex matcher, no-context prompt/agent error,
//      updatedInput `_`-key refusal) and asyncRewake wake delivery are pinned
//      end-to-end here as well.
//
// MACHINE-SETTINGS NEUTRALIZATION
// -------------------------------
// Project 1 wires ONLY the flag source (`meta.hooks`); filesystem-settings hooks +
// gates are Project 2. The native engine therefore never reads machine settings.
// The claude side is stubbed (no subprocess), and `CLAUDE_CONFIG_DIR` is redirected
// at a temp empty dir per test so user-scope skill discovery (and any CLI settings,
// were it live) cannot leak in. The cwd is a fresh temp dir with no `.claude/
// settings.json`. The flag source is the only source under test on both sides.
//
// MANUAL CROSS-PROVIDER PROCEDURE (live, out of unit-test scope)
// ------------------------------------------------------------
// To verify parity against the real CLI on a machine with credentials:
//   1. Pick one hooks config (e.g. a PreToolUse command hook that exits 2 on Bash).
//   2. Create two sessions with the SAME config via the Hooks settings tab — one
//      `claude`, one `native` — in the same cwd.
//   3. Trigger the event in each (send a prompt that calls Bash; compact; etc.).
//   4. Compare the observable outcome: the tool blocked/allowed, the model feedback
//      text, the injected context, and the HooksPanel Hook Activity rows
//      (hook_name / event / outcome / exit_code / stdout / stderr). They must agree
//      for every layer-1 event. Layer-2 events (SessionEnd, Notification, …) are
//      inert on BOTH sides by design (RS §9.2) and are not compared.
// The decision record (.agents/notes/implemented/feature/2026-11-26-native-hook-engine.md)
// lists the knowing parity deviations deferred to Projects 2-4 and follow-ups.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatHooksValidationErrors,
  toSdkHooksSettings,
  validateSessionHooksConfig,
  type HookEvent,
  type SessionHooksConfig,
} from '../../../../shared/hooks.js'
import { HttpError } from '../../../errors.js'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { nativeCoreOf } from '../../native-host-frame-adapter.js'
import type { NativeSession } from '../native-session.js'
import type { CanonicalEvent } from '../canonical.js'
import type { ProviderSessionHandle } from '../../types.js'
import type { HookDecision } from './types.js'
import { ClaudeProvider } from '../../claude/claude-provider.js'
import type { ProviderProfile } from '../../../config.js'

// ── claude SDK stub (config-channel capture) ──────────────────────────────────
// Mirrors claude-provider.test.ts: capture the options createSession hands to
// query() so the test can inspect the settings.hooks the CLI would receive. The
// Proxy answers any handle method with an async no-op and yields a done iterator,
// so ClaudeSessionHandle constructs without a real subprocess. The other value
// exports the provider imports are stubbed so the module graph links.
const captured = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { options: Record<string, unknown> }) => {
    captured.options = options
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === Symbol.asyncIterator) {
            return () => ({ next: async () => ({ done: true, value: undefined }) })
          }
          return vi.fn(async () => {})
        },
      },
    )
  }),
  getSessionInfo: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
  listSubagents: vi.fn(async () => []),
  renameSession: vi.fn(async () => {}),
}))

const CLAUDE_PROFILE: ProviderProfile = {
  id: 'parity',
  name: 'Parity',
  authToken: 'parity-token',
  baseUrl: 'https://gw.example.com',
  modelList: ['m/one'],
  recapModel: 'r',
  commitMessageModel: 'c',
}

// ── shared fixtures ───────────────────────────────────────────────────────────
const tempDirs: string[] = []

/** A fresh temp state dir per test; the project skills root is created so
 *  construction-time discovery never logs an ENOENT warning (pristine output). */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

// Redirect user-scope skill discovery at a temp empty dir so the developer's real
// ~/.claude/skills can never leak in (same fixture as the per-seam hook tests).
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-parity-config-'))
  await mkdir(join(skillsConfigDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
  captured.options = null
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(skillsConfigDir, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Explicit bash shell so a command hook is identical on win32 (Git Bash) and
 *  posix (the command-executor convention used across the hook suites). */
function bashCommand(command: string, extra: Record<string, unknown> = {}) {
  return { type: 'command' as const, command, shell: 'bash' as const, ...extra }
}

/** A command hook that echoes a hookSpecificOutput JSON payload for `event`. */
function hsoCommand(event: HookEvent, fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } })}'`
}

/** A command hook that blocks with `message` on stderr (exit 2). `printf '%s'`
 *  emits no trailing newline so the verbatim block reason is exactly `message`
 *  (the engine carries stderr untrimmed — RS §2.3). */
function blockCommand(message: string): string {
  return `printf '%s' '${message}' >&2; exit 2`
}

function configFor(
  event: HookEvent,
  command: string,
  extra: Record<string, unknown> = {},
): SessionHooksConfig {
  return { [event]: [{ hooks: [bashCommand(command, extra)] }] }
}

interface ParitySession {
  dir: string
  id: string
  core: NativeSession
  handle: ProviderSessionHandle
  frames: Array<Record<string, unknown>>
  requests: Array<{ messages: unknown[] }>
  send(text: string): void
  destroy(): Promise<void>
}

let userMsgSeq = 0
function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: `parity-u-${++userMsgSeq}`,
  }
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

/** A live native provider session with the given hooks config. `rounds` scripts
 *  that many text turns for cases that drive a real turn (asyncRewake / RF5);
 *  dispatch-only cases pass 0 and never start the turn pump. The frame collector
 *  drains the projected SDK frames (hook/run → system/hook_started|hook_response). */
async function nativeSession(hooks: SessionHooksConfig | undefined, rounds = 0): Promise<ParitySession> {
  const dir = await tempDir('parity-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const scripts: CanonicalEvent[][] = Array.from({ length: rounds }, (_, i) => textTurn(`round-${i + 1}`))
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: {
    messages: unknown[]
  }) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const handle = provider.createSession({
    id: 'parity',
    cwd: dir,
    ...(hooks ? { providerExtras: { sdkOptions: { settings: { hooks } } } } : {}),
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const core = nativeCoreOf(handle)! as NativeSession
  const frames: Array<Record<string, unknown>> = []
  void (async () => {
    for await (const f of handle.messages) frames.push(f as Record<string, unknown>)
  })()
  return {
    dir,
    id: 'parity',
    core,
    handle,
    frames,
    requests,
    send: (text) => handle.enqueueUserMessage(userMsg(text) as never),
    destroy: async () => {
      // Let the constructor's init SessionStart application settle (its durable
      // sessionTitle append) BEFORE closing the log writer, so teardown never
      // races a pending append into a "writer is closed" warning.
      await (core as unknown as { sessionStartInit?: Promise<void> }).sessionStartInit?.catch(() => {})
      await handle.destroy()
    },
  }
}

/** The completed hook activity frames (system/hook_response) for an event. */
function hookResponses(
  frames: Array<Record<string, unknown>>,
  event: HookEvent,
): Array<Record<string, unknown>> {
  return frames.filter((f) => f.type === 'system' && f.subtype === 'hook_response' && f.hook_event === event)
}

function resultFrames(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return frames.filter((f) => f.type === 'result')
}

// ── 1. config-channel parity (both providers, same config) ────────────────────
describe('config-channel parity — same config accepted and delivered by both providers', () => {
  // A representative config spanning all 13 layer-1 events (command hooks; the
  // prompt/agent availability gates are exercised by the RF4 cases below).
  const FULL_CONFIG: SessionHooksConfig = {
    PreToolUse: [{ matcher: 'Bash', hooks: [bashCommand('echo pre')] }],
    PostToolUse: [{ hooks: [bashCommand('echo post')] }],
    PostToolUseFailure: [{ hooks: [bashCommand('echo postfail')] }],
    UserPromptSubmit: [{ hooks: [bashCommand('echo ups')] }],
    Stop: [{ hooks: [bashCommand('echo stop')] }],
    StopFailure: [{ hooks: [bashCommand('echo stopfail')] }],
    SessionStart: [{ hooks: [bashCommand('echo ss')] }],
    SubagentStart: [{ hooks: [bashCommand('echo substart')] }],
    SubagentStop: [{ hooks: [bashCommand('echo substop')] }],
    PreCompact: [{ hooks: [bashCommand('echo precompact')] }],
    PostCompact: [{ hooks: [bashCommand('echo postcompact')] }],
    PermissionRequest: [{ hooks: [bashCommand('echo permreq')] }],
    PermissionDenied: [{ hooks: [bashCommand('echo permdenied')] }],
  }

  it('the shared validator accepts the representative config (single gate for both providers)', () => {
    const parsed = validateSessionHooksConfig(FULL_CONFIG)
    expect(parsed.ok).toBe(true)
  })

  it('claude delivers the projected config to the CLI unchanged (settings.hooks)', () => {
    const provider = new ClaudeProvider()
    const projected = toSdkHooksSettings(FULL_CONFIG)
    provider.createSession({
      id: 'parity-claude',
      cwd: '/x',
      profile: CLAUDE_PROFILE,
      providerExtras: { sdkOptions: { settings: { hooks: projected } } },
    } as unknown as Parameters<ClaudeProvider['createSession']>[0])
    const settings = captured.options?.settings as { hooks?: unknown } | undefined
    expect(settings?.hooks).toEqual(projected)
  })

  it('native accepts the same config and the engine observes it (flag source seeded)', async () => {
    // The PreToolUse group's hook echoes an allow decision; a dispatch must run it.
    const hooks: SessionHooksConfig = {
      PreToolUse: [
        { matcher: 'Bash', hooks: [bashCommand(hsoCommand('PreToolUse', { permissionDecision: 'allow' }))] },
      ],
    }
    const s = await nativeSession(hooks)
    try {
      const decision = await s.core.dispatchHook(
        'PreToolUse',
        {
          session_id: s.id,
          cwd: s.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
          tool_use_id: 'tu-1',
        },
        { signal: s.handle.abortSignal, hasContext: true },
      )
      expect(decision.action).toBe('allow')
      expect(hookResponses(s.frames, 'PreToolUse')).toHaveLength(1)
    } finally {
      await s.destroy()
    }
  }, 20_000)

  it('acceptance parity — the same invalid config is rejected with the same errors', async () => {
    const invalid = { PreToolUse: [{ hooks: [{ type: 'bogus', command: 'x' }] }] }
    const parsed = validateSessionHooksConfig(invalid)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const expectedMessage = `invalid hooks config: ${formatHooksValidationErrors(parsed.errors)}`
    // Native re-validates at spawn (the fence for direct provider callers) and
    // throws the SAME formatted error the shared route gate produces.
    const dir = await tempDir('parity-invalid-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    expect(() =>
      provider.createSession({
        id: 'parity-invalid',
        cwd: dir,
        providerExtras: { sdkOptions: { settings: { hooks: invalid } } },
      }),
    ).toThrow(HttpError)
    expect(() =>
      provider.createSession({
        id: 'parity-invalid-2',
        cwd: dir,
        providerExtras: { sdkOptions: { settings: { hooks: invalid } } },
      }),
    ).toThrow(expectedMessage)
  })
})

// ── 2. per-event decision parity (native vs RS-derived CLI expectations) ──────
interface ParityCase {
  name: string
  event: HookEvent
  hooks: SessionHooksConfig
  input: Record<string, unknown>
  hasContext: boolean
  expected: HookDecision
  activity: { outcome: 'success' | 'error' | 'cancelled'; exitCode: number }
  rs: string
}

const TOOL_INPUT = { command: 'echo hi' }
const CASES: ParityCase[] = [
  // PreToolUse (RS §3: exit-2 blocks tool, stderr to model; permissionDecision).
  {
    name: 'PreToolUse exit-2 blocks (stderr to model)',
    event: 'PreToolUse',
    hooks: configFor('PreToolUse', blockCommand('pre-block')),
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: TOOL_INPUT, tool_use_id: 'tu-1' },
    hasContext: true,
    expected: { action: 'block', block: { reason: 'pre-block', target: 'model' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 PreToolUse / §2.3',
  },
  {
    name: 'PreToolUse allow + updatedInput',
    event: 'PreToolUse',
    hooks: configFor(
      'PreToolUse',
      hsoCommand('PreToolUse', { permissionDecision: 'allow', updatedInput: { command: 'ls -la' } }),
    ),
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: TOOL_INPUT, tool_use_id: 'tu-1' },
    hasContext: true,
    expected: {
      action: 'allow',
      permission: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
      additionalContext: [],
    },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PreToolUse',
  },
  {
    name: 'PreToolUse additionalContext alongside allow',
    event: 'PreToolUse',
    hooks: configFor(
      'PreToolUse',
      hsoCommand('PreToolUse', { permissionDecision: 'allow', additionalContext: 'pre-ctx' }),
    ),
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: TOOL_INPUT, tool_use_id: 'tu-1' },
    hasContext: true,
    expected: { action: 'allow', permission: { behavior: 'allow' }, additionalContext: ['pre-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PreToolUse (multi-fact)',
  },
  {
    name: 'PreToolUse deny carries the reason',
    event: 'PreToolUse',
    hooks: configFor(
      'PreToolUse',
      hsoCommand('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: 'hook says no' }),
    ),
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: TOOL_INPUT, tool_use_id: 'tu-1' },
    hasContext: true,
    expected: {
      action: 'deny',
      permission: { behavior: 'deny', message: 'hook says no' },
      additionalContext: [],
    },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PreToolUse',
  },
  // PostToolUse (RS §3: exit-2 stderr to model, tool already ran; rewrites).
  {
    name: 'PostToolUse exit-2 (stderr to model)',
    event: 'PostToolUse',
    hooks: configFor('PostToolUse', blockCommand('post-block')),
    input: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: TOOL_INPUT,
      tool_response: 'hi',
      tool_use_id: 'tu-1',
    },
    hasContext: true,
    expected: { action: 'block', block: { reason: 'post-block', target: 'model' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 PostToolUse',
  },
  {
    name: 'PostToolUse updatedToolOutput rewrite',
    event: 'PostToolUse',
    hooks: configFor('PostToolUse', hsoCommand('PostToolUse', { updatedToolOutput: 'rewritten output' })),
    input: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: TOOL_INPUT,
      tool_response: 'hi',
      tool_use_id: 'tu-1',
    },
    hasContext: true,
    expected: { action: 'continue', additionalContext: [], updatedToolOutput: 'rewritten output' },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PostToolUse / §4.9',
  },
  {
    name: 'PostToolUse additionalContext',
    event: 'PostToolUse',
    hooks: configFor('PostToolUse', hsoCommand('PostToolUse', { additionalContext: 'post-ctx' })),
    input: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: TOOL_INPUT,
      tool_response: 'hi',
      tool_use_id: 'tu-1',
    },
    hasContext: true,
    expected: { action: 'continue', additionalContext: ['post-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PostToolUse',
  },
  // PostToolUseFailure (RS §3: exit-2 stderr to model; additionalContext).
  {
    name: 'PostToolUseFailure exit-2 (stderr to model)',
    event: 'PostToolUseFailure',
    hooks: configFor('PostToolUseFailure', blockCommand('fail-block')),
    input: {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: TOOL_INPUT,
      tool_use_id: 'tu-1',
      error: 'boom',
    },
    hasContext: true,
    expected: { action: 'block', block: { reason: 'fail-block', target: 'model' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 PostToolUseFailure',
  },
  {
    name: 'PostToolUseFailure additionalContext',
    event: 'PostToolUseFailure',
    hooks: configFor(
      'PostToolUseFailure',
      hsoCommand('PostToolUseFailure', { additionalContext: 'fail-ctx' }),
    ),
    input: {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: TOOL_INPUT,
      tool_use_id: 'tu-1',
      error: 'boom',
    },
    hasContext: true,
    expected: { action: 'continue', additionalContext: ['fail-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PostToolUseFailure',
  },
  // UserPromptSubmit (RS §3: exit-2 blocks + erases prompt, stderr USER-only).
  {
    name: 'UserPromptSubmit exit-2 (stderr user-only)',
    event: 'UserPromptSubmit',
    hooks: configFor('UserPromptSubmit', blockCommand('ups-block')),
    input: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    hasContext: true,
    expected: { action: 'block', block: { reason: 'ups-block', target: 'user' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 UserPromptSubmit',
  },
  {
    name: 'UserPromptSubmit additionalContext (hso)',
    event: 'UserPromptSubmit',
    hooks: configFor('UserPromptSubmit', hsoCommand('UserPromptSubmit', { additionalContext: 'ups-ctx' })),
    input: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    hasContext: true,
    expected: { action: 'continue', additionalContext: ['ups-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 UserPromptSubmit',
  },
  {
    name: 'UserPromptSubmit exit-0 plain stdout joins context',
    event: 'UserPromptSubmit',
    hooks: configFor('UserPromptSubmit', "printf '%s' 'plain-context'"),
    input: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    hasContext: true,
    expected: { action: 'continue', additionalContext: ['plain-context'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §2.2 / §3 UserPromptSubmit',
  },
  // Stop (RS §3: exit-2 feeds stderr to model + forces continuation; continue:false).
  {
    name: 'Stop exit-2 (force continuation, stderr to model)',
    event: 'Stop',
    hooks: configFor('Stop', blockCommand('stop-block')),
    input: { hook_event_name: 'Stop', stop_hook_active: false },
    hasContext: true,
    expected: { action: 'block', block: { reason: 'stop-block', target: 'model' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 Stop / §5',
  },
  {
    name: 'Stop continue:false + stopReason',
    event: 'Stop',
    hooks: configFor('Stop', `echo '${JSON.stringify({ continue: false, stopReason: 'all done' })}'`),
    input: { hook_event_name: 'Stop', stop_hook_active: false },
    hasContext: true,
    expected: { action: 'continue', additionalContext: [], continue: false, stopReason: 'all done' },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §2.3 / §3 Stop',
  },
  {
    name: 'Stop additionalContext (non-error continuation)',
    event: 'Stop',
    hooks: configFor('Stop', hsoCommand('Stop', { additionalContext: 'stop-ctx' })),
    input: { hook_event_name: 'Stop', stop_hook_active: false },
    hasContext: true,
    expected: { action: 'continue', additionalContext: ['stop-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 Stop',
  },
  // StopFailure (RS §3: fire-and-forget — the seam ignores the decision; the
  // engine still merges exit-2 into a user-target block fact and emits activity).
  {
    name: 'StopFailure exit-2 (decision ignored by seam, activity emitted)',
    event: 'StopFailure',
    hooks: configFor('StopFailure', blockCommand('sf-block')),
    input: { hook_event_name: 'StopFailure', error: 'unknown' },
    hasContext: false,
    expected: { action: 'block', block: { reason: 'sf-block', target: 'user' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 StopFailure (fire-and-forget)',
  },
  // SessionStart (RS §3: exit-2 stderr USER-only, never blocks; specific output).
  {
    name: 'SessionStart additionalContext + initialUserMessage + sessionTitle',
    event: 'SessionStart',
    hooks: configFor(
      'SessionStart',
      hsoCommand('SessionStart', {
        additionalContext: 'ss-ctx',
        initialUserMessage: 'hello',
        sessionTitle: 'My title',
      }),
    ),
    input: { hook_event_name: 'SessionStart', source: 'startup' },
    hasContext: false,
    expected: {
      action: 'continue',
      additionalContext: ['ss-ctx'],
      initialUserMessage: 'hello',
      sessionTitle: 'My title',
    },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 SessionStart / §13.2',
  },
  {
    name: 'SessionStart exit-2 (stderr user-only, never blocks)',
    event: 'SessionStart',
    hooks: configFor('SessionStart', blockCommand('ss-block')),
    input: { hook_event_name: 'SessionStart', source: 'startup' },
    hasContext: false,
    expected: { action: 'block', block: { reason: 'ss-block', target: 'user' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 SessionStart',
  },
  // SubagentStart (RS §3: additionalContext to subagent; no-context event).
  {
    name: 'SubagentStart additionalContext (to subagent)',
    event: 'SubagentStart',
    hooks: configFor('SubagentStart', hsoCommand('SubagentStart', { additionalContext: 'sub-ctx' })),
    input: { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' },
    hasContext: false,
    expected: { action: 'continue', additionalContext: ['sub-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 SubagentStart',
  },
  // SubagentStop (RS §3: exit-2 makes subagent continue; additionalContext).
  {
    name: 'SubagentStop exit-2 (subagent continues, stderr to model)',
    event: 'SubagentStop',
    hooks: configFor('SubagentStop', blockCommand('substop-block')),
    input: {
      hook_event_name: 'SubagentStop',
      agent_id: 'a1',
      agent_type: 'general-purpose',
      stop_hook_active: false,
      last_assistant_message: 'done',
    },
    hasContext: true,
    expected: { action: 'block', block: { reason: 'substop-block', target: 'model' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 SubagentStop',
  },
  {
    name: 'SubagentStop additionalContext (subagent continuation)',
    event: 'SubagentStop',
    hooks: configFor('SubagentStop', hsoCommand('SubagentStop', { additionalContext: 'substop-ctx' })),
    input: {
      hook_event_name: 'SubagentStop',
      agent_id: 'a1',
      agent_type: 'general-purpose',
      stop_hook_active: false,
      last_assistant_message: 'done',
    },
    hasContext: true,
    expected: { action: 'continue', additionalContext: ['substop-ctx'] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 SubagentStop',
  },
  // PreCompact (RS §3 / §13.3: exit-2 blocks compaction; exit-0 stdout → instructions).
  {
    name: 'PreCompact exit-2 (blocks compaction, stderr user-only)',
    event: 'PreCompact',
    hooks: configFor('PreCompact', blockCommand('pc-block')),
    input: { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
    hasContext: false,
    expected: { action: 'block', block: { reason: 'pc-block', target: 'user' }, additionalContext: [] },
    activity: { outcome: 'error', exitCode: 2 },
    rs: 'RS §3 PreCompact / §13.3',
  },
  {
    name: 'PreCompact exit-0 plain stdout → customInstructions',
    event: 'PreCompact',
    hooks: configFor('PreCompact', "printf '%s' 'focus on the API'"),
    input: { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
    hasContext: false,
    expected: { action: 'continue', additionalContext: [], customInstructions: 'focus on the API' },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §13.3 PreCompact',
  },
  // PostCompact (RS §3: exit-0 stdout user-only, no decision fact; non-blocking).
  {
    name: 'PostCompact exit-0 stdout (user-only, no decision fact)',
    event: 'PostCompact',
    hooks: configFor('PostCompact', 'echo compact-done'),
    input: { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'SUM' },
    hasContext: false,
    expected: { action: 'continue', additionalContext: [] },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PostCompact',
  },
  // PermissionRequest (RS §3 / §13.1: decision allow/deny; no exit-2 block).
  {
    name: 'PermissionRequest decision allow + updatedInput',
    event: 'PermissionRequest',
    hooks: configFor(
      'PermissionRequest',
      hsoCommand('PermissionRequest', { decision: { behavior: 'allow', updatedInput: { command: 'ls' } } }),
    ),
    input: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: TOOL_INPUT },
    hasContext: true,
    expected: {
      action: 'allow',
      permission: { behavior: 'allow', updatedInput: { command: 'ls' } },
      additionalContext: [],
    },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PermissionRequest / §13.1',
  },
  {
    name: 'PermissionRequest decision deny + message + interrupt',
    event: 'PermissionRequest',
    hooks: configFor(
      'PermissionRequest',
      hsoCommand('PermissionRequest', { decision: { behavior: 'deny', message: 'nope', interrupt: true } }),
    ),
    input: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: TOOL_INPUT },
    hasContext: true,
    expected: {
      action: 'deny',
      permission: { behavior: 'deny', message: 'nope', interrupt: true },
      additionalContext: [],
    },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PermissionRequest',
  },
  // PermissionDenied (RS §3: retry flag tells the model it may retry).
  {
    name: 'PermissionDenied retry:true',
    event: 'PermissionDenied',
    hooks: configFor('PermissionDenied', hsoCommand('PermissionDenied', { retry: true })),
    input: {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: TOOL_INPUT,
      tool_use_id: 'tu-1',
      reason: 'denied',
    },
    hasContext: true,
    expected: { action: 'continue', additionalContext: [], retry: true },
    activity: { outcome: 'success', exitCode: 0 },
    rs: 'RS §3 PermissionDenied',
  },
]

describe('per-event decision parity — native dispatch vs RS-derived CLI expectations', () => {
  it.each(CASES)(
    '$name ($rs)',
    async (c) => {
      const s = await nativeSession(c.hooks)
      try {
        const decision = await s.core.dispatchHook(
          c.event,
          { session_id: s.id, cwd: s.dir, ...c.input },
          { signal: s.handle.abortSignal, hasContext: c.hasContext },
        )
        expect(decision).toEqual(c.expected)
        // SessionStart ALSO fires once at init (the constructor's runSessionStart),
        // with the same source/hasContext/config — so a SessionStart case sees TWO
        // identical activity records (init + this manual dispatch); every other
        // event fires only on the manual dispatch. Both runs are the same hook, so
        // every record must match the expected outcome/exit code.
        const expectedCount = c.event === 'SessionStart' ? 2 : 1
        await vi.waitFor(
          () => {
            const responses = hookResponses(s.frames, c.event)
            expect(responses).toHaveLength(expectedCount)
            for (const response of responses) {
              expect(response.outcome).toBe(c.activity.outcome)
              expect(response.exit_code).toBe(c.activity.exitCode)
            }
          },
          { timeout: 10_000 },
        )
      } finally {
        await s.destroy()
      }
    },
    20_000,
  )
})

// ── 3. asyncRewake parity (RS §4.4) ───────────────────────────────────────────
describe('asyncRewake parity (RS §4.4)', () => {
  it('an async hook returns an immediate continue ack while it runs in the background', async () => {
    // The hook holds open until release.flag exists; the dispatch must return
    // continue BEFORE the hook settles (the action proceeds), then the background
    // completion emits the exit-2 activity and enqueues the idle wake.
    const command =
      'touch started.flag\nwhile [ ! -f release.flag ]; do sleep 0.05; done\necho async-block >&2\nexit 2'
    const hooks: SessionHooksConfig = {
      PreToolUse: [{ matcher: 'Bash', hooks: [bashCommand(command, { asyncRewake: true })] }],
    }
    const s = await nativeSession(hooks, 2)
    try {
      const pending = s.core.dispatchHook(
        'PreToolUse',
        {
          session_id: s.id,
          cwd: s.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: TOOL_INPUT,
          tool_use_id: 'tu-1',
        },
        { signal: s.handle.abortSignal, hasContext: true },
      )
      // The hook started but is held open; the dispatch resolves to continue now.
      await vi.waitFor(
        async () => {
          await expect(readFile(join(s.dir, 'started.flag'), 'utf8')).resolves.toBe('')
        },
        { timeout: 10_000 },
      )
      expect(await pending).toEqual({ action: 'continue', additionalContext: [] })
      expect(hookResponses(s.frames, 'PreToolUse')).toHaveLength(0)
      // Release the hook; the background completion emits activity + wakes idle.
      await writeFile(join(s.dir, 'release.flag'), '1')
      await vi.waitFor(
        () => {
          const responses = hookResponses(s.frames, 'PreToolUse')
          expect(responses).toHaveLength(1)
          expect(responses[0].exit_code).toBe(2)
        },
        { timeout: 10_000 },
      )
      // The wake delivered as a system turn re-invokes the model with the feedback.
      await vi.waitFor(
        () => {
          expect(s.requests.length).toBeGreaterThanOrEqual(1)
          expect(JSON.stringify(s.requests[0].messages)).toContain('async-block')
        },
        { timeout: 10_000 },
      )
    } finally {
      await s.destroy()
    }
  }, 30_000)

  it('asyncRewake exit-2 re-invokes the model with feedback when next idle (default summary)', async () => {
    const hooks: SessionHooksConfig = {
      UserPromptSubmit: [{ hooks: [bashCommand('echo wake-stderr >&2; exit 2', { asyncRewake: true })] }],
    }
    const s = await nativeSession(hooks, 4)
    try {
      s.send('go')
      await vi.waitFor(
        () => {
          expect(resultFrames(s.frames)).toHaveLength(2)
        },
        { timeout: 15_000 },
      )
      expect(s.requests).toHaveLength(2)
      expect(JSON.stringify(s.requests[1].messages)).toContain('wake-stderr')
      expect(JSON.stringify(s.requests[1].messages)).toContain('Stop hook blocking error from command')
      const banner = s.frames.find((f) => f.type === 'system' && f.subtype === 'informational')
      expect(banner?.content).toContain('Stop hook feedback')
    } finally {
      await s.destroy()
    }
  }, 30_000)

  it('asyncRewake exit-0 does NOT wake the session', async () => {
    const hooks: SessionHooksConfig = {
      UserPromptSubmit: [{ hooks: [bashCommand('touch ran.flag; exit 0', { asyncRewake: true })] }],
    }
    const s = await nativeSession(hooks, 2)
    try {
      s.send('go')
      await vi.waitFor(
        () => {
          expect(resultFrames(s.frames)).toHaveLength(1)
        },
        { timeout: 15_000 },
      )
      // Give a stray wake a window to appear before asserting it never does.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(resultFrames(s.frames)).toHaveLength(1)
      expect(s.requests).toHaveLength(1)
    } finally {
      await s.destroy()
    }
  }, 30_000)
})

// ── 4. Review Focus failure modes end-to-end ──────────────────────────────────
describe('Review Focus cases end-to-end', () => {
  it('RF1: a flooding command hook is truncated, bounded, and the turn survives', async () => {
    const s = await nativeSession(configFor('PreToolUse', 'yes | head -c 200000'))
    try {
      const decision = await s.core.dispatchHook(
        'PreToolUse',
        {
          session_id: s.id,
          cwd: s.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: TOOL_INPUT,
          tool_use_id: 'tu-1',
        },
        { signal: s.handle.abortSignal, hasContext: true },
      )
      // exit 0 → success → continue (the flood is not a block).
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      await vi.waitFor(
        () => {
          const responses = hookResponses(s.frames, 'PreToolUse')
          expect(responses).toHaveLength(1)
          expect(responses[0].outcome).toBe('success')
          const stdout = String(responses[0].stdout ?? '')
          expect(stdout).toContain('...[truncated]...')
          expect(stdout.length).toBeLessThan(31_000)
        },
        { timeout: 10_000 },
      )
    } finally {
      await s.destroy()
    }
  }, 20_000)

  it('RF2: }-terminated invalid JSON degrades to a non-blocking error; {-start without } is plain success', async () => {
    // `{bad json}` ends with } → invalid JSON → degrade (error outcome, continue).
    const invalid = await nativeSession(configFor('PreToolUse', "echo '{bad json}'"))
    try {
      const decision = await invalid.core.dispatchHook(
        'PreToolUse',
        {
          session_id: invalid.id,
          cwd: invalid.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: TOOL_INPUT,
          tool_use_id: 'tu-1',
        },
        { signal: invalid.handle.abortSignal, hasContext: true },
      )
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      await vi.waitFor(
        () => {
          const responses = hookResponses(invalid.frames, 'PreToolUse')
          expect(responses).toHaveLength(1)
          expect(responses[0].outcome).toBe('error')
          expect(responses[0].exit_code).toBe(0)
        },
        { timeout: 10_000 },
      )
    } finally {
      await invalid.destroy()
    }
    // `{bad json` (no closing }) → plain text SUCCESS (CLI zY, RS §2.2).
    const plain = await nativeSession(configFor('PreToolUse', "echo '{bad json'"))
    try {
      const decision = await plain.core.dispatchHook(
        'PreToolUse',
        {
          session_id: plain.id,
          cwd: plain.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: TOOL_INPUT,
          tool_use_id: 'tu-1',
        },
        { signal: plain.handle.abortSignal, hasContext: true },
      )
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      await vi.waitFor(
        () => {
          const responses = hookResponses(plain.frames, 'PreToolUse')
          expect(responses).toHaveLength(1)
          expect(responses[0].outcome).toBe('success')
        },
        { timeout: 10_000 },
      )
    } finally {
      await plain.destroy()
    }
  }, 30_000)

  it('RF3: an invalid-regex matcher no-matches (hook never runs, no activity, never throws)', async () => {
    const hooks: SessionHooksConfig = {
      PreToolUse: [{ matcher: '[', hooks: [bashCommand('echo should-not-run')] }],
    }
    const s = await nativeSession(hooks)
    try {
      const decision = await s.core.dispatchHook(
        'PreToolUse',
        {
          session_id: s.id,
          cwd: s.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: TOOL_INPUT,
          tool_use_id: 'tu-1',
        },
        { signal: s.handle.abortSignal, hasContext: true },
      )
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      // No hook ran: neither started nor completed activity for the event.
      const activity = s.frames.filter(
        (f) =>
          f.type === 'system' &&
          (f.subtype === 'hook_response' || f.subtype === 'hook_started') &&
          f.hook_event === 'PreToolUse',
      )
      expect(activity).toHaveLength(0)
    } finally {
      await s.destroy()
    }
  }, 20_000)

  it('RF4: a prompt hook on a no-context event (SessionStart) is a non-blocking availability error', async () => {
    const hooks: SessionHooksConfig = {
      SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'check this' }] }],
    }
    const s = await nativeSession(hooks)
    try {
      const decision = await s.core.dispatchHook(
        'SessionStart',
        { session_id: s.id, cwd: s.dir, hook_event_name: 'SessionStart', source: 'startup' },
        { signal: s.handle.abortSignal, hasContext: false },
      )
      // Non-blocking error → continue (never silent success, never a crash).
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      // SessionStart fires at init too (same no-context prompt hook) → 2 records.
      await vi.waitFor(
        () => {
          const responses = hookResponses(s.frames, 'SessionStart')
          expect(responses).toHaveLength(2)
          for (const response of responses) {
            expect(response.outcome).toBe('error')
            expect(String(response.stderr ?? '')).toContain('no conversation context is available')
          }
        },
        { timeout: 10_000 },
      )
    } finally {
      await s.destroy()
    }
  }, 20_000)

  it('RF4: an agent hook on PermissionRequest is explicitly rejected (non-blocking error)', async () => {
    const hooks: SessionHooksConfig = {
      PermissionRequest: [{ hooks: [{ type: 'agent', prompt: 'decide' }] }],
    }
    const s = await nativeSession(hooks)
    try {
      const decision = await s.core.dispatchHook(
        'PermissionRequest',
        {
          session_id: s.id,
          cwd: s.dir,
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: TOOL_INPUT,
        },
        { signal: s.handle.abortSignal, hasContext: true },
      )
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      await vi.waitFor(
        () => {
          const responses = hookResponses(s.frames, 'PermissionRequest')
          expect(responses).toHaveLength(1)
          expect(responses[0].outcome).toBe('error')
          expect(String(responses[0].stderr ?? '')).toContain(
            'agent-type hooks are not supported for PermissionRequest',
          )
        },
        { timeout: 10_000 },
      )
    } finally {
      await s.destroy()
    }
  }, 20_000)

  it('RF5: a PreToolUse updatedInput with an internal _-prefixed key is refused — tool NOT run', async () => {
    // Full turn fixture (pretooluse.test.ts pattern): the Bash command writes
    // marker.txt, so "tool ran" / "tool not run" is a disk fact. The hook allows
    // with a mutated command PLUS an internal _internal key → the seam refuses.
    const hooks: SessionHooksConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            bashCommand(
              hsoCommand('PreToolUse', {
                permissionDecision: 'allow',
                updatedInput: { command: 'echo mutated > marker.txt', _internal: 'x' },
              }),
            ),
          ],
        },
      ],
    }
    const dir = await tempDir('parity-rf5-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const canUseToolCalls: Array<{ toolName: string }> = []
    const scripts: CanonicalEvent[][] = [
      [
        { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
        { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 'tu-1', name: 'Bash' } },
        {
          kind: 'block_delta',
          index: 0,
          delta: { type: 'tool_input', json: JSON.stringify({ command: 'echo original > marker.txt' }) },
        },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
      ],
      textTurn('done'),
    ]
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
    const handle = provider.createSession({
      id: 'parity-rf5',
      cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (toolName: unknown, input: unknown) => {
        canUseToolCalls.push({ toolName: toolName as string })
        return { behavior: 'allow', updatedInput: input }
      },
    })
    const frames: Array<Record<string, unknown>> = []
    void (async () => {
      for await (const f of handle.messages) frames.push(f as Record<string, unknown>)
    })()
    try {
      handle.enqueueUserMessage(userMsg('go') as never)
      await vi.waitFor(
        () => {
          expect(resultFrames(frames)).toHaveLength(1)
        },
        { timeout: 15_000 },
      )
      // Neither the original nor the mutated command ran.
      await expect(readFile(join(dir, 'marker.txt'), 'utf8')).rejects.toThrow()
      // The permission prompt was short-circuited (PreToolUse runs before it).
      expect(canUseToolCalls).toEqual([])
      // An error tool_result carries the refusal.
      const toolResults = frames
        .filter((f) => f.type === 'user')
        .map((f) => (f.message as { content: Array<Record<string, unknown>> }).content[0])
        .filter((c) => c.tool_use_id !== undefined)
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].is_error).toBe(true)
      expect(JSON.stringify(toolResults[0].content)).toContain('The tool was not run')
    } finally {
      await handle.destroy()
    }
  }, 30_000)
})
