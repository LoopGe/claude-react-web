import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmRf } from './__test-utils__/index.js'
import { subagentTranscriptPath } from './subagent-watcher.js'

// --- SDK mock ---------------------------------------------------------------
//
// The real `query({ prompt, options })` spawns the `claude` CLI. For tests
// we replace it with a controllable async generator. Each mocked call is
// captured so tests can inspect what options the SessionManager passed in
// (e.g. the `resume` field) and drive messages into the generator.

interface MockQueryHandle {
  options: Record<string, unknown>
  consumed: unknown[]
  emit: (msg: unknown) => void
  finish: () => void
  throwError: (err: unknown) => void
  interrupt: ReturnType<typeof vi.fn>
  backgroundTasks: ReturnType<typeof vi.fn>
  stopTask: ReturnType<typeof vi.fn>
  setMaxThinkingTokens: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  setPermissionMode: ReturnType<typeof vi.fn>
  applyFlagSettings: ReturnType<typeof vi.fn>
  supportedModels: ReturnType<typeof vi.fn>
  supportedCommands: ReturnType<typeof vi.fn>
  supportedAgents: ReturnType<typeof vi.fn>
  mcpServerStatus: ReturnType<typeof vi.fn>
  setMcpServers: ReturnType<typeof vi.fn>
  getContextUsage: ReturnType<typeof vi.fn>
  accountInfo: ReturnType<typeof vi.fn>
  rewindFiles: ReturnType<typeof vi.fn>
  generateSessionTitle: ReturnType<typeof vi.fn>
}

const mockHandles: MockQueryHandle[] = []

// Default mock: pretend every session's transcript file is present on
// disk. fork()/resume() probe this via `getSessionInfo({ dir })` to
// reject missing-jsonl sources before spawning a doomed Query — tests
// that exercise that failure path override with mockResolvedValueOnce.
//
// Wrapped in `vi.hoisted` because vi.mock factories run BEFORE module-
// scope const declarations (Vitest hoists them). Without hoisting the
// closure inside the factory hits a TDZ on the bare `const` and any
// call into getSessionInfo via the SDK shim falls through to the
// vi.fn default (returns undefined), which makes hasSdkTranscript()
// always report "transcript missing" and breaks every fork/resume
// happy-path test.
const { mockGetSessionInfo, mockListSessions } = vi.hoisted(() => {
  return {
    mockGetSessionInfo: vi.fn<(id: string, opts?: { dir?: string }) => Promise<unknown>>(
      async (id) => ({ sessionId: id }),
    ),
    mockListSessions: vi.fn<(opts?: { dir?: string }) => Promise<unknown[]>>(
      async () => [],
    ),
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    getSessionInfo: (id: string, opts?: { dir?: string }) => mockGetSessionInfo(id, opts),
    listSessions: (opts?: { dir?: string }) => mockListSessions(opts),
    query({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) {
      const queue: unknown[] = []
      let waiter: ((v: IteratorResult<unknown>) => void) | null = null
      let done = false
      let errored: unknown = null

      // Match the real SDK's prompt consumption pacing:
      //   - On spawn, the SDK calls iter.next() once to get the FIRST
      //     user message that started the turn.
      //   - It does NOT call iter.next() again until AFTER emitting
      //     `result` for the current turn — at which point it pulls the
      //     next queued user message (or blocks waiting for one).
      //
      // This pacing matters for tests of working-state behavior: between
      // start-of-turn and result, queued user messages SIT in the input
      // Pushable's queue (queueDepth > 0). A naive "drain everything in
      // a loop" mock keeps a waiter permanently armed, so push() never
      // queues anything, and queueDepth-based logic in production is
      // invisible to tests.
      const promptIter = (prompt as AsyncIterable<unknown>)?.[Symbol.asyncIterator]?.()
      let drainInFlight = false
      const drainOne = () => {
        if (!promptIter || done || drainInFlight) return
        drainInFlight = true
        promptIter.next().then((r) => {
          if (!r.done) handle.consumed.push(r.value)
        }).finally(() => { drainInFlight = false })
      }
      // Initial drain: SDK consumes the first user message to start its
      // first turn.
      drainOne()

      const pushResolved = (r: IteratorResult<unknown>) => {
        if (waiter) {
          const w = waiter
          waiter = null
          w(r)
        }
      }

      const handle: MockQueryHandle = {
        options,
        consumed: [],
        emit: (msg) => {
          if (done) return
          if (waiter) pushResolved({ value: msg, done: false })
          else queue.push(msg)
          // After result, the real SDK pulls the next queued user
          // message to start its next turn. Mirror that here so tests
          // exercising back-to-back turns see the input queue drain
          // between turns.
          if ((msg as { type?: string })?.type === 'result') drainOne()
        },
        finish: () => {
          done = true
          pushResolved({ value: undefined, done: true })
        },
        throwError: (err) => {
          errored = err
          done = true
          pushResolved({ value: undefined, done: true })
        },
        interrupt: vi.fn(async () => {}),
        backgroundTasks: vi.fn(async () => false),
        stopTask: vi.fn(async () => {}),
        setMaxThinkingTokens: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        applyFlagSettings: vi.fn(async () => {}),
        supportedModels: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []),
        supportedAgents: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => ({})),
        setMcpServers: vi.fn(async (servers: Record<string, unknown>) => ({
          added: Object.keys(servers),
          removed: [],
          errors: {},
        })),
        getContextUsage: vi.fn(async () => ({})),
        accountInfo: vi.fn(async () => ({})),
        rewindFiles: vi.fn(async () => ({ canRewind: true })),
        generateSessionTitle: vi.fn(async (_desc: string, _opts?: { persist?: boolean }) => 'Mock auto title'),
      }
      mockHandles.push(handle)

      const q = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              if (errored) {
                const e = errored
                errored = null
                return Promise.reject(e)
              }
              if (queue.length) {
                return Promise.resolve({ value: queue.shift(), done: false })
              }
              if (done) return Promise.resolve({ value: undefined, done: true })
              return new Promise((r) => {
                waiter = r
              })
            },
            return(): Promise<IteratorResult<unknown>> {
              done = true
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
        interrupt: handle.interrupt,
        backgroundTasks: handle.backgroundTasks,
        stopTask: handle.stopTask,
        setMaxThinkingTokens: handle.setMaxThinkingTokens,
        setModel: handle.setModel,
        setPermissionMode: handle.setPermissionMode,
        applyFlagSettings: handle.applyFlagSettings,
        supportedModels: handle.supportedModels,
        supportedCommands: handle.supportedCommands,
        supportedAgents: handle.supportedAgents,
        mcpServerStatus: handle.mcpServerStatus,
        setMcpServers: handle.setMcpServers,
        getContextUsage: handle.getContextUsage,
        accountInfo: handle.accountInfo,
        rewindFiles: handle.rewindFiles,
        generateSessionTitle: handle.generateSessionTitle,
      }
      return q
    },
  }
})

// Mock server/exec.js so exec-abort tests can drive the abort path without
// spawning a real subprocess (the real execCommand goes through cmd.exe on
// Windows, where SIGKILL on the shell wrapper orphans the child — a real
// exec.ts limitation, not something the abort-wiring tests should depend on).
// escapeXml is passed through as the real implementation; execCommand is
// controllable: it resolves {interrupted:true} when the supplied signal
// aborts, otherwise hangs like a long-running command until aborted.
vi.mock('./exec.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./exec.js')>()
  return {
    ...orig,
    escapeXml: orig.escapeXml,
    execCommand: vi.fn(
      (_cwd: string, _command: string, opts: { signal?: AbortSignal } = {}) =>
        new Promise((resolve) => {
          const done = { stdout: '', stderr: '', exitCode: 0, interrupted: false, truncated: false }
          if (opts.signal) {
            if (opts.signal.aborted) { resolve({ ...done, interrupted: true }); return }
            opts.signal.addEventListener(
              'abort',
              () => resolve({ ...done, interrupted: true }),
              { once: true },
            )
          }
          // No abort → never resolves (mirrors a long-running command). Tests
          // that want a normal completion call mockResolvedValueOnce instead.
        }),
    ),
  }
})

// Mock compact-summary so compact() tests never hit the real Anthropic API.
// summarizeForCompact is the single LLM dependency of SessionManager.compact;
// tests override its resolved value per-case.
vi.mock('./compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => 'MOCK SUMMARY'),
}))

// Helper: yield to the event loop so the SessionManager's pump() can
// process whatever the mock just emitted. The pump iterates asynchronously,
// so a `setImmediate`-tick is enough to drain one message.
const tick = () => new Promise((r) => setImmediate(r))

// Import AFTER vi.mock so the SessionManager picks up the mocked SDK.
import { SessionManager, resolveConfiguredModel } from './session-manager.js'
import { ClaudeSessionHandle } from './providers/claude/claude-session.js'
import { SessionStore } from './persistence.js'
import { __setConfigForTest, config as defaultConfig } from './config.js'
import { McpConfigStore } from './mcp-config.js'
import { MpStore } from './mp-store.js'
import { execCommand as mockExecCommand } from './exec.js'
import { summarizeForCompact } from './compact-summary.js'
import { buildSessionRouter } from './routes/sessions.js'
import { HttpError } from './errors.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-rw-sm-'))
}

