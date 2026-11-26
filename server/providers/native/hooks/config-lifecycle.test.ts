// server/providers/native/hooks/config-lifecycle.test.ts
// T7: hooks config lifecycle on the native session — spawn consumption
// (sdkOptions.settings.hooks), live applyFlagSettings replacement, per-event
// re-collection (RS §12.3: the next dispatch observes the new config without a
// respawn), and hook/run activity emission through the session's operational
// frame path (the adapter projects it to SDK system/hook_* frames).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { nativeCoreOf } from '../../native-host-frame-adapter.js'
import type { ProviderSessionHandle } from '../../types.js'
import type { HookDecision, HookEvent } from './types.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'

const tempDirs: string[] = []

/** A fresh temp state dir per test — the provider's default state dir is the
 *  real `~/.claude-react-web`, which a test must never touch. The project
 *  skills root is created so construction-time discovery never logs an
 *  ENOENT warning for a missing root (pristine output). */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

/** Every native session discovers user-scope skills from the CLI config dir.
 *  Redirect it at a temp empty dir so the developer's real `~/.claude/skills`
 *  can never leak into a session (same fixture as native-session.test.ts). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-hooks-config-'))
  // The user skills root exists (empty) so discovery never logs an ENOENT
  // warning for a missing root (pristine output).
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

/** The providerWithStreamer fixture pattern (native-session.test.ts): a real
 *  NativeProvider with the per-turn test seam. These tests dispatch hooks
 *  directly (no model turn), so the script stays empty. */
function makeProvider(stateDir: string): NativeProvider {
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {}
  return provider
}

/** The neutral core surface T7 exposes: dispatchHook (the seam decision point)
 *  and applyFlagSettings (the live config channel). */
interface HookCore {
  dispatchHook(event: HookEvent, input: Record<string, unknown>, ctx: { signal: AbortSignal; hasContext: boolean }): Promise<HookDecision>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
}

function coreOf(handle: ProviderSessionHandle): HookCore {
  const core = nativeCoreOf(handle)
  if (!core) throw new Error('test: handle is not a wrapped native core')
  return core as unknown as HookCore
}

function collectFrames(session: ProviderSessionHandle): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  void (async () => { for await (const f of session.messages) frames.push(f as Record<string, unknown>) })()
  return frames
}

const hookFrames = (frames: Array<Record<string, unknown>>, subtype: string) =>
  frames.filter((f) => f.type === 'system' && f.subtype === subtype)

// Explicit bash shell (the command-executor test convention) so the commands
// are identical on win32 (Git Bash) and posix.
const BLOCK_CMD = 'echo spawn-block >&2; exit 2'
const ALLOW_CMD = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"live-allow"}}'`

const blockHooks: SessionHooksConfig = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: BLOCK_CMD, shell: 'bash' }] }],
}
const allowHooks: SessionHooksConfig = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: ALLOW_CMD, shell: 'bash' }] }],
}

const preToolUseInput = {
  session_id: 'hooks-lifecycle',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
}
const dispatchCtx = () => ({ signal: new AbortController().signal, hasContext: true })