describe('SessionManager', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager

  beforeEach(async () => {
    mockHandles.length = 0
    // Reset the SDK mocks: clear call history AND restore the default
    // "transcript exists" implementation, so a `mockResolvedValueOnce`
    // override leaking past its test can't cascade into others.
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockImplementation(async (id) => ({ sessionId: id }))
    mockListSessions.mockReset()
    mockListSessions.mockImplementation(async () => [])
    vi.mocked(mockExecCommand).mockClear()
    vi.mocked(summarizeForCompact).mockReset()
    vi.mocked(summarizeForCompact).mockResolvedValue('MOCK SUMMARY')
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('create() spawns a Query and returns info with working=false', () => {
    const info = sm.create({ cwd: '/tmp', model: 'test-model' })
    expect(info.running).toBe(true)
    expect(info.working).toBe(false)
    expect(info.cwd).toBe('/tmp')
    expect(mockHandles).toHaveLength(1)
    expect(mockHandles[0].options.resume).toBeUndefined()
    // Pin the SDK session_id to our id so the on-disk transcript filename
    // matches `id` (the bug this guards against: SDK auto-generated its own
    // UUID, so our id matched no jsonl and fork/resume probes failed).
    expect(mockHandles[0].options.sessionId).toBe(info.id)
  })

  it('pins subagent model-alias env vars to the session model', () => {
    sm.create({ cwd: '/tmp', model: 'gw/some-model' })
    const env = mockHandles[0].options.env as Record<string, string>
    // All four aliases resolve to the session's explicit model so subagents
    // (Task/Agent/Explore) never fall back to an ID the gateway rejects.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gw/some-model')
  })

  it('falls back to the default model for the alias env vars when none is given', () => {
    sm.create({ cwd: '/tmp' })
    const env = mockHandles[0].options.env as Record<string, string>
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(defaultConfig.defaultModel)
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe(defaultConfig.defaultModel)
  })

  it('does not contaminate the shared env cache across sessions with different models', () => {
    sm.create({ cwd: '/tmp', model: 'model-a' })
    sm.create({ cwd: '/tmp', model: 'model-b' })
    const envA = mockHandles[0].options.env as Record<string, string>
    const envB = mockHandles[1].options.env as Record<string, string>
    // Shallow-copy isolation: session A's aliases must not be overwritten by
    // session B spawning with a different model.
    expect(envA.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model-a')
    expect(envB.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model-b')
    expect(envA).not.toBe(envB)
  })

  describe('model groups (group sessions)', () => {
    const GROUP = {
      id: 'g_flagship', name: 'Flagship',
      opus: 'anthropic/claude-opus-4-20250514',
      sonnet: 'anthropic/claude-sonnet-4-20250514',
      haiku: 'claude-haiku-3-5-20241022',
      main: 'opus' as const,
    }

    afterEach(() => {
      __setConfigForTest({ modelGroups: [] })
    })

    it('maps the four tier env vars to the group slots and sets the main model', () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      const env = mockHandles[0].options.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-3-5-20241022')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-haiku-3-5-20241022')
      expect(info.model).toBe('anthropic/claude-opus-4-20250514')
      expect(info.modelGroupId).toBe('g_flagship')
      expect(mockHandles[0].options.model).toBe('anthropic/claude-opus-4-20250514')
    })

    it('applies the fallback degradation chain on spawn for a group session', () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: ['sonnet', 'haiku'] })
    })

    it('empty slots fall back to the main model', () => {
      __setConfigForTest({
        modelGroups: [{ id: 'g_sonnet_only', name: 'Sonnet Only', sonnet: 'anthropic/claude-sonnet-4-20250514', main: 'sonnet' }],
      })
      sm.create({ cwd: '/tmp', modelGroupId: 'g_sonnet_only' } as Parameters<SessionManager['create']>[0])
      const env = mockHandles[0].options.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
    })

    it('single-model sessions still collapse all four aliases to the model', () => {
      // Regression guard for the single-model path (the existing tests above
      // cover it; this one pins it against accidental group leakage).
      __setConfigForTest({ modelGroups: [GROUP] })
      sm.create({ cwd: '/tmp', model: 'gw/some-model' })
      const env = mockHandles[0].options.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gw/some-model')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gw/some-model')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw/some-model')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gw/some-model')
    })

    it('create rejects an unknown modelGroupId with 400', () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      expect(() => sm.create({ cwd: '/tmp', modelGroupId: 'g_missing' } as Parameters<SessionManager['create']>[0])).toThrow(/model group g_missing not found/)
    })

    it('setModelGroup resolves main, switches model live, applies fallback, persists', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = sm.create({ cwd: '/tmp', model: 'gw/start' })
      const updated = await sm.setModelGroup(info.id, 'g_flagship')
      expect(updated.model).toBe('anthropic/claude-opus-4-20250514')
      expect(updated.modelGroupId).toBe('g_flagship')
      expect(mockHandles[0].setModel).toHaveBeenCalledWith('anthropic/claude-opus-4-20250514')
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: ['sonnet', 'haiku'] })
      expect(store.get(info.id)?.modelGroupId).toBe('g_flagship')
    })

    it('setModelGroup clears the prior fallback when switching to a haiku-main group', async () => {
      const BUDGET = {
        id: 'g_budget', name: 'Budget',
        opus: 'anthropic/claude-opus-4-20250514',
        sonnet: 'anthropic/claude-sonnet-4-20250514',
        haiku: 'claude-haiku-3-5-20241022',
        main: 'haiku' as const,
      }
      __setConfigForTest({ modelGroups: [GROUP, BUDGET] })
      const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      mockHandles[0].applyFlagSettings.mockClear()
      const updated = await sm.setModelGroup(info.id, 'g_budget')
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: null })
      expect(updated.modelGroupId).toBe('g_budget')
      expect(updated.model).toBe('claude-haiku-3-5-20241022')
    })

    it('setModelGroup rejects an unknown group with 400', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = sm.create({ cwd: '/tmp' })
      await expect(sm.setModelGroup(info.id, 'g_missing')).rejects.toThrow(/model group g_missing not found/)
    })

    it('setModel clears modelGroupId and the fallback chain', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      mockHandles[0].applyFlagSettings.mockClear()
      const updated = await sm.setModel(info.id, 'gw/other')
      expect(updated.modelGroupId).toBeUndefined()
      expect(updated.model).toBe('gw/other')
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: null })
    })

    it('respawn with a deleted group self-heals: clears the reference and collapses', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      const id = info.id
      // Unload the session so it goes dormant — self-heal triggers on respawn
      await sm.unload(id)
      __setConfigForTest({ modelGroups: [] }) // delete the group
      const resumed = await sm.resume(id)
      expect(resumed.modelGroupId).toBeUndefined()
      // The persisted resolved main is kept; the provider collapses to it.
      expect(resumed.model).toBe('anthropic/claude-opus-4-20250514')
      const last = mockHandles[mockHandles.length - 1].options.env as Record<string, string>
      expect(last.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
      expect(last.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-opus-4-20250514')
      expect(last.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-opus-4-20250514')
    })

    it('respawn re-applies the persisted group', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      // Unload so resume goes through spawn() and re-applies the group
      await sm.unload(info.id)
      const resumed = await sm.resume(info.id)
      expect(resumed.modelGroupId).toBe('g_flagship')
      const last = mockHandles[mockHandles.length - 1].options.env as Record<string, string>
      expect(last.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
      expect(last.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-3-5-20241022')
    })
  })

  it('global stream emits `created` on spawn and `update` on subsequent changes', async () => {
    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    const info = sm.create({})
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ kind: 'created', session: { id: info.id } })
    // Triggering a send → result cycle should emit `update`, never a
    // second `created` (that would cause the frontend to draw two cards).
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    // The pending persist after send() and the persist after result both
    // emit one `update` event each; poll until we see at least one.
    const kinds: string[] = []
    // Drain whatever's queued up in the next two steps.
    for (let i = 0; i < 4; i++) {
      const next = await Promise.race([
        it.next(),
        new Promise<IteratorResult<unknown>>((r) => setTimeout(() => r({ value: null, done: true }), 50)),
      ])
      if (next.done) break
      const ev = next.value as { kind: string }
      kinds.push(ev.kind)
    }
    expect(kinds.length).toBeGreaterThan(0)
    for (const k of kinds) expect(k).toBe('update')
    sub.unsubscribe()
  })

  it('send() marks the session as working; result clears it and stamps lastTurnAt', async () => {
    const info = sm.create({})
    sm.send(info.id, 'hi')
    expect(sm.get(info.id).working).toBe(true)

    const before = Date.now()
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    const after = sm.get(info.id)
    expect(after.working).toBe(false)
    expect(after.lastTurnAt).toBeDefined()
    expect(after.lastTurnAt!).toBeGreaterThanOrEqual(before)
  })

  it('reports backgroundSubagentCount + a working phase while a background subagent is in flight', async () => {
    const info = sm.create({ cwd: '/tmp/workspace' })
    expect(info.backgroundSubagentCount).toBe(0)
    expect(info.phase).toBe('idle')

    // Point the transcript watcher at the throwaway state dir so its poll
    // never touches the real ~/.claude. No transcript exists there, so the
    // watcher stays armed and the count holds at 1 (instead of completing
    // synchronously on the watcher's immediate first poll).
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      // Feed the pump an async launch ack: an Agent tool_result whose content
      // starts with the anchored launch marker and carries an agentId line.
      mockHandles[0].emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_bg_1',
            content: 'Async agent launched successfully.\nagentId: agent-1\n',
          }],
        },
      })
      await tick()

      const waiting = sm.get(info.id)
      // Parent turn is NOT running — only the background subagent is.
      expect(waiting.working).toBe(false)
      expect(waiting.backgroundSubagentCount).toBe(1)
      expect(waiting.phase).toBe('working')
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    // Force-terminate so unload() clears the still-armed watcher's interval.
    await sm.delete(info.id)
  })

  it('clears backgroundSubagentCount once the background subagent settles', async () => {
    const info = sm.create({ cwd: '/tmp/workspace' })
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      // Pre-write a terminal assistant frame to the subagent's transcript so
      // the watcher's immediate first poll sees a completed subagent.
      const txnPath = subagentTranscriptPath('/tmp/workspace', info.id, 'agent-1')
      mkdirSync(dirname(txnPath), { recursive: true })
      writeFileSync(
        txnPath,
        JSON.stringify({
          type: 'assistant',
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'subagent done' }],
          },
        }) + '\n',
      )

      mockHandles[0].emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_bg_2',
            content: 'Async agent launched successfully.\nagentId: agent-1\n',
          }],
        },
      })
      await tick()

      const settled = sm.get(info.id)
      expect(settled.backgroundSubagentCount).toBe(0)
      expect(settled.phase).toBe('idle')
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
  })

  it('keeps backgroundSubagentCount at 1 when the only terminal-looking frame is an API-error-truncated stop_sequence', async () => {
    // Regression for the sidebar 'waiting'→'live' flip: a transient API error
    // mid-run makes the CLI write an assistant message with
    // stop_reason:'stop_sequence' and an error notice — the subagent then
    // recovers and keeps producing. If the watcher treated that as completion,
    // backgroundSubagentCount would drop to 0 (sidebar 'live') while the
    // subagent is still running. It must stay at 1 ('waiting').
    const info = sm.create({ cwd: '/tmp/workspace' })
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      // Pre-write a transcript whose only terminal-looking stop_reason is the
      // error-truncated stop_sequence (no real end_turn yet).
      const txnPath = subagentTranscriptPath('/tmp/workspace', info.id, 'agent-err')
      mkdirSync(dirname(txnPath), { recursive: true })
      writeFileSync(
        txnPath,
        JSON.stringify({
          type: 'assistant',
          message: {
            stop_reason: 'stop_sequence',
            content: [{ type: 'text', text: 'API Error: Connection lost mid-response. The response above may be incomplete.' }],
          },
        }) + '\n',
      )

      mockHandles[0].emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_bg_err',
            content: 'Async agent launched successfully.\nagentId: agent-err\n',
          }],
        },
      })
      await tick()

      const waiting = sm.get(info.id)
      // NOT false-completed: the watcher is still polling the transcript.
      expect(waiting.backgroundSubagentCount).toBe(1)
      expect(waiting.phase).toBe('working')
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    // Force-terminate so unload() clears the still-armed watcher's interval.
    await sm.delete(info.id)
  })

  // -------------------------------------------------------------------------
  // Background-task control (SDK gap #1): backgroundTasks()/stopTask() are
  // delegated through the provider handle (capability-gated), and the
  // subagent watcher seeds/folds `session.tasks` so TasksPanel sees
  // watcher-tracked subagents the CLI never emits task_* frames for.
  // -------------------------------------------------------------------------

  it('backgroundTasks() forwards to the Query and returns the SDK boolean', async () => {
    const info = sm.create({})
    mockHandles[0].backgroundTasks.mockResolvedValueOnce(true)
    const result = await sm.backgroundTasks(info.id, 'tu_1')
    expect(result).toBe(true)
    expect(mockHandles[0].backgroundTasks).toHaveBeenCalledWith('tu_1')
    // No toolUseId → forwards undefined (CLI's Ctrl+B "all tasks" semantics).
    await sm.backgroundTasks(info.id)
    expect(mockHandles[0].backgroundTasks).toHaveBeenLastCalledWith(undefined)
  })

  it('stopTask() forwards the taskId to the Query', async () => {
    const info = sm.create({})
    await sm.stopTask(info.id, 'task-7')
    expect(mockHandles[0].stopTask).toHaveBeenCalledWith('task-7')
  })

  it('backgroundTasks() 501s when the provider handle lacks the method', async () => {
    // requireHandleMethod's guard: a handle without backgroundTasks must
    // surface a clean HttpError 501, not a TypeError from calling undefined.
    const info = sm.create({})
    const proto = ClaudeSessionHandle.prototype as unknown as Record<string, unknown>
    const desc = Object.getOwnPropertyDescriptor(ClaudeSessionHandle.prototype, 'backgroundTasks')!
    delete proto.backgroundTasks
    try {
      await expect(sm.backgroundTasks(info.id)).rejects.toThrow('does not support background tasks')
    } finally {
      Object.defineProperty(ClaudeSessionHandle.prototype, 'backgroundTasks', desc)
    }
  })

  it('a background launch ack seeds a running TaskRecord; a real task_notification cancels the watcher and settles it', async () => {
    const info = sm.create({ cwd: '/tmp/workspace' })
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      // Arm the watcher via the pump's launch-ack path (no transcript on
      // disk, so it stays polling).
      mockHandles[0].emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_bg_tasks',
            content: 'Async agent launched successfully.\nagentId: agent-tasks\n',
          }],
        },
      })
      await tick()

      expect(sm.get(info.id)!.backgroundSubagentCount).toBe(1)
      // The watcher seeded a running TaskRecord (taskId = agentId) so the
      // TasksPanel sees subagents the CLI emits no task_* frames for.
      const seeded = sm.subscribeTasks(info.id)!.snapshot
      expect(seeded.find((t) => t.taskId === 'agent-tasks')).toMatchObject({
        toolUseId: 'tu_bg_tasks',
        taskType: 'subagent',
        status: 'running',
        isBackgrounded: true,
      })

      // A REAL task_notification for the same tool call: the watcher must be
      // cancelled (no synthesized duplicate later) and the seeded record
      // folded to terminal via the pump's applyTaskEvent.
      mockHandles[0].emit({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-tasks',
        tool_use_id: 'tu_bg_tasks',
        status: 'completed',
        summary: 'all done',
      })
      await tick()

      expect(sm.get(info.id)!.backgroundSubagentCount).toBe(0)
      const settled = sm.subscribeTasks(info.id)!.snapshot
      expect(settled.find((t) => t.taskId === 'agent-tasks')).toMatchObject({
        status: 'completed',
        progressSummary: 'all done',
      })
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    await sm.delete(info.id)
  })

  it('a real task_notification whose task_id differs from the agentId drops the phantom seed', async () => {
    const info = sm.create({ cwd: '/tmp/workspace' })
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      mockHandles[0].emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_bg_mm',
            content: 'Async agent launched successfully.\nagentId: agent-mismatch\n',
          }],
        },
      })
      await tick()
      expect(sm.get(info.id)!.backgroundSubagentCount).toBe(1)
      expect(
        sm.subscribeTasks(info.id)!.snapshot.find((t) => t.taskId === 'agent-mismatch'),
      ).toMatchObject({ toolUseId: 'tu_bg_mm', status: 'running' })

      // The SDK's task_id need not equal the launch-ack's agentId. The pump
      // folds the REAL record under the frame's task_id first; the watcher
      // cancel then drops the still-running seed keyed by the agentId — it
      // would otherwise linger as a duplicate 'running' row in TasksPanel.
      mockHandles[0].emit({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'sdk-task-9',
        tool_use_id: 'tu_bg_mm',
        status: 'completed',
        summary: 'real record',
      })
      await tick()

      expect(sm.get(info.id)!.backgroundSubagentCount).toBe(0)
      const snapshot = sm.subscribeTasks(info.id)!.snapshot
      expect(snapshot.find((t) => t.taskId === 'sdk-task-9')).toMatchObject({
        status: 'completed',
        progressSummary: 'real record',
      })
      expect(snapshot.find((t) => t.taskId === 'agent-mismatch')).toBeUndefined()
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    await sm.delete(info.id)
  })

  it('the watcher\'s synthesized notification settles the seeded TaskRecord to terminal', async () => {
    const info = sm.create({ cwd: '/tmp/workspace' })
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      // Pre-write a terminal assistant frame so the watcher's immediate
      // first poll sees the subagent completed and synthesizes the
      // notification (which folds the seed record — it never passes through
      // the pump).
      const txnPath = subagentTranscriptPath('/tmp/workspace', info.id, 'agent-seed')
      mkdirSync(dirname(txnPath), { recursive: true })
      writeFileSync(
        txnPath,
        JSON.stringify({
          type: 'assistant',
          message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
        }) + '\n',
      )

      mockHandles[0].emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_bg_seed',
            content: 'Async agent launched successfully.\nagentId: agent-seed\n',
          }],
        },
      })
      await tick()
      await tick()

      const snapshot = sm.subscribeTasks(info.id)!.snapshot
      expect(snapshot.find((t) => t.taskId === 'agent-seed')).toMatchObject({
        toolUseId: 'tu_bg_seed',
        status: 'completed',
      })
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
  })

  it('carries a user turn sent during the autoResume window to the resumed handle (parked SDK waiter detached on abort)', async () => {
    const info = sm.create({})
    const firstHandle = mockHandles[0]
    // Complete a first turn so autoResume's `lastTurnAt` guard passes. The
    // result re-arms the mock SDK's input waiter, so the SDK's streamInput is
    // now parked in next() — exactly the idle state that precedes a clean exit.
    sm.send(info.id, 'first')
    await tick()
    firstHandle.emit({ type: 'result', session_id: info.id })
    await tick()
    expect(mockHandles[0].consumed.map((m) => (m as { message?: { content?: unknown } }).message?.content)).toEqual(['first'])

    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      autoResume: (session: unknown) => Promise<boolean>
      buildResumeOpts: (session: unknown) => Promise<Record<string, unknown>>
    }
    const session = internals.sessions.get(info.id)!
    let releaseResumeOpts!: (opts: Record<string, unknown>) => void
    internals.buildResumeOpts = vi.fn((): Promise<Record<string, unknown>> => new Promise((resolve) => {
      releaseResumeOpts = resolve
    }))

    // Simulate the clean-exit path (handleProcessExit): mark the session
    // exiting and abort the handle BEFORE autoResume. abort() now DETACHES the
    // parked SDK input waiter (the fix for the message-loss finding), so the
    // first window send QUEUES instead of being handed to that waiter and
    // dropped — the SDK's streamInput checks its abort signal after each pull.
    ;(session as { exiting: boolean }).exiting = true
    ;(session as { handle: { abort: () => void } }).handle.abort()

    const resuming = internals.autoResume(session)

    expect((session as { handle: { closed: boolean } }).handle.closed).toBe(false)
    expect(() => sm.send(info.id, 'sent-during-auto-resume')).not.toThrow()
    expect(sm.getHistory(info.id)?.some((message) =>
      (message as { message?: { content?: unknown } }).message?.content === 'sent-during-auto-resume',
    )).toBe(true)
    // It sits in the old handle's input queue — NOT consumed by the old SDK
    // (the waiter was detached, so push queued instead of direct hand-off).
    expect((session as { handle: { queueDepth: number } }).handle.queueDepth).toBe(1)
    expect(mockHandles[0].consumed.some((m) =>
      (m as { message?: { content?: unknown } }).message?.content === 'sent-during-auto-resume',
    )).toBe(false)

    // Release resume opts → respawnInPlace drains the old queue and
    // re-enqueues onto the fresh handle, which the mock consumes as its first
    // input.
    releaseResumeOpts({ resume: info.id })
    await resuming
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBe(info.id)
    expect(mockHandles[1].consumed.some((m) =>
      (m as { message?: { content?: unknown } }).message?.content === 'sent-during-auto-resume',
    )).toBe(true)
  })

  it('drains and surfaces a user turn stranded when buildResumeOpts throws during autoResume', async () => {
    const info = sm.create({})
    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      autoResume: (session: unknown) => Promise<boolean>
      buildResumeOpts: (session: unknown) => Promise<Record<string, unknown>>
    }
    const session = internals.sessions.get(info.id)!
    // Establish the autoResume precondition (a completed turn).
    ;(session as { lastTurnAt?: number }).lastTurnAt = Date.now()

    // Subscribe so we can observe the ephemeral "undelivered" notice.
    const sub = sm.subscribe(info.id)
    const it = sub.iterable[Symbol.asyncIterator]()

    // Park buildResumeOpts so we can send during the resume window, then fail
    // the resume — the stranded turn must be surfaced, not silently abandoned.
    let rejectBuildResumeOpts!: (err: unknown) => void
    internals.buildResumeOpts = vi.fn(
      (): Promise<Record<string, unknown>> => new Promise((_, reject) => {
        rejectBuildResumeOpts = reject
      }),
    )
    ;(session as { exiting: boolean }).exiting = true
    // Clean-exit path (handleProcessExit) aborts the handle, detaching the
    // parked SDK input waiter so the window send QUEUES (drainable) instead of
    // being handed straight to the waiter.
    ;(session as { handle: { abort: () => void } }).handle.abort()

    const resuming = internals.autoResume(session)
    // First frame: the window send itself (broadcast to history/subscribers).
    const firstFrame = it.next()
    sm.send(info.id, 'stranded-during-window')
    expect((session as { handle: { queueDepth: number } }).handle.queueDepth).toBe(1)
    // Second frame: the ephemeral undelivered notice.
    const noticeFrame = it.next()

    rejectBuildResumeOpts(new Error('mcp refresh failed'))
    await expect(resuming).rejects.toThrow('mcp refresh failed')

    expect((await firstFrame).value).toMatchObject({ type: 'user' })
    const notice = (await noticeFrame).value as { type?: string; error?: string }
    expect(notice.type).toBe('system')
    expect(notice.error).toContain('stranded-during-window')
    // The stranded turn was drained (not abandoned) and the handle destroyed.
    expect((session as { handle: { queueDepth: number } }).handle.queueDepth).toBe(0)
    expect((session as { handle: { closed: boolean } }).handle.closed).toBe(true)
    sub.unsubscribe()
  })

  it('autoResume bails (no respawn) if the session is unloaded while buildResumeOpts is pending', async () => {
    const info = sm.create({})
    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      autoResume: (session: unknown) => Promise<boolean>
      buildResumeOpts: (session: unknown) => Promise<Record<string, unknown>>
    }
    const session = internals.sessions.get(info.id)!
    // Establish the autoResume precondition (a completed turn).
    ;(session as { lastTurnAt?: number }).lastTurnAt = Date.now()
    let releaseResumeOpts!: (opts: Record<string, unknown>) => void
    internals.buildResumeOpts = vi.fn((): Promise<Record<string, unknown>> => new Promise((resolve) => {
      releaseResumeOpts = resolve
    }))
    ;(session as { exiting: boolean }).exiting = true

    const resuming = internals.autoResume(session)
    // A concurrent unload() (Delete / shutdown) removes the session from the
    // live map while the resume setup is still pending.
    await sm.unload(info.id)
    // Release resume opts — the post-await liveness re-check must see the
    // session is gone and return WITHOUT respawning a Query for a dead session.
    releaseResumeOpts({ resume: info.id })
    await expect(resuming).resolves.toBe(true)
    // No respawn happened: still exactly one mock handle (the original).
    expect(mockHandles).toHaveLength(1)
  })

  it('rejects a user turn when the provider input is already closed', () => {
    const info = sm.create({})
    const internals = sm as unknown as {
      sessions: Map<string, { handle: { destroy: (reason: string) => void } }>
    }
    internals.sessions.get(info.id)!.handle.destroy('test-closed-input')

    expect(() => sm.send(info.id, 'must-not-be-acknowledged')).toThrow(/not ready for input/i)
    expect(sm.getHistory(info.id)).toHaveLength(0)
  })

  it('pendingTurns caps at 1 across multiple sends', async () => {
    // Multiple back-to-back sends never inflate pendingTurns past 1
    // (which would otherwise stick the UI in "working" forever once
    // the SDK merged queued messages into fewer turns than were sent).
    const info = sm.create({})
    sm.send(info.id, 'first')
    sm.send(info.id, 'second')
    sm.send(info.id, 'third')
    expect(sm.get(info.id).working).toBe(true)
    // Drain everything: each result lands, the SDK pulls the next
    // queued message, and the next result will see an empty queue.
    mockHandles[0].emit({ type: 'result' })
    await tick()
    mockHandles[0].emit({ type: 'result' })
    await tick()
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await tick()
    expect(sm.get(info.id).working).toBe(false)
  })

  it('result keeps working=true while another user message is still queued', async () => {
    // Repro for the WorkingBubble flicker bug: user sends msg A, then
    // queues msg B while A is still running. When the SDK emits result
    // for A, the pump used to unconditionally clear pendingTurns to 0,
    // momentarily flipping working=false until the next HTTP send()
    // bumped it back. The fix: if the input pushable still has queued
    // items when result lands, keep pendingTurns=1 so the working state
    // stays continuous.
    const info = sm.create({})
    sm.send(info.id, 'first')
    sm.send(info.id, 'second')
    // Mock SDK drains 'first' immediately on spawn (initial drainOne).
    // 'second' sits in the input queue until the next 'result' triggers
    // the next drain. So when we emit the FIRST result, queueDepth>0.
    mockHandles[0].emit({ type: 'result' })
    await tick()
    // BUG WAS: working would flip to false here. FIXED: working stays
    // true because the input queue still has at least one item.
    expect(sm.get(info.id).working).toBe(true)
    // Once the second turn finishes (and no more queued input), working
    // clears as normal.
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await tick()
    expect(sm.get(info.id).working).toBe(false)
  })

  it('subscribe() replays history and streams live messages', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', message: { content: 'hello' } })
    await tick()

    const sub = sm.subscribe(info.id)
    expect(sub.history).toHaveLength(1)
    expect(sub.history[0]).toMatchObject({ type: 'assistant' })

    const it = sub.iterable[Symbol.asyncIterator]()
    const pending = it.next()
    mockHandles[0].emit({ type: 'assistant', message: { content: 'world' } })
    const delivered = await pending
    expect(delivered.value).toMatchObject({ type: 'assistant' })
    sub.unsubscribe()
  })

  describe('two-ring history split (main vs subagent)', () => {
    const sessionOf = (manager: SessionManager, id: string) => {
      const internals = manager as unknown as {
        sessions: Map<string, { history: Array<{ uuid?: string }>; subagentHistory: Array<{ uuid?: string }> }>
      }
      const s = internals.sessions.get(id)
      if (!s) throw new Error(`session ${id} not live`)
      return s
    }
    const uuids = (frames: Array<{ uuid?: string }>) => frames.map((m) => m.uuid)

    it('routes frames by parent_tool_use_id into separate rings', async () => {
      const info = sm.create({})
      mockHandles[0].emit({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: 'main' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_task', message: { content: 'subagent text' } })
      await tick()
      const s = sessionOf(sm, info.id)
      expect(uuids(s.history)).toEqual(['m1'])
      expect(uuids(s.subagentHistory)).toEqual(['s1'])
    })

    it('subagent volume evicts only subagent frames — the main ring is untouched', async () => {
      const smSmall = new SessionManager({ store, historyCap: 3, subagentHistoryCap: 2 })
      const info = smSmall.create({})
      const h = mockHandles.at(-1)!
      // Fill the main ring to its cap…
      for (let i = 0; i < 3; i++) {
        h.emit({ type: 'assistant', uuid: `m${i}`, parent_tool_use_id: null, message: { content: 'x' } })
      }
      // …then flood past the subagent cap. Before the split this would have
      // evicted main-thread frames out of the replay surface.
      for (let i = 0; i < 5; i++) {
        h.emit({ type: 'assistant', uuid: `s${i}`, parent_tool_use_id: 'tu_t', message: { content: 'x' } })
      }
      await tick()
      const s = sessionOf(smSmall, info.id)
      expect(uuids(s.history)).toEqual(['m0', 'm1', 'm2'])
      expect(uuids(s.subagentHistory)).toEqual(['s3', 's4'])
      await smSmall.shutdown()
    })

    it('subscribe() returns the merged chronological view of both rings', async () => {
      const info = sm.create({})
      // Pre-stamp receivedAt (stampReceivedAt is set-only-if-absent, so the
      // pump keeps these) to force a deterministic interleaved order.
      mockHandles[0].emit({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, receivedAt: 1, message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_t', receivedAt: 2, message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 'm2', parent_tool_use_id: null, receivedAt: 3, message: { content: 'x' } })
      await tick()
      const sub = sm.subscribe(info.id)
      expect(uuids(sub.history as Array<{ uuid?: string }>)).toEqual(['m1', 's1', 'm2'])
      sub.unsubscribe()
    })

    it('discard() seeds the fork with subagent frames re-split by origin', async () => {
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'go investigate')
      // Subagent frames arrive between the main user prompt and the anchor
      // assistant message — merged view order [user, s1, asst-1].
      h0.emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_task', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent thinking' }] } })
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      // Wait for the turn to land (lastTurnAt) and the anchor sidecar write
      // (discard validates the anchor against the sidecar).
      const smAny = sm as unknown as { turnAnchorStore: { load: (id: string) => Promise<Array<{ assistantUuid: string }>> | null } }
      for (let i = 0; i < 60 && (sm.get(info.id).lastTurnAt === undefined || (((await smAny.turnAnchorStore.load(info.id)) ?? []).length === 0)); i++) await tick()

      const y = await sm.discard(info.id, 'asst-1')

      // Y's seed was the merged view [user, s1, asst-1]; spawn() re-split it
      // by origin — main ring keeps the (uuid-rewritten) user prompt + the
      // anchor, the subagent ring keeps s1.
      const sY = sessionOf(sm, y.id)
      const mainUuids = uuids(sY.history)
      expect(mainUuids).toHaveLength(2)
      expect(mainUuids[mainUuids.length - 1]).toBe('asst-1')
      expect(uuids(sY.subagentHistory)).toEqual(['s1'])
      // Merged replay of Y shows the subagent frame in its chronological slot.
      const sub = sm.subscribe(y.id)
      const merged = uuids(sub.history as Array<{ uuid?: string }>)
      expect(merged).toHaveLength(3)
      expect(merged[1]).toBe('s1')
      expect(merged[2]).toBe('asst-1')
      sub.unsubscribe()
    })

    it('messageCount counts both rings', async () => {
      const info = sm.create({})
      mockHandles[0].emit({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_t', message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's2', parent_tool_use_id: 'tu_t', message: { content: 'x' } })
      await tick()
      expect(sm.get(info.id).messageCount).toBe(3)
    })

    it('passes forwardSubagentText (resolved from config default) to the SDK Options', async () => {
      sm.create({})
      // Compare against defaultConfig, not literal true: the test process
      // shares the machine's real ~/.claude-react-web/config.json, and the
      // wiring under test is config → manager → provider → sdkOptions.
      expect(mockHandles.at(-1)!.options.forwardSubagentText).toBe(defaultConfig.forwardSubagentText)
    })

    it('forwards an explicit forwardSubagentText: false override', async () => {
      const smOff = new SessionManager({ store, forwardSubagentText: false })
      smOff.create({})
      expect(mockHandles.at(-1)!.options.forwardSubagentText).toBe(false)
      await smOff.shutdown()
    })
  })

  describe('user dialogs (onUserDialog / supportedDialogKinds)', () => {
    const sessionOf = (manager: SessionManager, id: string) => {
      const internals = manager as unknown as {
        sessions: Map<string, { dialogPending: Map<string, unknown> }>
      }
      const s = internals.sessions.get(id)
      if (!s) throw new Error(`session ${id} not live`)
      return s
    }

    it('spawns with the atomic onUserDialog + supportedDialogKinds pair', () => {
      sm.create({})
      const opts = mockHandles.at(-1)!.options as {
        onUserDialog?: unknown
        supportedDialogKinds?: string[]
      }
      expect(typeof opts.onUserDialog).toBe('function')
      expect(opts.supportedDialogKinds).toEqual(['refusal_fallback_prompt'])
    })

    it('parks a known-kind dialog via the SDK callback and resolves it via decideDialog', async () => {
      const info = sm.create({})
      const opts = mockHandles.at(-1)!.options as {
        onUserDialog?: (
          req: { dialogKind: string; payload: Record<string, unknown> },
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; result?: unknown }>
      }
      const promise = opts.onUserDialog!(
        {
          dialogKind: 'refusal_fallback_prompt',
          payload: {
            originalModel: 'model-a',
            fallbackModel: 'model-b',
            guidanceText: 'refused',
            retractedMessageUuids: ['u1', 'u2'],
          },
        },
        { signal: new AbortController().signal },
      )
      const s = sessionOf(sm, info.id)
      expect(s.dialogPending.size).toBe(1)
      const id = [...s.dialogPending.keys()][0]!
      sm.decideDialog(info.id, id, { behavior: 'completed', result: 'retry_fallback' })
      await expect(promise).resolves.toEqual({ behavior: 'completed', result: 'retry_fallback' })
      expect(s.dialogPending.size).toBe(0)
    })

    it('auto-cancels unknown dialog kinds without parking', async () => {
      const info = sm.create({})
      const opts = mockHandles.at(-1)!.options as {
        onUserDialog?: (
          req: { dialogKind: string; payload: Record<string, unknown> },
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; result?: unknown }>
      }
      const result = await opts.onUserDialog!(
        { dialogKind: 'future_kind', payload: {} },
        { signal: new AbortController().signal },
      )
      expect(result).toEqual({ behavior: 'cancelled' })
      expect(sessionOf(sm, info.id).dialogPending.size).toBe(0)
    })
  })

  it('clear() removes the pre-clear session from the sidebar and returns a fresh session under a new id', async () => {
    const info = sm.create({})
    expect(mockHandles).toHaveLength(1)
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(1)

    const next = await sm.clear(info.id)

    // Y is a brand-new session with a DIFFERENT id; old handle destroyed,
    // fresh one created. Fresh conversation: no `resume`, and the SDK
    // session_id is pinned to Y's id (not X's).
    expect(next.id).not.toBe(info.id)
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBeUndefined()
    expect(mockHandles[1].options.sessionId).toBe(next.id)
    // X is removed from the sidebar/store (not left dormant) — but the
    // transcript file survives on disk for resume (see the next test).
    expect(sm.list().find((s) => s.id === info.id)).toBeUndefined()
    expect(store.get(info.id)).toBeUndefined()
    // We never push a `/clear` slash command into either Query's input
    // queue (the headless binary rejects it; the unload+spawn IS the clear).
    for (const h of mockHandles) {
      const sawClear = h.consumed.some(
        (m) => (m as { message?: { content?: unknown } }).message?.content === '/clear',
      )
      expect(sawClear).toBe(false)
    }
  })

  it("clear() does not carry X's title onto the fresh session Y", async () => {
    const info = sm.create({ title: 'My Title' })
    expect(info.title).toBe('My Title')

    const next = await sm.clear(info.id)

    // Y is a fresh conversation — it must NOT inherit X's title. The client
    // falls back to the id-prefix display and auto-titles from the first
    // post-clear message.
    expect(next.id).not.toBe(info.id)
    expect(next.title).toBeUndefined()
    // And Y's persisted meta carries no title either.
    expect(store.get(next.id)?.title).toBeUndefined()
  })

  it('clear() removes X from the store but keeps it resumable via the on-disk transcript; Y is empty', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(1)

    const next = await sm.clear(info.id)

    // X is no longer live (unloaded) and removed from the store/sidebar, but
    // the transcript file survives on disk — resume(X) re-adopts it via
    // adoptDiskSession and recovers the pre-clear conversation.
    expect(sm.getHistory(info.id)).toBeNull()
    expect(store.get(info.id)).toBeUndefined()
    expect(sm.list().find((s) => s.id === info.id)).toBeUndefined()
    // Y is a fresh empty session (no history seeded).
    expect(sm.getHistory(next.id)!).toHaveLength(0)
    // P1 is still recoverable: resume(X) re-adopts the on-disk transcript
    // (store.get is undefined, so resume falls through to adoptDiskSession).
    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(store.get(info.id)).toBeDefined()
  })

  it('resume() after /clear maps the transcript SHORT model id back to the configured FULL id', async () => {
    // Regression for "executing /clear reports a model error": the CLI writes
    // the SHORT model id (deepseek-v4-flash) into the on-disk transcript's
    // assistant frames, but the gateway only accepts the configured FULL id
    // (deepseek/deepseek-v4-flash). Chain that bit us:
    //   1. X runs with the full id; /clear removes X from the store.
    //   2. Resume(X) → adoptDiskSession (store.get is undefined) → no
    //      meta.model → resume falls back to firstAssistantModel(seed),
    //      which reads the SHORT id out of the transcript.
    //   3. The SHORT id is persisted as X's model and cloned into the NEXT
    //      /clear's fresh session → "API Error: 400 Unsupported model".
    // Resume must resolve the SHORT id back to the configured FULL id.
    const FULL = 'anthropic/claude-sonnet-4-20250514'
    const SHORT = 'claude-sonnet-4-20250514'

    const info = sm.create({ cwd: '/tmp', model: FULL })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    await sm.clear(info.id)
    expect(store.get(info.id)).toBeUndefined() // X left the store

    // The on-disk transcript records the SHORT model id in assistant frames.
    const readPage = vi.spyOn(
      sm as unknown as { readProviderHistoryPage: (provider: unknown, id: string, opts: { limit: number; afterUuid?: string }) => Promise<unknown> },
      'readProviderHistoryPage',
    ).mockResolvedValue({
      messages: [{ type: 'assistant', message: { model: SHORT, content: 'hi' } }],
      totalCount: 1,
      startIndex: 0,
      hasMore: false,
    })

    const resumed = await sm.resume(info.id)
    readPage.mockRestore()

    expect(resumed.id).toBe(info.id)
    // The resumed Query must be spawned with the FULL configured id, not the
    // SHORT transcript id the gateway rejects.
    expect(mockHandles[mockHandles.length - 1].options.model).toBe(FULL)
    // Persisted meta must carry the FULL id so the next /clear inherits it.
    expect(store.get(info.id)?.model).toBe(FULL)
  })

  it('resume() heals a persisted SHORT model id back to the configured FULL id', async () => {
    // A session whose persisted meta already carries the SHORT id (e.g. the
    // corrupted 7142f1c8 entry) must be healed to the FULL id on resume — the
    // fix must not only stop NEW corruption, it must repair existing entries.
    const FULL = 'anthropic/claude-sonnet-4-20250514'
    const SHORT = 'claude-sonnet-4-20250514'

    const info = sm.create({ cwd: '/tmp', model: SHORT })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    await sm.unload(info.id)
    expect(store.get(info.id)?.model).toBe(SHORT) // corrupted, persisted as-is

    await sm.resume(info.id)
    expect(mockHandles[mockHandles.length - 1].options.model).toBe(FULL)
    expect(store.get(info.id)?.model).toBe(FULL)
  })

  it('clear() does not broadcast session-cleared (Y has no pre-clear content to hide)', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()

    const spy = vi.spyOn(sm, 'broadcastSessionCleared')
    await sm.clear(info.id)
    // clear() must not emit session-cleared; the only remaining producer is
    // the SDK's own in-band `cleared` control event (forwarded in ws.ts),
    // which the mock never fires.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('clear() resets stale working state from the interrupted turn', async () => {
    const info = sm.create({})
    sm.send(info.id, 'busy')
    expect(sm.get(info.id).working).toBe(true)

    const next = await sm.clear(info.id)

    // X is removed from the sidebar (not dormant); Y is a fresh idle session.
    expect(sm.list().find((s) => s.id === info.id)).toBeUndefined()
    expect(sm.get(next.id).working).toBe(false)
    expect(sm.get(next.id).phase).toBe('idle')
  })

  it('clear() drops hook run records on the fresh session', async () => {
    const info = sm.create({})
    // Seed two hook runs before the clear.
    sm.recordHookRun(info.id, {
      kind: 'completed',
      run: {
        id: 'h1', hookId: 'h1', hookName: 'audit', event: 'Stop', status: 'success',
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    })
    sm.recordHookRun(info.id, {
      kind: 'completed',
      run: {
        id: 'h2', hookId: 'h2', hookName: 'lint', event: 'PostToolUse', status: 'error',
        startedAt: Date.now(), updatedAt: Date.now(),
      },
    })
    expect(sm.subscribeHookRuns(info.id)!.snapshot).toHaveLength(2)

    const next = await sm.clear(info.id)

    // Hook history lived on X (now unloaded); Y starts with an empty log.
    expect(sm.subscribeHookRuns(next.id)!.snapshot).toHaveLength(0)
  })

  it('clear() preserves the session skill override on the fresh session', async () => {
    // Regression: clear() must forward X.skillOverride to spawn() (5th arg,
    // same as fork()) or Y silently falls back to the global — possibly
    // permissive — policy, losing a pinned restrictive override.
    const info = sm.create({})
    await sm.setSkillOverride(info.id, { kind: 'disabled' })
    expect(sm.get(info.id).skillOverride).toEqual({ kind: 'disabled' })

    const next = await sm.clear(info.id)

    // Y inherits the pinned override; the SDK also sees it applied via the
    // spawn-time skill policy (applySkillPolicyToOptions), not just the flag
    // layer. mockHandles[1] is Y's handle.
    expect(sm.get(next.id).skillOverride).toEqual({ kind: 'disabled' })
    // 'disabled' projects to an empty Options.skills (every skill forced off).
    expect(mockHandles[1].options.skills).toEqual([])
  })

  it('clear() leaves X runnable when spawn() of Y throws (no orphaned tab)', async () => {
    // Regression: clear() used to unload X BEFORE spawning Y, so a spawn
    // throw orphaned the tab (X gone, Y never registered). Now Y is spawned
    // first; on throw X stays live and runnable, clearing is reset.
    const info = sm.create({})
    // Stub the first spawn() call (Y) to throw synchronously. spawn is private
    // but the internal this.spawn dispatches through the instance method, so a
    // spy intercepts it. X must survive untouched.
    const spawnSpy = vi
      .spyOn(sm as unknown as { spawn: (...a: unknown[]) => unknown }, 'spawn')
      .mockImplementationOnce(() => {
        throw new Error('spawn boom')
      })
    await expect(sm.clear(info.id)).rejects.toThrow('spawn boom')
    spawnSpy.mockRestore()
    // X is still live, still runnable, no longer mid-clear.
    const x = sm.get(info.id)
    expect(x.id).toBe(info.id)
    expect((x as { clearing?: boolean }).clearing).toBeFalsy()
    // No fresh session was registered.
    expect(mockHandles).toHaveLength(1)
    // A new turn still works on X.
    sm.send(info.id, 'still here')
    expect(sm.get(info.id).working).toBe(true)
  })

  it('clear() does not leave lastTurnAt on the fresh session (no spurious "No messages yet" recap)', async () => {
    // Regression: the recap auto-hook gates on `lastTurnAt`. If clear()
    // left lastTurnAt set on the fresh Y while Y's history ring is empty,
    // the hook would fire requestGenerate on empty history and pop up
    // "No messages yet." Y must start with lastTurnAt undefined.
    const info = sm.create({})
    // Complete a real turn so X.lastTurnAt is stamped + history non-empty.
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    expect(sm.get(info.id).lastTurnAt).toBeDefined()

    const next = await sm.clear(info.id)

    // Y is fresh: lastTurnAt MUST be undefined, and no recap synthesized.
    expect(sm.get(next.id).lastTurnAt).toBeUndefined()
    expect(sm.get(next.id).recap).toBeUndefined()
  })

  it('clear() on a Side Chat still produces a Side Chat Y (parentId inherited); X is removed', async () => {
    // Side Chats can't be /clear'd from the UI (their composer bypasses
    // local-command processing), so this path is defensive — but clear()
    // still handles parentId sessions: Y inherits parentId + the Side Chat
    // boundary prompt, and X is removed from the store just like a regular
    // session (transcript kept for resume).
    const parent = sm.create({ cwd: '/tmp' })
    const side = await sm.createSideChat(parent.id)
    expect(side.parentId).toBe(parent.id)

    const next = await sm.clear(side.id)

    // Y is a fresh session under a new id, still a Side Chat (parentId carried).
    expect(next.id).not.toBe(side.id)
    expect(next.parentId).toBe(parent.id)
    // X is removed from the store (unified with regular sessions).
    expect(store.get(side.id)).toBeUndefined()
    expect(sm.list().find((s) => s.id === side.id)).toBeUndefined()
  })

  it('clear(id, { seedText }) seeds Y with a compact boundary + synthetic summary', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(1)

    const next = await sm.clear(info.id, { seedText: 'HAND-OFF SUMMARY' })

    // Y's ring holds exactly [boundary, summary] — nothing else.
    const history = sm.getHistory(next.id)!
    expect(history).toHaveLength(2)
    // [0] is the client-facing divider (never sent to the SDK).
    const boundary = history[0] as { type: string; subtype: string; compact_metadata: { trigger: string } }
    expect(boundary.type).toBe('system')
    expect(boundary.subtype).toBe('compact_boundary')
    expect(boundary.compact_metadata.trigger).toBe('auto')
    // [1] is the user-role summary carrying the hand-off text.
    const seed = history[1] as { type: string; message: { content: string }; isSynthetic: boolean; shouldQuery: boolean }
    expect(seed.type).toBe('user')
    expect(seed.message.content).toBe('HAND-OFF SUMMARY')
    expect(seed.isSynthetic).toBe(true)
    expect(seed.shouldQuery).toBe(false)
    // The seed must not bump Y into a turn.
    expect(sm.get(next.id).working).toBe(false)
    expect(sm.get(next.id).phase).toBe('idle')
    // The SDK received the seed through the input pushable (raw push) exactly
    // once, and with shouldQuery:false so it never triggers an assistant turn.
    const seedConsumed = mockHandles[1].consumed.find(
      (m) => (m as { isSynthetic?: boolean }).isSynthetic === true,
    )
    expect(seedConsumed).toBeDefined()
    expect((seedConsumed as { shouldQuery: boolean }).shouldQuery).toBe(false)
    expect(mockHandles[1].consumed.filter((m) => (m as { isSynthetic?: boolean }).isSynthetic === true)).toHaveLength(1)
  })

  it('clear(id, { seedText }) does not leak the seed into Y persisted metadata', async () => {
    // R3: the boundary + summary are in-memory artifacts of the live ring —
    // never persisted into the store meta (they aren't in the CLI-owned
    // jsonl either). After a restart the divider is absent from the UI but the
    // summary text remains inside the SDK's transcript. Guard against the
    // seed being persisted as a meta field here.
    const info = sm.create({})
    await tick()
    const next = await sm.clear(info.id, { seedText: 'HAND-OFF SUMMARY' })
    const meta = store.get(next.id)
    expect(meta).toBeDefined()
    expect(JSON.stringify(meta)).not.toContain('HAND-OFF SUMMARY')
  })

  it("compact() keeps X's title on the continuation session Y (plain /clear drops it)", async () => {
    const info = sm.create({ title: 'My Title' })
    expect(info.title).toBe('My Title')

    const next = await sm.compact(info.id)

    // Compact is a CONTINUATION of the same conversation, so Y keeps X's
    // title: the seeded summary suppresses the client's isFirstUserTurn
    // auto-title, so a compacted Y must stay labelled. (The plain /clear
    // path — no seedText — drops the title; covered by the test above.)
    expect(next.id).not.toBe(info.id)
    expect(next.title).toBe('My Title')
    expect(store.get(next.id)?.title).toBe('My Title')
  })

  it('compact() refuses unknown / working / terminated sessions', async () => {
    // Unknown → 404.
    await expect(sm.compact('ghost')).rejects.toMatchObject({ status: 404 })

    // Working → 409.
    const info = sm.create({})
    sm.send(info.id, 'busy')
    expect(sm.get(info.id).phase).toBe('working')
    await expect(sm.compact(info.id)).rejects.toMatchObject({ status: 409 })

    // Let the turn complete.
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    expect(sm.get(info.id).phase).toBe('idle')

    // Terminated → 410.
    mockHandles[0].finish()
    await tick()
    expect(sm.get(info.id).terminated).toBe(true)
    await expect(sm.compact(info.id)).rejects.toMatchObject({ status: 410 })
  })

  it('compact() refuses a slept (dormant) session with 404 (unloaded from the live map)', async () => {
    // unload() removes dormant sessions from the live map, so compact()'s
    // require() throws 404 before the phase guard. The 412 branch in compact()
    // is defensive parity with RecapManager for a hypothetical in-map-but-not-
    // running session — not reachable through the public API today.
    const info = sm.create({})
    await sm.sleep(info.id)
    // unload removed it from the live map (listActivity only sees live
    // sessions); get() still resolves it from the store as a dormant meta.
    expect(sm.listActivity().find((a) => a.sessionId === info.id)).toBeUndefined()
    await expect(sm.compact(info.id)).rejects.toMatchObject({ status: 404 })
  })

  it('compact() summarises an idle session and swaps to a fresh seeded session', async () => {
    vi.mocked(summarizeForCompact).mockResolvedValueOnce('HAND-OFF')
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(1)

    const next = await sm.compact(info.id)

    expect(vi.mocked(summarizeForCompact)).toHaveBeenCalledTimes(1)
    // X is removed (not left dormant), Y is fresh under a new id.
    expect(next.id).not.toBe(info.id)
    expect(sm.list().find((s) => s.id === info.id)).toBeUndefined()
    expect(mockHandles).toHaveLength(2)
    // Y is seeded with the boundary + hand-off summary, and is idle.
    const history = sm.getHistory(next.id)!
    expect(history).toHaveLength(2)
    expect((history[0] as { subtype: string }).subtype).toBe('compact_boundary')
    const seed = history[1] as { message: { content: string }; shouldQuery: boolean }
    expect(seed.message.content).toBe('HAND-OFF')
    expect(seed.shouldQuery).toBe(false)
    expect(sm.get(next.id).phase).toBe('idle')
  })

  it('compact() falls back to a plain clear when the summary is empty', async () => {
    vi.mocked(summarizeForCompact).mockResolvedValueOnce('')
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()

    const next = await sm.compact(info.id)

    // No boundary / summary seeded — Y is a plain empty session.
    expect(sm.getHistory(next.id)!).toHaveLength(0)
    expect(vi.mocked(summarizeForCompact)).toHaveBeenCalledTimes(1)
  })

  it('two concurrent compacts never double-spawn a fresh session', async () => {
    vi.mocked(summarizeForCompact).mockResolvedValue('HAND-OFF')
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()

    const results = await Promise.allSettled([sm.compact(info.id), sm.compact(info.id)])

    // The `s.clearing` guard in clear() lets exactly ONE clear spawn Y; the
    // loser either sees clearing=true and returns X's (stale) info, or lands
    // after X was unloaded and rejects. Either way, no second subprocess.
    expect(mockHandles).toHaveLength(2) // X + exactly one Y
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    // Exactly one live session remains (the fresh Y), seeded.
    const live = sm.list().filter((s) => s.running)
    expect(live).toHaveLength(1)
    expect(sm.getHistory(live[0].id)!).toHaveLength(2)
  })

  it('listActivity() emits coarse activity snapshots for live sessions', () => {
    const info = sm.create({ cwd: '/tmp', model: 'test-model' })
    const activity = sm.listActivity()
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({
      sessionId: info.id,
      provider: 'claude',
      cwd: '/tmp',
      model: 'test-model',
      running: true,
      terminated: false,
      pendingTurns: 0,
      pendingPermissions: 0,
      historyLength: 0,
    })
    expect(activity[0].lastActivityAt).toBeGreaterThan(0)

    // After a send, the snapshot reports the in-flight turn + workingSince.
    sm.send(info.id, 'hi')
    const working = sm.listActivity()[0]
    expect(working.pendingTurns).toBe(1)
    expect(working.workingSince).toBeGreaterThan(0)
  })

  it('getCachedContextUsage() reads the pump-cached snapshot, or null', async () => {
    const info = sm.create({})
    expect(sm.getCachedContextUsage(info.id)).toBeNull()
    expect(sm.getCachedContextUsage('ghost')).toBeNull()

    // A `result` with a valid usage payload populates the cache.
    mockHandles[0].emit({
      type: 'result',
      session_id: info.id,
      usage: {
        input_tokens: 90_000,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        iterations: [
          { type: 'message', input_tokens: 90_000, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 500 },
        ],
      },
      modelUsage: { 'claude-sonnet-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 } },
    })
    await tick()

    const usage = sm.getCachedContextUsage(info.id)
    expect(usage).not.toBeNull()
    expect(usage!.totalTokens).toBe(90_000)
    expect(usage!.maxTokens).toBe(200_000)
    expect(usage!.percentage).toBeCloseTo(45)
    expect(usage!.model).toBe('claude-sonnet-4-5')
    // 200000 − min(64000, 20000) − 13000 = 167000.
    expect(usage!.autoCompactThreshold).toBe(167_000)
  })

  it('subscribeContextUsage() hands a fresh subscriber the last cached snapshot', async () => {
    // A tab that attaches BETWEEN turns (reconnect / new panel / refresh)
    // should see the Context bar value immediately rather than waiting for
    // the next `result`. The pump caches every result's usage on the
    // session; subscribeContextUsage returns it as `snapshot`.
    const info = sm.create({})
    sm.send(info.id, 'hi')
    mockHandles[0].emit({
      type: 'result',
      usage: { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    await tick()

    const sub = sm.subscribeContextUsage(info.id)
    expect(sub).not.toBeNull()
    expect(sub!.snapshot).toMatchObject({ totalTokens: 6200, maxTokens: 200000, model: 'claude-opus-4-7' })
    sub!.unsubscribe()
  })

  it('subscribeContextUsage() snapshot is undefined before any result lands', () => {
    const info = sm.create({})
    const sub = sm.subscribeContextUsage(info.id)
    expect(sub).not.toBeNull()
    expect(sub!.snapshot).toBeUndefined()
    sub!.unsubscribe()
  })

  it('send() invalidates a stale prompt-suggestion snapshot', async () => {
    const info = sm.create({})
    // A previous turn produced a predicted next-prompt.
    mockHandles[0].emit({ type: 'prompt_suggestion', suggestion: 'stale prediction' })
    await tick()

    // A tab attaching between turns would receive that as its snapshot.
    const before = sm.subscribePromptSuggestion(info.id)
    expect(before).not.toBeNull()
    expect(before!.snapshot).toBe('stale prediction')
    before?.unsubscribe()

    // Starting a NEW user turn invalidates the old prediction. If the SDK
    // suppresses a fresh suggestion for this turn (plan mode / error / first
    // turn), a later resubscribe must NOT resurrect the stale value.
    sm.send(info.id, 'a brand new turn')

    const after = sm.subscribePromptSuggestion(info.id)
    expect(after).not.toBeNull()
    expect(after!.snapshot).toBeUndefined()
    after?.unsubscribe()
  })

  it('persists metadata on create and on send', async () => {
    const info = sm.create({ title: 'hello', cwd: '/x' })
    await store.flush()
    expect(store.get(info.id)).toMatchObject({ id: info.id, title: 'hello' })

    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await store.flush()
    expect(store.get(info.id)?.lastTurnAt).toBeDefined()
  })

  it('list() merges live sessions with dormant persisted ones', async () => {
    const live = sm.create({ title: 'live-one' })
    // Fake a dormant entry by upserting directly into the store.
    store.upsert({
      id: 'dormant-id',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 5,
      terminated: false,
      title: 'dormant-one',
    })

    const list = sm.list()
    expect(list).toHaveLength(2)
    const liveInfo = list.find((s) => s.id === live.id)!
    const dormantInfo = list.find((s) => s.id === 'dormant-id')!
    expect(liveInfo.running).toBe(true)
    expect(dormantInfo.running).toBe(false)
    expect(dormantInfo.messageCount).toBe(5)
  })

  it('delete() closes the Query and removes from the persistence index', async () => {
    const info = sm.create({})
    sm.send(info.id, 'q')
    expect(sm.get(info.id).working).toBe(true)

    await sm.delete(info.id)
    await store.flush()
    expect(store.get(info.id)).toBeUndefined()
    expect(() => sm.get(info.id)).toThrow(/not found/)
  })

  it('delete() resolves pending permissions as deny so SDK awaiters never hang', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string; suggestions?: unknown },
    ) => Promise<{ behavior: string; message?: string }>
    expect(canUseTool).toBeTypeOf('function')
    const ctrl = new AbortController()
    const permissionPromise = canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: ctrl.signal, toolUseID: 'tu-1', suggestions: [] },
    )

    // Give the manager a microtask to park the pending request.
    await tick()
    expect(sm.listPending(info.id)).toHaveLength(1)

    await sm.delete(info.id)
    const resolved = await permissionPromise
    expect(resolved.behavior).toBe('deny')
  })

  it('sleep() unloads an idle session to dormant (reversible, transcript kept)', async () => {
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    // A freshly-created session with no in-flight turn is idle.
    expect(sm.get(info.id).phase).toBe('idle')
    expect(sm.get(info.id).slept).toBeFalsy()

    const slept = await sm.sleep(info.id)

    // No longer live, but persisted as non-terminated (dormant).
    expect(slept.running).toBe(false)
    expect(slept.phase).toBe('dormant')
    expect(slept.terminated).toBe(false)
    // sleep() marks the session deliberately-slept so auto-resume paths skip it.
    expect(slept.slept).toBe(true)
    const meta = store.get(info.id)
    expect(meta).toBeDefined()
    expect(meta!.terminated).toBe(false)
    expect(meta!.slept).toBe(true)
    expect(meta!.cwd).toBe('/tmp')
    expect(meta!.model).toBe('m1')

    // resume() brings it back: a new Query with resume=id is spawned, and
    // clears the slept flag (the session is live again).
    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(resumed.running).toBe(true)
    expect(resumed.slept).toBe(false)
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBe(info.id)
  })

  it('sleep() rejects a working session with 409 (idle guard)', async () => {
    const info = sm.create({})
    sm.send(info.id, 'in-flight')
    expect(sm.get(info.id).working).toBe(true)

    await expect(sm.sleep(info.id)).rejects.toThrow(/working/)
    // The session is untouched — still live and running.
    expect(sm.get(info.id).running).toBe(true)
    expect(mockHandles).toHaveLength(1)
  })

  it('sleep() on an already-dormant session throws (not live)', async () => {
    const info = sm.create({})
    await sm.sleep(info.id)
    // A second sleep hits requireLive → require → 404 (not in the live map).
    await expect(sm.sleep(info.id)).rejects.toThrow(/not found/)
  })

  it('resume() spawns a new Query with options.resume set to the original id', async () => {
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)

    // Live map no longer contains it, but persistence does.
    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBe(info.id)
    expect(mockHandles[1].options.cwd).toBe('/tmp')
    expect(mockHandles[1].options.model).toBe('m1')
    // Plain resume must NOT set sessionId — the SDK rejects sessionId
    // alongside resume unless forkSession is also set, and resume preserves
    // the existing session_id on its own anyway.
    expect(mockHandles[1].options.sessionId).toBeUndefined()
  })

  it('resume() is idempotent when the session is already live', async () => {
    const info = sm.create({})
    const again = await sm.resume(info.id)
    expect(again.id).toBe(info.id)
    // No extra Query was spawned.
    expect(mockHandles).toHaveLength(1)
  })

  it('resume() refuses hard-terminated sessions (deleted / transcript_missing / crash_recovered_fork)', async () => {
    const info = sm.create({})
    // Simulate the pump finishing naturally — queue a result then close.
    // This leaves terminated:true with terminatedReason:'query_ended' (a
    // TRANSIENT reason — covered by the next test). Overwrite it with a
    // hard-terminal reason to verify the guard still 410s those.
    mockHandles[0].emit({ type: 'result' })
    mockHandles[0].finish()
    await tick()
    await sm.unload(info.id)
    expect(store.get(info.id)?.terminated).toBe(true)

    for (const reason of ['deleted', 'transcript_missing', 'crash_recovered_fork'] as const) {
      const meta = store.get(info.id)!
      store.upsert({ ...meta, terminatedReason: reason })
      await expect(sm.resume(info.id)).rejects.toThrow(/ended/i)
    }
  })

  it('resume() allows resuming a transiently-terminated session when the transcript still exists', async () => {
    // Auto-recovery (crash ladder) may have failed and left the session
    // terminated with a transient reason (process crash / query error /
    // spawn failure), but the SDK transcript can still be intact on disk.
    // resume() must defer to the hasSdkTranscript probe rather than
    // hard-410-ing — the user's manual retry should succeed.
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    mockHandles[0].finish()
    await tick()
    await sm.unload(info.id)
    // Pump natural end → terminated:true, terminatedReason:'query_ended'.
    expect(store.get(info.id)?.terminated).toBe(true)
    expect(store.get(info.id)?.terminatedReason).toBe('query_ended')

    // Default mock → transcript exists on disk. The transient reason lets
    // resume() fall through to the probe, which authorises the spawn.
    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(resumed.terminated).toBe(false)
    // Resumed with `resume: id` (not a fresh respawn).
    expect(mockHandles[1].options.resume).toBe(info.id)
    expect(mockHandles[1].options.sessionId).toBeUndefined()
    // spawn()'s writeStore is a wholesale replace → the stale terminal
    // state is cleared from the persisted meta.
    const after = store.get(info.id)!
    expect(after.terminated).toBe(false)
    expect(after.terminatedReason).toBeUndefined()
    expect(after.error).toBeUndefined()
  })

  it('resume() of a transiently-terminated session with a missing transcript falls back to transcript_missing 410', async () => {
    // Transient reason lets resume() past the guard, but the on-disk
    // transcript is gone — the hasSdkTranscript probe must catch it,
    // mark it transcript_missing, and 410 (mirroring the existing
    // !hasTranscript + lastTurnAt branch for non-terminated sessions).
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    await sm.unload(info.id)
    // Force a transient reason + a completed turn (so the probe's
    // markTranscriptMissing branch fires rather than respawnFresh).
    const meta = store.get(info.id)!
    store.upsert({ ...meta, terminated: true, terminatedReason: 'process_exited' })
    expect(store.get(info.id)?.lastTurnAt).toBeDefined()

    // Transcript missing on disk.
    mockGetSessionInfo.mockResolvedValueOnce(undefined)

    await expect(sm.resume(info.id)).rejects.toThrow(/missing|ended/i)
    // markTranscriptMissing overwrote the reason to transcript_missing.
    expect(store.get(info.id)?.terminatedReason).toBe('transcript_missing')
  })

  it('resume() unloads and re-spawns a live transiently-terminated zombie (crash while server is running)', async () => {
    // The pump's cleanup tail sets terminated=true but does NOT unload, so a
    // crashed session lingers in the live map as a dead zombie. resume() must
    // NOT short-circuit return that zombie (which would advertise
    // canRetryResume but do nothing) — it must unload the zombie and fall
    // through to the store/disk path to actually re-spawn. This is the
    // live-crash case (server still running), distinct from the post-restart
    // dormant case covered above.
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    mockHandles[0].finish()
    await tick()
    // The session is now a LIVE zombie: still in the map, terminated:true,
    // transient reason 'query_ended' (pump natural end, no autoResume in tests).
    const zombie = sm.get(info.id)
    expect(zombie.terminated).toBe(true)
    expect(zombie.terminatedReason).toBe('query_ended')
    expect(zombie.canRetryResume).toBe(true)

    // Default mock → transcript exists on disk. resume() unloads the zombie
    // and re-spawns with `resume: id` on a fresh handle.
    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(resumed.terminated).toBe(false)
    expect(resumed.running).toBe(true)
    expect(mockHandles[1].options.resume).toBe(info.id)
    // The stale terminal state is cleared in the persisted meta.
    expect(store.get(info.id)?.terminated).toBe(false)
    expect(store.get(info.id)?.terminatedReason).toBeUndefined()
  })

  it('resume() preserves lastTurnAt so a second resume after going dormant still works', async () => {
    // Regression: spawn() used to drop lastTurnAt from the persisted meta
    // on resume (it carried gitStartSha/fastMode/hooks
    // forward but not lastTurnAt). writeStore() is a wholesale replace,
    // not a merge, so the first resume clobbered the on-disk lastTurnAt
    // back to undefined. A bare resume emits system/init but NO `result`,
    // so the pump (which only stamps lastTurnAt on a real result) never
    // re-stamped it. When the session then went dormant again WITHOUT a
    // new completed turn, the NEXT resume tripped the `!meta.lastTurnAt`
    // guard and threw "the first turn never completed", marking the
    // session terminated — so a session could be resumed exactly once.
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    // Complete a real turn so lastTurnAt is stamped + persisted.
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    await sm.unload(info.id)
    expect(store.get(info.id)?.lastTurnAt).toBeDefined()

    // First resume: must NOT clobber the persisted lastTurnAt. Before the
    // fix, writeStore(session) here overwrote it with undefined.
    const r1 = await sm.resume(info.id)
    expect(r1.id).toBe(info.id)
    expect(store.get(info.id)?.lastTurnAt).toBeDefined()
    // The resurrected live session carries lastTurnAt forward too.
    expect(sm.get(info.id).lastTurnAt).toBeDefined()

    // Go dormant again WITHOUT a new completed turn (no result emitted on
    // the resumed session).
    await sm.unload(info.id)

    // Second resume: before the fix this threw HttpError(410, "the first
    // turn never completed") and marked the session terminated.
    const r2 = await sm.resume(info.id)
    expect(r2.id).toBe(info.id)
    expect(r2.terminated).toBe(false)
    expect(r2.lastTurnAt).toBeDefined()
  })

  it('resume() respawns a fresh conversation for a turn-less session (e.g. only ran ! commands)', async () => {
    // A session that never completed a model turn has no SDK transcript
    // (the SDK only writes ~/.claude/projects/<id>.jsonl after the first
    // `result`). The common real case: the user only ran local `!`
    // commands, whose output never enters the SDK input queue. Before the
    // restructure this dead-ended as terminated:'no_data' ("the first turn
    // never completed") — a permanent dead end whose only "recovery" was
    // "create a new session", abandoning the id / cwd / grouping.
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    // No send / no result → lastTurnAt undefined, and (simulated) no
    // transcript on disk.
    await sm.unload(info.id)
    mockGetSessionInfo.mockResolvedValueOnce(undefined)

    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(resumed.terminated).toBe(false)
    expect(resumed.running).toBe(true)
    // A new Query was spawned — as a FRESH conversation (no `resume:`),
    // reusing the session id (not a new UUID) and the original config.
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBeUndefined()
    expect(mockHandles[1].options.sessionId).toBe(info.id)
    expect(mockHandles[1].options.cwd).toBe('/tmp')
    expect(mockHandles[1].options.model).toBe('m1')
  })

  it('resume() resumes normally when the transcript exists even if lastTurnAt was lost', async () => {
    // Regression for the pre-fix lastTurnAt-clobber bug's residual: a real
    // conversation whose persisted lastTurnAt got wiped to undefined (but
    // whose SDK transcript is intact on disk) must still RESUME — not
    // dead-end as terminated:'no_data'. The disk probe (hasSdkTranscript)
    // is ground truth; lastTurnAt is only a fallible proxy, so the guard
    // keys off the probe.
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    await sm.unload(info.id)
    expect(store.get(info.id)?.lastTurnAt).toBeDefined()

    // Simulate the clobber: wipe lastTurnAt from the persisted meta, exactly
    // as the pre-fix spawn()-drops-lastTurnAt bug did on the first resume.
    const clobbered = store.get(info.id)!
    store.upsert({ ...clobbered, lastTurnAt: undefined })
    // Default mock → transcript exists on disk (ground truth says resumable).

    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(resumed.terminated).toBe(false)
    // Resumed (resume: id), NOT respawned fresh.
    expect(mockHandles[1].options.resume).toBe(info.id)
    expect(mockHandles[1].options.sessionId).toBeUndefined()
  })

  it('setModel() updates the session and forwards to the Query', async () => {
    const info = sm.create({ model: 'old' })
    await sm.setModel(info.id, 'new-model')
    expect(mockHandles[0].setModel).toHaveBeenCalledWith('new-model')
    expect(sm.get(info.id).model).toBe('new-model')
  })

  it('setFastMode() records the intent and forwards applyFlagSettings({ fastMode }) to the Query', async () => {
    const info = sm.create({})
    expect(info.fastMode).toBeUndefined()
    const updated = await sm.setFastMode(info.id, true)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fastMode: true })
    expect(updated.fastMode).toBe(true)
    expect(sm.get(info.id).fastMode).toBe(true)
    await sm.setFastMode(info.id, false)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ fastMode: false })
    expect(sm.get(info.id).fastMode).toBe(false)
  })

  it('setFastMode() persists the intent so it survives resume', async () => {
    const info = sm.create({})
    await sm.setFastMode(info.id, true)
    await store.flush()
    expect(store.get(info.id)?.fastMode).toBe(true)
  })

  it('setEffortLevel() records the level and forwards applyFlagSettings({ effortLevel })', async () => {
    const info = sm.create({})
    expect(info.effortLevel).toBeUndefined()
    const updated = await sm.setEffortLevel(info.id, 'low')
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'low' })
    expect(updated.effortLevel).toBe('low')
    expect(sm.get(info.id).effortLevel).toBe('low')
  })

  it("setEffortLevel() forwards 'max' (Settings typedef omits it, but the API accepts it)", async () => {
    const info = sm.create({})
    const updated = await sm.setEffortLevel(info.id, 'max')
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'max' })
    expect(updated.effortLevel).toBe('max')
  })

  it('setEffortLevel() persists the level so it survives resume', async () => {
    const info = sm.create({})
    await sm.setEffortLevel(info.id, 'xhigh')
    await store.flush()
    expect(store.get(info.id)?.effortLevel).toBe('xhigh')
  })

  // --- auto-compact window (SDK Settings.autoCompactWindow via applyFlagSettings) ---

  it('setAutoCompactWindow() pins a positive token window and enables auto-compact', async () => {
    const info = sm.create({})
    expect(info.autoCompactWindow).toBeUndefined()
    const updated = await sm.setAutoCompactWindow(info.id, 180000)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      autoCompactWindow: 180000,
      autoCompactEnabled: true,
    })
    expect(updated.autoCompactWindow).toBe(180000)
    expect(sm.get(info.id).autoCompactWindow).toBe(180000)
  })

  it('setAutoCompactWindow() rounds fractional tokens', async () => {
    const info = sm.create({})
    const updated = await sm.setAutoCompactWindow(info.id, 180000.6)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      autoCompactWindow: 180001,
      autoCompactEnabled: true,
    })
    expect(updated.autoCompactWindow).toBe(180001)
  })

  it('setAutoCompactWindow() with null clears back to "auto"', async () => {
    const info = sm.create({})
    await sm.setAutoCompactWindow(info.id, 180000)
    expect(sm.get(info.id).autoCompactWindow).toBe(180000)
    const updated = await sm.setAutoCompactWindow(info.id, null)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({
      autoCompactWindow: null,
      autoCompactEnabled: null,
    })
    expect(updated.autoCompactWindow).toBeUndefined()
    expect(sm.get(info.id).autoCompactWindow).toBeUndefined()
  })

  it('setAutoCompactWindow() persists the window so it survives resume', async () => {
    const info = sm.create({})
    await sm.setAutoCompactWindow(info.id, 100000)
    await store.flush()
    expect(store.get(info.id)?.autoCompactWindow).toBe(100000)
  })

  // --- thinking config (Options.thinking at spawn + setMaxThinkingTokens live) ---

  it("setThinking() maps adaptive → null and forwards setMaxThinkingTokens(null, undefined) — absent display keeps the current mode", async () => {
    const info = sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'adaptive' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(null, undefined)
    expect(updated.thinking).toEqual({ type: 'adaptive' })
    expect(sm.get(info.id).thinking).toEqual({ type: 'adaptive' })
  })

  it("setThinking() maps disabled → (0, undefined)", async () => {
    const info = sm.create({})
    await sm.setThinking(info.id, { type: 'disabled' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(0, undefined)
  })

  it("setThinking() maps enabled N → (N, undefined)", async () => {
    const info = sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'enabled', budgetTokens: 16384 })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(16384, undefined)
    expect(updated.thinking).toEqual({ type: 'enabled', budgetTokens: 16384 })
  })

  it("setThinking() clears the display back to the API default only via the explicit clearDisplay opt", async () => {
    const info = sm.create({})
    await sm.setThinking(info.id, { type: 'adaptive' }, { clearDisplay: true })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenLastCalledWith(null, null)
  })

  it("setThinking() forwards display as the 2nd param", async () => {
    const info = sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'adaptive', display: 'omitted' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(null, 'omitted')
    expect(updated.thinking).toEqual({ type: 'adaptive', display: 'omitted' })

    await sm.setThinking(info.id, { type: 'enabled', budgetTokens: 8192, display: 'summarized' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(8192, 'summarized')
    expect(sm.get(info.id).thinking).toEqual({ type: 'enabled', budgetTokens: 8192, display: 'summarized' })
  })

  it('setThinking() persists display so it survives resume', async () => {
    const info = sm.create({})
    await sm.setThinking(info.id, { type: 'adaptive', display: 'omitted' })
    await store.flush()
    expect(store.get(info.id)?.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
  })

  it("setThinking() 400s on enabled-without-budget (not expressible via setMaxThinkingTokens)", async () => {
    const info = sm.create({})
    await expect(sm.setThinking(info.id, { type: 'enabled' })).rejects.toThrow('budgetTokens')
    expect(mockHandles[0].setMaxThinkingTokens).not.toHaveBeenCalled()
  })

  it('setThinking() persists the setting so it survives resume', async () => {
    const info = sm.create({})
    await sm.setThinking(info.id, { type: 'disabled' })
    await store.flush()
    expect(store.get(info.id)?.thinking).toEqual({ type: 'disabled' })
  })

  it('create({ thinking }) forwards Options.thinking to the SDK and records it', async () => {
    const info = sm.create({ thinking: { type: 'enabled', budgetTokens: 8192 } } as unknown as Parameters<typeof sm.create>[0])
    expect(mockHandles[0].options.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
    expect(info.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
  })

  it('fork() carries the thinking config onto the new session', async () => {
    const source = sm.create({})
    await sm.setThinking(source.id, { type: 'enabled', budgetTokens: 4096 })
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    const forked = await sm.fork(source.id)
    expect(forked.thinking).toEqual({ type: 'enabled', budgetTokens: 4096 })
    // Thinking is a spawn-time Options key — the fork's fresh Query must have
    // received it directly (no post-spawn applyFlagSettings needed).
    expect(mockHandles[1].options.thinking).toEqual({ type: 'enabled', budgetTokens: 4096 })
  })

  it('thinkingSupported is classified from the model id at spawn', async () => {
    const opus = sm.create({ model: 'claude-opus-4-8' })
    expect(sm.get(opus.id).thinkingSupported).toBe(true)
    expect(opus.thinkingSupported).toBe(true)
    const haiku = sm.create({ model: 'claude-haiku-4-5' })
    expect(haiku.thinkingSupported).toBe(false)
    const other = sm.create({ model: 'deepseek/deepseek-v4-pro' })
    expect(other.thinkingSupported).toBe(false)
  })

  it('setModel() recomputes thinkingSupported for the new model', async () => {
    const info = sm.create({ model: 'claude-opus-4-8' })
    expect(sm.get(info.id).thinkingSupported).toBe(true)
    const updated = await sm.setModel(info.id, 'deepseek/deepseek-v4-pro')
    expect(updated.thinkingSupported).toBe(false)
    await sm.setModel(info.id, 'claude-sonnet-4-6')
    expect(sm.get(info.id).thinkingSupported).toBe(true)
  })

  // --- accountInfo (SDK accountInfo control read) ---

  it('accountInfo() forwards the control request and narrows the raw response', async () => {
    const info = sm.create({})
    mockHandles[0].accountInfo.mockResolvedValueOnce({
      email: 'user@example.com',
      organization: 'Acme',
      subscriptionType: 'max',
      tokenSource: 'oauth',
      apiKeySource: '',
      apiProvider: 'firstParty',
      junk: 'dropped',
    })
    const account = await sm.accountInfo(info.id)
    expect(mockHandles[0].accountInfo).toHaveBeenCalled()
    expect(account).toEqual({
      email: 'user@example.com',
      organization: 'Acme',
      subscriptionType: 'max',
      tokenSource: 'oauth',
      apiProvider: 'firstParty',
    })
  })

  it('accountInfo() collapses a malformed / empty response to undefined', async () => {
    const info = sm.create({})
    mockHandles[0].accountInfo.mockResolvedValueOnce({ email: '  ', apiProvider: 'not-a-provider' })
    expect(await sm.accountInfo(info.id)).toBeUndefined()
    mockHandles[0].accountInfo.mockResolvedValueOnce(null)
    expect(await sm.accountInfo(info.id)).toBeUndefined()
  })

  it('accountInfo() 404s for an unknown session', async () => {
    await expect(sm.accountInfo('nope')).rejects.toThrow()
  })

  // --- rewindFiles (SDK file-checkpoint rewind) ---

  it('rewindFiles() maps the app uuid to the paired SDK uuid and narrows the result', async () => {
    const info = sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    // The SDK echoes the persisted prompt back with its on-disk uuid —
    // the pump hands that to onPromptEcho, which pairs u → v.
    mockHandles[0].emit({ type: 'user', message: { role: 'user', content: 'edit a file' }, parent_tool_use_id: null, uuid: 'sdk-v-1' })
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    mockHandles[0].rewindFiles.mockResolvedValueOnce({
      canRewind: true,
      filesChanged: ['a.ts', ''],
      insertions: 2,
      deletions: 'x',
      junk: 'dropped',
    })
    const res = await sm.rewindFiles(info.id, sent.uuid!, { dryRun: true })
    expect(mockHandles[0].rewindFiles).toHaveBeenCalledWith('sdk-v-1', { dryRun: true })
    expect(res).toEqual({ canRewind: true, filesChanged: ['a.ts'], insertions: 2 })
  })

  it('rewindFiles() collapses a malformed SDK response to a safe error result', async () => {
    const info = sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    mockHandles[0].emit({ type: 'user', message: { role: 'user', content: 'edit a file' }, parent_tool_use_id: null, uuid: 'sdk-v-2' })
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    mockHandles[0].rewindFiles.mockResolvedValueOnce('garbage')
    expect(await sm.rewindFiles(info.id, sent.uuid!)).toEqual({
      canRewind: false,
      error: 'malformed rewind response',
    })
  })

  it('rewindFiles() 400s when the message has no paired SDK uuid yet', async () => {
    const info = sm.create({})
    const sent = sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    await expect(sm.rewindFiles(info.id, sent.uuid!)).rejects.toThrow('checkpoint target')
    expect(mockHandles[0].rewindFiles).not.toHaveBeenCalled()
  })

  it('rewindFiles() 409s while the session is working', async () => {
    const info = sm.create({})
    const sent = sm.send(info.id, 'hi') // pendingTurns=1 → phase 'working'
    await expect(sm.rewindFiles(info.id, sent.uuid!)).rejects.toThrow('working')
    expect(mockHandles[0].rewindFiles).not.toHaveBeenCalled()
  })

  it('rewindFiles() broadcasts a git-status refresh after a real rewind (not a dry run)', async () => {
    const bcast = vi.spyOn(sm, 'broadcastGitStatusChanged').mockImplementation(() => {})
    const info = sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    mockHandles[0].emit({ type: 'user', message: { role: 'user', content: 'edit a file' }, parent_tool_use_id: null, uuid: 'sdk-v-3' })
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    mockHandles[0].rewindFiles.mockResolvedValueOnce({ canRewind: true })
    await sm.rewindFiles(info.id, sent.uuid!, { dryRun: true })
    expect(bcast).not.toHaveBeenCalled()
    await sm.rewindFiles(info.id, sent.uuid!)
    expect(bcast).toHaveBeenCalledWith(info.id)
    bcast.mockRestore()
  })

  it('autoGenerateTitle persists a generated title on an untitled session, exactly once', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const handle = mockHandles[mockHandles.length - 1]
    const titled = await sm.autoGenerateTitle(info.id, 'Refactor the checkout flow')
    expect(titled.title).toBe('Mock auto title')
    expect(handle.generateSessionTitle).toHaveBeenCalledWith('Refactor the checkout flow', { persist: true })
    // Second call is a no-op: the title is already set.
    const again = await sm.autoGenerateTitle(info.id, 'whatever')
    expect(again.title).toBe('Mock auto title')
    expect(handle.generateSessionTitle).toHaveBeenCalledTimes(1)
  })

  it('autoGenerateTitle never overwrites a user-named session', async () => {
    const info = sm.create({ cwd: '/tmp', title: 'My session' })
    const handle = mockHandles[mockHandles.length - 1]
    const titled = await sm.autoGenerateTitle(info.id, 'should be ignored')
    expect(titled.title).toBe('My session')
    expect(handle.generateSessionTitle).not.toHaveBeenCalled()
  })

  it('setMemorySettings() forwards only present keys and records them on the session', async () => {
    const info = sm.create({})
    expect(info.memory).toBeUndefined()
    const updated = await sm.setMemorySettings(info.id, { autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      autoMemoryEnabled: true,
      autoMemoryDirectory: '~/mem',
    })
    expect(updated.memory).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
    expect(sm.get(info.id).memory).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
  })

  it('setMemorySettings() treats an empty partial as a no-op', async () => {
    const info = sm.create({})
    const updated = await sm.setMemorySettings(info.id, {})
    expect(mockHandles[0].applyFlagSettings).not.toHaveBeenCalled()
    expect(updated.memory).toBeUndefined()
  })

  it('setMemorySettings() null clears a key; clearing the last key drops the object', async () => {
    const info = sm.create({})
    await sm.setMemorySettings(info.id, { autoMemoryEnabled: true })
    await sm.setMemorySettings(info.id, { autoMemoryEnabled: null })
    // null forwards to the SDK so the flag tier clears too.
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ autoMemoryEnabled: null })
    expect(sm.get(info.id).memory).toBeUndefined()
  })

  it('setMemorySettings() forwards a trimmed directory and null-normalises whitespace-only', async () => {
    const info = sm.create({})
    await sm.setMemorySettings(info.id, { autoMemoryDirectory: '  ~/mem  ' })
    // The SDK must see the trimmed value — matching what gets recorded.
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ autoMemoryDirectory: '~/mem' })
    expect(sm.get(info.id).memory).toEqual({ autoMemoryDirectory: '~/mem' })

    // A whitespace-only directory forwards as null (clear), not a literal " "
    // dir — the SDK's view and the persisted record must agree.
    await sm.setMemorySettings(info.id, { autoMemoryDirectory: '   ' })
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ autoMemoryDirectory: null })
    expect(sm.get(info.id).memory).toBeUndefined()
  })

  it('setMemorySettings() persists the intent so it survives resume', async () => {
    const info = sm.create({})
    await sm.setMemorySettings(info.id, { autoMemoryEnabled: true, autoDreamEnabled: false })
    await store.flush()
    expect(store.get(info.id)?.memory).toEqual({ autoMemoryEnabled: true, autoDreamEnabled: false })
  })

  it('create({ memory }) seeds the session intent and re-applies it at spawn', async () => {
    // `memory` is an app-level create-body field (not an SDK Options key), so
    // cast through unknown the same way the route does.
    const info = sm.create({ memory: { autoMemoryEnabled: true } } as unknown as Parameters<typeof sm.create>[0])
    expect(info.memory).toEqual({ autoMemoryEnabled: true })
    // The provider re-applies the intent post-spawn (spawn-time values are
    // never null — nulls only arrive via the live route).
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ autoMemoryEnabled: true })
    // And the app-level field must NOT leak into the SDK Options.
    expect(mockHandles[0].options.memory).toBeUndefined()
  })

  it('fork() carries the auto-memory intent onto the new session', async () => {
    const source = sm.create({})
    await sm.setMemorySettings(source.id, { autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    const forked = await sm.fork(source.id)
    expect(forked.memory).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
    expect(mockHandles[1].applyFlagSettings).toHaveBeenCalledWith({
      autoMemoryEnabled: true,
      autoMemoryDirectory: '~/mem',
    })
  })

  it('applyHooks() forwards, records, and persists structured hooks', async () => {
    const info = sm.create({})
    const hooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'echo ok' }] }],
    }

    const result = await sm.applyHooks(info.id, hooks)

    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ hooks })
    expect(result.hooks).toEqual(hooks)
    expect(sm.getHooks(info.id).hooks).toEqual(hooks)
    await store.flush()
    expect(store.get(info.id)?.hooks).toEqual(hooks)
  })

  it('applySettings() validates raw hooks and persists them only after SDK success', async () => {
    const info = sm.create({})
    const hooks = {
      Notification: [{ hooks: [{ type: 'http' as const, url: 'https://example.com/hook' }] }],
    }

    await sm.applySettings(info.id, { hooks } as never)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ hooks })
    expect(store.get(info.id)?.hooks).toEqual(hooks)

    mockHandles[0].applyFlagSettings.mockRejectedValueOnce(new Error('SDK failed'))
    await expect(sm.applySettings(info.id, { hooks: {} } as never)).rejects.toThrow('SDK failed')
    expect(store.get(info.id)?.hooks).toEqual(hooks)
  })

  // --- effort capability (effortLevels three-state) ---
  // Capability is now classified by model-id keyword (effortLevelsForModel),
  // NOT the SDK's supportedModels (which on gateways reports unmatched
  // aliases and claims every model supports effort). We exercise it through
  // setModel and read the projected SessionInfo (synchronous now).

  it('effortLevels is the full 5 for an opus-family id (provider prefix tolerated)', async () => {
    const info = sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'ppio/pa/claude-opus-4-8')
    expect(sm.get(info.id).effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('effortLevels omits xhigh for a sonnet-family id', async () => {
    const info = sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'anthropic/claude-sonnet-4-20250514')
    expect(sm.get(info.id).effortLevels).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('effortLevels is [] for haiku (no effort support → chip hidden)', async () => {
    const info = sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'claude-haiku-3-5-20241022')
    expect(sm.get(info.id).effortLevels).toEqual([])
  })

  it('effortLevels is [] for a non-Claude model (chip hidden)', async () => {
    const info = sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'xiaomi/mimo-v2.5-pro')
    expect(sm.get(info.id).effortLevels).toEqual([])
  })

  it('rename() updates title on a live session', () => {
    const info = sm.create({ title: 'before' })
    const updated = sm.rename(info.id, 'after')
    expect(updated.title).toBe('after')
    expect(sm.get(info.id).title).toBe('after')
  })

  it('rename() updates title on a dormant session', async () => {
    const info = sm.create({ title: 'alive' })
    await sm.unload(info.id)
    const updated = sm.rename(info.id, 'dormant-renamed')
    expect(updated.title).toBe('dormant-renamed')
    await store.flush()
    expect(store.get(info.id)?.title).toBe('dormant-renamed')
  })

  it('rename() with blank string clears the title', () => {
    const info = sm.create({ title: 'keep me' })
    const updated = sm.rename(info.id, '   ')
    expect(updated.title).toBeUndefined()
  })

  it('setPermissionMode() to a non-plan mode forwards "default" to the SDK (canUseTool owns it)', async () => {
    const info = sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'acceptEdits')
    expect(sm.get(info.id).permissionMode).toBe('acceptEdits')
    // Only `plan` forwards a real mode; every other mode forwards 'default'
    // so the SDK has no read-only lock and canUseTool stays authoritative.
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('default')
  })

  it('setPermissionMode() to plan forwards "plan" to the SDK (read-only steering)', async () => {
    const info = sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'plan')
    expect(sm.get(info.id).permissionMode).toBe('plan')
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('plan')
  })

  it('setPermissionMode() OUT of plan forwards "default" to release the SDK lock', async () => {
    const info = sm.create({ permissionMode: 'plan' })
    await sm.setPermissionMode(info.id, 'acceptEdits')
    // Switching away from plan must send 'default' to disengage the SDK's
    // read-only lock, otherwise the model stays stuck unable to edit.
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('default')
  })

  it('setPermissionMode() never fails even if the SDK control request throws', async () => {
    const info = sm.create({ permissionMode: 'default' })
    mockHandles[0].setPermissionMode.mockRejectedValueOnce(new Error('SDK boom'))
    const updated = await sm.setPermissionMode(info.id, 'bypassPermissions')
    expect(updated.permissionMode).toBe('bypassPermissions')
    expect(sm.get(info.id).permissionMode).toBe('bypassPermissions')
  })

  it('spawn forwards only plan to the SDK options; other modes map to undefined', () => {
    sm.create({ permissionMode: 'acceptEdits' })
    expect(mockHandles[0].options.permissionMode).toBeUndefined()

    sm.create({ permissionMode: 'plan' })
    expect(mockHandles[1].options.permissionMode).toBe('plan')
  })

  it('fork() spawns a new session with resume=sourceId + forkSession=true', async () => {
    const source = sm.create({ cwd: '/tmp', model: 'm1', permissionMode: 'default', title: 'parent' })
    // The SDK only writes its conversation log after the first completed
    // turn. Simulate one so the fork guard allows the call.
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    const forked = await sm.fork(source.id)
    expect(forked.id).not.toBe(source.id)
    expect(mockHandles).toHaveLength(2)
    // The forked Query's options must carry the resume + forkSession combo;
    // cwd/model should be inherited, and title suffixed to disambiguate.
    expect(mockHandles[1].options.resume).toBe(source.id)
    expect(mockHandles[1].options.forkSession).toBe(true)
    expect(mockHandles[1].options.cwd).toBe('/tmp')
    expect(mockHandles[1].options.model).toBe('m1')
    expect(forked.title).toBe('parent (fork)')
    // The fork pins the SDK session_id to the fork's fresh id (allowed by the
    // SDK only because forkSession is set alongside resume). This makes the
    // fork's transcript land at <forkedId>.jsonl instead of an SDK-chosen
    // name that our id would never match.
    expect(mockHandles[1].options.sessionId).toBe(forked.id)
  })

  it('fork() works on dormant (unloaded) sessions too', async () => {
    const source = sm.create({ title: 'dormant-source' })
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(source.id)
    const forked = await sm.fork(source.id)
    expect(forked.id).not.toBe(source.id)
    // sm now has 1 live session (the original was unloaded; fork is new).
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBe(source.id)
  })

  it('fork() broadcasts a created event for the new session', async () => {
    const source = sm.create({})
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    // Subscribe *after* the result has been processed — this way the
    // stream starts fresh and the first fork-triggered event is
    // unambiguously the new session's `created`, with no leftover
    // send/result update noise ahead of it.
    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    const forked = await sm.fork(source.id)
    const next = await it.next()
    expect(next.done).toBe(false)
    expect(next.value).toMatchObject({ kind: 'created', session: { id: forked.id } })
    // fork tags Y with joinGroupOf (X stays in the group) but NOT
    // evictingSource — the client must keep enforcing maxGroupSize for fork.
    expect(next.value).toMatchObject({ joinGroupOf: source.id })
    expect(next.value).not.toHaveProperty('evictingSource')
    sub.unsubscribe()
  })

  it('fork({ replacesSource: true }) broadcasts created tagged replacesSource (crash-recovery fork)', async () => {
    const source = sm.create({})
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    const forked = await sm.fork(source.id, { replacesSource: true })
    const next = await it.next()
    expect(next.done).toBe(false)
    expect(next.value).toMatchObject({ kind: 'created', session: { id: forked.id } })
    // A crash-recovery fork REPLACES the dead source X, so the created
    // broadcast carries replacesSource — but NOT evictingSource (which is
    // the /clear/restart eviction signal; here X is terminated, not evicted).
    expect(next.value).toMatchObject({ joinGroupOf: source.id, replacesSource: true })
    expect(next.value).not.toHaveProperty('evictingSource')
    sub.unsubscribe()
  })

  it('fork({ forkFromLastSafe: true }) resolves resumeSessionAt to the newest completed turn', async () => {
    const source = sm.create({})
    sm.send(source.id, 'hi')
    // Complete one real turn so the fork() lastTurnAt guard passes.
    mockHandles[0].emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } })
    mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: source.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
    // Poll for the pump's asst-1 anchor to land (it appends fire-and-forget).
    const smAny = sm as unknown as {
      turnAnchorStore: {
        load: (id: string) => Promise<Array<{ assistantUuid: string; completedAt: number }> | null>
        save: (id: string, entries: Array<{ assistantUuid: string; completedAt: number }>) => Promise<void>
      }
    }
    for (let i = 0; i < 30 && ((await smAny.turnAnchorStore.load(source.id)) ?? []).length === 0; i++) await tick()
    // Now seed TWO anchors deterministically (newest = asst-2) so "pick the
    // newest completed turn" is exercised against two distinct points — the
    // crash-recovery "Fork from last completed turn" button drops any
    // poisonous trailing turn (no result) by anchoring at the newest
    // successful one.
    await smAny.turnAnchorStore.save(source.id, [
      { assistantUuid: 'asst-1', completedAt: 1 },
      { assistantUuid: 'asst-2', completedAt: 2 },
    ])

    const forked = await sm.fork(source.id, { forkFromLastSafe: true })
    expect(forked.id).not.toBe(source.id)
    const opts = mockHandles.at(-1)!.options
    expect(opts.resume).toBe(source.id)
    expect(opts.forkSession).toBe(true)
    expect(opts.resumeSessionAt).toBe('asst-2')
  })

  it('fork({ forkFromLastSafe: true, replacesSource: true }) broadcasts created tagged replacesSource', async () => {
    const source = sm.create({})
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
    mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: source.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
    // Poll for the anchor to land (pump appends fire-and-forget) so
    // forkFromLastSafe finds a completed turn to anchor on.
    const smAny = sm as unknown as { turnAnchorStore: { load: (id: string) => Promise<Array<{ assistantUuid: string }> | null> } }
    for (let i = 0; i < 30 && ((await smAny.turnAnchorStore.load(source.id)) ?? []).length === 0; i++) await tick()

    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    const forked = await sm.fork(source.id, { forkFromLastSafe: true, replacesSource: true })
    const next = await it.next()
    expect(next.done).toBe(false)
    expect(next.value).toMatchObject({ kind: 'created', session: { id: forked.id } })
    expect(next.value).toMatchObject({ joinGroupOf: source.id, replacesSource: true })
    expect(next.value).not.toHaveProperty('evictingSource')
    sub.unsubscribe()
  })

  it('fork({ forkFromLastSafe: true }) still refuses a source with no completed turn', async () => {
    const source = sm.create({ title: 'fresh' })
    // The lastTurnAt guard fires first: no result was ever emitted, so there
    // is no completed turn (and no anchor) to fork from. Same 400 as the
    // base path — forkFromLastSafe does not bypass it.
    await expect(sm.fork(source.id, { forkFromLastSafe: true })).rejects.toThrow(/no completed turns yet/i)
    expect(mockHandles).toHaveLength(1)
  })

  it('clear() broadcasts a created event for the fresh session tagged with joinGroupOf + evictingSource', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    const next = await sm.clear(info.id)
    const ev = await it.next()
    expect(ev.done).toBe(false)
    expect(ev.value).toMatchObject({ kind: 'created', session: { id: next.id } })
    // clear() evicts X, so Y's created broadcast carries both joinGroupOf
    // (so Y lands in X's group) and evictingSource (so the client bypasses
    // its maxGroupSize cap — no "Ungrouped" flash on a full group).
    expect(ev.value).toMatchObject({ joinGroupOf: info.id, evictingSource: true })
    sub.unsubscribe()
  })

  it('fork() refuses a source with no completed turns (avoids SDK "No conversation found" error)', async () => {
    const source = sm.create({ title: 'fresh' })
    // No send → no result → no jsonl on disk. Fork should throw with a
    // 400 (user-actionable) rather than letting the SDK blow up later
    // with a cryptic "No conversation found with session ID: <uuid>".
    await expect(sm.fork(source.id)).rejects.toThrow(/no completed turns yet/i)
    // No extra Query was spawned.
    expect(mockHandles).toHaveLength(1)
  })

  it('fork() refuses a dormant source that never completed a turn', async () => {
    const source = sm.create({ title: 'fresh-dormant' })
    await sm.unload(source.id)
    await expect(sm.fork(source.id)).rejects.toThrow(/no completed turns yet/i)
  })

  it('fork() refuses when the SDK transcript file is missing on disk', async () => {
    const source = sm.create({ cwd: '/tmp', title: 'orphan-fork' })
    // Complete a turn so the lastTurnAt guard passes — we want this test
    // to land squarely on the on-disk-probe guard, not the in-memory one.
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    // Simulate the SDK's jsonl having been deleted out from under us.
    mockGetSessionInfo.mockResolvedValueOnce(undefined)
    // Watch the global stream for the dim-it-now `update` event.
    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    await expect(sm.fork(source.id)).rejects.toThrow(/transcript file is missing/i)
    expect(mockHandles).toHaveLength(1) // no doomed Query was spawned
    // Source is now flagged terminated with the new reason so the UI
    // dims it instead of inviting another fork attempt.
    const next = await it.next()
    expect(next.value).toMatchObject({
      kind: 'update',
      session: { id: source.id, terminated: true, terminatedReason: 'transcript_missing' },
    })
    sub.unsubscribe()
  })

  it('resume() refuses when the SDK transcript file is missing on disk', async () => {
    const info = sm.create({ cwd: '/tmp', title: 'orphan-resume' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    mockGetSessionInfo.mockResolvedValueOnce(undefined)
    await expect(sm.resume(info.id)).rejects.toThrow(/transcript file is missing/i)
    // No second Query was spawned (only the original create + initial spawn).
    expect(mockHandles).toHaveLength(1)
    // Persisted meta now reflects the missing-transcript state.
    await store.flush()
    expect(store.get(info.id)?.terminated).toBe(true)
    expect(store.get(info.id)?.terminatedReason).toBe('transcript_missing')
  })

  describe('createSideChat (fork-boundary history filtering)', () => {
    // The fork copies the parent's transcript verbatim into the Side Chat's
    // on-disk jsonl, then appends the Side Chat's own messages. Without a
    // boundary, loadOlder / resume-seed / search would page the inherited
    // parent prefix back into the Side Chat UI. createSideChat captures the
    // parent's newest renderable message uuid as `forkBoundaryUuid` and every
    // history read passes it as `afterUuid` so only the Side Chat's own
    // messages surface.
    it('captures the parent tail uuid as forkBoundaryUuid and excludes the inherited prefix from getHistoryPage', async () => {
      const parent = sm.create({ cwd: '/tmp', title: 'parent' })
      // Complete a turn so the parent has a transcript (hasSdkTranscript probe
      // — mocked getSessionInfo returns truthy by default).
      sm.send(parent.id, 'hi')
      mockHandles[0].emit({ type: 'result' })
      await tick()

      // Simulated on-disk transcripts. The parent's file holds its own two
      // messages; the Side Chat's file (fork copy + own turns) holds all four.
      const uParent = { uuid: 'u-parent' }
      const aParent = { uuid: 'a-parent' }
      const uSide = { uuid: 'u-side' }
      const aSide = { uuid: 'a-side' }
      const parentTranscript = [uParent, aParent]
      const sideTranscript = [uParent, aParent, uSide, aSide]

      const readPage = vi.spyOn(
        sm as unknown as { readProviderHistoryPage: (provider: unknown, id: string, opts: { limit: number; afterUuid?: string }) => Promise<unknown> },
        'readProviderHistoryPage',
      ).mockImplementation(async (_provider: unknown, id: string, opts: { limit: number; afterUuid?: string }) => {
        if (id === parent.id) {
          // createSideChat asks for the parent's newest renderable message.
          const tail = parentTranscript[parentTranscript.length - 1]
          return { messages: [tail], totalCount: parentTranscript.length, startIndex: parentTranscript.length - 1, hasMore: false }
        }
        // Side Chat read. Without the boundary the full inherited prefix would
        // surface; with afterUuid === 'a-parent' only the Side Chat's own
        // messages (those strictly after the boundary) should remain.
        if (opts.afterUuid === 'a-parent') {
          return { messages: [uSide, aSide], totalCount: 2, startIndex: 0, hasMore: false }
        }
        return { messages: sideTranscript, totalCount: sideTranscript.length, startIndex: 0, hasMore: false }
      })

      const side = await sm.createSideChat(parent.id)
      expect(side.parentId).toBe(parent.id)
      // The boundary was captured from the parent's newest message.
      expect(readPage).toHaveBeenCalledWith(expect.anything(), parent.id, { limit: 1 })
      const liveSide = (sm as unknown as { sessions: Map<string, { forkBoundaryUuid?: string }> }).sessions.get(side.id)
      expect(liveSide?.forkBoundaryUuid).toBe('a-parent')

      // getHistoryPage must forward afterUuid so the inherited prefix stays
      // out of the Side Chat UI.
      const page = await sm.getHistoryPage(side.id, { limit: 200 })
      expect((page.messages as Array<{ uuid?: string }>).map((m) => m.uuid)).toEqual(['u-side', 'a-side'])
      expect(readPage).toHaveBeenCalledWith(expect.anything(), side.id, expect.objectContaining({ afterUuid: 'a-parent' }))

      readPage.mockRestore()
    })

    it('persists forkBoundaryUuid so a dormant Side Chat still filters after resume', async () => {
      const parent = sm.create({ cwd: '/tmp', title: 'parent' })
      sm.send(parent.id, 'hi')
      mockHandles[0].emit({ type: 'result' })
      await tick()

      const aParent = { uuid: 'a-parent' }
      const uSide = { uuid: 'u-side' }
      const aSide = { uuid: 'a-side' }
      const readPage = vi.spyOn(
        sm as unknown as { readProviderHistoryPage: (provider: unknown, id: string, opts: { limit: number; afterUuid?: string }) => Promise<unknown> },
        'readProviderHistoryPage',
      ).mockImplementation(async (_provider: unknown, id: string, opts: { limit: number; afterUuid?: string }) => {
        if (id === parent.id) return { messages: [aParent], totalCount: 1, startIndex: 0, hasMore: false }
        // Any read of the Side Chat (resume seed included) must carry the boundary.
        if (opts.afterUuid === 'a-parent') return { messages: [uSide, aSide], totalCount: 2, startIndex: 0, hasMore: false }
        return { messages: [aParent, uSide, aSide], totalCount: 3, startIndex: 0, hasMore: false }
      })

      const side = await sm.createSideChat(parent.id)
      await sm.unload(side.id)
      // Persisted meta carries the boundary across the dormancy boundary.
      await store.flush()
      expect(store.get(side.id)?.forkBoundaryUuid).toBe('a-parent')
      readPage.mockRestore()
    })
  })

  it('canUseTool short-circuits when permissionMode is bypassPermissions', async () => {
    const info = sm.create({})
    await sm.setPermissionMode(info.id, 'bypassPermissions')
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string }>
    const ctrl = new AbortController()
    const res = await canUseTool(
      'Bash',
      { command: 'echo hi' },
      { signal: ctrl.signal, toolUseID: 'tu-bypass' },
    )
    expect(res.behavior).toBe('allow')
    // No pending permission should be queued — the callback resolved
    // immediately rather than parking for user input.
    expect(sm.listPending(info.id)).toHaveLength(0)
  })

  // --- AskUserQuestion interactive flow ---
  //
  // The SDK routes AskUserQuestion through canUseTool just like any other
  // tool. We intercept the 'AskUserQuestion' toolName specifically and
  // park a pending question instead of a permission. The user's answer
  // resolves the SDK's promise as `deny` with a JSON `message` — that's
  // the only way to fully override the SDK's built-in placeholder
  // handler (verified against SDK 2.1.133 with PreToolUse/PostToolUse;
  // neither hook path actually short-circuits the built-in handler).

  it('canUseTool parks an AskUserQuestion as a pending question (kind=question)', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>
    const ctrl = new AbortController()
    void canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            multiSelect: false,
            options: [
              { label: 'red', description: 'like fire' },
              { label: 'blue', description: 'like sky' },
            ],
          },
          {
            question: 'Pick languages',
            header: 'Langs',
            multiSelect: true,
            options: [
              { label: 'english' },
              { label: 'chinese' },
              { label: 'spanish' },
            ],
          },
        ],
      },
      { signal: ctrl.signal, toolUseID: 'tu-question-1' },
    )
    await tick()
    const pending = sm.listPending(info.id)
    expect(pending).toHaveLength(1)
    const head = pending[0]
    if (head.kind !== 'question') throw new Error('expected question kind')
    expect(head.toolName).toBe('AskUserQuestion')
    expect(head.questions).toHaveLength(2)
    expect(head.questions[0].options.map((o) => o.label)).toEqual(['red', 'blue'])
    expect(head.questions[1].multiSelect).toBe(true)
  })

  it('answerQuestion resolves the SDK promise with a deny + JSON message payload', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string; message?: string; interrupt?: boolean; toolUseID?: string }>
    const ctrl = new AbortController()
    const promise = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which language?',
            options: [{ label: 'english' }, { label: 'chinese' }],
          },
          {
            question: 'Which frameworks?',
            multiSelect: true,
            options: [{ label: 'react' }, { label: 'vue' }, { label: 'svelte' }],
          },
        ],
      },
      { signal: ctrl.signal, toolUseID: 'tu-question-2' },
    )
    await tick()
    const pid = sm.listPending(info.id)[0].id
    sm.answerQuestion(info.id, pid, ['chinese', ['react', 'svelte']])
    const resolved = await promise
    expect(resolved.behavior).toBe('deny')
    expect((resolved as { interrupt?: boolean }).interrupt).toBe(false)
    expect(resolved.toolUseID).toBe('tu-question-2')
    // The message body is the JSON the model reads as tool_result.
    const parsed = JSON.parse(resolved.message!)
    expect(parsed.answers).toEqual([
      { question: 'Which language?', answer: 'chinese' },
      { question: 'Which frameworks?', answer: ['react', 'svelte'] },
    ])
    // Pending cleared on answer.
    expect(sm.listPending(info.id)).toHaveLength(0)
  })

  it('answerQuestion encodes skipped questions as null', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string; message?: string }>
    const ctrl = new AbortController()
    const promise = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          { question: 'Pick a fruit', options: [{ label: 'apple' }, { label: 'banana' }] },
          { question: 'Pick a number', options: [{ label: '1' }, { label: '2' }] },
        ],
      },
      { signal: ctrl.signal, toolUseID: 'tu-skip' },
    )
    await tick()
    const pid = sm.listPending(info.id)[0].id
    sm.answerQuestion(info.id, pid, ['apple', null])
    const resolved = await promise
    const parsed = JSON.parse(resolved.message!)
    expect(parsed.answers).toEqual([
      { question: 'Pick a fruit', answer: 'apple' },
      { question: 'Pick a number', answer: null },
    ])
  })

  it('decide refuses to act on a pending question', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>
    const ctrl = new AbortController()
    void canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'x', options: [{ label: 'y' }] }] },
      { signal: ctrl.signal, toolUseID: 'tu-decide-guard' },
    )
    await tick()
    const pid = sm.listPending(info.id)[0].id
    // decide() is async now (it may switch permission mode after a plan
    // approval), so the broker's synchronous throw surfaces as a rejection.
    await expect(sm.decide(info.id, pid, { behavior: 'deny' })).rejects.toThrow(
      /interactive question/i,
    )
  })

  it('answerQuestion refuses to act on a pending permission', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>
    const ctrl = new AbortController()
    void canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: ctrl.signal, toolUseID: 'tu-answer-guard' },
    )
    await tick()
    const pid = sm.listPending(info.id)[0].id
    expect(() => sm.answerQuestion(info.id, pid, [null])).toThrow(
      /not an interactive question/i,
    )
  })

  it('approving an ExitPlanMode plan switches the session to the chosen execution mode', async () => {
    const info = sm.create({ permissionMode: 'plan' })
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>
    const ctrl = new AbortController()
    void canUseTool(
      'ExitPlanMode',
      { plan: 'do the thing' },
      { signal: ctrl.signal, toolUseID: 'tu-plan' },
    )
    await tick()
    const pid = sm.listPending(info.id)[0].id
    await sm.decide(info.id, pid, { behavior: 'allow', planTargetMode: 'acceptEdits' })
    // Session left plan mode and landed in the chosen execution mode.
    expect(sm.get(info.id).permissionMode).toBe('acceptEdits')
    // And the SDK was told to release the plan lock (forward 'default' for the
    // non-plan target).
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('default')
  })

  it('approving an ExitPlanMode plan with no target defaults to "default" mode', async () => {
    const info = sm.create({ permissionMode: 'plan' })
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>
    const ctrl = new AbortController()
    void canUseTool('ExitPlanMode', { plan: 'p' }, { signal: ctrl.signal, toolUseID: 'tu-plan2' })
    await tick()
    const pid = sm.listPending(info.id)[0].id
    await sm.decide(info.id, pid, { behavior: 'allow' })
    expect(sm.get(info.id).permissionMode).toBe('default')
  })

  it('AskUserQuestion is never auto-allowed under bypassPermissions (interactive is not bypassable)', async () => {
    const info = sm.create({})
    await sm.setPermissionMode(info.id, 'bypassPermissions')
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>
    const ctrl = new AbortController()
    void canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'q', options: [{ label: 'a' }] }] },
      { signal: ctrl.signal, toolUseID: 'tu-bypass-question' },
    )
    await tick()
    // Even in bypass mode, a question is parked — the model is explicitly
    // asking for human input, and silently auto-allowing it would leave
    // the CLI's built-in placeholder handler to answer. That's the exact
    // failure mode the interactive path is here to fix.
    expect(sm.listPending(info.id)).toHaveLength(1)
    expect(sm.listPending(info.id)[0].kind).toBe('question')
  })

  it('aborting a pending question resolves the SDK promise as deny(aborted)', async () => {
    const info = sm.create({})
    const canUseTool = mockHandles[0].options.canUseTool as (
      tool: string,
      input: unknown,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string; message?: string }>
    const ctrl = new AbortController()
    const promise = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'q', options: [{ label: 'a' }] }] },
      { signal: ctrl.signal, toolUseID: 'tu-abort' },
    )
    await tick()
    ctrl.abort()
    const resolved = await promise
    expect(resolved.behavior).toBe('deny')
    expect(resolved.message).toBe('aborted')
    expect(sm.listPending(info.id)).toHaveLength(0)
  })

  describe('listResumable', () => {
    it('maps SDK listSessions output and annotates known/running/terminated', async () => {
      const live = sm.create({ cwd: '/tmp/live' })
      mockListSessions.mockResolvedValueOnce([
        // a live session this app created
        { sessionId: live.id, summary: 'Live one', cwd: '/tmp/live', lastModified: 300, createdAt: 100 },
        // a session the CLI created — unknown to this app
        { sessionId: 'cli-xyz', firstPrompt: 'Hello from CLI', cwd: '/tmp/cli', lastModified: 500 },
        // customTitle wins over summary/firstPrompt for the display title
        { sessionId: 'title', customTitle: 'My Title', summary: 'ignored', lastModified: 400, gitBranch: 'main' },
      ])

      const list = await sm.listResumable()

      // Sorted newest-first by lastModified: cli-xyz(500) > title(400) > live(300)
      expect(list.map((s) => s.sessionId)).toEqual(['cli-xyz', 'title', live.id])

      const cli = list.find((s) => s.sessionId === 'cli-xyz')!
      expect(cli.known).toBe(false)
      expect(cli.running).toBe(false)
      expect(cli.title).toBe('Hello from CLI')

      const liveRow = list.find((s) => s.sessionId === live.id)!
      expect(liveRow.known).toBe(true)
      expect(liveRow.running).toBe(true)
      expect(liveRow.title).toBe('Live one')

      const title = list.find((s) => s.sessionId === 'title')!
      expect(title.title).toBe('My Title')
      expect(title.gitBranch).toBe('main')
    })

    it('forwards the dir scope to the SDK', async () => {
      await sm.listResumable({ dir: '/tmp/project' })
      expect(mockListSessions).toHaveBeenCalledWith({ dir: '/tmp/project' })
    })

    it('degrades to an empty list when the SDK throws', async () => {
      mockListSessions.mockRejectedValueOnce(new Error('disk gone'))
      expect(await sm.listResumable()).toEqual([])
    })
  })

  describe('resume() adopts unknown disk sessions', () => {
    it('synthesises a SessionMeta from getSessionInfo and resumes', async () => {
      mockGetSessionInfo.mockResolvedValueOnce({
        sessionId: 'orphan',
        cwd: '/tmp/orphan',
        summary: 'Orphaned session',
        lastModified: 1234,
        createdAt: 1000,
      })

      const info = await sm.resume('orphan')
      expect(info.id).toBe('orphan')
      expect(info.running).toBe(true)
      // Spawned with resume pointing at the adopted id.
      const handle = mockHandles[mockHandles.length - 1]
      expect(handle.options.resume).toBe('orphan')
      // The session is now adopted into the store (known on next listing).
      expect(store.get('orphan')).toBeTruthy()
    })

    it('404s when the session exists neither in store nor on disk', async () => {
      mockGetSessionInfo.mockResolvedValueOnce(undefined)
      await expect(sm.resume('ghost')).rejects.toMatchObject({ status: 404 })
    })

    it('coalesces concurrent resume() calls into a single spawn (no duplicate process)', async () => {
      mockGetSessionInfo.mockResolvedValueOnce({
        sessionId: 'orphan',
        cwd: '/tmp/orphan',
        summary: 'Orphaned session',
        lastModified: 1234,
        createdAt: 1000,
      })

      const p1 = sm.resume('orphan')
      const p2 = sm.resume('orphan')
      const [info1, info2] = await Promise.all([p1, p2])
      expect(info1.id).toBe('orphan')
      expect(info2.id).toBe('orphan')
      const spawnedHandles = mockHandles.filter((h) => h.options.resume === 'orphan')
      expect(spawnedHandles).toHaveLength(1)
      expect(sm.get('orphan').running).toBe(true)
    })
  })

  // `!`/`!!` exec abort — the "stop" button on a bash card. execCommand is
  // mocked (see the vi.mock above) so we drive the abort path without spawning
  // a real subprocess: the mock resolves {interrupted:true} when its signal
  // aborts, otherwise hangs like a long-running command.
  describe('exec abort (Ctrl+C analogue)', () => {
    it('abortExec() aborts the in-flight command and returns interrupted:true', async () => {
      const info = sm.create({ cwd: dir, model: 'm1' })
      // Don't await — run in the background so we can abort mid-flight. The
      // mock hangs until the signal aborts.
      const execP = sm.execInSession(info.id, 'long-running-cmd')
      // execInSession parks the AbortController before awaiting execCommand;
      // let that synchronous setup land.
      await tick()
      sm.abortExec(info.id)
      const result = await execP
      expect(result.interrupted).toBe(true)
      // execCommand received a signal (the wiring we added).
      const callOpts = vi.mocked(mockExecCommand).mock.calls[0]?.[2]
      expect(callOpts?.signal).toBeInstanceOf(AbortSignal)
    })

    it('abortExec() is a no-op when no command is running', () => {
      const info = sm.create({ cwd: dir, model: 'm1' })
      // No exec in flight — must not throw.
      expect(() => sm.abortExec(info.id)).not.toThrow()
    })

    it('the AbortController is cleared after execInSession settles', async () => {
      const info = sm.create({ cwd: dir, model: 'm1' })
      const execP = sm.execInSession(info.id, 'long-running-cmd')
      await tick()
      sm.abortExec(info.id)
      await execP
      // A second abort after settle is a no-op (controller was cleared), and
      // the session is still usable.
      expect(() => sm.abortExec(info.id)).not.toThrow()
      expect(sm.get(info.id)).toBeTruthy()
    })

    it('unload() aborts an in-flight exec so it does not hang', async () => {
      const info = sm.create({ cwd: dir, model: 'm1' })
      const execP = sm.execInSession(info.id, 'long-running-cmd')
      await tick()
      await sm.unload(info.id)
      // unload() aborted the in-flight exec, so execP resolves (interrupted)
      // instead of hanging forever (exec has no wall-clock timeout).
      const result = await execP
      expect(result.interrupted).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Dynamic MCP server management (setMcpServers + mergeMcpServers)
// ---------------------------------------------------------------------------

describe('mergeMcpServers', () => {
  let dir: string
  let store: SessionStore
  let mcpDir: string
  let mcpStore: McpConfigStore
  let sm: SessionManager

  beforeEach(async () => {
    mockHandles.length = 0
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockImplementation(async (id) => ({ sessionId: id }))
    mockListSessions.mockReset()
    mockListSessions.mockImplementation(async () => [])
    dir = makeTmpDir()
    mcpDir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    mcpStore = new McpConfigStore({ stateDir: mcpDir })
    await mcpStore.load()
    // Seed two global servers; one disabled so it's excluded from toSdkConfig.
    mcpStore.upsert({
      name: 'global-a', type: 'stdio', command: 'node', args: ['a.js'],
      createdAt: 1, updatedAt: 1,
    })
    mcpStore.upsert({
      name: 'global-b', type: 'sse', url: 'http://b.local',
      createdAt: 1, updatedAt: 1,
    })
    mcpStore.upsert({
      name: 'global-off', type: 'stdio', command: 'node', enabled: false,
      createdAt: 1, updatedAt: 1,
    })
    await mcpStore.flush()
    sm = new SessionManager({ store, mcpConfigStore: mcpStore })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
    rmRf(mcpDir)
  })

  it('resolves enabled global server names to their SDK config', () => {
    const merged = sm.mergeMcpServers(['global-a'], undefined)
    expect(merged).toEqual({
      'global-a': { type: 'stdio', command: 'node', args: ['a.js'] },
    })
  })

  it('skips unknown names but honors an explicitly-requested disabled server', () => {
    // A globally-disabled server is "off by default" (not pre-checked in the
    // new-session dialog) but the user can still opt into it per session by
    // checking its box — so an explicit request must override `enabled:false`.
    const merged = sm.mergeMcpServers(['global-a', 'global-off', 'nope'], undefined)
    expect(Object.keys(merged ?? {}).sort()).toEqual(['global-a', 'global-off'])
    expect(merged?.['global-off']).toEqual({ type: 'stdio', command: 'node' })
  })

  it('lets inline session servers override a global of the same name', () => {
    const merged = sm.mergeMcpServers(
      ['global-a'],
      { 'global-a': { type: 'http', url: 'http://override' } },
    )
    expect(merged).toEqual({ 'global-a': { type: 'http', url: 'http://override' } })
  })

  it('returns undefined when nothing resolves', () => {
    expect(sm.mergeMcpServers([], undefined)).toBeUndefined()
    expect(sm.mergeMcpServers(undefined, {})).toBeUndefined()
    expect(sm.mergeMcpServers(undefined, undefined)).toBeUndefined()
  })

  it('does not iterate a stray string character-by-character', () => {
    // Defensive: a non-array enabledGlobal must be ignored, not split into
    // chars. 'global-a' as a string would otherwise produce keys 'g','l',...
    const merged = sm.mergeMcpServers('global-a' as unknown as string[], undefined)
    expect(merged).toBeUndefined()
  })
})

describe('plugin subset selection', () => {
  let dir: string
  let store: SessionStore
  let mpStore: MpStore
  let sm: SessionManager

  beforeEach(async () => {
    mockHandles.length = 0
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockImplementation(async (id) => ({ sessionId: id }))
    mockListSessions.mockReset()
    mockListSessions.mockImplementation(async () => [])
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    mpStore = new MpStore({ stateDir: dir })
    await mpStore.load()
    // Seed one marketplace with two enabled in-repo plugins (fake dirs are
    // fine — in-repo plugin paths are pushed without an existsSync guard).
    mpStore.upsert({
      id: 'mp1',
      displayName: 'mp1',
      source: { type: 'https', url: 'https://example.com/mp1.git' },
      cloneDir: join(dir, 'mp1'),
      addedAt: 1, lastRefreshedAt: 1, lastSha: 'a'.repeat(40),
      manifest: { name: 'mp1', plugins: [
        { name: 'plugA', dir: '/fake/plugA' },
        { name: 'plugB', dir: '/fake/plugB' },
      ] },
    })
    mpStore.setEnabled('plugA', 'mp1', true)
    mpStore.setEnabled('plugB', 'mp1', true)
    sm = new SessionManager({ store, mpStore })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('create() with enabledPlugins injects only the selected plugin paths', () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    expect(mockHandles[0].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
    ])
    expect(info.enabledPlugins).toEqual([MpStore.keyOf('plugA', 'mp1')])
  })

  it('create() without enabledPlugins injects all enabled plugins (default)', () => {
    sm.create({ cwd: dir })
    expect(mockHandles[0].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
      { type: 'local', path: '/fake/plugB' },
    ])
  })

  it('create() with enabledPlugins: [] injects no plugins', () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [],
    } as any)
    expect(mockHandles[0].options.plugins).toBeUndefined()
    expect(info.enabledPlugins).toEqual([])
  })

  it('resume() re-injects the persisted plugin subset', async () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    await sm.unload(info.id)
    await sm.resume(info.id)
    expect(mockHandles[1].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
    ])
  })

  it('clear() re-injects the persisted plugin subset', async () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    // mockHandles[0] is X's spawn. clear() unloads X and spawns Y → mockHandles[1].
    await sm.clear(info.id)
    expect(mockHandles[1].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
    ])
  })

  it('respawnFresh() preserves the persisted plugin subset (no transcript + no turn)', async () => {
    // Force hasSdkTranscript=false (getSessionInfo → undefined) so resume()
    // takes the respawnFresh path. lastTurnAt is undefined (no turn completed),
    // which is the other respawnFresh precondition.
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockResolvedValue(undefined)
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    await sm.unload(info.id)
    await sm.resume(info.id)
    // The respawned session must still carry the persisted subset — both on
    // the live Session and re-persisted to disk (no clobber to undefined).
    expect(sm.get(info.id)?.enabledPlugins).toEqual([MpStore.keyOf('plugA', 'mp1')])
    expect(store.get(info.id)?.enabledPlugins).toEqual([MpStore.keyOf('plugA', 'mp1')])
  })

  it('does not leak the app-level enabledPlugins string[] into SDK Options', () => {
    // SDK Options.enabledPlugins is a {[k:string]: ...} map, not a string[].
    // The app-level selection must be stripped from sdkOptions before reaching
    // query() (only Options.plugins — resolved paths — should reach the SDK).
    sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    expect(mockHandles[0].options.enabledPlugins).toBeUndefined()
  })
})

describe('provider control-op error wrapping', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager

  beforeEach(async () => {
    mockHandles.length = 0
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockImplementation(async (id) => ({ sessionId: id }))
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  async function rejectOf(p: Promise<unknown>): Promise<unknown> {
    return p.then(
      () => {
        throw new Error('expected the promise to reject')
      },
      (e) => e,
    )
  }

  it('wraps a plain SDK error from a handle method as HttpError 502 naming the action', async () => {
    const info = sm.create({ cwd: '/tmp' })
    mockHandles[0].setMcpServers.mockRejectedValueOnce(new Error('Connection closed'))
    const err = await rejectOf(sm.setMcpServers(info.id, { x: { type: 'stdio', command: 'node' } }))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(502)
    expect((err as HttpError).message).toBe('dynamic MCP servers failed: Connection closed')
  })

  it('passes an existing HttpError through unchanged', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const original = new HttpError(409, 'phase guard')
    mockHandles[0].getContextUsage.mockRejectedValueOnce(original)
    const err = await rejectOf(sm.contextUsage(info.id))
    expect(err).toBe(original)
  })

  it('wraps a plain SDK error on the timeSdkControl path too', async () => {
    const info = sm.create({ cwd: '/tmp' })
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('Connection closed'))
    const err = await rejectOf(sm.contextUsage(info.id))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(502)
    expect((err as HttpError).message).toBe('context usage failed: Connection closed')
  })
})