describe('spawn consumption (sdkOptions.settings.hooks)', () => {
  it('the engine dispatches the spawn config (matcher-filtered)', async () => {
    const dir = await tempDir('hooks-spawn-')
    const provider = makeProvider(dir)
    const session = provider.createSession({
      id: 'hooks-spawn', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: blockHooks } } },
    })
    collectFrames(session)
    try {
      const decision = await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      expect(decision.action).toBe('block')
      expect(decision.block?.reason).toContain('spawn-block')
      expect(decision.block?.target).toBe('model')
      // The matcher filters: a Read call does not match the Bash group.
      const other = await coreOf(session).dispatchHook('PreToolUse', { ...preToolUseInput, tool_name: 'Read' }, dispatchCtx())
      expect(other.action).toBe('continue')
      expect(other.additionalContext).toEqual([])
    } finally {
      await session.destroy()
    }
  }, 15_000)

  it('hook activity rides the live stream as SDK system/hook_started + hook_response', async () => {
    const dir = await tempDir('hooks-emit-')
    const provider = makeProvider(dir)
    const session = provider.createSession({
      id: 'hooks-emit', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: blockHooks } } },
    })
    const frames = collectFrames(session)
    try {
      await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      await vi.waitFor(() => {
        expect(hookFrames(frames, 'hook_started').length).toBe(1)
        expect(hookFrames(frames, 'hook_response').length).toBe(1)
      })
      const started = hookFrames(frames, 'hook_started')[0]
      const response = hookFrames(frames, 'hook_response')[0]
      expect(started.hook_event).toBe('PreToolUse')
      expect(started.hook_name).toBe(BLOCK_CMD)
      expect(started.session_id).toBe('hooks-emit')
      // One run: started and response correlate on hook_id.
      expect(response.hook_id).toBe(started.hook_id)
      // Exit 2 → blocked → terminal error outcome, exit code carried.
      expect(response.outcome).toBe('error')
      expect(response.exit_code).toBe(2)
    } finally {
      await session.destroy()
    }
  }, 15_000)

  it('no hooks at spawn → dispatch is a no-op continue', async () => {
    const dir = await tempDir('hooks-none-')
    const provider = makeProvider(dir)
    const session = provider.createSession({ id: 'hooks-none', cwd: dir })
    const frames = collectFrames(session)
    try {
      const decision = await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      expect(hookFrames(frames, 'hook_started')).toEqual([])
    } finally {
      await session.destroy()
    }
  })

  it('invalid hooks at spawn → createSession throws (loud, not silently dropped)', async () => {
    const dir = await tempDir('hooks-bad-spawn-')
    const provider = makeProvider(dir)
    expect(() => provider.createSession({
      id: 'hooks-bad-spawn', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: { PreToolUse: 'not-an-array' } } } },
    })).toThrow(/hooks/)
  })
})

describe('live applyFlagSettings({hooks}) — RS §12.3', () => {
  it('replaces the config — the NEXT dispatch uses the new one (no respawn)', async () => {
    const dir = await tempDir('hooks-live-')
    const provider = makeProvider(dir)
    const session = provider.createSession({
      id: 'hooks-live', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: blockHooks } } },
    })
    collectFrames(session)
    try {
      const before = await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      expect(before.action).toBe('block')

      await coreOf(session).applyFlagSettings({ hooks: allowHooks })

      // Replacement, not merge: a merged config would still block (block
      // outranks allow), so an allow decision proves the old config is gone.
      const after = await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      expect(after.action).toBe('allow')
      expect(after.permission?.behavior).toBe('allow')
      expect(after.permission?.reason).toBe('live-allow')
    } finally {
      await session.destroy()
    }
  }, 15_000)

  it('applyFlagSettings({hooks:{}}) clears — dispatch continues with no activity', async () => {
    const dir = await tempDir('hooks-clear-')
    const provider = makeProvider(dir)
    const session = provider.createSession({
      id: 'hooks-clear', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: blockHooks } } },
    })
    const frames = collectFrames(session)
    try {
      await coreOf(session).applyFlagSettings({ hooks: {} })
      const decision = await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      expect(decision).toEqual({ action: 'continue', additionalContext: [] })
      // Grace period for the async frame consumer: no activity was emitted.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(hookFrames(frames, 'hook_started')).toEqual([])
      expect(hookFrames(frames, 'hook_response')).toEqual([])
    } finally {
      await session.destroy()
    }
  }, 15_000)

  it('invalid hooks config rejects and leaves the current config intact', async () => {
    const dir = await tempDir('hooks-bad-apply-')
    const provider = makeProvider(dir)
    const session = provider.createSession({
      id: 'hooks-bad-apply', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks: blockHooks } } },
    })
    collectFrames(session)
    try {
      await expect(coreOf(session).applyFlagSettings({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '' }] }] },
      })).rejects.toThrow(/hooks/)
      // Validation ran BEFORE any state change: the spawn config still fires.
      const decision = await coreOf(session).dispatchHook('PreToolUse', preToolUseInput, dispatchCtx())
      expect(decision.action).toBe('block')
    } finally {
      await session.destroy()
    }
  }, 15_000)

  it('an unknown key still throws', async () => {
    const dir = await tempDir('hooks-unknown-')
    const provider = makeProvider(dir)
    const session = provider.createSession({ id: 'hooks-unknown', cwd: dir })
    collectFrames(session)
    try {
      await expect(coreOf(session).applyFlagSettings({ bogus: true }))
        .rejects.toThrow(/does not support flag settings: bogus/)
    } finally {
      await session.destroy()
    }
  })
})