describe('setMcpServers (dynamic, on a live session)', () => {
  let dir: string
  let store: SessionStore
  let mcpDir: string
  let mcpStore: McpConfigStore
  let sm: SessionManager

  beforeEach(async () => {
    mockHandles.length = 0
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockImplementation(async (id) => ({ sessionId: id }))
    mockListSessions.mockReset()
    mockListSessions.mockImplementation(async () => [])
    dir = makeTmpDir()
    mcpDir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    mcpStore = new McpConfigStore({ stateDir: mcpDir })
    await mcpStore.load()
    mcpStore.upsert({
      name: 'global-a', type: 'stdio', command: 'node', args: ['a.js'],
      createdAt: 1, updatedAt: 1,
    })
    await mcpStore.flush()
    sm = new SessionManager({ store, mcpConfigStore: mcpStore })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
    rmRf(mcpDir)
  })

  it('forwards the given servers straight to query.setMcpServers', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const servers = { x: { type: 'stdio', command: 'node' } }
    const result = await sm.setMcpServers(info.id, servers)
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith(servers)
    expect(result).toEqual({ added: ['x'], removed: [], errors: {} })
  })

  it('throws for an unknown / non-live session', async () => {
    await expect(sm.setMcpServers('ghost', {})).rejects.toBeTruthy()
  })

  // --- via the HTTP route (mergeMcpServers integration) -------------------

  function app() {
    return buildSessionRouter(sm)
  }

  async function post(path: string, body: unknown) {
    return app().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('resolves enabledMcpServers names before calling setMcpServers', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, {
      enabledMcpServers: ['global-a'],
    })
    expect(res.status).toBe(200)
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({
      'global-a': { type: 'stdio', command: 'node', args: ['a.js'] },
    })
  })

  it('merges inline servers with enabled global names', async () => {
    const info = sm.create({ cwd: '/tmp' })
    await post(`/sessions/${info.id}/mcp/servers`, {
      enabledMcpServers: ['global-a'],
      servers: { inline: { type: 'http', url: 'http://x' } },
    })
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({
      'global-a': { type: 'stdio', command: 'node', args: ['a.js'] },
      inline: { type: 'http', url: 'http://x' },
    })
  })

  it('passes an empty object (clear-all) when nothing resolves', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { servers: {} })
    expect(res.status).toBe(200)
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({})
  })

  it('400s when neither servers nor enabledMcpServers is provided', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, {})
    expect(res.status).toBe(400)
  })

  it('400s when servers is not an object', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { servers: ['nope'] })
    expect(res.status).toBe(400)
  })

  it('400s when enabledMcpServers is a string (not an array)', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { enabledMcpServers: 'global-a' })
    expect(res.status).toBe(400)
    expect(mockHandles[0].setMcpServers).not.toHaveBeenCalled()
  })

  it('400s when enabledMcpServers contains a non-string element', async () => {
    const info = sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { enabledMcpServers: ['global-a', 123] })
    expect(res.status).toBe(400)
    expect(mockHandles[0].setMcpServers).not.toHaveBeenCalled()
  })

  // The create route shares the same validator.
  it('create route 400s when enabledMcpServers is a string', async () => {
    const res = await app().request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', enabledMcpServers: 'global-a' }),
    })
    expect(res.status).toBe(400)
    // No session should have spawned.
    expect(mockHandles).toHaveLength(0)
  })

  // enabledPlugins shares the same validator shape as enabledMcpServers.
  it('create route 400s when enabledPlugins is a string (not an array)', async () => {
    const res = await app().request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', enabledPlugins: 'plugA@mp1' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect((body as { error: string }).error).toMatch(/enabledPlugins/)
    // No session should have spawned.
    expect(mockHandles).toHaveLength(0)
  })

  it('create route 400s when env is not an object', async () => {
    const res = await app().request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', env: 'TOKEN=value' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'env must be an object with string values' })
    expect(mockHandles).toHaveLength(0)
  })

  it('create route 400s when env contains a non-string value', async () => {
    const res = await app().request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', env: { TOKEN: 123 } }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'env.TOKEN must be a string' })
    expect(mockHandles).toHaveLength(0)
  })

  it('create route forwards valid env overrides', async () => {
    const res = await app().request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', env: { TOKEN: 'value', EMPTY: '' } }),
    })
    expect(res.status).toBe(201)
    expect(mockHandles).toHaveLength(1)
    const env = mockHandles[0].options.env as Record<string, string>
    expect(env).toMatchObject({ TOKEN: 'value', EMPTY: '' })
  })

  describe('crash recovery', () => {
    // Drive the SessionManager's private crash handler directly. In
    // production ProcessMonitor fires it in real time; the mock SDK never
    // spawns a real subprocess, so we synthesize the exit event.
    const fireCrash = (
      manager: SessionManager,
      sessionId: string,
      info: { code: number | null; signal: NodeJS.Signals | null; killed: boolean; spawnError?: { code?: string; message: string } },
    ) => {
      ;(manager as unknown as { handleProcessExit: (i: unknown) => void }).handleProcessExit({
        sessionId,
        ...info,
      })
    }
    // Poll macrotasks until `cond` is true or we run out of ticks. The pump
    // + cleanupPump + recovery respawn is a chain of async steps, each
    // needing a setImmediate tick to advance.
    const waitFor = async (cond: () => boolean, ticks = 30) => {
      for (let i = 0; i < ticks; i++) {
        if (cond()) return true
        await tick()
      }
      return cond()
    }

    it('Step 1: re-resumes in-place after a crash (keeps same id, no terminate)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      // Complete one turn so lastTurnAt + lastSafeResumeUuid are set
      // (recovery needs a disk transcript / completed turn to resume from).
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 2)

      // In-place recovery: a new Query was spawned on the SAME session id,
      // and the session is alive (not terminated).
      expect(mockHandles.length).toBe(2)
      expect(mockHandles[1].options.resume).toBe(info.id)
      expect(sm.get(info.id).terminated).toBe(false)
    })

    it('crash recovery disabled: terminates immediately (legacy behavior)', async () => {
      sm = new SessionManager({ store, crashRecovery: false })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => sm.get(info.id).terminated === true)

      expect(sm.get(info.id).terminated).toBe(true)
      expect(sm.get(info.id).terminatedReason).toBe('process_exited')
      expect(mockHandles).toHaveLength(1) // no recovery respawn
    })

    it('spawn failures unload to dormant (resumable), not terminated (binary unavailable is transient)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      fireCrash(sm, info.id, { code: null, signal: null, killed: false, spawnError: { code: 'ENOENT', message: 'not found' } })
      // Unloaded to dormant synchronously (unloadSpawnFailed -> unload runs
      // its body with no await when not terminating).
      await waitFor(() => sm.get(info.id).running === false)

      const dormant = sm.get(info.id)
      expect(dormant.terminated).toBe(false)
      expect(dormant.terminatedReason).toBe('spawn_failed')
      expect(dormant.error).toMatch(/not found|ENOENT/)
      expect(mockHandles).toHaveLength(1) // no auto-recovery respawn (retrying would fail identically)

      // The binary being missing is transient + user-fixable, so the session
      // must stay resumable: resume re-spawns and clears the stale error.
      await sm.resume(info.id)
      expect(mockHandles.length).toBeGreaterThanOrEqual(2)
      expect(sm.get(info.id).running).toBe(true)
      expect(sm.get(info.id).error).toBeUndefined()
    })

    it('ladder exhausted: a 3rd crash gives up transiently (no auto-fork) so the client can offer Resume/Fork', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // Every crash is Step 1 (in-place resume, same id) — there is NO Step 2
      // auto-fork. maxCrashRecovery=2 budgets in-place resumes: crashes 1 & 2
      // recover, the 3rd gives up.
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 2)
      expect(mockHandles[1].options.resume).toBe(info.id)
      expect(mockHandles[1].options.forkSession).toBeUndefined()
      expect(sm.get(info.id).terminated).toBe(false)

      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 3)
      // Still in-place: same id, no forkSession, alive.
      expect(mockHandles[2].options.resume).toBe(info.id)
      expect(mockHandles[2].options.forkSession).toBeUndefined()
      expect(sm.get(info.id).terminated).toBe(false)

      // 3rd crash → ladder exhausted → give up with the (transient) crash
      // reason: canRetryResume=true so the composer shows the choice banner.
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => sm.get(info.id).terminated === true)

      expect(sm.get(info.id).terminated).toBe(true)
      expect(sm.get(info.id).terminatedReason).toBe('process_exited')
      expect(sm.get(info.id).canRetryResume).toBe(true)
      // No fork happened: an auto-fork would have spawned a 4th handle (and a
      // second session). 3 handles = original + 2 in-place resumes, and the
      // original session object is still the only one (now terminated).
      expect(mockHandles).toHaveLength(3)

      // canRetryResume is real: a manual resume still works after give-up
      // (the composer's [Resume] button path).
      await sm.resume(info.id)
      await waitFor(() => mockHandles.length >= 4 && sm.get(info.id).running === true)
      expect(sm.get(info.id).terminated).toBe(false)
    })

    it('MAX=3 gives three in-place resumes, then give-up on the 4th crash (no fork at any rung)', async () => {
      sm = new SessionManager({ store, crashRecovery: true, maxCrashRecovery: 3 })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // Crashes 1-3 are ALL Step 1 in-place: same id, no forkSession, alive.
      // maxCrashRecovery budgets AUTOMATIC resumes, so MAX=3 means three.
      for (let i = 1; i <= 3; i++) {
        fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
        await waitFor(() => mockHandles.length >= i + 1)
        expect(mockHandles[i].options.resume).toBe(info.id)
        expect(mockHandles[i].options.forkSession).toBeUndefined()
        expect(sm.get(info.id).terminated).toBe(false)
      }

      // Crash 4 → ladder exhausted → transient give-up (NOT a fork).
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => sm.get(info.id).terminated === true)
      expect(mockHandles).toHaveLength(4) // original + 3 resumes, no fork
      expect(sm.get(info.id).terminatedReason).toBe('process_exited')
      expect(sm.get(info.id).canRetryResume).toBe(true)
    })

    it('manual fork starts a fresh crash counter (its own first crash is Step 1 in-place)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // User-initiated fork (the composer's "Fork from last completed turn"
      // button triggers forkFromLastSafe + replacesSource). A fresh session.
      const forkInfo = await sm.fork(info.id, { replacesSource: true })
      expect(forkInfo.id).not.toBe(info.id)
      expect(sm.get(forkInfo.id).running).toBe(true)

      // The fork is a NEW Session object with NO crash counter, so its own
      // first crash is Step 1 in-place on the fork id — not an immediate
      // give-up (and not a fork-of-fork). Default mock → transcript exists.
      fireCrash(sm, forkInfo.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 3 && sm.get(forkInfo.id).running === true)
      expect(mockHandles[2].options.resume).toBe(forkInfo.id)
      expect(mockHandles[2].options.forkSession).toBeUndefined()
      expect(sm.get(forkInfo.id).terminated).toBe(false)
    })

    it('recovery counter does NOT reset on user message (ladder still exhausts on the 3rd crash)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // Crash 1 → Step 1 in-place resume (counter 0 → 1).
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 2)

      // User sends a new message on the recovered session. The counter must
      // NOT reset here: a poisonous turn that crashes the CLI on the model's
      // response (but loads fine on resume) would otherwise loop at Step 1
      // forever, never exhausting the ladder.
      sm.send(info.id, 'again')
      await tick()

      // Crash 2 → STILL Step 1 (counter 1 → 2), not a give-up.
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 3)
      expect(mockHandles[2].options.resume).toBe(info.id)
      expect(mockHandles[2].options.forkSession).toBeUndefined()
      expect(sm.get(info.id).terminated).toBe(false)

      // Crash 3 → ladder exhausted → transient give-up. If the counter had
      // reset on the user message, this would be Step 1 (counter 0) instead —
      // the assertion that crash 3 terminates proves the counter survived.
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => sm.get(info.id).terminated === true)
      expect(mockHandles).toHaveLength(3)
      expect(sm.get(info.id).terminatedReason).toBe('process_exited')
      expect(sm.get(info.id).canRetryResume).toBe(true)
    })

    it('Step 1 clears the crash error so the next clean idle-exit auto-resumes (not terminate)', async () => {
      sm = new SessionManager({ store, crashRecovery: true, autoResume: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // Crash → Step 1 in-place recovery.
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 2)

      // F1: the crash error must be cleared on the recovered session,
      // otherwise the next clean idle-exit trips `!session.error && autoResume`
      // = false and terminates a healthy session.
      expect(sm.get(info.id).error).toBeUndefined()
      expect(sm.get(info.id).terminated).toBe(false)

      // Simulate a clean idle-exit (code=0) on the recovered session. With
      // the error cleared, autoResume should re-spawn (mockHandles grows)
      // rather than terminate.
      ;(sm as unknown as { handleProcessExit: (i: unknown) => void }).handleProcessExit({
        sessionId: info.id, code: 0, signal: null, killed: false,
      })
      await waitFor(() => mockHandles.length >= 3)
      expect(sm.get(info.id).terminated).toBe(false)
      expect(mockHandles.length).toBe(3)
    })

    it('rejects sends during the recovering window (no message loss)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // fireCrash is sync: recovering flips true immediately, before the
      // async ladder runs. A send in that window must be rejected (409)
      // so it isn't enqueued to the about-to-be-destroyed handle.
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      expect(() => sm.send(info.id, 'too soon')).toThrow(/recovering/i)
      await waitFor(() => mockHandles.length >= 2) // let Step 1 finish
    })

    it('clear() works during the recovering window (reset escape hatch not blocked)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      // /clear is the "reset a stuck session" escape hatch — it must NOT be
      // blocked by the recovering guard (it drives its own fresh respawn and
      // sets clearing=true, which makes the ladder bail). Sends are blocked,
      // but clear is allowed.
      const fresh = await sm.clear(info.id)
      expect(fresh.id).not.toBe(info.id) // clear spawns a fresh session Y
      expect(mockHandles.length).toBeGreaterThanOrEqual(2)
    })

    it('give-up preserves the crash reason (process_exited, not query_error)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = sm.create({ cwd: dir })
      // No result emitted — no completed turn. The ladder probes the disk
      // for a transcript (hasSdkTranscript); a session with no completed
      // turn has no jsonl on disk, so mock getSessionInfo to return
      // undefined → hasSdkTranscript false → give up immediately.
      // handleProcessExit preserved the crash reason on terminatedReason;
      // crashRecoveryGiveUp must surface it instead of 'query_error'.
      mockGetSessionInfo.mockResolvedValueOnce(undefined)
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => sm.get(info.id).terminated === true)

      expect(sm.get(info.id).terminated).toBe(true)
      expect(sm.get(info.id).terminatedReason).toBe('process_exited')
      expect(mockHandles).toHaveLength(1) // no respawn on give-up
    })
  })

  describe('interrupt with cancelQueued', () => {
    const waitFor = async (cond: () => boolean | Promise<boolean>, ticks = 60) => {
      for (let i = 0; i < ticks; i++) {
        if (await cond()) return true
        await new Promise((r) => setImmediate(r))
      }
      return false
    }

    /** Read the live replay ring directly — getHistoryPage serves the DISK
     *  transcript, which these mock sessions never write, so the ring (what
     *  a fresh subscriber replays) is the observable for removal. */
    const ringOf = (sid: string): Array<{ uuid?: string }> => {
      const smAny = sm as unknown as { sessions: Map<string, { history: Array<{ uuid?: string }> }> }
      return smAny.sessions.get(sid)!.history
    }

    /** Session with one in-flight turn (no result emitted) and `n` user
     *  messages queued behind it in the host input Pushable. Returns the
     *  queued messages' server-minted uuids. */
    const setupQueued = (n: number) => {
      const info = sm.create({ cwd: dir })
      const h = mockHandles.at(-1)!
      sm.send(info.id, 'in-flight turn seed')
      const queuedUuids: string[] = []
      for (let i = 0; i < n; i++) {
        const sent = sm.send(info.id, `queued-${i}`)
        queuedUuids.push((sent as { uuid: string }).uuid)
      }
      return { info, h, queuedUuids }
    }

    it('drains the host queue, forwards cancelQueued, and reports the withdrawn count', async () => {
      const { info, h, queuedUuids } = setupQueued(2)
      const withdrawnFrames: Array<{ kind?: string; uuids?: string[] }> = []
      const sub = sm.subscribeMessageStatus(info.id)
      void (async () => {
        for await (const v of sub!.iterable) withdrawnFrames.push(v as { kind?: string; uuids?: string[] })
      })()

      const removed = await sm.interrupt(info.id, { cancelQueued: true })

      // The provider handle received the cancelQueued option (the claude
      // provider forwards it as the SDK control request's cancel_queued).
      expect(h.interrupt).toHaveBeenCalledWith({ cancelQueued: true })
      // Both queued turns were withdrawn: ring entries removed + count.
      expect(removed).toBe(2)
      // Live subscribers got the withdrawal frame with the server uuids.
      await waitFor(() => withdrawnFrames.length > 0)
      const frame = withdrawnFrames[0] as { kind?: string; uuids?: string[] }
      expect(frame.kind).toBe('messages-withdrawn')
      expect(frame.uuids).toEqual(expect.arrayContaining(queuedUuids))
      // The replay ring no longer carries the withdrawn turns.
      const ringUuids = ringOf(info.id).map((m) => m.uuid)
      for (const u of queuedUuids) expect(ringUuids).not.toContain(u)
      sub!.unsubscribe()
    })

    it('a plain interrupt leaves the queue intact (queued turns start the next turn)', async () => {
      const { info, h, queuedUuids } = setupQueued(1)
      const removed = await sm.interrupt(info.id)
      expect(removed).toBe(0)
      // The manager forwards opts through; the provider normalizes absent →
      // undefined (the SDK builds the cancel_queued field conditionally).
      expect(h.interrupt).toHaveBeenCalledWith(undefined)
      const ringUuids = ringOf(info.id).map((m) => m.uuid)
      expect(ringUuids).toContain(queuedUuids[0])
    })

    it('folds the interrupt receipt cancellations into the withdrawal set (unknown uuids + overlap dedupe)', async () => {
      const { info, h, queuedUuids } = setupQueued(1)
      // The receipt here replays the SDK contract: 'cli-internal-1' is a
      // CLI-internal uuid we never sent (docs: "ignore unknown uuids rather
      // than treating them as an error" — the ring lookup misses it), and
      // queuedUuids[0] overlaps the host-drained set (a message can sit in
      // both accounts across the drain/interrupt race) — the union must
      // dedupe it so the withdrawn count stays 1, not 2.
      h.interrupt.mockResolvedValueOnce({ cancelled: ['cli-internal-1', queuedUuids[0]] })
      const removed = await sm.interrupt(info.id, { cancelQueued: true })
      expect(h.interrupt).toHaveBeenCalledWith({ cancelQueued: true })
      expect(removed).toBe(1)
      const ringUuids = ringOf(info.id).map((m) => m.uuid)
      expect(ringUuids).not.toContain(queuedUuids[0])
    })

    it('restores drained messages when the interrupt fails', async () => {
      const { info, h, queuedUuids } = setupQueued(1)
      h.interrupt.mockRejectedValueOnce(new Error('cli died'))
      await expect(sm.interrupt(info.id, { cancelQueued: true })).rejects.toThrow('cli died')
      // The drained message was re-enqueued, not lost.
      const ringUuids = ringOf(info.id).map((m) => m.uuid)
      expect(ringUuids).toContain(queuedUuids[0])
    })

    /** Read the in-memory promptUuids sidecar via the manager's internals. */
    const promptUuidsOf = (sid: string): Array<{ u: string; v?: string }> => {
      const smAny = sm as unknown as { sessions: Map<string, { promptUuids?: Array<{ u: string; v?: string }> }> }
      return smAny.sessions.get(sid)!.promptUuids ?? []
    }

    it('drops the withdrawn turns from the promptUuids sidecar (unpaired entries would mispair the next FIFO echo)', async () => {
      const { info, queuedUuids } = setupQueued(2)
      // Both queued turns recorded an unpaired {u} entry at dispatch (the
      // same entries onPromptEcho pairs FIFO-style with the SDK echo).
      for (const u of queuedUuids) {
        expect(promptUuidsOf(info.id).some((e) => e.u === u && e.v == null)).toBe(true)
      }
      await sm.interrupt(info.id, { cancelQueued: true })
      // A withdrawn prompt never dispatches, so it never echoes — its entry
      // must be gone or the next live send would pair with it (and every
      // later rewindFiles mapping would shift). The in-flight turn's own
      // unpaired entry stays.
      for (const u of queuedUuids) {
        expect(promptUuidsOf(info.id).some((e) => e.u === u)).toBe(false)
      }
      expect(promptUuidsOf(info.id).some((e) => e.v == null)).toBe(true)
    })

    it('puts non-user-turn queue entries (the compact hand-off seed) back instead of withdrawing them', async () => {
      const { info, queuedUuids } = setupQueued(1)
      // A control seed rides the same input Pushable (sendControlMessage —
      // shouldQuery:false, its own uuid, but NO promptUuids entry: it never
      // went through dispatchUserMessage). Destroying it would silently
      // lose the compact hand-off.
      const handleOf = (sid: string) => {
        const smAny = sm as unknown as {
          sessions: Map<string, { handle: { sendControlMessage: (m: unknown) => void; queueDepth: number } }>
        }
        return smAny.sessions.get(sid)!.handle
      }
      handleOf(info.id).sendControlMessage({
        type: 'user',
        message: { role: 'user', content: 'compact hand-off summary' },
        parent_tool_use_id: null,
        isSynthetic: true,
        shouldQuery: false,
        uuid: randomUUID(),
        session_id: info.id,
      })
      const removed = await sm.interrupt(info.id, { cancelQueued: true })
      // Only the queued user turn counts as withdrawn…
      expect(removed).toBe(1)
      // …and the seed is back on the queue (queueDepth 1) instead of gone.
      expect(handleOf(info.id).queueDepth).toBe(1)
      expect(ringOf(info.id).map((m) => m.uuid)).not.toContain(queuedUuids[0])
    })

    it('seeds a late message-status subscriber with the withdrawal window (a tab that missed the live frame still evicts)', async () => {
      const { info, queuedUuids } = setupQueued(1)
      await sm.interrupt(info.id, { cancelQueued: true })
      // Subscribe AFTER the stop — a tab reconnecting post-stop missed the
      // live frame, and incremental sinceUuid replay can never heal it (the
      // withdrawn messages are gone from the ring, so nothing re-sends them).
      const lateFrames: Array<{ kind?: string; uuids?: string[] }> = []
      const late = sm.subscribeMessageStatus(info.id)
      void (async () => {
        for await (const v of late!.iterable) lateFrames.push(v as { kind?: string; uuids?: string[] })
      })()
      await waitFor(() => lateFrames.length > 0)
      expect(lateFrames[0].kind).toBe('messages-withdrawn')
      expect(lateFrames[0].uuids).toContain(queuedUuids[0])
      late!.unsubscribe()
    })
  })

  describe('discard (fork-from-anchor)', () => {
    const waitFor = async (cond: () => boolean | Promise<boolean>, ticks = 60) => {
      for (let i = 0; i < ticks; i++) {
        if (await cond()) return true
        await new Promise((r) => setImmediate(r))
      }
      return false
    }

    /** Complete a turn with a known assistant uuid so the pump records it
     *  as a turn anchor (success result → turnAnchorStore.append). */
    const completeTurn = (handle: MockQueryHandle, sessionId: string, asstUuid: string) => {
      handle.emit({ type: 'assistant', uuid: asstUuid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply ' + asstUuid }] } })
      handle.emit({ type: 'result', subtype: 'success', uuid: 'res-' + asstUuid, session_id: sessionId, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
    }

    /** Read the turn-anchor sidecar via the manager's internals. */
    const anchorsOf = async (sid: string) => {
      const smAny = sm as unknown as { turnAnchorStore: { load: (id: string) => Promise<Array<{ assistantUuid: string; completedAt: number }> | null> } }
      return (await smAny.turnAnchorStore.load(sid)) ?? []
    }

    it('records a turn anchor on each successful result', async () => {
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      // The pump records the anchor asynchronously (fire-and-forget); poll
      // for the sidecar write to land.
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)
      const anchors = await anchorsOf(info.id)
      expect(anchors).toHaveLength(1)
      expect(anchors[0].assistantUuid).toBe('asst-1')
    })

    it('discard() forks from the anchor and swaps X out (keeps transcript)', async () => {
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      const y = await sm.discard(info.id, 'asst-1')
      // Y is a new session id, live, not terminated.
      expect(y.id).not.toBe(info.id)
      expect(y.terminated).toBe(false)
      expect(y.running).toBe(true)
      // The fork spawn carried resumeSessionAt = the anchor (inclusive).
      const forkHandle = mockHandles.at(-1)!
      expect(forkHandle.options.resume).toBe(info.id)
      expect(forkHandle.options.forkSession).toBe(true)
      expect(forkHandle.options.resumeSessionAt).toBe('asst-1')
      // X is gone from the live map + store (unload + removeFromStore).
      expect(() => sm.get(info.id)).toThrow(/not found/i)
    })

    it('discard() refuses a non-anchor uuid (400)', async () => {
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      // 'asst-bogus' was never recorded as a turn anchor.
      await expect(sm.discard(info.id, 'asst-bogus')).rejects.toThrow(/isn't the last reply|Cannot discard/i)
    })

    it('Y inherits X turn anchors truncated to the cut point (composable)', async () => {
      const info = sm.create({ cwd: dir })
      // Seed three turn anchors directly into the sidecar (bypassing the
      // pump's fire-and-forget append, which races the test's event loop
      // under the full suite). discard() reads the sidecar, not the pump,
      // so this exercises the real cut-point inheritance logic without
      // flaky timing.
      const smAnchors = sm as unknown as { turnAnchorStore: { save: (id: string, entries: Array<{ assistantUuid: string; completedAt: number }>) => Promise<void> } }
      await smAnchors.turnAnchorStore.save(info.id, [
        { assistantUuid: 'asst-1', completedAt: 1000 },
        { assistantUuid: 'asst-2', completedAt: 2000 },
        { assistantUuid: 'asst-3', completedAt: 3000 },
      ])
      // Complete one real turn so fork() has a transcript + lastTurnAt
      // (fork refuses without a completed turn).
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // Discard after asst-2 → Y should inherit anchors [asst-1, asst-2]
      // (the cut point inclusive, asst-3 dropped). A later discard on Y
      // can still cut at asst-1 or asst-2.
      const y = await sm.discard(info.id, 'asst-2')
      await waitFor(async () => (await anchorsOf(y.id)).length > 0)
      const yAnchors = await anchorsOf(y.id)
      expect(yAnchors.map((a) => a.assistantUuid)).toEqual(['asst-1', 'asst-2'])
    })

    it('deleteOriginal unlinks the source transcript + sidecar', async () => {
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      const y = await sm.discard(info.id, 'asst-1', { deleteOriginal: true })
      expect(y.id).not.toBe(info.id)
      // X's sidecar is gone.
      expect(await anchorsOf(info.id)).toEqual([])
      // X's prompt-uuid sidecar is gone too.
      const smAny = sm as unknown as { promptUuidStore: { load: (id: string) => Promise<unknown> } }
      expect(await smAny.promptUuidStore.load(info.id)).toBeNull()
    })

    it('listDiscardAnchors returns anchors with previews', async () => {
      const info = sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      const { anchors } = await sm.listDiscardAnchors(info.id)
      expect(anchors).toHaveLength(1)
      expect(anchors[0].uuid).toBe('asst-1')
      // Preview: the mock SDK doesn't write a disk transcript, so
      // readHistoryEntries returns nothing and the preview degrades to a
      // placeholder. (Real preview content is exercised by the e2e check
      // in the plan, not this unit test.)
      expect(anchors[0].preview).toBe('(reply not found on disk)')
    })
  })
})

describe('resolveConfiguredModel with a profile modelList', () => {
  const list = ['anthropic/claude-sonnet-4-20250514', 'deepseek/deepseek-v4-pro']
  it('resolves a bare short name against the given list', () => {
    expect(resolveConfiguredModel('deepseek-v4-pro', list)).toBe('deepseek/deepseek-v4-pro')
  })
  it('leaves a provider-prefixed id unchanged', () => {
    expect(resolveConfiguredModel('myprovider/gpt-5.6', list)).toBe('myprovider/gpt-5.6')
  })
  it('falls back to the default (active-profile) list when omitted', () => {
    // Default list: 'anthropic/claude-sonnet-4-20250514' is the first entry.
    // 'claude-opus-4-20250514' is a bare name in the default list that
    // resolves to itself (exact match).
    expect(resolveConfiguredModel('claude-opus-4-20250514')).toBe('claude-opus-4-20250514')
  })
})

describe('create() validates modelGroupId against the effective profile', () => {
  let dir: string
  let smLocal: SessionManager

  const GROUP_B = {
    id: 'g_budget', name: 'Budget',
    sonnet: 'anthropic/claude-sonnet-4-20250514',
    haiku: 'claude-haiku-3-5-20241022',
    main: 'sonnet' as const,
  }
  const profileA: import('./config.js').ProviderProfile = {
    id: 'A', name: 'Profile A', authToken: 'tok-a',
    baseUrl: 'https://api.anthropic.com',
    modelList: ['anthropic/claude-sonnet-4-20250514'],
    modelGroups: [], recapModel: '', commitMessageModel: '',
  }
  const profileB: import('./config.js').ProviderProfile = {
    id: 'B', name: 'Profile B', authToken: 'tok-b',
    baseUrl: 'https://api.anthropic.com',
    modelList: ['anthropic/claude-sonnet-4-20250514'],
    modelGroups: [GROUP_B], recapModel: '', commitMessageModel: '',
  }

  beforeEach(async () => {
    dir = makeTmpDir()
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    smLocal = new SessionManager({ store })
  })

  afterEach(async () => {
    await smLocal.shutdown()
    rmRf(dir)
    __setConfigForTest({ profiles: [], activeProfileId: 'default', modelGroups: [] })
  })

  it('succeeds when profile B has the group but the active profile does not', () => {
    __setConfigForTest({
      profiles: [profileA, profileB],
      activeProfileId: 'A',
      modelGroups: [],
    })
    const info = smLocal.create({
      cwd: '/tmp',
      profileId: 'B',
      modelGroupId: 'g_budget',
    } as Parameters<SessionManager['create']>[0])
    expect(info.modelGroupId).toBe('g_budget')
    expect(info.model).toBe('anthropic/claude-sonnet-4-20250514')
    expect(info.profileId).toBe('B')
  })

  it('rejects a group that belongs to neither profile', () => {
    __setConfigForTest({
      profiles: [profileA, profileB],
      activeProfileId: 'A',
      modelGroups: [],
    })
    expect(() => smLocal.create({
      cwd: '/tmp',
      profileId: 'B',
      modelGroupId: 'nonexistent',
    } as Parameters<SessionManager['create']>[0])).toThrow('model group nonexistent not found')
  })
})
