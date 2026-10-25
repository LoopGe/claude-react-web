import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmRf } from './__test-utils__/index.js'
import { encodeCwd, subagentTranscriptPath } from './subagent-watcher.js'

// Wrap node:fs/promises so `stat` is a controllable mock that defaults to the
// real implementation (preexisting stat users keep working) but individual
// tests can override it — SessionManager.readFile stats the file to floor an
// mtime before seeding the CLI read-state cache. vi.mock guarantees the
// manager's `import { stat }` reads this same mocked `stat`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof nodeFs
  return { ...actual, stat: vi.fn(actual.stat) }
})

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
  close: ReturnType<typeof vi.fn>
  setMaxThinkingTokens: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  setPermissionMode: ReturnType<typeof vi.fn>
  applyFlagSettings: ReturnType<typeof vi.fn>
  supportedModels: ReturnType<typeof vi.fn>
  supportedCommands: ReturnType<typeof vi.fn>
  supportedAgents: ReturnType<typeof vi.fn>
  mcpServerStatus: ReturnType<typeof vi.fn>
  readMcpResource: ReturnType<typeof vi.fn>
  toggleMcpServer: ReturnType<typeof vi.fn>
  reconnectMcpServer: ReturnType<typeof vi.fn>
  setMcpServers: ReturnType<typeof vi.fn>
  setMcpPermissionModeOverride: ReturnType<typeof vi.fn>
  getContextUsage: ReturnType<typeof vi.fn>
  accountInfo: ReturnType<typeof vi.fn>
  generateSessionTitle: ReturnType<typeof vi.fn>
  readFile: ReturnType<typeof vi.fn>
  seedReadState: ReturnType<typeof vi.fn>
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
const { mockGetSessionInfo, mockListSessions, mockListSubagents, mockRenameSession } = vi.hoisted(() => {
  return {
    mockGetSessionInfo: vi.fn<(id: string, opts?: { dir?: string }) => Promise<unknown>>(
      async (id) => ({ sessionId: id }),
    ),
    mockListSessions: vi.fn<(opts?: { dir?: string }) => Promise<unknown[]>>(
      async () => [],
    ),
    mockListSubagents: vi.fn<(id: string, opts?: { dir?: string }) => Promise<string[]>>(
      async () => [],
    ),
    mockRenameSession: vi.fn<(id: string, title: string, opts?: { dir?: string }) => Promise<unknown>>(async () => {}),
  }
})

// First-party in-process servers are injected into every session's
// mcpServers map at spawn / live setMcpServers. Mock the registry so no real
// in-process McpServer is constructed; mockInjectAll mirrors the real logic
// (inject the `git-tools` server when the resolver enables it and a cwd is
// present), letting tests assert on the injected entry.
const { mockInjectAll } = vi.hoisted(() => ({ mockInjectAll: vi.fn() }))
mockInjectAll.mockImplementation((cwd: string | null, enabled: (name: string) => boolean) => {
  if (enabled('git-tools') && cwd) return { 'git-tools': { type: 'sdk', name: 'git-tools' } }
  return undefined
})
vi.mock('./sdk-tools/registry.js', () => ({
  firstPartyRegistry: {
    injectAll: mockInjectAll,
    readOnlyToolFqns: () => new Set(['mcp__git-tools__git_status', 'mcp__git-tools__git_branches']),
    mutatingToolFqns: () => new Set(['mcp__git-tools__git_stage']),
    list: () => [{ name: 'git-tools', description: '', defaultEnabled: true, requiresCwd: true, buildTools: () => [] }],
    // toolServerStatus embeds this listing verbatim — the real registry's
    // listToolDefs content is pinned in sdk-tools/registry.test.ts.
    listToolDefs: () => [{ name: 'git-tools', description: '', tools: [{ name: 'stub_tool', description: 'stub', readOnly: true }] }],
  },
}))
vi.mock('./sdk-tools/app-tools.js', () => ({
  APP_TOOLS_SERVER_NAME: 'git-tools',
  buildAppToolsServer: vi.fn((cwd: string) => ({ type: 'sdk', name: 'git-tools', instance: { cwd } })),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    getSessionInfo: (id: string, opts?: { dir?: string }) => mockGetSessionInfo(id, opts),
    listSessions: (opts?: { dir?: string }) => mockListSessions(opts),
    listSubagents: (id: string, opts?: { dir?: string }) => mockListSubagents(id, opts),
    renameSession: (id: string, title: string, opts?: { dir?: string }) => mockRenameSession(id, title, opts),
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
          if (!r.done) {
            handle.consumed.push(r.value)
            // Mirror the real SDK: onUserMessageConsumed fires when a
            // queued user message is dequeued for the next turn.
            const consumedCb = (options as { onUserMessageConsumed?: (m: unknown) => void })
              .onUserMessageConsumed
            if (typeof consumedCb === 'function') {
              try { consumedCb(r.value) } catch { /* never break iteration */ }
            }
          }
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
        // Query.close() terminates the stream — mark the generator done so any
        // parked/pending next() resolves instead of hanging the pump.
        close: vi.fn(() => {
          done = true
          pushResolved({ value: undefined, done: true })
        }),
        setMaxThinkingTokens: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        applyFlagSettings: vi.fn(async () => {}),
        supportedModels: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []),
        supportedAgents: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => ({})),
        readMcpResource: vi.fn(async (_serverName: string, uri: string) => ({
          contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<html>app</html>' }],
        })),
        toggleMcpServer: vi.fn(async () => {}),
        reconnectMcpServer: vi.fn(async () => {}),
        setMcpServers: vi.fn(async (servers: Record<string, unknown>) => ({
          added: Object.keys(servers),
          removed: [],
          errors: {},
        })),
        setMcpPermissionModeOverride: vi.fn(async () => ({})),
        getContextUsage: vi.fn(async () => ({})),
        accountInfo: vi.fn(async () => ({})),
        generateSessionTitle: vi.fn(async (_desc: string, _opts?: { persist?: boolean }) => 'Mock auto title'),
        readFile: vi.fn(async () => ({ available: false })),
        seedReadState: vi.fn(async () => {}),
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
        close: handle.close,
        setMaxThinkingTokens: handle.setMaxThinkingTokens,
        setModel: handle.setModel,
        setPermissionMode: handle.setPermissionMode,
        applyFlagSettings: handle.applyFlagSettings,
        supportedModels: handle.supportedModels,
        supportedCommands: handle.supportedCommands,
        supportedAgents: handle.supportedAgents,
        mcpServerStatus: handle.mcpServerStatus,
        readMcpResource: handle.readMcpResource,
        toggleMcpServer: handle.toggleMcpServer,
        reconnectMcpServer: handle.reconnectMcpServer,
        setMcpServers: handle.setMcpServers,
        setMcpPermissionModeOverride: handle.setMcpPermissionModeOverride,
        getContextUsage: handle.getContextUsage,
        accountInfo: handle.accountInfo,
        generateSessionTitle: handle.generateSessionTitle,
        readFile: handle.readFile,
        seedReadState: handle.seedReadState,
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

// session-worktree wrapped so tests can force ensureWorktreeForResume to
// throw once (worktree-resume transient-failure split). Everything defaults
// to the real implementation; only tests that opt in mock it.
vi.mock('./session-worktree.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./session-worktree.js')>()
  return {
    ...orig,
    ensureWorktreeForResume: vi.fn(orig.ensureWorktreeForResume),
  }
})

// Helper: yield to the event loop so the SessionManager's pump() can
// process whatever the mock just emitted. The pump iterates asynchronously,
// so a `setImmediate`-tick is enough to drain one message.
const tick = () => new Promise((r) => setImmediate(r))
// Wall-clock wait for conditions that depend on real fs I/O (the subagent
// watcher's async transcript tail), which a fixed number of setImmediate
// ticks does not reliably span.
const waitForIo = async (cond: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
}

// Import AFTER vi.mock so the SessionManager picks up the mocked SDK.
import { SessionManager, resolveConfiguredModel, backfillSubagentCompletions, mergeResultFrames } from './session-manager.js'
import { ensureWorktreeForResume } from './session-worktree.js'
import type { Session } from './session-types.js'
import { ClaudeSessionHandle } from './providers/claude/claude-session.js'
import { SessionStore } from './persistence.js'
import { AgentDefinitionStore } from './agent-definition-store.js'
import { __setConfigForTest, config as defaultConfig } from './config.js'
import { McpConfigStore } from './mcp-config.js'
import { MpStore } from './mp-store.js'
import { execCommand as mockExecCommand } from './exec.js'
import { summarizeForCompact } from './compact-summary.js'
import { buildSessionRouter } from './routes/sessions.js'
import { HttpError } from './errors.js'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { ONE_M_CONTEXT_BETA } from '../shared/context-steps.js'
import { cleanupGitFixtures, makeRepo } from './test-git-fixtures.js'
import { branchExists } from './git.js'
import { SnapshotStore } from './snapshot/snapshot-store.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-rw-sm-'))
}

/** A minimal seed pair: an Agent tool_use plus its async launch ack — the
 *  durable transcript shape the seed-time completion backfill scans for
 *  (shared by the SessionManager and discard describe blocks). */
function ackSeed(toolUseId: string, agentId: string): unknown[] {
  return [
    {
      type: 'assistant',
      uuid: `a-${toolUseId}`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'work' } }] },
    },
    {
      type: 'user',
      uuid: `u-${toolUseId}`,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Async agent launched successfully.\nagentId: ${agentId}\n`,
        }],
      },
    },
  ]
}

/** Write a subagent sidecar transcript with one terminal assistant frame. */
function writeSidecar(cwd: string, sessionId: string, agentId: string, stopReason: string, text: string): void {
  const p = subagentTranscriptPath(cwd, sessionId, agentId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(
    p,
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason } }) + '\n',
  )
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
    // Short model-switch retry delay (same idea as deleteLockMaxWaitMs in the
    // op-lock suite): the retry path is exercised here, and the production
    // 1.5s wait would slow the suite without adding signal.
    sm = new SessionManager({ store, modelSwitchRetryDelayMs: 5 })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('create() spawns a Query and returns info with working=false', async () => {
    const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
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

  it('create() defaults betas to the 1M-context flag when none is supplied', async () => {
    const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
    // The SDK subprocess must be spawned with the 1M beta, exactly like the
    // New Session dialog does on every create.
    expect(mockHandles[0].options.betas).toEqual([ONE_M_CONTEXT_BETA])
    // And it must be persisted onto the session meta so resume / fork / clear
    // inherit it instead of silently dropping back to 200K on the next spawn.
    expect(store.get(info.id)?.betas).toEqual([ONE_M_CONTEXT_BETA])
  })

  it('create() leaves explicitly supplied betas untouched', async () => {
    const info = await sm.create({
      cwd: '/tmp',
      model: 'test-model',
      betas: ['some-custom-beta'],
    } as unknown as Parameters<SessionManager['create']>[0])
    expect(mockHandles[0].options.betas).toEqual(['some-custom-beta'])
    expect(store.get(info.id)?.betas).toEqual(['some-custom-beta'])
  })

  it('create() respects an explicit empty betas list as an opt-out (no 1M default)', async () => {
    const info = await sm.create({
      cwd: '/tmp',
      model: 'test-model',
      betas: [],
    } as Parameters<SessionManager['create']>[0])
    // `[]` is the API-visible way to say "run at the model's native window" —
    // it must NOT be rewritten to the 1M flag.
    expect(mockHandles[0].options.betas).toEqual([])
    expect(store.get(info.id)?.betas).toEqual([])
  })

  it('pins subagent model-alias env vars to the session model', async () => {
    await sm.create({ cwd: '/tmp', model: 'gw/some-model' })
    const env = mockHandles[0].options.env as Record<string, string>
    // All four aliases resolve to the session's explicit model so subagents
    // (Task/Agent/Explore) never fall back to an ID the gateway rejects.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gw/some-model')
  })

  it('falls back to the default model for the alias env vars when none is given', async () => {
    await sm.create({ cwd: '/tmp' })
    const env = mockHandles[0].options.env as Record<string, string>
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(defaultConfig.defaultModel)
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe(defaultConfig.defaultModel)
  })

  it('does not contaminate the shared env cache across sessions with different models', async () => {
    await sm.create({ cwd: '/tmp', model: 'model-a' })
    await sm.create({ cwd: '/tmp', model: 'model-b' })
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

    it('maps the four tier env vars to the group slots and sets the main model', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      const env = mockHandles[0].options.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-3-5-20241022')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-haiku-3-5-20241022')
      expect(info.model).toBe('anthropic/claude-opus-4-20250514')
      expect(info.modelGroupId).toBe('g_flagship')
      expect(mockHandles[0].options.model).toBe('anthropic/claude-opus-4-20250514')
    })

    it('resolves the aux target to the group haiku tier, not the main', async () => {
      // The aux calls (recap / commit message / auto-mode classifier) ask the
      // manager for their target when the matching config field is empty. For
      // a group session the model must be the HAIKU slot — the class of model
      // the CLI itself routes internal queries to — while session.model (and
      // the info projection) stays the group's main.
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      expect(info.model).toBe('anthropic/claude-opus-4-20250514')
      expect(sm.auxTargetFor(info.id, 'recap')).toMatchObject({ model: 'claude-haiku-3-5-20241022' })
    })

    it('resolves the aux target model to the session model without a group', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'gw/some-model' })
      expect(sm.auxTargetFor(info.id, 'recap')).toMatchObject({ model: 'gw/some-model' })
    })

    it('prefers the profile override, and reads it from the SESSION profile', async () => {
      // The override is a per-profile field, so a session pinned to B must
      // use B's — reading the active profile's would apply one profile's model
      // to another profile's session.
      const before = {
        profiles: defaultConfig.profiles,
        activeProfileId: defaultConfig.activeProfileId,
        modelGroups: defaultConfig.modelGroups,
      }
      const profile = (id: string, recapModel: string): import('./config.js').ProviderProfile => ({
        id, name: id, authToken: 'sk-' + id, baseUrl: 'https://gw-' + id,
        modelList: ['vendor/model'], modelGroups: [], recapModel, commitMessageModel: '',
      })
      try {
        __setConfigForTest({
          profiles: [profile('A', 'vendor/from-a'), profile('B', 'vendor/from-b')],
          activeProfileId: 'A',
          modelGroups: [],
        })
        const info = await sm.create({ cwd: '/tmp', profileId: 'B', model: 'vendor/model' } as Parameters<SessionManager['create']>[0])
        expect(sm.auxTargetFor(info.id, 'recap')).toMatchObject({
          model: 'vendor/from-b',
          baseUrl: 'https://gw-B',
          authToken: 'sk-B',
        })
        // …and 'commitMessage' follows the same profile (its own field, empty
        // here ⇒ the session model), never the active profile's endpoint.
        expect(sm.auxTargetFor(info.id, 'commitMessage')).toMatchObject({
          model: 'vendor/model',
          baseUrl: 'https://gw-B',
          authToken: 'sk-B',
        })
      } finally {
        __setConfigForTest({ ...before })
      }
    })

    it('persists the profile pin so a dormant session still resolves its own profile', async () => {
      // The pin is what identifies WHICH profile's credentials and model
      // groups apply. It is not derivable from the active profile, so it has
      // to survive a restart — otherwise a dormant session is resolved against
      // whatever profile happens to be active, sending its model to the wrong
      // endpoint.
      const groupB = { id: 'g_b', name: 'B group', opus: 'vendor/big', haiku: 'vendor/small', main: 'opus' as const }
      const before = {
        profiles: defaultConfig.profiles,
        activeProfileId: defaultConfig.activeProfileId,
        modelGroups: defaultConfig.modelGroups,
      }
      const profile = (id: string, modelGroups: unknown[]): import('./config.js').ProviderProfile => ({
        id, name: id, authToken: 'sk-' + id, baseUrl: 'https://gw-' + id,
        modelList: ['vendor/big', 'vendor/small'],
        modelGroups: modelGroups as import('./config.js').ModelGroupConfig[],
        recapModel: '', commitMessageModel: '',
      })
      try {
        __setConfigForTest({
          profiles: [profile('A', []), profile('B', [groupB])],
          activeProfileId: 'A',
          modelGroups: [],
        })
        const info = await sm.create({
          cwd: '/tmp', profileId: 'B', modelGroupId: 'g_b',
        } as Parameters<SessionManager['create']>[0])
        expect(sm.auxTargetFor(info.id, 'recap')).toMatchObject({
          model: 'vendor/small', baseUrl: 'https://gw-B', authToken: 'sk-B',
        })
        expect(store.get(info.id)?.profileId).toBe('B')

        // A second manager over the same store IS the restart case: the
        // session is dormant, so only the persisted pin can resolve it.
        const restarted = new SessionManager({ store })
        expect(restarted.auxTargetFor(info.id, 'recap')).toMatchObject({
          model: 'vendor/small', baseUrl: 'https://gw-B', authToken: 'sk-B',
        })
        void restarted.shutdown()
      } finally {
        __setConfigForTest({ ...before })
      }
    })

    it('applies the fallback degradation chain on spawn for a group session', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: ['sonnet', 'haiku'] })
    })

    it('empty slots fall back to the main model', async () => {
      __setConfigForTest({
        modelGroups: [{ id: 'g_sonnet_only', name: 'Sonnet Only', sonnet: 'anthropic/claude-sonnet-4-20250514', main: 'sonnet' }],
      })
      await sm.create({ cwd: '/tmp', modelGroupId: 'g_sonnet_only' } as Parameters<SessionManager['create']>[0])
      const env = mockHandles[0].options.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
    })

    it('single-model sessions still collapse all four aliases to the model', async () => {
      // Regression guard for the single-model path (the existing tests above
      // cover it; this one pins it against accidental group leakage).
      __setConfigForTest({ modelGroups: [GROUP] })
      await sm.create({ cwd: '/tmp', model: 'gw/some-model' })
      const env = mockHandles[0].options.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gw/some-model')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gw/some-model')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw/some-model')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gw/some-model')
    })

    it('create rejects an unknown modelGroupId with 400', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      await expect(sm.create({ cwd: '/tmp', modelGroupId: 'g_missing' } as Parameters<SessionManager['create']>[0])).rejects.toThrow(/model group g_missing not found/)
    })

    it('setModelGroup resolves main, switches model live, applies fallback, persists', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp', model: 'gw/start' })
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
      const info = await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      mockHandles[0].applyFlagSettings.mockClear()
      const updated = await sm.setModelGroup(info.id, 'g_budget')
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: null })
      expect(updated.modelGroupId).toBe('g_budget')
      expect(updated.model).toBe('claude-haiku-3-5-20241022')
    })

    it('setModelGroup rejects an unknown group with 400', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp' })
      await expect(sm.setModelGroup(info.id, 'g_missing')).rejects.toThrow(/model group g_missing not found/)
    })

    it('setModelGroup retries an unconfirmed switch before applying the fallback chain', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp', model: 'gw/start' })
      mockHandles[0].setModel
        .mockRejectedValueOnce(
          new Error('Couldn\'t confirm model "anthropic/claude-opus-4-20250514" with the API. Try again, or run /model to see available models.'),
        )
      const updated = await sm.setModelGroup(info.id, 'g_flagship')
      expect(mockHandles[0].setModel).toHaveBeenCalledTimes(2)
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: ['sonnet', 'haiku'] })
      expect(updated.model).toBe('anthropic/claude-opus-4-20250514')
      expect(updated.modelGroupId).toBe('g_flagship')
    })

    it('setModel clears modelGroupId and the fallback chain', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
      mockHandles[0].applyFlagSettings.mockClear()
      const updated = await sm.setModel(info.id, 'gw/other')
      expect(updated.modelGroupId).toBeUndefined()
      expect(updated.model).toBe('gw/other')
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: null })
    })

    it('respawn with a deleted group self-heals: clears the reference and collapses', async () => {
      __setConfigForTest({ modelGroups: [GROUP] })
      const info = await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
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
      const info = await sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' } as Parameters<SessionManager['create']>[0])
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({ cwd: '/tmp/workspace' })
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
    const info = await sm.create({ cwd: '/tmp/workspace' })
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
      await waitForIo(() => sm.get(info.id).backgroundSubagentCount === 0)

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
    const info = await sm.create({ cwd: '/tmp/workspace' })
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
      // Give the first (async) transcript read time to land so the assertion
      // below sees its outcome rather than a not-yet-read watcher.
      await new Promise((r) => setTimeout(r, 100))

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
    const info = await sm.create({})
    mockHandles[0].backgroundTasks.mockResolvedValueOnce(true)
    const result = await sm.backgroundTasks(info.id, 'tu_1')
    expect(result).toBe(true)
    expect(mockHandles[0].backgroundTasks).toHaveBeenCalledWith('tu_1')
    // No toolUseId → forwards undefined (CLI's Ctrl+B "all tasks" semantics).
    await sm.backgroundTasks(info.id)
    expect(mockHandles[0].backgroundTasks).toHaveBeenLastCalledWith(undefined)
  })

  it('stopTask() forwards the taskId to the Query', async () => {
    const info = await sm.create({})
    await sm.stopTask(info.id, 'task-7')
    expect(mockHandles[0].stopTask).toHaveBeenCalledWith('task-7')
  })

  it('backgroundTasks() 501s when the provider handle lacks the method', async () => {
    // requireHandleMethod's guard: a handle without backgroundTasks must
    // surface a clean HttpError 501, not a TypeError from calling undefined.
    const info = await sm.create({})
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
    const info = await sm.create({ cwd: '/tmp/workspace' })
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
      })
      // The notification's `summary` is a completion payload (here: the
      // subagent's final text), not live progress — it must not land in
      // progressSummary. The client's subagent result merge reads the summary
      // off the raw frame, so nothing is lost by leaving the slot alone.
      expect(settled.find((t) => t.taskId === 'agent-tasks')!.progressSummary).toBeUndefined()
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    await sm.delete(info.id)
  })

  it('a real task_notification whose task_id differs from the agentId drops the phantom seed', async () => {
    const info = await sm.create({ cwd: '/tmp/workspace' })
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
      })
      // Completion summary, not live progress — see the note above.
      expect(snapshot.find((t) => t.taskId === 'sdk-task-9')!.progressSummary).toBeUndefined()
      expect(snapshot.find((t) => t.taskId === 'agent-mismatch')).toBeUndefined()
    } finally {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    await sm.delete(info.id)
  })

  // -------------------------------------------------------------------------
  // Seed-time backfill of missing background-subagent completions.
  //
  // The CLI does not persist task_notification frames (or result frames) to
  // its JSONL, so a completion that no client consumed live is unrecoverable
  // by replay: every reload re-seeds the Agent tool_use as 'running' (the
  // launch ack is skipped by design) and the WorkingBubble pill strands on a
  // multi-hour-old timer. The durable data to reconstruct the REAL outcome
  // exists — the subagent's own sidecar transcript — so the resume seed
  // synthesizes the missing notification instead of relying on delivery luck.
  // (ackSeed / writeSidecar are module-scope helpers shared with the
  // discard-describe tests below.)
  // -------------------------------------------------------------------------

  describe('backfillSubagentCompletions', () => {
    let realConfigDir: string | undefined
    beforeEach(() => {
      realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
    })
    afterEach(() => {
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    })

    it('synthesizes a terminal notification from the durable sidecar transcript', async () => {
      writeSidecar('/tmp/workspace', 'sess-1', 'agent-1', 'end_turn', 'DONE — commit 90762696')
      const seed = ackSeed('tu_1', 'agent-1') as never[]
      const out = await backfillSubagentCompletions(seed, { cwd: '/tmp/workspace', sessionId: 'sess-1' })
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'tu_1',
        task_id: 'agent-1',
        session_id: 'sess-1',
        status: 'completed',
        summary: 'DONE — commit 90762696',
      })
      // receivedAt comes from stampReceivedAt (monotonic), never a raw
      // Date.now() — same-ms ordering against pump-stamped frames.
      expect(typeof (out[0] as { receivedAt?: unknown }).receivedAt).toBe('number')
      expect(typeof (out[0] as { uuid?: unknown }).uuid).toBe('string')
    })

    it('synthesizes stopped when the sidecar transcript has no terminal frame', async () => {
      // The subagent ran inside the PREVIOUS subprocess — once that process
      // is gone it can never produce another transcript line, so no terminal
      // frame means the work died with it. Same semantics as the watcher's
      // process-exit path.
      const seed = ackSeed('tu_2', 'agent-2') as never[]
      const out = await backfillSubagentCompletions(seed, { cwd: '/tmp/workspace', sessionId: 'sess-1' })
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'tu_2',
        status: 'stopped',
        summary: '',
      })
    })

    it('does not synthesize for a launch ack whose notification already exists', async () => {
      writeSidecar('/tmp/workspace', 'sess-1', 'agent-3', 'end_turn', 'done')
      const seed = [
        ...ackSeed('tu_3', 'agent-3'),
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'agent-3',
          tool_use_id: 'tu_3',
          status: 'completed',
          summary: 'real frame survived in the client cache',
        },
      ] as never[]
      expect(await backfillSubagentCompletions(seed, { cwd: '/tmp/workspace', sessionId: 'sess-1' })).toHaveLength(0)
    })

    it('does not synthesize when the completion reached the transcript via the XML injection path', async () => {
      // Harnesses that deliver background-subagent results as user-role
      // <task-notification> XML have that frame PERSISTED in the jsonl. The
      // notified-scan must recognize it (not just system frames), or every
      // resume would re-synthesize a duplicate that clobbers the XML-captured
      // <result> on the client.
      const seed = [
        ...ackSeed('tu_xml', 'agent-xml'),
        {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{
              type: 'text',
              text: '<task-notification>\n<tool-use-id>tu_xml</tool-use-id>\n<status>completed</status>\n<summary>xml delivery</summary>\n<result>the real result body</result>\n</task-notification>',
            }],
          },
        },
      ] as never[]
      expect(await backfillSubagentCompletions(seed, { cwd: '/tmp/workspace', sessionId: 'sess-1' })).toHaveLength(0)
    })

    it('returns empty for a seed with no launch acks', async () => {
      const seed = [
        { type: 'assistant', uuid: 'a', message: { content: 'plain text' } },
        { type: 'user', uuid: 'u', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'ok' }] } },
      ] as never[]
      expect(await backfillSubagentCompletions(seed, { cwd: '/tmp/workspace', sessionId: 'sess-1' })).toHaveLength(0)
    })

    it('synthesizes only for the acks missing a notification (mixed seed)', async () => {
      writeSidecar('/tmp/workspace', 'sess-1', 'agent-5', 'end_turn', 'five done')
      const seed = [
        ...ackSeed('tu_4', 'agent-4'), // no notification, no sidecar → stopped
        ...ackSeed('tu_5', 'agent-5'), // no notification, sidecar terminal → completed
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'agent-6',
          tool_use_id: 'tu_6',
          status: 'completed',
          summary: 'already notified',
        },
        ...ackSeed('tu_6', 'agent-6'), // ack present AND notification present → skip
      ] as never[]
      const out = await backfillSubagentCompletions(seed, { cwd: '/tmp/workspace', sessionId: 'sess-1' })
      expect(out).toHaveLength(2)
      expect(out.map((m) => (m as { tool_use_id?: string }).tool_use_id).sort()).toEqual(['tu_4', 'tu_5'])
      const byId = new Map(out.map((m) => [(m as { tool_use_id?: string }).tool_use_id, m]))
      expect(byId.get('tu_4')).toMatchObject({ status: 'stopped' })
      expect(byId.get('tu_5')).toMatchObject({ status: 'completed', summary: 'five done' })
    })
  })

  it('resume() backfills missing background-subagent completions into the seeded ring', async () => {
    // A REAL workspace directory — resume() validates the cwd exists.
    const workspace = makeTmpDir()
    const info = await sm.create({ cwd: workspace })
    // The durable sidecar transcript: the agent really finished (end_turn).
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    const readPage = vi.spyOn(
      sm as unknown as { readProviderHistoryPage: (provider: unknown, id: string, opts: { limit: number; afterUuid?: string }) => Promise<unknown> },
      'readProviderHistoryPage',
    )
    try {
      writeSidecar(workspace, info.id, 'agent-bf', 'end_turn', 'DONE — all gates green')

      // Drive the live session to a settled state, then unload.
      mockHandles[0].emit({ type: 'result' })
      await tick()
      await sm.unload(info.id)

      // The disk page (what a restart's resume actually seeds from) carries
      // the Agent tool_use + launch ack but NO task_notification — the CLI
      // never persists one.
      readPage.mockResolvedValue({
        messages: ackSeed('tu_bf', 'agent-bf'),
        totalCount: 2,
        startIndex: 0,
        hasMore: false,
      })

      const resumed = await sm.resume(info.id)

      const hist = sm.getHistory(resumed.id) ?? []
      const notifications = hist.filter((m) => (m as { subtype?: string }).subtype === 'task_notification')
      expect(notifications).toHaveLength(1)
      expect(notifications[0]).toMatchObject({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'tu_bf',
        status: 'completed',
        summary: 'DONE — all gates green',
      })
    } finally {
      readPage.mockRestore()
      if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = realConfigDir
    }
    await sm.delete(info.id)
    rmRf(workspace)
  })

  it('the watcher\'s synthesized notification settles the seeded TaskRecord to terminal', async () => {
    const info = await sm.create({ cwd: '/tmp/workspace' })
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
      const liveTasks = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, { status: string }> }>
      }).sessions.get(info.id)!.tasks
      await waitForIo(() => liveTasks.get('agent-seed')?.status === 'completed')

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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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

  it('rejects a user turn when the provider input is already closed', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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

  it('subscribe() streams live messages (history read via getHistory)', async () => {
    const info = await sm.create({})
    mockHandles[0].emit({ type: 'assistant', message: { content: 'hello' } })
    await tick()

    const sub = sm.subscribe(info.id)
    const ring = sm.getHistory(info.id) as Array<{ type?: string }>
    expect(ring).toHaveLength(1)
    expect(ring[0]).toMatchObject({ type: 'assistant' })

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
      const info = await sm.create({})
      mockHandles[0].emit({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: 'main' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_task', message: { content: 'subagent text' } })
      await tick()
      const s = sessionOf(sm, info.id)
      expect(uuids(s.history)).toEqual(['m1'])
      expect(uuids(s.subagentHistory)).toEqual(['s1'])
    })

    it('subagent volume evicts only subagent frames — the main ring is untouched', async () => {
      const smSmall = new SessionManager({ store, historyCap: 3, subagentHistoryCap: 2 })
      const info = await smSmall.create({})
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
      const info = await sm.create({})
      // Pre-stamp receivedAt (stampReceivedAt is set-only-if-absent, so the
      // pump keeps these) to force a deterministic interleaved order.
      mockHandles[0].emit({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, receivedAt: 1, message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_t', receivedAt: 2, message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 'm2', parent_tool_use_id: null, receivedAt: 3, message: { content: 'x' } })
      await tick()
      const sub = sm.subscribe(info.id)
      expect(uuids(sm.getHistory(info.id) as Array<{ uuid?: string }>)).toEqual(['m1', 's1', 'm2'])
      sub.unsubscribe()
    })

    it('discard() seeds the fork from the renderable transcript (subagent inner frames dropped)', async () => {
      const info = await sm.create({ cwd: dir })
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

      // The seed is X's RENDERABLE transcript up to the anchor — the same set
      // the seq store serves — so the subagent inner frame is not carried into
      // Y (it is dropped by the shared isRenderableSdkMessage gate, exactly
      // what a restart of X shows). Main rows keep their chronological order.
      const sY = sessionOf(sm, y.id)
      expect(uuids(sY.subagentHistory)).toEqual([])
      const mainUuids = uuids(sY.history)
      expect(mainUuids).toEqual([expect.any(String), 'asst-1', 'res-1'])
    })

    it('messageCount counts both rings', async () => {
      const info = await sm.create({})
      mockHandles[0].emit({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's1', parent_tool_use_id: 'tu_t', message: { content: 'x' } })
      mockHandles[0].emit({ type: 'assistant', uuid: 's2', parent_tool_use_id: 'tu_t', message: { content: 'x' } })
      await tick()
      expect(sm.get(info.id).messageCount).toBe(3)
    })

    it('passes forwardSubagentText (resolved from config default) to the SDK Options', async () => {
      await sm.create({})
      // Compare against defaultConfig, not literal true: the test process
      // shares the machine's real ~/.claude-react-web/config.json, and the
      // wiring under test is config → manager → provider → sdkOptions.
      expect(mockHandles.at(-1)!.options.forwardSubagentText).toBe(defaultConfig.forwardSubagentText)
    })

    it('forwards an explicit forwardSubagentText: false override', async () => {
      const smOff = new SessionManager({ store, forwardSubagentText: false })
      await smOff.create({})
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

    it('spawns with the atomic onUserDialog + supportedDialogKinds pair', async () => {
      await sm.create({})
      const opts = mockHandles.at(-1)!.options as {
        onUserDialog?: unknown
        supportedDialogKinds?: string[]
      }
      expect(typeof opts.onUserDialog).toBe('function')
      expect(opts.supportedDialogKinds).toEqual(['refusal_fallback_prompt'])
    })

    it('parks a known-kind dialog via the SDK callback and resolves it via decideDialog', async () => {
      const info = await sm.create({})
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
      const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({ title: 'My Title' })
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
    const info = await sm.create({})
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

    const info = await sm.create({ cwd: '/tmp', model: FULL })
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

    const info = await sm.create({ cwd: '/tmp', model: SHORT })
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
    const info = await sm.create({})
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

  it('clear() carries per-session UI prefs and first-party pins onto Y', async () => {
    // Y has a NEW id, so spawn's persisted-meta fallback can't see X's
    // values — clear() must pass them as the explicit `prefs` arg or every
    // override silently reverts to the global default (and writeStore()
    // then clobbers the on-disk value).
    const info = await sm.create({})
    await sm.setPrefs(info.id, {
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      autoExpandRunningGroups: false,
      showMessageHeaders: false,
    })
    await sm.setFirstPartyTool(info.id, 'git-tools', false)

    const next = await sm.clear(info.id)

    expect(next.showPinnedUserMessage).toBe(false)
    expect(next.autoRecap).toBe(false)
    expect(next.toolGroupCards).toBe(false)
    expect(next.autoExpandRunningGroups).toBe(false)
    expect(next.showMessageHeaders).toBe(false)
    expect(next.firstPartyTools?.['git-tools']).toBe(false)
    // Persisted too, so the next resume/fork of Y keeps them.
    const meta = store.get(next.id)
    expect(meta?.autoExpandRunningGroups).toBe(false)
    expect(meta?.toolGroupCards).toBe(false)
    expect(meta?.firstPartyTools?.['git-tools']).toBe(false)
  })

  it('clear() carries the plugin subset onto Y (a narrowed subset must not widen)', async () => {
    // `undefined` = all enabled, `[]` = none — a dropped subset silently
    // widens the session to every globally-enabled plugin.
    const info = await sm.create({ enabledPlugins: [] } as Parameters<SessionManager['create']>[0])
    expect(info.enabledPlugins).toEqual([])

    const next = await sm.clear(info.id)
    expect(next.enabledPlugins).toEqual([])
    expect(store.get(next.id)?.enabledPlugins).toEqual([])
  })

  it('clear() of an all-default session passes no prefs arg (fallback stays live)', async () => {
    // An empty prefs OBJECT would shadow spawn's `prefs?.field ?? meta?.field`
    // fallback for a future same-id caller; all-undefined must collapse.
    const info = await sm.create({})
    const spawnSpy = vi.spyOn(
      sm as unknown as { spawn: (...args: unknown[]) => unknown },
      'spawn',
    )
    await sm.clear(info.id)
    // args: [id, opts, env, seed, skillOverride, prefs, ...]
    const prefsArg = spawnSpy.mock.calls[0]![5]
    expect(prefsArg).toBeUndefined()
    spawnSpy.mockRestore()
  })

  it('clear() resets stale working state from the interrupted turn', async () => {
    const info = await sm.create({})
    sm.send(info.id, 'busy')
    expect(sm.get(info.id).working).toBe(true)

    const next = await sm.clear(info.id)

    // X is removed from the sidebar (not dormant); Y is a fresh idle session.
    expect(sm.list().find((s) => s.id === info.id)).toBeUndefined()
    expect(sm.get(next.id).working).toBe(false)
    expect(sm.get(next.id).phase).toBe('idle')
  })

  it('clear() drops hook run records on the fresh session', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const parent = await sm.create({ cwd: '/tmp' })
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
    const info = await sm.create({})
    // Assistant frame + result closes the turn: a bare assistant emit leaves
    // pendingTurns=1 (the doClear seeded-clear guard would rightly 409 on a
    // 'working' session), while the real /handoff path only ever reaches the
    // seeded clear from an idle session.
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    expect(sm.getHistory(info.id)!.length).toBeGreaterThanOrEqual(1)

    const next = await sm.clear(info.id, { seedText: 'HAND-OFF SUMMARY', handoff: true })

    // Y's ring holds exactly [boundary, summary] — nothing else.
    const history = sm.getHistory(next.id)!
    expect(history).toHaveLength(2)
    // [0] is the client-facing divider (never sent to the SDK). trigger is
    // 'manual' + the app-level `handoff` flag — a user-invoked /handoff; the
    // flag lets the client render the divider with its own identity instead
    // of the CLI-compact copy.
    const boundary = history[0] as { type: string; subtype: string; handoff?: boolean; compact_metadata: { trigger: string } }
    expect(boundary.type).toBe('system')
    expect(boundary.subtype).toBe('compact_boundary')
    expect(boundary.compact_metadata.trigger).toBe('manual')
    expect(boundary.handoff).toBe(true)
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

  it('clear(id, { seedText }) without handoff keeps the pre-handoff boundary shape (idle-compact plugin path)', async () => {
    // seedCompactSummary also serves SessionManager.compact()'s OTHER caller —
    // the idle-compact plugin's host API, an AUTOMATIC compaction. Its card
    // must keep the pre-/handoff shape: trigger 'auto', no app-level handoff
    // flag — otherwise an automatic compaction renders as a user-invoked
    // "Handoff" card.
    const info = await sm.create({})
    const next = await sm.clear(info.id, { seedText: 'AUTO SUMMARY' })
    const boundary = (sm.getHistory(next.id)!)[0] as { handoff?: boolean; compact_metadata: { trigger: string } }
    expect(boundary.compact_metadata.trigger).toBe('auto')
    expect(boundary.handoff).toBeUndefined()
  })

  it('compact() re-guards the phase after the summarize await (a message raced the window)', async () => {
    // The entry guard cannot see input that arrives DURING the tens-of-seconds
    // summarize await (another tab / a scheduled send firing). Without the
    // post-await re-check that message is silently drained by doClear and
    // lost in the X→Y swap — the 409 turns the race into a loud retryable
    // error and X survives with its message intact. summarizeForCompact is
    // held open (mockImplementationOnce overrides beforeEach's immediate
    // mockResolvedValue) so the send genuinely lands mid-summarize.
    let release!: (v: string) => void
    vi.mocked(summarizeForCompact).mockImplementationOnce(
      () => new Promise<string>((resolve) => { release = resolve }),
    )
    const info = await sm.create({})

    const pending = sm.compact(info.id, { handoff: true })
    // Input lands in X's queue WHILE the summarize is still in flight.
    sm.send(info.id, 'raced the window')
    await tick()
    release('SUMMARY')

    await expect(pending).rejects.toMatchObject({ status: 409 })
    // X was NOT cleared: the raced message stays in the session, undrained.
    expect(sm.get(info.id)).toBeDefined()
    expect(store.get(info.id)).toBeDefined()
  })

  it('clear(id, { seedText }) does not leak the seed into Y persisted metadata', async () => {
    // R3: the boundary + summary are in-memory artifacts of the live ring —
    // never persisted into the store meta (they aren't in the CLI-owned
    // jsonl either). After a restart the divider is absent from the UI but the
    // summary text remains inside the SDK's transcript. Guard against the
    // seed being persisted as a meta field here.
    const info = await sm.create({})
    await tick()
    const next = await sm.clear(info.id, { seedText: 'HAND-OFF SUMMARY' })
    const meta = store.get(next.id)
    expect(meta).toBeDefined()
    expect(JSON.stringify(meta)).not.toContain('HAND-OFF SUMMARY')
  })

  it("compact() keeps X's title on the continuation session Y (plain /clear drops it)", async () => {
    const info = await sm.create({ title: 'My Title' })
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
    const info = await sm.create({})
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
    const info = await sm.create({})
    await sm.sleep(info.id)
    // unload removed it from the live map (listActivity only sees live
    // sessions); get() still resolves it from the store as a dormant meta.
    expect(sm.listActivity().find((a) => a.sessionId === info.id)).toBeUndefined()
    await expect(sm.compact(info.id)).rejects.toMatchObject({ status: 404 })
  })

  it('compact() summarises an idle session and swaps to a fresh seeded session', async () => {
    vi.mocked(summarizeForCompact).mockResolvedValueOnce('HAND-OFF')
    const info = await sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    // A main-thread assistant frame while no turn is accounted now stamps the
    // session working (CLI-driven continuation detection); a real turn ALWAYS
    // ends with a result frame, so emit one to make the stream realistic and
    // the session idle again.
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(2)

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
    const info = await sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    // Turn ran to completion — see the unaccounted-turn stamp note above.
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()

    const next = await sm.compact(info.id)

    // No boundary / summary seeded — Y is a plain empty session.
    expect(sm.getHistory(next.id)!).toHaveLength(0)
    expect(vi.mocked(summarizeForCompact)).toHaveBeenCalledTimes(1)
  })

  it('compact(id, { handoff: true }) refuses instead of silently wiping when the summary is empty', async () => {
    vi.mocked(summarizeForCompact).mockResolvedValueOnce('')
    const info = await sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    const historyBefore = sm.getHistory(info.id)

    // /handoff's contract is "summarize AND continue in a fresh session".
    // An empty summary must not silently degrade into a bare /clear — the
    // user would get a wipe with no boundary and no summary card.
    await expect(sm.compact(info.id, { handoff: true })).rejects.toThrow(/nothing to summarize/i)
    // X survives intact — no swap happened.
    expect(sm.get(info.id)).toBeDefined()
    expect(sm.getHistory(info.id)).toEqual(historyBefore)
  })

  it('two concurrent compacts never double-spawn a fresh session', async () => {
    vi.mocked(summarizeForCompact).mockResolvedValue('HAND-OFF')
    const info = await sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    // Turn ran to completion — see the unaccounted-turn stamp note above.
    mockHandles[0].emit({ type: 'result', session_id: info.id })
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

  it('listActivity() emits coarse activity snapshots for live sessions', async () => {
    const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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

  it('subscribeContextUsage() snapshot is undefined before any result lands', async () => {
    const info = await sm.create({})
    const sub = sm.subscribeContextUsage(info.id)
    expect(sub).not.toBeNull()
    expect(sub!.snapshot).toBeUndefined()
    sub!.unsubscribe()
  })

  it('send() invalidates a stale prompt-suggestion snapshot', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({ title: 'hello', cwd: '/x' })
    await store.flush()
    expect(store.get(info.id)).toMatchObject({ id: info.id, title: 'hello' })

    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await store.flush()
    expect(store.get(info.id)?.lastTurnAt).toBeDefined()
  })

  it('list() merges live sessions with dormant persisted ones', async () => {
    const live = await sm.create({ title: 'live-one' })
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
    const info = await sm.create({})
    sm.send(info.id, 'q')
    expect(sm.get(info.id).working).toBe(true)

    await sm.delete(info.id)
    await store.flush()
    expect(store.get(info.id)).toBeUndefined()
    expect(() => sm.get(info.id)).toThrow(/not found/)
    // unload() → handle.destroy() must close the underlying SDK Query so the
    // CLI subprocess / MCP transports / pending control requests are released.
    const handle = mockHandles.find((h) => h.options.sessionId === info.id || h.options.resume === info.id)
    expect(handle?.close).toHaveBeenCalled()
  })

  it('delete() resolves pending permissions as deny so SDK awaiters never hang', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({})
    sm.send(info.id, 'in-flight')
    expect(sm.get(info.id).working).toBe(true)

    await expect(sm.sleep(info.id)).rejects.toThrow(/working/)
    // The session is untouched — still live and running.
    expect(sm.get(info.id).running).toBe(true)
    expect(mockHandles).toHaveLength(1)
  })

  it('sleep() on an already-dormant session throws (not live)', async () => {
    const info = await sm.create({})
    await sm.sleep(info.id)
    // A second sleep hits requireLive → require → 404 (not in the live map).
    await expect(sm.sleep(info.id)).rejects.toThrow(/not found/)
  })

  it('resume() spawns a new Query with options.resume set to the original id', async () => {
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({})
    const again = await sm.resume(info.id)
    expect(again.id).toBe(info.id)
    // No extra Query was spawned.
    expect(mockHandles).toHaveLength(1)
  })

  it('resume() refuses hard-terminated sessions (deleted / transcript_missing / crash_recovered_fork)', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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

  it('resume() 400s with "Working directory not found" when the session cwd is gone (no spawn)', async () => {
    // Node's spawn reports ENOENT for a missing cwd as well as a missing
    // binary. Without a pre-spawn probe the user is told to reinstall the
    // CLI while the real fault is a moved/deleted project directory.
    const gone = join(dir, 'moved-away')
    const info = await sm.create({ cwd: gone, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    const before = mockHandles.length

    await expect(sm.resume(info.id)).rejects.toThrow(/Working directory not found/)
    // The doomed Query must never be constructed.
    expect(mockHandles.length).toBe(before)
  })

  it('resume() unloads and re-spawns a live transiently-terminated zombie (crash while server is running)', async () => {
    // The pump's cleanup tail sets terminated=true but does NOT unload, so a
    // crashed session lingers in the live map as a dead zombie. resume() must
    // NOT short-circuit return that zombie (which would advertise
    // canRetryResume but do nothing) — it must unload the zombie and fall
    // through to the store/disk path to actually re-spawn. This is the
    // live-crash case (server still running), distinct from the post-restart
    // dormant case covered above.
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({ cwd: '/tmp', model: 'm1' })
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
    const info = await sm.create({ model: 'old' })
    await sm.setModel(info.id, 'new-model')
    expect(mockHandles[0].setModel).toHaveBeenCalledWith('new-model')
    expect(sm.get(info.id).model).toBe('new-model')
  })

  it('setModel() retries once when the CLI cannot confirm the model', async () => {
    const info = await sm.create({ model: 'gw/old' })
    mockHandles[0].setModel.mockRejectedValueOnce(
      new Error('Couldn\'t confirm model "gw/new" with the API. Try again, or run /model to see available models.'),
    )
    await sm.setModel(info.id, 'gw/new')
    expect(mockHandles[0].setModel).toHaveBeenCalledTimes(2)
    expect(sm.get(info.id).model).toBe('gw/new')
  })

  it('setModel() does not retry a policy refusal', async () => {
    const info = await sm.create({ model: 'gw/old' })
    // The CLI's verdict on the REQUEST (entitlement), not a transient probe
    // failure — a second attempt would only repeat it, so this must surface
    // on the first try.
    mockHandles[0].setModel.mockRejectedValue(
      new Error('set_model: model "gw/new" is not allowed on this account'),
    )
    await expect(sm.setModel(info.id, 'gw/new')).rejects.toThrow(/is not allowed/)
    expect(mockHandles[0].setModel).toHaveBeenCalledTimes(1)
    expect(sm.get(info.id).model).toBe('gw/old')
  })

  it('setModel() surfaces the CLI failure when the retry is refused too', async () => {
    const info = await sm.create({ model: 'gw/old' })
    mockHandles[0].setModel.mockRejectedValue(
      new Error('Couldn\'t confirm model "gw/new" with the API. Try again, or run /model to see available models.'),
    )
    await expect(sm.setModel(info.id, 'gw/new')).rejects.toThrow(/Couldn't confirm model "gw\/new"/)
    // Exactly one retry — not a ladder, and not zero.
    expect(mockHandles[0].setModel).toHaveBeenCalledTimes(2)
    expect(sm.get(info.id).model).toBe('gw/old')
  })

  it('setFastMode() records the intent and forwards applyFlagSettings({ fastMode }) to the Query', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
    await sm.setFastMode(info.id, true)
    await store.flush()
    expect(store.get(info.id)?.fastMode).toBe(true)
  })

  it('setEffortLevel() records the level and forwards applyFlagSettings({ effortLevel })', async () => {
    const info = await sm.create({})
    expect(info.effortLevel).toBeUndefined()
    const updated = await sm.setEffortLevel(info.id, 'low')
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'low' })
    expect(updated.effortLevel).toBe('low')
    expect(sm.get(info.id).effortLevel).toBe('low')
  })

  it("setEffortLevel() forwards 'max' (Settings typedef omits it, but the API accepts it)", async () => {
    const info = await sm.create({})
    const updated = await sm.setEffortLevel(info.id, 'max')
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'max' })
    expect(updated.effortLevel).toBe('max')
  })

  it('setEffortLevel() persists the level so it survives resume', async () => {
    const info = await sm.create({})
    await sm.setEffortLevel(info.id, 'xhigh')
    await store.flush()
    expect(store.get(info.id)?.effortLevel).toBe('xhigh')
  })

  // --- auto-compact window (SDK Settings.autoCompactWindow via applyFlagSettings) ---

  it('setAutoCompactWindow() pins a positive token window and enables auto-compact', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
    const updated = await sm.setAutoCompactWindow(info.id, 180000.6)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      autoCompactWindow: 180001,
      autoCompactEnabled: true,
    })
    expect(updated.autoCompactWindow).toBe(180001)
  })

  it('setAutoCompactWindow() with null clears the window but keeps auto-compact enabled', async () => {
    const info = await sm.create({})
    await sm.setAutoCompactWindow(info.id, 180000)
    expect(sm.get(info.id).autoCompactWindow).toBe(180000)
    const updated = await sm.setAutoCompactWindow(info.id, null)
    // Product rule: auto-compact stays ON — clear only drops the pin.
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({
      autoCompactWindow: null,
      autoCompactEnabled: true,
    })
    expect(updated.autoCompactWindow).toBeUndefined()
    expect(sm.get(info.id).autoCompactWindow).toBeUndefined()
  })

  it('setAutoCompactWindow() persists the window so it survives resume', async () => {
    const info = await sm.create({})
    await sm.setAutoCompactWindow(info.id, 100000)
    await store.flush()
    expect(store.get(info.id)?.autoCompactWindow).toBe(100000)
  })

  it('create() marks autoCompactDefaultPending when no window is supplied', async () => {
    const info = await sm.create({})
    expect(store.get(info.id)?.autoCompactDefaultPending).toBe(true)
    expect(sm.get(info.id).autoCompactWindow).toBeUndefined()
  })

  it('create() with an explicit window does not mark pending', async () => {
    const info = await sm.create({ autoCompactWindow: 180000 } as never)
    expect(store.get(info.id)?.autoCompactDefaultPending).toBeUndefined()
    expect(sm.get(info.id).autoCompactWindow).toBe(180000)
  })

  it('applies the default 85% pin once the model window is known, then clears pending', async () => {
    // 1M window: want threshold 850000 → window 883000.
    const info = await sm.create({})
    usageStateOf(info.id).lastContextUsage = {
      totalTokens: 1000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 0.1,
      model: 'claude-opus-4-7',
      maxOutputTokens: 32_000,
    }
    await (sm as unknown as { maybeApplyDefaultAutoCompactWindow: (id: string) => Promise<void> })
      .maybeApplyDefaultAutoCompactWindow(info.id)

    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      autoCompactWindow: 883000,
      autoCompactEnabled: true,
    })
    expect(sm.get(info.id).autoCompactWindow).toBe(883000)
    await store.flush()
    expect(store.get(info.id)?.autoCompactDefaultPending).toBeFalsy()
  })

  it('does not apply the default pin over a user pin or a second time', async () => {
    const info = await sm.create({ autoCompactWindow: 120000 } as never)
    usageStateOf(info.id).lastContextUsage = {
      totalTokens: 1000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 0.1,
      model: 'claude-opus-4-7',
      maxOutputTokens: 32_000,
    }
    ;(sm as unknown as { maybeApplyDefaultAutoCompactWindow: (id: string) => Promise<void> })
      .maybeApplyDefaultAutoCompactWindow(info.id)
    expect(sm.get(info.id).autoCompactWindow).toBe(120000)

    const info2 = await sm.create({})
    usageStateOf(info2.id).lastContextUsage = {
      totalTokens: 1000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.5,
      model: 'm',
    }
    const apply = (sm as unknown as { maybeApplyDefaultAutoCompactWindow: (id: string) => Promise<void> })
      .maybeApplyDefaultAutoCompactWindow.bind(sm)
    await apply(info2.id)
    // 85% is not achievable on 200k (inverse exceeds the window) — leave auto
    // rather than pinning a sticky 200k that mis-fires after a model switch.
    expect(sm.get(info2.id).autoCompactWindow).toBeUndefined()
    await store.flush()
    expect(store.get(info2.id)?.autoCompactDefaultPending).toBeFalsy()
  })

  // --- authoritative auto-compact facts (the CLI's own threshold) ---------
  //
  // The pinned window genuinely reaches the CLI, but the THRESHOLD the
  // ContextBar renders was a local replica of a CLI-internal formula with no
  // way to tell it had drifted. getContextUsage() is the one place the SDK
  // reports the real numbers, so every call to it is harvested, and a pin
  // additionally fires one background probe so the marker settles on the
  // CLI's answer instead of our approximation.

  /** Reach the live Session to seed / inspect the cached usage + facts. */
  const usageStateOf = (id: string) =>
    (sm as unknown as {
      sessions: Map<string, {
        lastContextUsage?: Record<string, unknown>
        lastSdkAutoCompact?: { model: string; threshold?: number }
      }>
    }).sessions.get(id)!

  const seedSnapshot = (id: string) => {
    usageStateOf(id).lastContextUsage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      model: 'claude-opus-4-7',
      autoCompactThreshold: 167000,
      maxOutputTokens: 32000,
    }
  }

  it('contextUsage() harvests the CLI threshold and folds it into the live snapshot', async () => {
    const info = await sm.create({})
    seedSnapshot(info.id)
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      model: 'claude-opus-4-7',
      rawMaxTokens: 200000,
      autoCompactThreshold: 164500,
      isAutoCompactEnabled: true,
      categories: [],
    })

    await sm.contextUsage(info.id)

    expect(usageStateOf(info.id).lastSdkAutoCompact).toMatchObject({
      model: 'claude-opus-4-7',
      threshold: 164500,
    })
    // The bar switches off the derived 167000 without waiting for a turn.
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(164500)
  })

  it('contextUsage() returns the harvested raw response with autoCompactEnabled mapped', async () => {
    const info = await sm.create({})
    const raw = { model: 'm', autoCompactThreshold: 1000, isAutoCompactEnabled: true, categories: [] }
    mockHandles[0].getContextUsage.mockResolvedValueOnce(raw)
    // The raw SDK field is `isAutoCompactEnabled`; we also surface it under our
    // ContextUsage key so the first paint of the orb popover knows. Everything
    // else in the payload rides through untouched.
    await expect(sm.contextUsage(info.id)).resolves.toEqual({
      ...raw,
      autoCompactEnabled: true,
    })
  })

  it('contextUsage() maps autoCompactEnabled even when the response has no model', async () => {
    // parseSdkAutoCompactFacts is model-gated (facts need a model to be
    // trustworthy) — but the boolean is still the CLI's answer and the
    // detailed-payload readers must see it either way.
    const info = await sm.create({})
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 10,
      maxTokens: 100,
      isAutoCompactEnabled: false,
      categories: [],
    })
    const usage = await sm.contextUsage(info.id) as { autoCompactEnabled?: boolean }
    expect(usage.autoCompactEnabled).toBe(false)
  })

  it('contextUsage() tolerates a response with no auto-compact fields', async () => {
    const info = await sm.create({})
    seedSnapshot(info.id)
    mockHandles[0].getContextUsage.mockResolvedValueOnce({ categories: [] })

    await sm.contextUsage(info.id)

    expect(usageStateOf(info.id).lastSdkAutoCompact).toBeUndefined()
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(167000)
  })

  it('setAutoCompactWindow() probes the CLI in the background and lands its threshold', async () => {
    const info = await sm.create({})
    seedSnapshot(info.id)
    // Hold the probe open: getContextUsage has no SDK-side timeout, so the pin
    // response must not be waiting on it.
    let resolveProbe: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { resolveProbe = res }))

    await sm.setAutoCompactWindow(info.id, 113000)
    // The background probe asks for the cheap summary (no per-category
    // token-count API calls) — it only needs the auto-compact facts.
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
    // Pin already committed, with our derived approximation on the bar.
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(80000)

    // The CLI answers 78000 — its number replaces the approximation, with no
    // turn needed in between.
    resolveProbe({
      model: 'claude-opus-4-7',
      autoCompactThreshold: 78000,
      isAutoCompactEnabled: true,
      categories: [],
    })
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.autoCompactThreshold !== 78000; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(78000)
  })

  it('a failing background probe leaves the derived threshold in place', async () => {
    const info = await sm.create({})
    seedSnapshot(info.id)
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('subprocess busy'))

    await sm.setAutoCompactWindow(info.id, 113000)
    for (let i = 0; i < 5; i++) await tick()

    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(80000)
  })

  it('setAutoCompactWindow() skips the probe mid-turn (a busy subprocess stalls control requests)', async () => {
    const info = await sm.create({})
    seedSnapshot(info.id)
    const s = usageStateOf(info.id) as unknown as { pendingTurns: number }
    s.pendingTurns = 1
    mockHandles[0].getContextUsage.mockClear()

    await sm.setAutoCompactWindow(info.id, 113000)
    for (let i = 0; i < 5; i++) await tick()

    expect(mockHandles[0].getContextUsage).not.toHaveBeenCalled()
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(80000)
  })

  it('setModel() drops facts computed for the previous model', async () => {
    const info = await sm.create({})
    seedSnapshot(info.id)
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      model: 'claude-opus-4-7',
      autoCompactThreshold: 164500,
      isAutoCompactEnabled: true,
      categories: [],
    })
    await sm.contextUsage(info.id)
    expect(usageStateOf(info.id).lastSdkAutoCompact).toBeDefined()

    await sm.setModel(info.id, 'claude-haiku-4-7')

    expect(usageStateOf(info.id).lastSdkAutoCompact).toBeUndefined()
  })

  // --- turn-end context-usage reconciliation -------------------------------
  //
  // On aggregate-reporting backends (SDK 0.3.278 + e.g. mify proxies) a
  // result's top-level `usage` is the turn's BILLING SUM across all API calls,
  // so the pump's empty-iterations fallback used to inflate the bar by the
  // call count — a real session cached 995,023/1M = 99.5% while the CLI's own
  // accounting said 16%. The derivation now REFUSES that wire entirely, and
  // every non-empty result that fails to yield a snapshot fires one background
  // getContextUsage() probe whose answer (the CLI's own lens) feeds the bar.

  /** An aggregate-reporting result: usage sums a ~35-call turn, iterations
   *  empty → liteContextUsageFromResult refuses the wire (returns null), so
   *  the pump fires the reconcile dep for it. */
  const emitAggregateResult = () => {
    mockHandles[0].emit({
      type: 'result',
      session_id: 'unused',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      uuid: 'r-agg',
      usage: {
        input_tokens: 81551,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 913472,
        iterations: [],
      },
      modelUsage: { 'zhipuai/glm-5.3-flash': { contextWindow: 1000000, maxOutputTokens: 32000 } },
    })
  }

  /** Seed the polluted aggregate snapshot the pump would have cached before
   *  the derive gate existed — the state every reconcile test starts from. */
  const seedAggregateSnapshot = (id: string) => {
    usageStateOf(id).lastContextUsage = {
      totalTokens: 995023,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 99.5023,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      maxOutputTokens: 32000,
    }
  }

  it('a result fires a background reconcile probe that corrects the cached snapshot', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)
    emitAggregateResult()
    await tick()
    // Precondition: the derive gate refused the aggregate, so the polluted
    // seed is untouched.
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(995023)

    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      categories: [],
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 16,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()

    // The probe asked for the cheap summary (no per-category token-count calls).
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
    const usage = sm.getCachedContextUsage(info.id)
    expect(usage!.totalTokens).toBe(155641)
    expect(usage!.maxTokens).toBe(1000000)
    expect(usage!.percentage).toBeCloseTo((155641 / 1000000) * 100, 5)
    expect(usage!.model).toBe('zhipuai/glm-5.3-flash')
    expect(usage!.autoCompactThreshold).toBe(967000)
    // maxOutputTokens carries forward (model limit, not a billing sum); the
    // per-call buckets do NOT — `last`'s are billing sums on this wire and
    // the summary response reported no apiUsage.
    expect(usage!.maxOutputTokens).toBe(32000)
    expect(usage!.cacheReadTokens).toBeUndefined()
    expect(usage!.degraded).toBeUndefined()
  })

  it('a failing reconcile probe leaves the derived snapshot and clears the in-flight flag', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)

    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('subprocess busy'))
    emitAggregateResult()
    for (let i = 0; i < 5; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(995023)

    // The flag cleared → the NEXT result's probe still fires and lands.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(155641)
  })

  it('the reconcile probe is skipped while one is already in flight', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)

    let resolveProbe: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { resolveProbe = res }))
    emitAggregateResult()
    for (let i = 0; i < 5; i++) await tick()

    // A second result arrives while the first probe is still open — no
    // second control request piles onto the subprocess.
    emitAggregateResult()
    for (let i = 0; i < 5; i++) await tick()
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledTimes(1)

    resolveProbe({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(155641)
  })

  it('the reconcile probe runs even with a turn still pending (queued-input sessions never idle)', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)

    // Simulate the queued-input state: the pump keeps pendingTurns=1 across
    // back-to-back turns, so a pendingTurns skip would starve the correction
    // forever (the exact 73a4960a scenario).
    const s = usageStateOf(info.id) as unknown as { pendingTurns: number }
    s.pendingTurns = 1

    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    // Fire the private reconcile directly (the dep path is covered above);
    // the point is the guard: pendingTurns must NOT skip it.
    ;(sm as unknown as { reconcileContextUsage: (s: unknown) => void }).reconcileContextUsage(s)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()

    expect(mockHandles[0].getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(155641)
  })

  it('a threshold-less reconcile response preserves the CLI threshold the correction carried', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)

    // Probe 1 reports the CLI's OWN threshold — 800000, distinct from the
    // local formula's 967000 for a 1M/32k window.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 800000,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(800000)

    // Probe 2's response omits autoCompactThreshold (e.g. auto-compact
    // disabled at the CLI): the threshold fold must NOT replace the carried
    // CLI number with the local formula (967000).
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 160000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 160000; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(160000)
    expect(sm.getCachedContextUsage(info.id)?.autoCompactThreshold).toBe(800000)
  })

  it('a stale reconcile response never overwrites a newer snapshot', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)

    // Hold a probe open against the CURRENT snapshot object…
    let resolveProbe: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { resolveProbe = res }))
    ;(sm as unknown as { reconcileContextUsage: (s: unknown) => void })
      .reconcileContextUsage(usageStateOf(info.id))
    for (let i = 0; i < 5; i++) await tick()

    // …then the snapshot is replaced while it is in flight (a concurrent
    // updater — e.g. a resume re-seed — landing between fire and response;
    // control requests have no SDK-side timeout, so this ordering is real).
    // Give the new snapshot DIFFERENT numbers so the two are distinguishable.
    usageStateOf(info.id).lastContextUsage = {
      totalTokens: 600000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 60,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
    }
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(600000)

    // The stale response lands — it must NOT drag the bar backwards — and
    // its skip RE-ARMS a fresh probe against the newest snapshot (without
    // the re-arm, a burst of concurrent updates would starve corrections
    // forever). Both payloads are distinctive: a guard failure would land
    // 111111, the re-armed probe's answer lands 155641. Queue the re-arm's
    // answer BEFORE resolving — the cascade runs inside one microtask drain.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    resolveProbe({
      totalTokens: 111111,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(155641)
  })

  /** Seed shape helper for tests that mutate the snapshot object identity. */
  const seedAggregateSnapshotShape = () => ({
    totalTokens: 995023,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: 99.5023,
    model: 'zhipuai/glm-5.3-flash',
    autoCompactThreshold: 967000,
    maxOutputTokens: 32000,
  })

  it('caps stale re-arms so a churning snapshot cannot loop control requests', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)
    // Settle + clear the spawn-time seed probe so the call counts below
    // belong to the reconcile probe alone.
    for (let i = 0; i < 10; i++) await tick()
    mockHandles[0].getContextUsage.mockClear()

    // Four held promises: the direct fire consumes the first; each stale
    // resolve re-arms once, consuming the next. After the 3rd re-arm (cap)
    // the 4th stale resolve must NOT fire a 5th probe.
    const holders: Array<(v: unknown) => void> = []
    for (let i = 0; i < 4; i++) {
      mockHandles[0].getContextUsage.mockReturnValueOnce(
        new Promise((res) => { holders.push(res) }),
      )
    }
    ;(sm as unknown as { reconcileContextUsage: (s: unknown) => void })
      .reconcileContextUsage(usageStateOf(info.id))
    for (let i = 0; i < 5; i++) await tick()
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledTimes(1)

    const resolveStale = (total: number) => {
      holders.shift()!({
        totalTokens: total,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        model: 'zhipuai/glm-5.3-flash',
        autoCompactThreshold: 967000,
        categories: [],
      })
    }

    // Each cycle: the snapshot is replaced by a concurrent updater FIRST
    // (making the held probe stale), then the probe resolves with a
    // distinctive garbage reading (111xxx) the staleness guard must skip.
    // The re-arm then targets the newest snapshot.
    const churn = (total: number) => {
      usageStateOf(info.id).lastContextUsage = { ...seedAggregateSnapshotShape(), totalTokens: total }
    }

    churn(600000)
    resolveStale(111100)
    for (let i = 0; i < 8 && mockHandles[0].getContextUsage.mock.calls.length < 2; i++) await tick()

    churn(610000)
    resolveStale(111200)
    for (let i = 0; i < 8 && mockHandles[0].getContextUsage.mock.calls.length < 3; i++) await tick()

    churn(620000)
    resolveStale(111300)
    for (let i = 0; i < 8 && mockHandles[0].getContextUsage.mock.calls.length < 4; i++) await tick()

    churn(630000)
    resolveStale(111400)
    for (let i = 0; i < 10; i++) await tick()

    // Cap hit after 3 re-arms: exactly 4 probes for the one initial fire; the
    // garbage 111400 never landed and the newest churned snapshot stands.
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledTimes(4)
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(630000)
  })

  it('an identical reconcile reading does not replace the cached snapshot (no churn)', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)
    // First correction lands (fresh numbers).
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    const before = usageStateOf(info.id).lastContextUsage

    // A second probe returning the SAME totals must not replace the object
    // (no redundant broadcast) — steady-state turns that only consumed
    // cached reads hit this every turn.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 10; i++) await tick()
    expect(usageStateOf(info.id).lastContextUsage).toBe(before)
  })

  it('a solo autoCompactEnabled flip still replaces the snapshot (not swallowed by no-churn)', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)
    // First correction lands with auto-compact ON.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.autoCompactEnabled !== true; i++) await tick()

    // Same totals / window / model / threshold — only enabled flips off.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: false,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.autoCompactEnabled !== false; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.autoCompactEnabled).toBe(false)
  })

  it('a wedged reconcile probe times out, frees the in-flight flag, and ignores the late resolve', async () => {
    const info = await sm.create({})
    seedAggregateSnapshot(info.id)

    let neverResolve: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { neverResolve = res }))
    // Fire the reconcile directly with a tiny timeout (the default is 10s —
    // far too slow for a test; the value itself is not what's under test).
    const session = usageStateOf(info.id)
    ;(sm as unknown as { reconcileContextUsage: (s: unknown, timeoutMs?: number) => void })
      .reconcileContextUsage(session, 30)
    // Poll for the timeout to land — no fixed wall-clock sleep (flake risk
    // under loaded CI); bounded at ~3000 polls worst case. NOTE: the poll
    // must be setTimeout(0)-based — an unref'd (or even ref'd) setTimeout
    // NEVER fires while a setImmediate chain is spinning in this
    // environment (measured: 3000 immediates starve a 30ms timer), so the
    // suite's setImmediate tick() would hang here forever.
    const tickMs = () => new Promise((r) => setTimeout(r, 0))
    const flagState = () =>
      (usageStateOf(info.id) as unknown as { contextUsageProbeInFlight?: boolean }).contextUsageProbeInFlight
    for (let i = 0; i < 3000 && flagState() !== false; i++) await tickMs()

    // The timeout freed the flag instead of wedging it for the session's life.
    expect(flagState()).toBe(false)
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(995023)

    // The eventually-resolving subprocess answer must be ignored…
    neverResolve({ totalTokens: 777777, maxTokens: 1000000, model: 'zhipuai/glm-5.3-flash', categories: [] })
    for (let i = 0; i < 5; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(995023)

    // …and the next result's probe still fires and lands.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      categories: [],
    })
    emitAggregateResult()
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(155641)
  })

  // --- zero-turn context-usage seed (init handshake) ------------------------
  //
  // A brand-new session has no `result` yet, so the pump's result-derivation
  // path (and the subscribe seed, which serves the CACHE) can never paint the
  // Context bar. The manager now fires ONE background getContextUsage() probe
  // when the init handshake lands, seeding the snapshot the WS path serves.

  /** The SDK's own answer for a fresh session: system prompt + tools already
   *  occupy real tokens even at zero turns. */
  const freshSessionUsage = {
    categories: [],
    totalTokens: 62000,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 31,
    model: 'claude-sonnet-4-5',
    autoCompactThreshold: 167000,
    isAutoCompactEnabled: true,
    apiUsage: null,
  }

  const emitInit = (id: string) => {
    mockHandles[0].emit({ type: 'system', subtype: 'init', session_id: id, uuid: 'init-1', model: 'claude-sonnet-4-5' })
  }

  /** Settle the spawn-time seed probe: create() now fires it synchronously
   *  (default {} mock → refused, in-flight flag released after a microtask
   *  chain, cooldown stamp set). Every seed scenario below must start from
   *  that quiescent state, or its mock queue gets consumed by whichever
   *  probe happens to fire. The cooldown stamp is reset so scenarios that
   *  seed manually aren't rate-limited by the spawn attempt. */
  const settleSpawnProbe = async (id: string) => {
    for (let i = 0; i < 10; i++) await tick()
    ;(usageStateOf(id) as unknown as { lastContextUsageSeedAt?: number }).lastContextUsageSeedAt = 0
  }

  it('init landing fires a background seed probe that paints the zero-turn bar', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    const sub = sm.subscribeContextUsage(info.id)!
    const it = sub.iterable[Symbol.asyncIterator]()
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockResolvedValueOnce(freshSessionUsage)
    emitInit(info.id)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id) === null; i++) await tick()

    // The probe asked for the cheap summary (no per-category token-count calls).
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledTimes(1)
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
    // The CLI's own numbers seeded the cache…
    const usage = sm.getCachedContextUsage(info.id)
    expect(usage!.totalTokens).toBe(62000)
    expect(usage!.maxTokens).toBe(200000)
    expect(usage!.model).toBe('claude-sonnet-4-5')
    expect(usage!.autoCompactThreshold).toBe(167000)
    expect(usage!.source).toBe('probe')
    // …and the already-attached tab received the snapshot live (bar paints).
    const pushed = (await it.next()).value as { totalTokens?: number }
    expect(pushed.totalTokens).toBe(62000)
    sub.unsubscribe()
  })

  it('a garbage seed answer leaves the cache empty and the session unharmed', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    // Default mock resolves {} — liteContextUsageFromSdkUsage refuses it.
    emitInit(info.id)
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()
  })

  it('a rejected seed probe is silent and does not wedge later usage updates', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('subprocess busy'))
    emitInit(info.id)
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()

    // The first real result still lands its derivation normally.
    mockHandles[0].emit({
      type: 'result',
      session_id: info.id,
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      uuid: 'r-1',
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
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id) === null; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(90_000)
  })

  it('the seed probe is skipped while a turn is already pending (resume with queued input)', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    sm.send(info.id, 'hi')
    mockHandles[0].getContextUsage.mockClear()
    emitInit(info.id)
    for (let i = 0; i < 10; i++) await tick()
    // Mid-turn: the seed stands down; the turn's own result will snapshot.
    expect(mockHandles[0].getContextUsage).not.toHaveBeenCalled()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()
  })

  it('a delayed seed response never overwrites a newer turn-derived snapshot', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    // Seed probe fired at init and HANGS (control responses have no SDK-side
    // timeout — the reason every probe races its own 10s timer).
    let resolveSeed: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { resolveSeed = res }))
    emitInit(info.id)
    for (let i = 0; i < 5; i++) await tick()

    // The user sends; turn 1 completes and the pump derives a FRESH snapshot
    // from the result (90k — the pre-turn seed answer would say 62k).
    mockHandles[0].emit({
      type: 'result',
      session_id: info.id,
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      uuid: 'r-1',
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
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens === undefined; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(90_000)

    // The stale pre-turn seed answer lands afterwards — it must NOT drag the
    // bar backwards (the reconcile probe's lastAtFire guard, mirrored here).
    resolveSeed(freshSessionUsage)
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(90_000)
  })

  it('a seed still in flight does not block turn-1 reconcile on the aggregate wire', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    // Seed probe in flight when turn 1 completes…
    let resolveSeed: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { resolveSeed = res }))
    emitInit(info.id)
    for (let i = 0; i < 5; i++) await tick()

    // …an aggregate-reporting result whose derivation the pump refuses — the
    // reconcile probe is the bar's ONLY corrector there.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      categories: [],
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 16,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    })
    // The reconcile's own staleness re-arm (the seed's answer landing in
    // between invalidates its fire-time identity) consumes one more.
    mockHandles[0].getContextUsage.mockResolvedValueOnce({
      categories: [],
      totalTokens: 155641,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 16,
      model: 'zhipuai/glm-5.3-flash',
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    })
    emitAggregateResult()
    for (let i = 0; i < 5; i++) await tick()

    resolveSeed(freshSessionUsage)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id)?.totalTokens !== 155641; i++) await tick()
    // The CLI-accurate correction for turn 1 landed (not the stale 62k seed).
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(155641)
  })

  it('a completed turn whose own snapshots all failed voids the stale seed answer', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    let resolveSeed: (v: unknown) => void = () => {}
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockReturnValueOnce(new Promise((res) => { resolveSeed = res }))
    emitInit(info.id)
    for (let i = 0; i < 5; i++) await tick()

    // Turn 1 completes on the aggregate wire: the derivation refuses it, the
    // reconcile probe fires and FAILS (a busy subprocess delaying
    // control_response — the failure class the probe timers defend against).
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('control timeout'))
    emitAggregateResult()
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()

    // The seed's pre-turn answer lands last. The turn DID happen — the
    // zero-turn reading must not paint itself as post-turn truth.
    resolveSeed(freshSessionUsage)
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()
  })

  it('spawning a session fires the seed probe immediately (no init-frame dependency)', async () => {
    // The mify-proxy backend can delay the pump's `system/init` frame by
    // minutes (or forever) while control requests answer in ~2s — the seed
    // must therefore fire at spawn, not wait for init.
    const info = await sm.create({})
    // The spawn-time probe is the first control call of the session's life.
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })

    // A valid answer seeds the bar (queue one for the next probe; the spawn
    // probe consumed the default {} mock and was refused).
    await settleSpawnProbe(info.id)
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockResolvedValueOnce(freshSessionUsage)
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id) === null; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(62000)
  })

  it('ensureContextUsageSeed() stands down when the cache already holds a snapshot', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    mockHandles[0].getContextUsage.mockClear()
    mockHandles[0].getContextUsage.mockResolvedValueOnce(freshSessionUsage)
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id) === null; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).not.toBeNull()

    // A second call (another tab subscribing) must not re-probe.
    mockHandles[0].getContextUsage.mockClear()
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 5; i++) await tick()
    expect(mockHandles[0].getContextUsage).not.toHaveBeenCalled()
  })

  it('ensureContextUsageSeed() is a no-op for an unknown session', () => {
    expect(() => sm.ensureContextUsageSeed('ghost')).not.toThrow()
  })

  it('ensureContextUsageSeed() rate-limits repeated attempts while the cache stays empty', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    mockHandles[0].getContextUsage.mockClear()

    // A rejected probe leaves the cache empty…
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('backend down'))
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()

    // …but the attempt stamps the session: an immediate re-trigger (another
    // tab subscribing) must not pile another probe onto a backend that just
    // refused one.
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 5; i++) await tick()
    expect(mockHandles[0].getContextUsage).toHaveBeenCalledTimes(1)

    // Once the cooldown window has passed, the next subscribe retries —
    // this is the self-heal path for a backend that recovered.
    ;(usageStateOf(info.id) as unknown as { lastContextUsageSeedAt?: number }).lastContextUsageSeedAt = Date.now() - 60_000
    mockHandles[0].getContextUsage.mockResolvedValueOnce(freshSessionUsage)
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id) === null; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(62000)
  })

  it('a mid-turn seed attempt is skipped WITHOUT consuming the cooldown window', async () => {
    const info = await sm.create({})
    await settleSpawnProbe(info.id)
    mockHandles[0].getContextUsage.mockClear()

    // Subscribe while a turn is pending: the seed must stand down AND leave
    // the cooldown unstamped — otherwise the post-turn self-heal would wait
    // 15s for an attempt that never ran.
    sm.send(info.id, 'hi')
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 5; i++) await tick()
    expect(mockHandles[0].getContextUsage).not.toHaveBeenCalled()

    // Turn completes on the aggregate wire; its reconcile fails too, so the
    // cache is still empty and the seed is the only remaining source.
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('control timeout'))
    emitAggregateResult()
    for (let i = 0; i < 10; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)).toBeNull()

    // The immediate post-turn subscribe must probe NOW, not in 15s.
    mockHandles[0].getContextUsage.mockResolvedValueOnce(freshSessionUsage)
    sm.ensureContextUsageSeed(info.id)
    for (let i = 0; i < 20 && sm.getCachedContextUsage(info.id) === null; i++) await tick()
    expect(sm.getCachedContextUsage(info.id)?.totalTokens).toBe(62000)
  })

  // --- thinking config (Options.thinking at spawn + setMaxThinkingTokens live) ---

  it("setThinking() maps adaptive → null and forwards setMaxThinkingTokens(null, undefined) — absent display keeps the current mode", async () => {
    const info = await sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'adaptive' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(null, undefined)
    expect(updated.thinking).toEqual({ type: 'adaptive' })
    expect(sm.get(info.id).thinking).toEqual({ type: 'adaptive' })
  })

  it("setThinking() maps disabled → (0, undefined)", async () => {
    const info = await sm.create({})
    await sm.setThinking(info.id, { type: 'disabled' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(0, undefined)
  })

  it("setThinking() maps enabled N → (N, undefined)", async () => {
    const info = await sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'enabled', budgetTokens: 16384 })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(16384, undefined)
    expect(updated.thinking).toEqual({ type: 'enabled', budgetTokens: 16384 })
  })

  it("setThinking() clears the display back to the API default only via the explicit clearDisplay opt", async () => {
    const info = await sm.create({})
    await sm.setThinking(info.id, { type: 'adaptive' }, { clearDisplay: true })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenLastCalledWith(null, null)
  })

  it("setThinking() forwards display as the 2nd param", async () => {
    const info = await sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'adaptive', display: 'omitted' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(null, 'omitted')
    expect(updated.thinking).toEqual({ type: 'adaptive', display: 'omitted' })

    await sm.setThinking(info.id, { type: 'enabled', budgetTokens: 8192, display: 'summarized' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(8192, 'summarized')
    expect(sm.get(info.id).thinking).toEqual({ type: 'enabled', budgetTokens: 8192, display: 'summarized' })
  })

  it("setThinking() forwards display 'highlights' (SDK 0.3.295) as the 2nd param", async () => {
    const info = await sm.create({})
    const updated = await sm.setThinking(info.id, { type: 'adaptive', display: 'highlights' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(null, 'highlights')
    expect(updated.thinking).toEqual({ type: 'adaptive', display: 'highlights' })
  })

  it("spawn strips display:'highlights' from Options.thinking (spawn union is summarized|omitted only) and re-applies it post-spawn", async () => {
    // Cast: 'highlights' is deliberately NOT in the SDK spawn-time
    // ThinkingConfig union — it arrives here from the persisted intent, and
    // the strip under test is what keeps the spawn options type-honest.
    await sm.create({ thinking: { type: 'enabled', budgetTokens: 8192, display: 'highlights' } as unknown as Options['thinking'] })
    // Spawn options carry the budget intent but NOT the highlights display.
    expect(mockHandles[0].options.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
    // Post-spawn re-apply RE-STATES the spawn-time budget explicitly (the
    // same N the spawn options carry) rather than relying on null's
    // "reset to the spawn-time budget" defaulting.
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(8192, 'highlights')
  })

  it("spawn re-applies highlights with tokens null for adaptive (no budget to restate)", async () => {
    await sm.create({ thinking: { type: 'adaptive', display: 'highlights' } as unknown as Options['thinking'] })
    expect(mockHandles[0].options.thinking).toEqual({ type: 'adaptive' })
    expect(mockHandles[0].setMaxThinkingTokens).toHaveBeenCalledWith(null, 'highlights')
  })

  it('readMcpAppResource() delegates to the handle readMcpResource (MCP Apps ui:// read)', async () => {
    const info = await sm.create({})
    const r = await sm.readMcpAppResource(info.id, 'basic', 'ui://get-time/mcp-app.html') as {
      contents?: Array<{ uri?: string; mimeType?: string }>
    }
    expect(mockHandles[0].readMcpResource).toHaveBeenCalledWith('basic', 'ui://get-time/mcp-app.html')
    expect(r.contents?.[0]).toMatchObject({ uri: 'ui://get-time/mcp-app.html', mimeType: 'text/html;profile=mcp-app' })
  })

  it("spawn forwards non-highlights thinking displays verbatim (no strip, no post-spawn re-apply)", async () => {
    await sm.create({ thinking: { type: 'adaptive', display: 'summarized' } })
    expect(mockHandles[0].options.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(mockHandles[0].setMaxThinkingTokens).not.toHaveBeenCalled()
  })

  it('setCwd() relocates the workspace and clears a stale spawn_failed error', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    // Simulate the spawn_failed aftermath we are recovering from.
    const stale = store.get(info.id)!
    store.upsert({
      ...stale,
      terminated: false,
      terminatedReason: 'spawn_failed',
      error: 'Working directory not found: /gone',
    })

    const next = join(dir, 'moved', 'web')
    mkdirSync(next, { recursive: true })
    const updated = await sm.setCwd(info.id, next)

    expect(updated.cwd).toBe(next)
    expect(store.get(info.id)!.cwd).toBe(next)
    // A workspace fix is exactly how the user clears this class of failure.
    expect(store.get(info.id)!.error).toBeUndefined()
    expect(store.get(info.id)!.terminatedReason).toBeUndefined()
    // Git anchors belong to the OLD tree and must not keep grouping this
    // session with the previous repo's snapshots.
    expect(store.get(info.id)!.repoRoot).toBeUndefined()
    expect(store.get(info.id)!.gitStartSha).toBeUndefined()
  })

  it('setCwd() 409s on a running session (the live CLI keeps its spawn cwd)', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    const next = join(dir, 'moved')
    mkdirSync(next, { recursive: true })
    await expect(sm.setCwd(info.id, next)).rejects.toThrow(/sleep it first/)
    expect(store.get(info.id)!.cwd ?? sm.get(info.id).cwd).toBe(dir)
  })

  it('setCwd() 400s when the directory does not exist', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    return (async () => {
      await tick()
      await sm.unload(info.id)
      await expect(sm.setCwd(info.id, join(dir, 'no-such-subdir'))).rejects.toThrow(
        /Working directory not found/,
      )
      expect(store.get(info.id)!.cwd).toBe(dir)
    })()
  })

  it('setCwd() 400s on an empty cwd string', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    return (async () => {
      await tick()
      await sm.unload(info.id)
      await expect(sm.setCwd(info.id, '')).rejects.toThrow(/Working directory not found/)
    })()
  })

  it('setCwd() un-kills a transcript_missing session (relocating is the recovery)', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    // The pre-id-scoped hasTranscript bug used to mark relocated sessions
    // transcript_missing. PATCH cwd must let the id-scoped probe retry.
    store.upsert({
      ...store.get(info.id)!,
      terminated: true,
      terminatedReason: 'transcript_missing',
    })
    const next = join(dir, 'moved')
    mkdirSync(next, { recursive: true })
    const updated = await sm.setCwd(info.id, next)
    expect(updated.terminated).toBe(false)
    expect(store.get(info.id)!.terminated).toBe(false)
    expect(store.get(info.id)!.terminatedReason).toBeUndefined()
  })

  it('setCwd() 400s when the path is a file, not a directory', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'x')
    return (async () => {
      await tick()
      await sm.unload(info.id)
      await expect(sm.setCwd(info.id, file)).rejects.toThrow(/Working directory not found/)
    })()
  })

  it('resume() after setCwd still finds the transcript (probe is id-scoped, not cwd-scoped)', async () => {
    // Regression for the relocate path: hasTranscript used to pass `dir:
    // meta.cwd`, so after PATCH cwd the probe looked in the NEW path's
    // encoded projects/ subtree, missed the jsonl under the OLD encoding,
    // and markTranscriptMissing permanently killed the session.
    const info = await sm.create({ cwd: dir, model: 'm1' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    await sm.unload(info.id)

    const next = join(dir, 'moved')
    mkdirSync(next, { recursive: true })
    await sm.setCwd(info.id, next)
    mockGetSessionInfo.mockClear()

    const resumed = await sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(mockGetSessionInfo).toHaveBeenCalled()
    // Id-scoped: no `dir` argument that would scope the lookup to `next`.
    const probeArgs = mockGetSessionInfo.mock.calls[0]
    expect(probeArgs?.[1]?.dir).toBeUndefined()
    expect(store.get(info.id)?.terminatedReason).not.toBe('transcript_missing')
  })

  it('setCwd() during a resume waits for it, then 409s on the now-live session', async () => {
    // TOCTOU: doResume reads meta, awaits (transcript/history/MCP), then
    // spawn() writeStores a WHOLESALE replace from that earlier snapshot.
    // A PATCH cwd landing in the await window would be silently reverted.
    // The per-session op lock queues it behind the resume instead; once the
    // resume has spawned, the session is live and the dormant-only guard
    // refuses the relocate.
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)

    let releaseProbe!: () => void
    mockGetSessionInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = () => resolve({ sessionId: info.id })
        }),
    )

    const next = join(dir, 'moved')
    mkdirSync(next, { recursive: true })

    const resuming = sm.resume(info.id)
    await tick() // doResume is now parked on the transcript probe

    let settled = false
    const relocating = sm.setCwd(info.id, next)
    void relocating.then(() => { settled = true }, () => { settled = true })
    await tick()
    // Queued behind the resume — neither applied nor refused yet.
    expect(settled).toBe(false)
    expect(store.get(info.id)!.cwd).toBe(dir)

    releaseProbe()
    await resuming
    await expect(relocating).rejects.toThrow(/sleep it first/)
    expect(store.get(info.id)!.cwd).toBe(dir)
    // Once dormant again, a relocate works.
    await sm.unload(info.id)
    expect((await sm.setCwd(info.id, next)).cwd).toBe(next)
    expect(store.get(info.id)!.cwd).toBe(next)
  })

  it('rename() during a resume waits for it, then applies to the live session', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)

    let releaseProbe!: () => void
    mockGetSessionInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = () => resolve({ sessionId: info.id })
        }),
    )

    const resuming = sm.resume(info.id)
    await tick()

    let settled = false
    const renaming = sm.rename(info.id, 'Renamed mid-resume')
    void renaming.then(() => { settled = true }, () => { settled = true })
    await tick()
    expect(settled).toBe(false)
    expect(store.get(info.id)!.title).not.toBe('Renamed mid-resume')

    releaseProbe()
    await resuming
    expect((await renaming).title).toBe('Renamed mid-resume')
    // Applied AFTER the spawn's wholesale writeStore, so it isn't reverted.
    expect(sm.get(info.id).running).toBe(true)
    expect(sm.get(info.id).title).toBe('Renamed mid-resume')
    expect(store.get(info.id)!.title).toBe('Renamed mid-resume')
  })

  it('a dormant rename survives the next resume (title carry path)', async () => {
    const info = await sm.create({ cwd: dir, model: 'm1', title: 'old' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    await sm.rename(info.id, 'dormant title')
    const resumed = await sm.resume(info.id)
    expect(resumed.title).toBe('dormant title')
    expect(store.get(info.id)!.title).toBe('dormant title')
  })

  it('setThinking() persists display so it survives resume', async () => {
    const info = await sm.create({})
    await sm.setThinking(info.id, { type: 'adaptive', display: 'omitted' })
    await store.flush()
    expect(store.get(info.id)?.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
  })

  it("setThinking() 400s on enabled-without-budget (not expressible via setMaxThinkingTokens)", async () => {
    const info = await sm.create({})
    await expect(sm.setThinking(info.id, { type: 'enabled' })).rejects.toThrow('budgetTokens')
    expect(mockHandles[0].setMaxThinkingTokens).not.toHaveBeenCalled()
  })

  it('setThinking() persists the setting so it survives resume', async () => {
    const info = await sm.create({})
    await sm.setThinking(info.id, { type: 'disabled' })
    await store.flush()
    expect(store.get(info.id)?.thinking).toEqual({ type: 'disabled' })
  })

  it('create({ thinking }) forwards Options.thinking to the SDK and records it', async () => {
    const info = await sm.create({ thinking: { type: 'enabled', budgetTokens: 8192 } } as unknown as Parameters<typeof sm.create>[0])
    expect(mockHandles[0].options.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
    expect(info.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
  })

  it('fork() carries the thinking config onto the new session', async () => {
    const source = await sm.create({})
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

  // --- task budget (Options.taskBudget at spawn; no live setter exists) ---

  it('create({ taskBudget }) forwards Options.taskBudget to the SDK and records it', async () => {
    const info = await sm.create({ taskBudget: { total: 64000 } } as unknown as Parameters<typeof sm.create>[0])
    expect(mockHandles[0].options.taskBudget).toEqual({ total: 64000 })
    expect(info.taskBudget).toEqual({ total: 64000 })
  })

  it('setTaskBudget() records the intent without contacting the SDK (no live setter exists)', async () => {
    const info = await sm.create({})
    expect(info.taskBudget).toBeUndefined()
    const flagCalls = mockHandles[0].applyFlagSettings.mock.calls.length
    const updated = await sm.setTaskBudget(info.id, { total: 128000 })
    expect(mockHandles[0].applyFlagSettings.mock.calls.length).toBe(flagCalls)
    expect(updated.taskBudget).toEqual({ total: 128000 })
    expect(sm.get(info.id).taskBudget).toEqual({ total: 128000 })
  })

  it('setTaskBudget() persists the intent so it survives resume', async () => {
    const info = await sm.create({})
    await sm.setTaskBudget(info.id, { total: 96000 })
    await store.flush()
    expect(store.get(info.id)?.taskBudget).toEqual({ total: 96000 })
  })

  it('setTaskBudget(undefined) clears the budget locally and in the store', async () => {
    const info = await sm.create({})
    await sm.setTaskBudget(info.id, { total: 96000 })
    const cleared = await sm.setTaskBudget(info.id, undefined)
    expect(cleared.taskBudget).toBeUndefined()
    await store.flush()
    expect(store.get(info.id)?.taskBudget).toBeUndefined()
  })

  it('fork() carries the task budget onto the new session', async () => {
    const source = await sm.create({})
    await sm.setTaskBudget(source.id, { total: 64000 })
    sm.send(source.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    const forked = await sm.fork(source.id)
    expect(forked.taskBudget).toEqual({ total: 64000 })
    // Task budget is a spawn-time Options key — the fork's fresh Query must
    // have received it directly.
    expect(mockHandles[1].options.taskBudget).toEqual({ total: 64000 })
  })

  it('clear() carries the task budget onto the fresh session spawn', async () => {
    const info = await sm.create({})
    await sm.setTaskBudget(info.id, { total: 64000 })
    const cleared = await sm.clear(info.id)
    expect(cleared).toBeDefined()
    const newHandle = mockHandles[mockHandles.length - 1]
    expect(newHandle.options.taskBudget).toEqual({ total: 64000 })
  })

  it('setTaskBudget() works on a dormant session (pure local intent, no SDK contact)', async () => {
    const info = await sm.create({})
    await sm.setTaskBudget(info.id, { total: 64000 })
    // Unload the session so it goes dormant — the budget edit targets the
    // NEXT spawn, so the dormant state must not 410 the write.
    await sm.unload(info.id)
    const updated = await sm.setTaskBudget(info.id, { total: 96000 })
    expect(updated.taskBudget).toEqual({ total: 96000 })
    // The respawn picks the intent up.
    await sm.resume(info.id)
    expect(mockHandles[mockHandles.length - 1].options.taskBudget).toEqual({ total: 96000 })
  })

  it('start-as agent rides create into the SDK + meta; fork carries it while enabled, drops it when disabled', async () => {
    const defs: Record<string, { enabled: boolean }> = { reviewer: { enabled: true } }
    const agentStore = {
      get: (n: string) => defs[n],
      getEnabledDefinitions: () => Object.fromEntries(
        Object.entries(defs).filter(([, d]) => d.enabled).map(([n]) => [n, { description: n }]),
      ),
    } as unknown as AgentDefinitionStore
    const sm2 = new SessionManager({ store, agentStore })
    try {
      // create with a start-as agent → SDK receives Options.agent, meta persists it
      const info = await sm2.create({ model: 'test-model', agent: 'reviewer' })
      expect(mockHandles[0].options.agent).toBe('reviewer')
      expect(store.get(info.id)?.agent).toBe('reviewer')

      // give the source a completed turn so fork() will allow the branch
      sm2.send(info.id, 'hi')
      mockHandles[0].emit({ type: 'result' })
      await tick()

      // fork while the def is still enabled → the fork's fresh Query carries it
      const forked = await sm2.fork(info.id)
      expect(mockHandles[1].options.agent).toBe('reviewer')
      expect(store.get(forked.id)?.agent).toBe('reviewer')

      // disable the def → subsequent fork drops the agent (persona gone)
      defs.reviewer = { enabled: false }
      const forked2 = await sm2.fork(info.id)
      expect(mockHandles[2].options.agent).toBeUndefined()
      expect(store.get(forked2.id)?.agent).toBeUndefined()
    } finally {
      await sm2.shutdown()
    }
  })

  it('thinkingSupported is classified from the model id at spawn', async () => {
    const opus = await sm.create({ model: 'claude-opus-4-8' })
    expect(sm.get(opus.id).thinkingSupported).toBe(true)
    expect(opus.thinkingSupported).toBe(true)
    const haiku = await sm.create({ model: 'claude-haiku-4-5' })
    expect(haiku.thinkingSupported).toBe(false)
    const other = await sm.create({ model: 'deepseek/deepseek-v4-pro' })
    expect(other.thinkingSupported).toBe(false)
  })

  it('setModel() recomputes thinkingSupported for the new model', async () => {
    const info = await sm.create({ model: 'claude-opus-4-8' })
    expect(sm.get(info.id).thinkingSupported).toBe(true)
    const updated = await sm.setModel(info.id, 'deepseek/deepseek-v4-pro')
    expect(updated.thinkingSupported).toBe(false)
    await sm.setModel(info.id, 'claude-sonnet-4-6')
    expect(sm.get(info.id).thinkingSupported).toBe(true)
  })

  // --- accountInfo (SDK accountInfo control read) ---

  it('accountInfo() forwards the control request and narrows the raw response', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
    mockHandles[0].accountInfo.mockResolvedValueOnce({ email: '  ', apiProvider: 'not-a-provider' })
    expect(await sm.accountInfo(info.id)).toBeUndefined()
    mockHandles[0].accountInfo.mockResolvedValueOnce(null)
    expect(await sm.accountInfo(info.id)).toBeUndefined()
  })

  it('accountInfo() 404s for an unknown session', async () => {
    await expect(sm.accountInfo('nope')).rejects.toThrow()
  })

  // --- rewindFiles (shadow-repo snapshot rewind) ---

  /** Spy on the SessionManager's internal SnapshotService so tests don't
   *  spawn a real git subprocess. Returns the spies so each test can wire
   *  its own resolved values. */
  const spySnapshots = () => {
    const any = sm as unknown as { snapshots: { dryRun: ReturnType<typeof vi.fn>; rewind: ReturnType<typeof vi.fn>; capture: ReturnType<typeof vi.fn>; recordAnchor: ReturnType<typeof vi.fn> } }
    return {
      dryRun: vi.spyOn(any.snapshots, 'dryRun').mockResolvedValue({ canRewind: false, error: 'stub' }),
      rewind: vi.spyOn(any.snapshots, 'rewind').mockResolvedValue({ canRewind: false, error: 'stub' }),
      capture: vi.spyOn(any.snapshots, 'capture').mockResolvedValue(null),
      recordAnchor: vi.spyOn(any.snapshots, 'recordAnchor').mockResolvedValue(undefined),
    }
  }

  it('rewindFiles() delegates to snapshots.dryRun and narrows the result', async () => {
    const spies = spySnapshots()
    const info = await sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    // Complete the turn so the session is idle (phase guard passes).
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    spies.dryRun.mockResolvedValueOnce({
      canRewind: true,
      filesChanged: ['a.ts', ''],
      insertions: 2,
      deletions: '5', // junk type — narrowed out
      diffs: [{ file: 'a.ts', status: 'modified', additions: 2, deletions: 1 }],
    })
    const res = await sm.rewindFiles(info.id, sent.uuid!, { dryRun: true })
    // dryRun was called with the server user uuid — no SDK uuid mapping.
    expect(spies.dryRun).toHaveBeenCalledWith(info.id, sent.uuid)
    // diffs field dropped; bad types stripped; canRewind + valid stats kept.
    expect(res).toEqual({ canRewind: true, filesChanged: ['a.ts'], insertions: 2 })
    // Real rewind not called on a dry-run.
    expect(spies.rewind).not.toHaveBeenCalled()
  })

  it('rewindFiles() delegates to snapshots.rewind for a real rewind', async () => {
    const spies = spySnapshots()
    const info = await sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    spies.rewind.mockResolvedValueOnce({ canRewind: true, filesChanged: ['a.ts'] })
    const res = await sm.rewindFiles(info.id, sent.uuid!)
    expect(spies.rewind).toHaveBeenCalledWith(info.id, sent.uuid)
    expect(res.canRewind).toBe(true)
    expect(res.filesChanged).toEqual(['a.ts'])
  })

  it('rewindFiles() 409s while the session is working on a REAL rewind', async () => {
    const spies = spySnapshots()
    const info = await sm.create({})
    const sent = sm.send(info.id, 'hi') // pendingTurns=1 → phase 'working'
    await expect(sm.rewindFiles(info.id, sent.uuid!)).rejects.toThrow('working')
    expect(spies.rewind).not.toHaveBeenCalled()
    spies.dryRun.mockRestore?.()
    spies.rewind.mockRestore?.()
  })

  it('rewindFiles() allows a dry-run while the session is working', async () => {
    const spies = spySnapshots()
    const info = await sm.create({})
    const sent = sm.send(info.id, 'hi') // pendingTurns=1 → phase 'working'
    spies.dryRun.mockResolvedValueOnce({ canRewind: true, filesChanged: ['x.ts'] })
    const res = await sm.rewindFiles(info.id, sent.uuid!, { dryRun: true })
    expect(spies.dryRun).toHaveBeenCalledWith(info.id, sent.uuid)
    expect(res.canRewind).toBe(true)
  })

  it('rewindFiles() 404s for an unknown session', async () => {
    const spies = spySnapshots()
    await expect(sm.rewindFiles('nope', 'U1')).rejects.toThrow(/not found/i)
    expect(spies.rewind).not.toHaveBeenCalled()
    expect(spies.dryRun).not.toHaveBeenCalled()
  })

  it('rewindFiles() broadcasts a git-status refresh after a real rewind (not a dry run)', async () => {
    const spies = spySnapshots()
    const bcast = vi.spyOn(sm, 'broadcastGitStatusChanged').mockImplementation(() => {})
    const info = await sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    spies.dryRun.mockResolvedValueOnce({ canRewind: true })
    spies.rewind.mockResolvedValueOnce({ canRewind: true })
    await sm.rewindFiles(info.id, sent.uuid!, { dryRun: true })
    expect(bcast).not.toHaveBeenCalled()
    await sm.rewindFiles(info.id, sent.uuid!)
    expect(bcast).toHaveBeenCalledWith(info.id)
    bcast.mockRestore()
  })

  it('rewindFiles() does NOT broadcast when rewind reports canRewind=false', async () => {
    const spies = spySnapshots()
    const bcast = vi.spyOn(sm, 'broadcastGitStatusChanged').mockImplementation(() => {})
    const info = await sm.create({})
    const sent = sm.send(info.id, 'edit a file')
    mockHandles[0].emit({ type: 'result', subtype: 'success' })
    await tick()
    spies.rewind.mockResolvedValueOnce({ canRewind: false, error: 'no snapshot' })
    await sm.rewindFiles(info.id, sent.uuid!)
    expect(bcast).not.toHaveBeenCalled()
    bcast.mockRestore()
  })

  it('send() captures a snapshot anchor before dispatch (fire-and-forget)', async () => {
    const spies = spySnapshots()
    const info = await sm.create({ cwd: dir })
    spies.capture.mockResolvedValueOnce('tree-1')
    sm.send(info.id, 'hi')
    // Capture was invoked synchronously (fire-and-forget but started
    // before dispatch). recordAnchor runs after capture resolves.
    await tick()
    await tick()
    expect(spies.capture).toHaveBeenCalledWith({ sessionId: info.id, cwd: dir })
    expect(spies.recordAnchor).toHaveBeenCalledWith(info.id, dir, expect.any(String), 'tree-1')
  })

  it('send() never blocks on capture failure (continues to dispatch)', async () => {
    const spies = spySnapshots()
    spies.capture.mockRejectedValueOnce(new Error('git missing'))
    const info = await sm.create({ cwd: dir })
    // send must not throw even though capture rejects.
    const sent = sm.send(info.id, 'hi')
    expect(sent.uuid).toBeTruthy()
    // The user message reached the ring (dispatch ran).
    expect(sm.getHistory(info.id)?.some((m) => (m as { uuid?: string }).uuid === sent.uuid)).toBe(true)
  })

  it('queued send defers the anchor and captures on consume (no re-defer loop)', async () => {
    const spies = spySnapshots()
    spies.capture.mockResolvedValue('tree-q')
    const info = await sm.create({ cwd: dir })
    // First send starts a turn — session is now working.
    sm.send(info.id, 'first')
    // Second send is queued while working: must NOT capture at enqueue.
    const queued = sm.send(info.id, 'second')
    expect(spies.capture).toHaveBeenCalledTimes(1) // only the idle first send
    // Consume time is the correct pre-turn tree. Call onInputConsumed
    // directly (the critical regression: captureAnchor re-checks idle, and
    // at consume time pendingTurns is still >= 1, which would re-defer
    // forever and orphan the anchor).
    const smAny = sm as unknown as {
      onInputConsumed: (id: string, msg: unknown) => void
    }
    smAny.onInputConsumed(info.id, {
      type: 'user',
      uuid: queued.uuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'second' },
    })
    await tick()
    await tick()
    expect(spies.capture).toHaveBeenCalledTimes(2)
    expect(spies.recordAnchor).toHaveBeenCalledWith(info.id, dir, queued.uuid, 'tree-q')
  })

  // --- readFile: SDK readFile + CLI read-state seeding (seedReadState) ---

  it('readFile() seeds the CLI read-state cache after a successful read', async () => {
    const info = await sm.create({})
    mockHandles[0].readFile.mockResolvedValueOnce({ available: true, contents: 'body' })
    const statMock = nodeFs.stat as MockedFunction<typeof nodeFs.stat>
    statMock.mockResolvedValue({ mtimeMs: 12345.9 } as Awaited<ReturnType<typeof nodeFs.stat>>)
    try {
      const res = await sm.readFile(info.id, '/repo/a.txt')
      expect(res).toEqual({ available: true, contents: 'body' })
      // mtime floored to whole ms — the SDK compares against this.
      expect(statMock).toHaveBeenCalledWith('/repo/a.txt')
      expect(mockHandles[0].seedReadState).toHaveBeenCalledWith('/repo/a.txt', 12345)
    } finally {
      statMock.mockReset()
    }
  })

  it('readFile() does not seed when the read is denied or missing', async () => {
    const info = await sm.create({})
    mockHandles[0].readFile.mockResolvedValueOnce({ available: false })
    const res = await sm.readFile(info.id, '/repo/secret.txt')
    expect(res).toEqual({ available: false })
    expect(mockHandles[0].seedReadState).not.toHaveBeenCalled()
  })

  it('readFile() still returns contents when seeding fails (best-effort)', async () => {
    const info = await sm.create({})
    mockHandles[0].readFile.mockResolvedValueOnce({ available: true, contents: 'body' })
    const statMock = nodeFs.stat as MockedFunction<typeof nodeFs.stat>
    statMock.mockRejectedValueOnce(new Error('ENOENT'))
    try {
      const res = await sm.readFile(info.id, '/repo/a.txt')
      expect(res).toEqual({ available: true, contents: 'body' })
      expect(mockHandles[0].seedReadState).not.toHaveBeenCalled()
    } finally {
      statMock.mockReset()
    }
  })

  // --- tool-profile (per-session built-in tool surface) ---

  it('captures create-body tool fields into the session tool profile and projects them at spawn', async () => {
    const info = await sm.create({ tools: ['Bash'], allowedTools: ['Read'] })
    expect(sm.getToolProfile(info.id)).toEqual({ tools: ['Bash'], allowedTools: ['Read'] })
    expect(mockHandles[0].options.tools).toEqual(['Bash'])
    expect(mockHandles[0].options.allowedTools).toEqual(['Read'])
  })

  it('setToolProfile()/getToolProfile() round-trip a RAM-only profile and clear it with undefined', async () => {
    const info = await sm.create({})
    expect(sm.getToolProfile(info.id)).toBeUndefined()
    await sm.setToolProfile(info.id, { tools: ['Edit'], toolAliases: { Bash: 'mcp__ws__bash' } })
    expect(sm.getToolProfile(info.id)).toEqual({ tools: ['Edit'], toolAliases: { Bash: 'mcp__ws__bash' } })
    await sm.setToolProfile(info.id, undefined)
    expect(sm.getToolProfile(info.id)).toBeUndefined()
  })

  it('create-body passthrough wins over a session tool profile at spawn', async () => {
    const info = await sm.create({ tools: ['Edit'] }) // body passes tools through
    await sm.setToolProfile(info.id, { tools: ['Bash'] }) // later RAM profile
    const cleared = await sm.clear(info.id)
    expect(cleared).toBeDefined()
    const newHandle = mockHandles[mockHandles.length - 1]
    // /clear rebuilds opts from the session/meta, so the body-only passthrough
    // is gone and the RAM tool profile carries — projected as 'Bash'.
    expect(newHandle.options.tools).toEqual(['Bash'])
  })

  it('clear() carries the RAM tool profile onto the fresh session spawn', async () => {
    const info = await sm.create({})
    await sm.setToolProfile(info.id, { tools: ['Edit'], disallowedTools: ['WebFetch'] })
    const cleared = await sm.clear(info.id)
    expect(cleared).toBeDefined()
    const newHandle = mockHandles[mockHandles.length - 1]
    expect(newHandle.options.tools).toEqual(['Edit'])
    expect(newHandle.options.disallowedTools).toEqual(['WebFetch'])
  })

  it('setToolProfile() requires a live session', async () => {
    await expect(sm.setToolProfile('nope', { tools: ['Bash'] })).rejects.toThrow('not found')
  })

  it('autoGenerateTitle persists a generated title on an untitled session, exactly once', async () => {
    const info = await sm.create({ cwd: '/tmp' })
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
    const info = await sm.create({ cwd: '/tmp', title: 'My session' })
    const handle = mockHandles[mockHandles.length - 1]
    const titled = await sm.autoGenerateTitle(info.id, 'should be ignored')
    expect(titled.title).toBe('My session')
    expect(handle.generateSessionTitle).not.toHaveBeenCalled()
  })

  it('autoGenerateTitle does not clobber a rename that landed while the LLM call was in flight', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const handle = mockHandles[mockHandles.length - 1]
    let release!: (v: string) => void
    handle.generateSessionTitle.mockImplementationOnce(
      () => new Promise<string>((r) => { release = r }),
    )
    const pending = sm.autoGenerateTitle(info.id, 'Refactor the checkout flow')
    // The generate call starts synchronously inside the async body, so the
    // deferred promise exists by the time autoGenerateTitle returns.
    await sm.rename(info.id, 'User named')
    release('LLM title')
    const titled = await pending
    expect(titled.title).toBe('User named')
  })

  it('setMemorySettings() forwards only present keys and records them on the session', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
    const updated = await sm.setMemorySettings(info.id, {})
    expect(mockHandles[0].applyFlagSettings).not.toHaveBeenCalled()
    expect(updated.memory).toBeUndefined()
  })

  it('setMemorySettings() null clears a key; clearing the last key drops the object', async () => {
    const info = await sm.create({})
    await sm.setMemorySettings(info.id, { autoMemoryEnabled: true })
    await sm.setMemorySettings(info.id, { autoMemoryEnabled: null })
    // null forwards to the SDK so the flag tier clears too.
    expect(mockHandles[0].applyFlagSettings).toHaveBeenLastCalledWith({ autoMemoryEnabled: null })
    expect(sm.get(info.id).memory).toBeUndefined()
  })

  it('setMemorySettings() forwards a trimmed directory and null-normalises whitespace-only', async () => {
    const info = await sm.create({})
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
    const info = await sm.create({})
    await sm.setMemorySettings(info.id, { autoMemoryEnabled: true, autoDreamEnabled: false })
    await store.flush()
    expect(store.get(info.id)?.memory).toEqual({ autoMemoryEnabled: true, autoDreamEnabled: false })
  })

  it('create({ memory }) seeds the session intent and re-applies it at spawn', async () => {
    // `memory` is an app-level create-body field (not an SDK Options key), so
    // cast through unknown the same way the route does.
    const info = await sm.create({ memory: { autoMemoryEnabled: true } } as unknown as Parameters<typeof sm.create>[0])
    expect(info.memory).toEqual({ autoMemoryEnabled: true })
    // The provider re-applies the intent post-spawn (spawn-time values are
    // never null — nulls only arrive via the live route).
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ autoMemoryEnabled: true })
    // And the app-level field must NOT leak into the SDK Options.
    expect(mockHandles[0].options.memory).toBeUndefined()
  })

  it('fork() carries the auto-memory intent onto the new session', async () => {
    const source = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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

  // `settings.env` reaches the live CLI through this generic route, so the
  // spawn-merge blocklist has to apply here too — otherwise the rule only
  // holds for the HTTP doors that happen to validate, and any other caller of
  // this public method reopens the override.
  it('applySettings() strips a blocked env override before forwarding', async () => {
    const info = await sm.create({})

    await sm.applySettings(info.id, {
      env: { CLAUDE_CONFIG_DIR: '/tmp/sess-home', MY_FLAG: '1' },
    } as never)

    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ env: { MY_FLAG: '1' } })
  })

  // --- effort capability (effortLevels three-state) ---
  // Capability is now classified by model-id keyword (effortLevelsForModel),
  // NOT the SDK's supportedModels (which on gateways reports unmatched
  // aliases and claims every model supports effort). We exercise it through
  // setModel and read the projected SessionInfo (synchronous now).

  it('effortLevels is the full 5 for an opus-family id (provider prefix tolerated)', async () => {
    const info = await sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'ppio/pa/claude-opus-4-8')
    expect(sm.get(info.id).effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('effortLevels omits xhigh for a sonnet-family id', async () => {
    const info = await sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'anthropic/claude-sonnet-4-20250514')
    expect(sm.get(info.id).effortLevels).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('effortLevels is [] for haiku (no effort support → chip hidden)', async () => {
    const info = await sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'claude-haiku-3-5-20241022')
    expect(sm.get(info.id).effortLevels).toEqual([])
  })

  it('effortLevels is [] for a non-Claude model (chip hidden)', async () => {
    const info = await sm.create({ model: 'm-a' })
    await sm.setModel(info.id, 'xiaomi/mimo-v2.5-pro')
    expect(sm.get(info.id).effortLevels).toEqual([])
  })

  it('rename() updates title on a live session', async () => {
    const info = await sm.create({ title: 'before' })
    const updated = await sm.rename(info.id, 'after')
    expect(updated.title).toBe('after')
    expect(sm.get(info.id).title).toBe('after')
  })

  it('rename() updates title on a dormant session', async () => {
    const info = await sm.create({ title: 'alive' })
    await sm.unload(info.id)
    const updated = await sm.rename(info.id, 'dormant-renamed')
    expect(updated.title).toBe('dormant-renamed')
    await store.flush()
    expect(store.get(info.id)?.title).toBe('dormant-renamed')
  })

  it('rename() with blank string clears the title', async () => {
    const info = await sm.create({ title: 'keep me' })
    const updated = await sm.rename(info.id, '   ')
    expect(updated.title).toBeUndefined()
  })

  it('rename() also writes the manual title into the CLI transcript (best-effort renameSession)', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockRenameSession.mockClear()
    const renamed = await sm.rename(info.id, '  My Title  ')
    expect(renamed.title).toBe('My Title')
    await tick()
    // Id-scoped (no `dir`): same rationale as hasTranscript — a title write
    // after a project move must still find the jsonl under the OLD encoding.
    // The SDK shim forwards a third arg; it must be undefined (no dir scope).
    expect(mockRenameSession).toHaveBeenCalledWith(info.id, 'My Title', undefined)
  })

  it('rename() does not write an empty/cleared title to the CLI transcript', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockRenameSession.mockClear()
    await sm.rename(info.id, '   ')
    await tick()
    expect(mockRenameSession).not.toHaveBeenCalled()
  })

  it('rename() keeps the app-level rename even when transcript persistence fails', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockRenameSession.mockClear()
    mockRenameSession.mockRejectedValueOnce(new Error('boom'))
    const renamed = await sm.rename(info.id, 'Still Works')
    expect(renamed.title).toBe('Still Works')
    await tick()
  })

  it('setPermissionMode() to a non-plan mode forwards "default" to the SDK (canUseTool owns it)', async () => {
    const info = await sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'acceptEdits')
    expect(sm.get(info.id).permissionMode).toBe('acceptEdits')
    // Only SDK-forwarded modes (plan/auto — see SDK_FORWARDED_PERMISSION_MODES)
    // forward a real mode; every other mode forwards 'default' so the SDK has
    // no CLI-side mode and canUseTool stays authoritative.
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('default')
  })

  it('setPermissionMode() to plan forwards "plan" to the SDK (read-only steering)', async () => {
    const info = await sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'plan')
    expect(sm.get(info.id).permissionMode).toBe('plan')
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('plan')
  })

  it('setPermissionMode() OUT of plan forwards "default" to release the SDK lock', async () => {
    const info = await sm.create({ permissionMode: 'plan' })
    await sm.setPermissionMode(info.id, 'acceptEdits')
    // Switching away from plan must send 'default' to disengage the SDK's
    // read-only lock, otherwise the model stays stuck unable to edit.
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('default')
  })

  it('setPermissionMode() to auto forwards "auto" to the SDK (native CLI classifier)', async () => {
    const info = await sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'auto')
    expect(sm.get(info.id).permissionMode).toBe('auto')
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('auto')
  })

  it('setPermissionMode() plan -> auto on a CLI that rejects auto falls back to a "default" release', async () => {
    // Old --claude-binary binaries predating 'auto' reject the mode. Without
    // the fallback the CLI would keep the plan lock engaged while the UI
    // shows Autonomous (model stuck read-only).
    const info = await sm.create({ permissionMode: 'plan' })
    mockHandles[0].setPermissionMode.mockRejectedValueOnce(new Error('unknown mode auto'))
    const updated = await sm.setPermissionMode(info.id, 'auto')
    expect(updated.permissionMode).toBe('auto')
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledTimes(2)
    expect(mockHandles[0].setPermissionMode).toHaveBeenNthCalledWith(1, 'auto')
    expect(mockHandles[0].setPermissionMode).toHaveBeenNthCalledWith(2, 'default')
  })

  it('setPermissionMode() default -> auto on a CLI that rejects auto does NOT release (no CLI-side lock held)', async () => {
    // Only a previously-held plan lock needs releasing; the broker enforces
    // 'auto' locally when the CLI refuses it, and a release round-trip after
    // an ambiguous failure (e.g. timeout) could strip a mode that engaged.
    const info = await sm.create({ permissionMode: 'default' })
    mockHandles[0].setPermissionMode.mockRejectedValueOnce(new Error('unknown mode auto'))
    const updated = await sm.setPermissionMode(info.id, 'auto')
    expect(updated.permissionMode).toBe('auto')
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledTimes(1)
    expect(mockHandles[0].setPermissionMode).toHaveBeenCalledWith('auto')
  })

  it('setPermissionMode() never fails even if the SDK control request throws', async () => {
    const info = await sm.create({ permissionMode: 'default' })
    mockHandles[0].setPermissionMode.mockRejectedValueOnce(new Error('SDK boom'))
    const updated = await sm.setPermissionMode(info.id, 'bypassPermissions')
    expect(updated.permissionMode).toBe('bypassPermissions')
    expect(sm.get(info.id).permissionMode).toBe('bypassPermissions')
  })

  // The spawn fallback must pin 'default', not omit — SDK 0.3.286 redefined
  // omission as "leave it to Claude Code" (see SDK_FORWARDED_PERMISSION_MODES
  // in server/permission-modes.ts); the broker's enforcement depends on the
  // CLI actually being in default mode.
  it('spawn forwards only SDK-forwarded modes (plan/auto) to the SDK options; other modes pin default', async () => {
    await sm.create({ permissionMode: 'acceptEdits' })
    expect(mockHandles[0].options.permissionMode).toBe('default')

    await sm.create({})
    expect(mockHandles[1].options.permissionMode).toBe('default')

    await sm.create({ permissionMode: 'plan' })
    expect(mockHandles[2].options.permissionMode).toBe('plan')

    await sm.create({ permissionMode: 'auto' })
    expect(mockHandles[3].options.permissionMode).toBe('auto')
  })

  it('fork() spawns a new session with resume=sourceId + forkSession=true', async () => {
    const source = await sm.create({ cwd: '/tmp', model: 'm1', permissionMode: 'default', title: 'parent' })
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
    const source = await sm.create({ title: 'dormant-source' })
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
    const source = await sm.create({})
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
    const source = await sm.create({})
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
    const source = await sm.create({})
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
    const source = await sm.create({})
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
    const source = await sm.create({ title: 'fresh' })
    // The lastTurnAt guard fires first: no result was ever emitted, so there
    // is no completed turn (and no anchor) to fork from. Same 400 as the
    // base path — forkFromLastSafe does not bypass it.
    await expect(sm.fork(source.id, { forkFromLastSafe: true })).rejects.toThrow(/no completed turns yet/i)
    expect(mockHandles).toHaveLength(1)
  })

  it('clear() broadcasts a created event for the fresh session tagged with joinGroupOf + evictingSource', async () => {
    const info = await sm.create({})
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
    const source = await sm.create({ title: 'fresh' })
    // No send → no result → no jsonl on disk. Fork should throw with a
    // 400 (user-actionable) rather than letting the SDK blow up later
    // with a cryptic "No conversation found with session ID: <uuid>".
    await expect(sm.fork(source.id)).rejects.toThrow(/no completed turns yet/i)
    // No extra Query was spawned.
    expect(mockHandles).toHaveLength(1)
  })

  it('fork() refuses a dormant source that never completed a turn', async () => {
    const source = await sm.create({ title: 'fresh-dormant' })
    await sm.unload(source.id)
    await expect(sm.fork(source.id)).rejects.toThrow(/no completed turns yet/i)
  })

  it('fork() refuses when the SDK transcript file is missing on disk', async () => {
    const source = await sm.create({ cwd: '/tmp', title: 'orphan-fork' })
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
    const info = await sm.create({ cwd: '/tmp', title: 'orphan-resume' })
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
      const parent = await sm.create({ cwd: '/tmp', title: 'parent' })
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
      const parent = await sm.create({ cwd: '/tmp', title: 'parent' })
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
    const info = await sm.create({ permissionMode: 'plan' })
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
    const info = await sm.create({ permissionMode: 'plan' })
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
    const info = await sm.create({})
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
    const info = await sm.create({})
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
      const live = await sm.create({ cwd: '/tmp/live' })
      mockListSessions.mockResolvedValueOnce([
        // a live session this app created
        { sessionId: live.id, summary: 'Live one', cwd: '/tmp/live', lastModified: 300, createdAt: 100 },
        // a session the CLI created — unknown to this app
        { sessionId: 'cli-xyz', firstPrompt: 'Hello from CLI', cwd: '/tmp/cli', lastModified: 500 },
        // a customTitle (CLI /rename) IS the session's real title
        { sessionId: 'title', customTitle: 'My Title', summary: 'ignored', lastModified: 400, gitBranch: 'main' },
        // NO derived fallback: summary/firstPrompt must never become the
        // title — an untitled session stays untitled (the picker labels
        // rows with firstPrompt itself as a display-only preview)
        { sessionId: 'both', summary: 'Latest question text', firstPrompt: 'First question', lastModified: 600 },
      ])

      const list = await sm.listResumable()

      // Sorted newest-first by lastModified: both(600) > cli-xyz(500) > title(400) > live(300)
      expect(list.map((s) => s.sessionId)).toEqual(['both', 'cli-xyz', 'title', live.id])

      const cli = list.find((s) => s.sessionId === 'cli-xyz')!
      expect(cli.known).toBe(false)
      expect(cli.running).toBe(false)
      // firstPrompt is NOT adopted as the title — untitled stays untitled.
      expect(cli.title).toBeUndefined()
      expect(cli.firstPrompt).toBe('Hello from CLI')

      // Unknown session with both fields: neither summary nor firstPrompt
      // becomes the title.
      const both = list.find((s) => s.sessionId === 'both')!
      expect(both.known).toBe(false)
      expect(both.title).toBeUndefined()

      const liveRow = list.find((s) => s.sessionId === live.id)!
      expect(liveRow.known).toBe(true)
      expect(liveRow.running).toBe(true)
      // The SDK's display `summary` is not adopted either.
      expect(liveRow.title).toBeUndefined()

      const title = list.find((s) => s.sessionId === 'title')!
      expect(title.title).toBe('My Title')
      expect(title.gitBranch).toBe('main')
    })

    it('prefers the app-known title over the SDK display title for known sessions', async () => {
      const live = await sm.create({ cwd: '/tmp/live2' })
      await sm.rename(live.id, 'App-side title')
      mockListSessions.mockResolvedValueOnce([
        // The SDK's display title prefers the LAST user prompt — the manager
        // must override it with the app's own title for known sessions.
        { sessionId: live.id, summary: 'Latest question text', cwd: '/tmp/live2', lastModified: 900 },
      ])
      const list = await sm.listResumable()
      expect(list).toHaveLength(1)
      expect(list[0].known).toBe(true)
      expect(list[0].title).toBe('App-side title')

      // Dormant half — the picker's most common shape: the same override
      // must run off the persisted meta alone (rename → unload → the store
      // keeps the title; there is no live holder to read it from).
      await sm.unload(live.id)
      mockListSessions.mockResolvedValueOnce([
        { sessionId: live.id, summary: 'Latest question text', cwd: '/tmp/live2', lastModified: 901 },
      ])
      const dormant = await sm.listResumable()
      expect(dormant).toHaveLength(1)
      expect(dormant[0].known).toBe(true)
      expect(dormant[0].running).toBe(false)
      expect(dormant[0].title).toBe('App-side title')

      // A CLI-side /rename lands as the on-disk customTitle — it wins over
      // the app-known title so the picker reflects the freshest name.
      mockListSessions.mockResolvedValueOnce([
        { sessionId: live.id, customTitle: 'CLI rename', summary: 'Latest question text', cwd: '/tmp/live2', lastModified: 902 },
      ])
      const cliRenamed = await sm.listResumable()
      expect(cliRenamed).toHaveLength(1)
      expect(cliRenamed[0].title).toBe('CLI rename')
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
        cwd: dir,
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
      // NO derived title: the SDK's summary/firstPrompt must never become the
      // session's title — an untitled session stays untitled (sidebar falls
      // back to the id prefix), and the resume spawn passes no `title`, so the
      // CLI never bakes the derived name into the transcript as custom-title.
      expect(info.title).toBeUndefined()
      expect(store.get('orphan')?.title).toBeUndefined()
      expect(handle.options.title).toBeUndefined()
    })

    it('carries a real on-disk customTitle into the adopted meta (and spawns with it)', async () => {
      mockGetSessionInfo.mockResolvedValueOnce({
        sessionId: 'orphan-titled',
        cwd: dir,
        summary: 'ignored display title',
        customTitle: 'Disk rename',
        lastModified: 1234,
        createdAt: 1000,
      })

      const info = await sm.resume('orphan-titled')
      // A CLI-side /rename is a REAL title — carried into the store and the
      // spawn options, unlike the derived summary/firstPrompt fallbacks.
      expect(info.title).toBe('Disk rename')
      expect(store.get('orphan-titled')?.title).toBe('Disk rename')
      const handle = mockHandles[mockHandles.length - 1]
      expect(handle.options.title).toBe('Disk rename')
    })

    it('resumes an adopted CLI session with the default 1M beta (no persisted meta)', async () => {
      // A CLI-created session has no app-side SessionMeta, so getSessionInfo
      // can't supply betas — the resume must default to the 1M flag instead of
      // silently dropping to the model's default 200K window.
      mockGetSessionInfo.mockResolvedValueOnce({
        sessionId: 'orphan-cli',
        cwd: dir,
        summary: 'CLI session',
        lastModified: 1234,
        createdAt: 1000,
      })

      await sm.resume('orphan-cli')
      const handle = mockHandles[mockHandles.length - 1]
      expect(handle.options.betas).toEqual([ONE_M_CONTEXT_BETA])
      // Defaulted value must be persisted so later resume/fork/clear inherit it.
      expect(store.get('orphan-cli')?.betas).toEqual([ONE_M_CONTEXT_BETA])
    })

    it('404s when the session exists neither in store nor on disk', async () => {
      mockGetSessionInfo.mockResolvedValueOnce(undefined)
      await expect(sm.resume('ghost')).rejects.toMatchObject({ status: 404 })
    })

    it('coalesces concurrent resume() calls into a single spawn (no duplicate process)', async () => {
      mockGetSessionInfo.mockResolvedValueOnce({
        sessionId: 'orphan',
        cwd: dir,
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
      const info = await sm.create({ cwd: dir, model: 'm1' })
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

    it('abortExec() is a no-op when no command is running', async () => {
      const info = await sm.create({ cwd: dir, model: 'm1' })
      // No exec in flight — must not throw.
      expect(() => sm.abortExec(info.id)).not.toThrow()
    })

    it('the AbortController is cleared after execInSession settles', async () => {
      const info = await sm.create({ cwd: dir, model: 'm1' })
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
      const info = await sm.create({ cwd: dir, model: 'm1' })
      const execP = sm.execInSession(info.id, 'long-running-cmd')
      await tick()
      await sm.unload(info.id)
      // unload() aborted the in-flight exec, so execP resolves (interrupted)
      // instead of hanging forever (exec has no wall-clock timeout).
      const result = await execP
      expect(result.interrupted).toBe(true)
    })
  })

  describe('local `!` working-state reset', () => {
    const turnStateOf = (sid: string): { pendingTurns: number; workingSince?: number; turnActive?: boolean } => {
      const smAny = sm as unknown as {
        sessions: Map<string, { pendingTurns: number; workingSince?: number; turnActive?: boolean }>
      }
      return smAny.sessions.get(sid)!
    }
    const waitFor = async (cond: () => boolean, ticks = 60): Promise<boolean> => {
      for (let i = 0; i < ticks; i++) {
        if (cond()) return true
        await new Promise((r) => setImmediate(r))
      }
      return cond()
    }

    it('resets to idle when no turn was pending (the local path triggers no SDK turn, so no result will ever arrive)', async () => {
      const info = await sm.create({ cwd: dir, model: 'm1' })
      vi.mocked(mockExecCommand).mockResolvedValueOnce({ stdout: 'out', stderr: '', exitCode: 0, interrupted: false, truncated: false })
      await sm.execInSession(info.id, 'local-cmd')
      const s = turnStateOf(info.id)
      expect(s.pendingTurns).toBe(0)
      expect(s.workingSince).toBeUndefined()
      expect(sm.list().find((x) => x.id === info.id)!.working).toBe(false)
    })

    it('preserves an in-flight turn’s working state (requireRunnable permits exec mid-turn)', async () => {
      // Regression: pushToSession caps pendingTurns at 1, so the old
      // unconditional reset after a mid-turn local `!` wiped a genuinely
      // running SDK turn's state — WorkingBubble vanished, phase-gated
      // routes opened, and the health monitor stopped watching the session.
      const info = await sm.create({ cwd: dir, model: 'm1' })
      const h = mockHandles.at(-1)!
      sm.send(info.id, 'in-flight turn')
      const s = turnStateOf(info.id)
      expect(s.pendingTurns).toBe(1)

      vi.mocked(mockExecCommand).mockResolvedValueOnce({ stdout: 'out', stderr: '', exitCode: 0, interrupted: false, truncated: false })
      await sm.execInSession(info.id, 'local-cmd')

      // The turn's state survives — its result stays the authority.
      expect(s.pendingTurns).toBe(1)
      expect(sm.list().find((x) => x.id === info.id)!.working).toBe(true)

      h.emit({ type: 'result', subtype: 'success' })
      expect(await waitFor(() => turnStateOf(info.id).pendingTurns === 0)).toBe(true)
      expect(turnStateOf(info.id).workingSince).toBeUndefined()
    })
  })

  describe('debug introspection', () => {
    it('lists a live session with a derived phase and zeroed counters', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      const row = sm.debugSessions().find((r) => r.id === info.id)
      expect(row).toMatchObject({
        id: info.id,
        phase: 'live',
        running: true,
        terminated: false,
        pendingTurns: 0,
        pendingPermissions: 0,
        queuedInputs: 0,
      })
    })

    it('derives phase dormant for a session that is in the store but not live', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      await sm.unload(info.id)
      const row = sm.debugSessions().find((r) => r.id === info.id)
      expect(row?.phase).toBe('dormant')
      expect(row?.running).toBe(false)
      expect(row?.terminated).toBe(false)
    })

    it('counts queued inputs via receivedAt-without-consumedAt predicate', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      sm.send(info.id, 'hello')
      const row = sm.debugSessions().find((r) => r.id === info.id)
      // In the test mock, the SDK drains the input queue synchronously
      // (direct hand-off via the Pushable's parked waiter), so consumedAt
      // is stamped immediately — the predicate yields 0.
      expect(row?.queuedInputs).toBe(0)
    })

    it('does not count non-user frames (assistant) as queued inputs', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      const h = mockHandles.at(-1)!
      // The pump stamps receivedAt on every frame that enters the ring.
      // An assistant frame has receivedAt but is NOT a user message —
      // countQueuedUserTurns must skip it. Emit the frame into the SDK
      // stream so the pump processes it into the history ring.
      h.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: 'reply' } })
      // Yield to the event loop so the pump can process the emitted frame.
      await new Promise((r) => setTimeout(r, 10))
      const row = sm.debugSessions().find((r) => r.id === info.id)
      expect(row?.queuedInputs).toBe(0)
      // Sanity: the assistant frame IS in the ring (pump added it).
      expect(row?.messageCount).toBeGreaterThan(0)
    })

    it('projects historyTail to routing metadata only and nulls the live-only sections off-live', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      sm.send(info.id, 'hello')
      const detail = await sm.debugSession(info.id, 10)
      expect(detail.id).toBe(info.id)
      expect(detail.historyTail.length).toBeGreaterThan(0)
      // Exactly these six keys — a leaked SDK message body would add one.
      expect(Object.keys(detail.historyTail[0]).sort()).toEqual(
        ['consumedAt', 'parentToolUseId', 'receivedAt', 'subtype', 'type', 'uuid'].sort(),
      )
      expect(detail.historyTail[0].type).toBe('user')
      expect(detail.tasks).toEqual([])
      // recordPromptUuid runs at dispatch, so the unpaired entry is already there.
      expect(detail.promptUuids.length).toBeGreaterThan(0)
      expect(detail.cli?.stderrTail).toBeDefined()

      // A dormant session resolves from the store: in-memory collections are
      // empty and the three live-only sections are null, not an error.
      await sm.unload(info.id)
      const dormant = await sm.debugSession(info.id, 0)
      expect(dormant.phase).toBe('dormant')
      expect(dormant.contextUsage).toBeNull()
      expect(dormant.cachedContextUsage).toBeNull()
      expect(dormant.contextUsageMismatch).toBe(false)
      expect(dormant.cli).toBeNull()
      expect(dormant.toolServers).toBeNull()
      expect(dormant.historyTail).toEqual([])
      expect(dormant.withdrawnUuids).toEqual([])
      expect(dormant.tasks).toEqual([])
    })

    it('exposes the cached Lite snapshot beside the live breakdown and flags a large mismatch', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      sm.send(info.id, 'hello')

      // Seed the pump-cached snapshot with the aggregate-bug signature
      // (995,023 cached while the CLI's own accounting says 155,641 — a 6.4×
      // divergence; normal lens jitter is well under 1.5×).
      ;(sm as unknown as { sessions: Map<string, { lastContextUsage?: Record<string, unknown> }> })
        .sessions.get(info.id)!.lastContextUsage = {
        totalTokens: 995023,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        percentage: 99.5023,
        model: 'test-model',
      }

      mockHandles[0].getContextUsage.mockResolvedValueOnce({
        categories: [],
        totalTokens: 155641,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        percentage: 16,
        model: 'test-model',
        isAutoCompactEnabled: true,
      })
      const detail = await sm.debugSession(info.id, 0)
      // Both lenses side by side — the pair that would have made the
      // 73a4960a investigation a one-call diagnosis.
      expect(detail.cachedContextUsage?.totalTokens).toBe(995023)
      expect((detail.contextUsage as { totalTokens?: number }).totalTokens).toBe(155641)
      expect(detail.contextUsageMismatch).toBe(true)

      // Matching readings (normal lens jitter) do not flag.
      ;(sm as unknown as { sessions: Map<string, { lastContextUsage?: Record<string, unknown> }> })
        .sessions.get(info.id)!.lastContextUsage = {
        totalTokens: 155641,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        percentage: 16,
        model: 'test-model',
      }
      mockHandles[0].getContextUsage.mockResolvedValueOnce({
        categories: [],
        totalTokens: 155641,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        percentage: 16,
        model: 'test-model',
        isAutoCompactEnabled: true,
      })
      const matched = await sm.debugSession(info.id, 0)
      expect(matched.contextUsageMismatch).toBe(false)

      // A DEGRADED cached snapshot is the pump's self-declared estimate for a
      // corrupt turn — it never accuses the lens of lying, however far the
      // numbers drift.
      ;(sm as unknown as { sessions: Map<string, { lastContextUsage?: Record<string, unknown> }> })
        .sessions.get(info.id)!.lastContextUsage = {
        totalTokens: 50000,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        percentage: 5,
        model: 'test-model',
        degraded: true,
      }
      mockHandles[0].getContextUsage.mockResolvedValueOnce({
        categories: [],
        totalTokens: 300000,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        percentage: 30,
        model: 'test-model',
        isAutoCompactEnabled: true,
      })
      const degraded = await sm.debugSession(info.id, 0)
      expect(degraded.contextUsageMismatch).toBe(false)
    })

    it('throws for an unknown session id', async () => {
      expect(() => sm.debugSessions()).not.toThrow()
      await expect(sm.debugSession('nope')).rejects.toThrow()
    })
  })

  describe('transcript seq store (Task 3 wiring)', () => {
    const waitFor = async (cond: () => boolean, ticks = 60): Promise<boolean> => {
      for (let i = 0; i < ticks; i++) {
        if (cond()) return true
        await tick()
      }
      return cond()
    }

    const emitAssistant = (uuid: string, text: string) => {
      mockHandles[0].emit({
        type: 'assistant',
        uuid,
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })
    }

    it('seq-assigns sent prompts and pump-ingested messages; window reads back by seq', async () => {
      const info = await sm.create({ cwd: '/tmp' })
      sm.send(info.id, 'hello')
      emitAssistant('a1', 'hi there')
      mockHandles[0].emit({ type: 'system', subtype: 'init', uuid: 'init1' })
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'r1', session_id: info.id })
      expect(await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)).toBe(true)

      const win = await sm.getTranscriptWindow(info.id)
      // Durable rows only: the user prompt, the assistant reply, the result
      // frame. system/init stays out of the seq space (non-broadcast system).
      expect(win.messages.map((m) => [(m.msg as { uuid?: string }).uuid, m.seq])).toEqual([
        [expect.any(String), 0],
        ['a1', 1],
        ['r1', 2],
      ])
      expect((win.messages[0].msg as { message?: { content?: string } }).message?.content).toBe('hello')
      expect(win.totalCount).toBe(3)
      expect(win.headSeq).toBe(3)
      expect(win.hasMore).toBe(false)
      expect(sm.transcriptHead(info.id)).toEqual({ generation: 0, headSeq: 3 })
    })

    it('pages backwards by exclusive seq bound', async () => {
      const info = await sm.create({ cwd: '/tmp' })
      for (let i = 0; i < 5; i++) emitAssistant(`a${i}`, `m${i}`)
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'r', session_id: info.id })
      expect(await waitFor(() => sm.transcriptHead(info.id)?.headSeq === 6)).toBe(true)

      const page = await sm.getTranscriptWindow(info.id, 3, 2)
      expect(page.messages.map((m) => m.seq)).toEqual([1, 2])
      expect(page.hasMore).toBe(true)
      const first = await sm.getTranscriptWindow(info.id, 1, 2)
      expect(first.messages.map((m) => m.seq)).toEqual([0])
      expect(first.hasMore).toBe(false)
    })

    it('persists an ndjson sidecar; evictTranscript tombstones flow through the window and survive a reload', async () => {
      const info = await sm.create({ cwd: '/tmp' })
      sm.send(info.id, 'evict me')
      emitAssistant('a1', 'reply')
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'r1', session_id: info.id })
      expect(await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)).toBe(true)
      await sm.getTranscriptWindow(info.id) // ensure reconcile completed

      const sidecarFile = join(dir, 'transcripts', `${info.id}.ndjson`)
      expect(existsSync(sidecarFile)).toBe(true)

      const userUuid = ((await sm.getTranscriptWindow(info.id)).messages[0].msg as { uuid?: string }).uuid as string
      expect(await sm.evictTranscript(info.id, [userUuid, 'unknown-uuid'])).toEqual([0])
      // Idempotent: a repeat evict returns nothing and appends nothing.
      expect(await sm.evictTranscript(info.id, [userUuid])).toEqual([])

      const win = await sm.getTranscriptWindow(info.id)
      expect(win.messages.map((m) => m.seq)).toEqual([1, 2])
      expect(win.totalCount).toBe(2)
      expect(win.headSeq).toBe(3) // seqs are not recycled

      // Simulate a process restart: a fresh manager over the same state dir
      // rehydrates the store from the sidecar, tombstone included.
      const store2 = new SessionStore({ stateDir: dir })
      await store2.load()
      const sm2 = new SessionManager({ store: store2 })
      try {
        const reloaded = await sm2.getTranscriptWindow(info.id)
        expect(reloaded.messages.map((m) => m.seq)).toEqual([1, 2])
        expect(reloaded.totalCount).toBe(2)
        expect(reloaded.generation).toBe(0)
      } finally {
        await sm2.shutdown()
      }
    })

    it('unknown sessions read as empty: transcriptHead null, window empty', async () => {
      expect(sm.transcriptHead('no-such-session')).toBeNull()
      expect(await sm.evictTranscript('no-such-session', ['u1'])).toEqual([])
      const win = await sm.getTranscriptWindow('no-such-session')
      expect(win.messages).toEqual([])
      expect(win.totalCount).toBe(0)
    })

    it('fork pre-seeds the seq space: a post-fork live message seq exceeds every pre-fork row (chronology holds)', async () => {
      // Give the SOURCE a completed turn so fork() allows the branch.
      const sourceCwd = '/tmp/fork-seq-src'
      const source = await sm.create({ cwd: sourceCwd })
      sm.send(source.id, 'before fork')
      emitAssistant('live-pre-1', 'prefork reply')
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'live-pre-r', session_id: source.id })
      expect(await waitFor(() => sm.get(source.id).lastTurnAt !== undefined)).toBe(true)

      // Write the source's transcript JSONL where findTranscriptFile looks
      // for it — the fork's pre-seed composes its pre-fork rows from the
      // SOURCE's on-disk transcript (the fork's own file only materializes
      // when its CLI copies it at subprocess start).
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      let forked: Awaited<ReturnType<typeof sm.fork>>
      try {
        const jsonlPath = join(dir, 'projects', encodeCwd(sourceCwd), `${source.id}.jsonl`)
        mkdirSync(dirname(jsonlPath), { recursive: true })
        writeFileSync(
          jsonlPath,
          [
            JSON.stringify({ type: 'user', uuid: 'disk-u1', sessionId: source.id, parent_tool_use_id: null, message: { role: 'user', content: 'before fork' } }),
            JSON.stringify({ type: 'assistant', uuid: 'disk-a1', sessionId: source.id, message: { role: 'assistant', content: [{ type: 'text', text: 'prefork reply' }] } }),
            '',
          ].join('\n'),
        )
        forked = await sm.fork(source.id)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }

      // The fork is LIVE with its own pump — ingest a message into it.
      const forkHandle = mockHandles[mockHandles.length - 1]
      forkHandle.emit({
        type: 'assistant',
        uuid: 'post-fork-1',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'live after fork' }] },
      })
      forkHandle.emit({ type: 'result', subtype: 'success', uuid: 'post-fork-r', session_id: forked.id })
      expect(await waitFor(() => sm.get(forked.id).lastTurnAt !== undefined)).toBe(true)

      const win = await sm.getTranscriptWindow(forked.id)
      const byUuid = new Map(win.messages.map((m) => [(m.msg as { uuid?: string }).uuid, m.seq]))
      // The pre-fork rows were assigned first, dense from 0.
      expect(byUuid.get('disk-u1')).toBe(0)
      expect(byUuid.get('disk-a1')).toBe(1)
      // The post-fork live message and its result came AFTER every
      // pre-fork seq — the regression would put them at 0..k ahead of the
      // back-filled pre-fork rows.
      expect(byUuid.get('post-fork-1')).toBe(2)
      expect(byUuid.get('post-fork-r')).toBe(3)
      expect(win.totalCount).toBe(4)
    })

    it('fork restart reconcile never re-appends an inherited prompt (v→u bridge)', async () => {
      const sourceCwd = '/tmp/fork-bridge-src'
      const source = await sm.create({ cwd: sourceCwd })
      sm.send(source.id, 'hello world')
      // SDK echo: pairs the server-minted `u` with the SDK's on-disk `v` and
      // persists the mapping into the source's prompt-uuid sidecar (the pump
      // drops this frame as an input echo — it never enters the seq store).
      mockHandles[0].emit({
        type: 'user',
        uuid: 'sdk-v-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello world' },
      })
      const promptUuidFile = join(dir, 'prompt-uuids', `${source.id}.json`)
      expect(await waitFor(() => existsSync(promptUuidFile))).toBe(true)
      const sourceMappings = JSON.parse(readFileSync(promptUuidFile, 'utf8')) as Array<{ u: string; v?: string }>
      const serverU = sourceMappings.find((e) => e.v === 'sdk-v-1')!.u
      // fork() gates on a completed turn — settle one.
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'pre-r', session_id: source.id })
      expect(await waitFor(() => sm.get(source.id).lastTurnAt !== undefined)).toBe(true)

      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      let forked: Awaited<ReturnType<typeof sm.fork>>
      try {
        // The source's transcript on disk carries the SDK uuid `v`.
        const srcJsonl = join(dir, 'projects', encodeCwd(sourceCwd), `${source.id}.jsonl`)
        mkdirSync(dirname(srcJsonl), { recursive: true })
        const rows = [
          JSON.stringify({ type: 'user', uuid: 'sdk-v-1', sessionId: source.id, parent_tool_use_id: null, message: { role: 'user', content: 'hello world' } }),
          JSON.stringify({ type: 'assistant', uuid: 'sdk-a1', sessionId: source.id, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
          '',
        ].join('\n')
        writeFileSync(srcJsonl, rows)
        forked = await sm.fork(source.id)
        // Simulate the forkSession copy: the fork's own JSONL is the source
        // conversation under the SAME SDK uuids. (The real CLI performs this
        // copy at subprocess start; the mock doesn't, so write it by hand.)
        const forkJsonl = join(dir, 'projects', encodeCwd(sourceCwd), `${forked.id}.jsonl`)
        writeFileSync(forkJsonl, rows)

        // LIVE USE between fork and restart (the round-3 regression): the
        // fork's first post-fork prompt + echo + result. onPromptEcho saves
        // the WHOLE in-memory promptUuids list with writeAtomic REPLACE —
        // the live session must carry the bridged inherited mappings or the
        // save wipes them off disk right here.
        sm.send(forked.id, 'after fork')
        const forkHandle = mockHandles[mockHandles.length - 1]
        forkHandle.emit({
          type: 'user',
          uuid: 'sdk-v-fork-1',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'after fork' },
        })
        forkHandle.emit({ type: 'result', subtype: 'success', uuid: 'post-fork-r', session_id: forked.id })
        expect(await waitFor(() => sm.get(forked.id).lastTurnAt !== undefined)).toBe(true)

        const forkMappingFile = join(dir, 'prompt-uuids', `${forked.id}.json`)
        const readForkMappings = (): Array<{ u: string; v?: string }> =>
          existsSync(forkMappingFile) ? (JSON.parse(readFileSync(forkMappingFile, 'utf8')) as Array<{ u: string; v?: string }>) : []
        // The echo's REPLACE save kept the inherited mapping AND added the
        // new prompt's pairing.
        expect(await waitFor(() => readForkMappings().some((e) => e.v === 'sdk-v-fork-1'))).toBe(true)
        const forkMappings = readForkMappings()
        expect(forkMappings.some((e) => e.v === 'sdk-v-1' && e.u === serverU)).toBe(true)
        const forkNewU = forkMappings.find((e) => e.v === 'sdk-v-fork-1')!.u

        // The live fork's seq space: pre-seeded rows + the live prompt + its
        // result (the echo frame is dropped by the pump — no seq).
        const liveWin = await sm.getTranscriptWindow(forked.id)
        expect(liveWin.totalCount).toBe(4)
        expect(liveWin.messages.map((m) => [(m.msg as { uuid?: string }).uuid, m.seq])).toEqual([
          [serverU, 0],
          ['sdk-a1', 1],
          [forkNewU, 2],
          ['post-fork-r', 3],
        ])

        // The SDK appends the new prompt to the fork's JSONL — extend the
        // copy before the restart reconcile.
        writeFileSync(
          forkJsonl,
          [
            ...rows.split('\n').filter((l) => l.trim() !== ''),
            JSON.stringify({ type: 'user', uuid: 'sdk-v-fork-1', sessionId: forked.id, parent_tool_use_id: null, message: { role: 'user', content: 'after fork' } }),
            '',
          ].join('\n'),
        )

        // Fork restart: a fresh manager over the same state dir reconciles
        // the fork's seq store from its sidecar + its own JSONL, rewriting
        // the copied `v` rows through the FORK's (bridged) prompt-uuid store.
        const store2 = new SessionStore({ stateDir: dir })
        await store2.load()
        const sm2 = new SessionManager({ store: store2 })
        try {
          const win = await sm2.getTranscriptWindow(forked.id)
          // The regression: without the bridge (or with the live echo wiping
          // it) the copied `sdk-v-1` uuid misses dedup and the inherited
          // prompt is appended AGAIN at a fresh tail seq (totalCount 5, two
          // user rows carrying `sdk-v-1` / `serverU` respectively).
          expect(win.totalCount).toBe(4)
          expect(win.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3])
          const users = win.messages.filter((m) => (m.msg as { type?: string }).type === 'user')
          expect(users.map((m) => (m.msg as { uuid?: string }).uuid)).toEqual([serverU, forkNewU])
          // No raw SDK uuid may survive the rewrite.
          expect(win.messages.some((m) => (m.msg as { uuid?: string }).uuid === 'sdk-v-1')).toBe(false)
          expect(win.messages.some((m) => (m.msg as { uuid?: string }).uuid === 'sdk-v-fork-1')).toBe(false)
        } finally {
          await sm2.shutdown()
        }
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })

    it('discard-style fork (explicit historySeed) bridges only the seed’s prompt mappings', async () => {
      const sourceCwd = '/tmp/fork-bridge-seed'
      const source = await sm.create({ cwd: sourceCwd })
      // Two mapped prompts; the seed (discard's kept prefix) contains only
      // the FIRST — the bridge must not copy the second's mapping.
      sm.send(source.id, 'first')
      mockHandles[0].emit({
        type: 'user', uuid: 'sdk-v-1', parent_tool_use_id: null,
        message: { role: 'user', content: 'first' },
      })
      await tick()
      sm.send(source.id, 'second')
      mockHandles[0].emit({
        type: 'user', uuid: 'sdk-v-2', parent_tool_use_id: null,
        message: { role: 'user', content: 'second' },
      })
      const promptUuidFile = join(dir, 'prompt-uuids', `${source.id}.json`)
      // Wait for BOTH echoes to be persisted (the file appears after the
      // first save; existence alone races the second).
      const readMappings = (): Array<{ u: string; v?: string }> =>
        existsSync(promptUuidFile) ? (JSON.parse(readFileSync(promptUuidFile, 'utf8')) as Array<{ u: string; v?: string }>) : []
      expect(await waitFor(() => readMappings().filter((e) => e.v != null).length >= 2)).toBe(true)
      const sourceMappings = readMappings()
      const serverU1 = sourceMappings.find((e) => e.v === 'sdk-v-1')!.u
      // fork() gates on a completed turn — settle one.
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'pre-r', session_id: source.id })
      expect(await waitFor(() => sm.get(source.id).lastTurnAt !== undefined)).toBe(true)

      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      let forked: Awaited<ReturnType<typeof sm.fork>>
      try {
        // historySeed is what discard() passes: the kept prefix with
        // rewriteSeedPromptUuids ALREADY applied (server `u` uuids).
        const seed = [
          { type: 'user', uuid: serverU1, parent_tool_use_id: null, session_id: source.id, message: { role: 'user', content: 'first' } },
          { type: 'assistant', uuid: 'sdk-a1', session_id: source.id, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
        ] as SDKMessage[]
        forked = await sm.fork(source.id, { historySeed: seed })

        // Bridge selection: only the seed's mapping is copied.
        const forkMappingFile = join(dir, 'prompt-uuids', `${forked.id}.json`)
        expect(existsSync(forkMappingFile)).toBe(true)
        const forkMappings = JSON.parse(readFileSync(forkMappingFile, 'utf8')) as Array<{ u: string; v?: string }>
        expect(forkMappings).toEqual([{ u: serverU1, v: 'sdk-v-1' }])

        // The truncated fork JSONL copy (kept turn only, SDK `v` uuids);
        // restart reconcile must rewrite and dedup, not re-append.
        const forkJsonl = join(dir, 'projects', encodeCwd(sourceCwd), `${forked.id}.jsonl`)
        mkdirSync(dirname(forkJsonl), { recursive: true })
        writeFileSync(
          forkJsonl,
          [
            JSON.stringify({ type: 'user', uuid: 'sdk-v-1', sessionId: forked.id, parent_tool_use_id: null, message: { role: 'user', content: 'first' } }),
            JSON.stringify({ type: 'assistant', uuid: 'sdk-a1', sessionId: forked.id, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
            '',
          ].join('\n'),
        )
        const store2 = new SessionStore({ stateDir: dir })
        await store2.load()
        const sm2 = new SessionManager({ store: store2 })
        try {
          const win = await sm2.getTranscriptWindow(forked.id)
          expect(win.totalCount).toBe(2)
          const users = win.messages.filter((m) => (m.msg as { type?: string }).type === 'user')
          expect(users).toHaveLength(1)
          expect((users[0].msg as { uuid?: string }).uuid).toBe(serverU1)
        } finally {
          await sm2.shutdown()
        }
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })
  })
  describe('transcript eviction + messages-evicted broadcast (Task 5 wiring)', () => {
    const waitFor = async (cond: () => boolean, ticks = 60): Promise<boolean> => {
      for (let i = 0; i < ticks; i++) {
        if (cond()) return true
        await tick()
      }
      return cond()
    }

    const emitAssistant = (uuid: string, text: string) => {
      mockHandles[0].emit({
        type: 'assistant',
        uuid,
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })
    }

    /** Complete a turn so the seq space has: user prompt (seq 0), assistant
     *  reply (seq 1), result frame (seq 2). Returns the prompt's uuid. */
    const seedTurn = async () => {
      const info = await sm.create({ cwd: '/tmp' })
      sm.send(info.id, 'refuse me')
      emitAssistant('a1', 'refused leg')
      mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'r1', session_id: info.id })
      expect(await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)).toBe(true)
      await sm.getTranscriptWindow(info.id) // ensure reconcile completed
      const win = await sm.getTranscriptWindow(info.id)
      return { info, userUuid: win.messages[0].uuid as string }
    }

    const collectMsgStatus = (id: string): Array<Record<string, unknown>> => {
      const sub = sm.subscribeMessageStatus(id)
      if (!sub) throw new Error('no message-status channel')
      const frames: Array<Record<string, unknown>> = []
      void (async () => {
        for await (const f of sub.iterable) frames.push(f as unknown as Record<string, unknown>)
      })()
      return frames
    }

    const sessionOf = (id: string) => {
      const internals = sm as unknown as {
        sessions: Map<string, { dialogPending: Map<string, unknown> }>
      }
      const s = internals.sessions.get(id)
      if (!s) throw new Error('session not live')
      return s
    }

    it('broadcasts messages-evicted (seqs + generation) when the pump sees a refusal retraction', async () => {
      const { info, userUuid } = await seedTurn()

      const frames = collectMsgStatus(info.id)
      mockHandles[0].emit({
        type: 'system',
        subtype: 'model_refusal_fallback',
        retracted_message_uuids: [userUuid, 'uuid-never-seen'],
      })
      expect(await waitFor(() => frames.some((f) => f.kind === 'messages-evicted'))).toBe(true)
      const ev = frames.find((f) => f.kind === 'messages-evicted') as {
        seqs: number[]
        generation: number
      }
      // Unknown uuids contribute nothing; the tombstoned seq matches the
      // store, and the frame carries the store's generation.
      expect(ev.seqs).toEqual([0])
      expect(ev.generation).toBe(0)

      // The tombstone reached the window: seq 0 gone, later rows kept.
      const after = await sm.getTranscriptWindow(info.id)
      expect(after.messages.map((m) => m.seq)).not.toContain(0)
      expect(after.messages.map((m) => m.seq)).toEqual(expect.arrayContaining([1, 2]))
    })

    it('evicts on dialog resolution carrying retractedMessageUuids (any resolution path)', async () => {
      const { info, userUuid } = await seedTurn()
      const opts = mockHandles.at(-1)!.options as {
        onUserDialog?: (
          req: { dialogKind: string; payload: Record<string, unknown> },
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; result?: unknown }>
      }
      const promise = opts.onUserDialog!(
        { dialogKind: 'refusal_fallback_prompt', payload: { retractedMessageUuids: [userUuid] } },
        { signal: new AbortController().signal },
      )
      const frames = collectMsgStatus(info.id)
      const s = sessionOf(info.id)
      const did = [...s.dialogPending.keys()][0]!
      sm.decideDialog(info.id, did, { behavior: 'completed', result: 'retry_fallback' })
      await promise

      expect(await waitFor(() => frames.some((f) => f.kind === 'messages-evicted'))).toBe(true)
      const ev = frames.find((f) => f.kind === 'messages-evicted') as { seqs: number[] }
      expect(ev.seqs).toEqual([0])
    })

    it('evictTranscript reconciles a COLD store before tombstoning (reconcile-first)', async () => {
      const { info, userUuid } = await seedTurn()

      // Simulate a restart: a fresh manager over the same state dir. The
      // session is persisted but never loaded — its seq store is cold, and
      // eviction keyed by uuid would silently miss against a half-empty
      // index. Reconcile-first must rebuild the index from the sidecar,
      // then tombstone the right seq.
      await sm.shutdown()
      const store2 = new SessionStore({ stateDir: dir })
      await store2.load()
      const sm2 = new SessionManager({ store: store2 })
      try {
        expect(await sm2.evictTranscript(info.id, [userUuid])).toEqual([0])
        const win = await sm2.getTranscriptWindow(info.id)
        expect(win.messages.map((m) => m.seq)).toEqual([1, 2])
        expect(win.totalCount).toBe(2)
      } finally {
        await sm2.shutdown()
      }
    })
  })

  describe('per-session op lock', () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void
      const promise = new Promise<void>((r) => { resolve = r })
      return { promise, resolve }
    }

    /** Reject when `p` hasn't settled within `ms` — the deadlock guard. */
    function within<T>(p: Promise<T>, ms = 2000): Promise<T> {
      return Promise.race([
        p,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms (deadlock?)`)), ms)),
      ])
    }

    type PrivateSm = {
      applySessionMcpServers: (...args: unknown[]) => Promise<unknown>
      buildResumeOpts: (...args: unknown[]) => Promise<unknown>
    }

    /** Park the FIRST call of a private async seam on a gate; later calls pass
     *  straight through. Returns the gate and the call log (first arg). */
    function parkFirstCall(name: keyof PrivateSm): { gate: ReturnType<typeof deferred>; calls: unknown[] } {
      const target = sm as unknown as PrivateSm
      const orig = target[name].bind(sm)
      const gate = deferred()
      const calls: unknown[] = []
      vi.spyOn(target, name).mockImplementation(async (...args: unknown[]) => {
        calls.push(args[0])
        if (calls.length === 1) await gate.promise
        return orig(...args)
      })
      return { gate, calls }
    }

    /** A live session with one completed turn (lastTurnAt set). */
    async function liveWithTurn(opts: Record<string, unknown> = {}): Promise<string> {
      const info = await sm.create({ cwd: dir, model: 'm1', ...opts } as Parameters<SessionManager['create']>[0])
      const h = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
      h.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      for (let i = 0; i < 60 && sm.get(info.id).lastTurnAt === undefined; i++) await tick()
      expect(sm.get(info.id).lastTurnAt).toBeDefined()
      return info.id
    }

    it('concurrent clear(X) + fork(X) do not interleave', async () => {
      const x = await liveWithTurn()
      const { gate, calls } = parkFirstCall('applySessionMcpServers')
      const probesBefore = mockGetSessionInfo.mock.calls.length

      const clearing = sm.clear(x)
      const forking = sm.fork(x)
      for (let i = 0; i < 5; i++) await tick()
      // clear is parked inside its body; fork hasn't entered (no transcript
      // probe, no MCP resolution of its own).
      expect(calls).toHaveLength(1)
      expect(mockGetSessionInfo.mock.calls.length).toBe(probesBefore)

      gate.resolve()
      const [cleared, forked] = await within(Promise.allSettled([clearing, forking]))
      expect(cleared.status).toBe('fulfilled')
      const y = (cleared as PromiseFulfilledResult<{ id: string }>).value.id
      // fork ran AFTER clear removed X — a clean 404/410, never a crash.
      expect(forked.status).toBe('rejected')
      expect([404, 410]).toContain(((forked as PromiseRejectedResult).reason as HttpError).status)
      // Meta consistent: X gone from the store, Y present and healthy.
      expect(store.get(x)).toBeUndefined()
      expect(store.get(y)?.terminated).toBe(false)
      expect(sm.get(y).running).toBe(true)
    })

    it('concurrent sleep(X) + resume(X) end in a consistent state', async () => {
      const x = await liveWithTurn()
      const results = await within(Promise.allSettled([sm.sleep(x), sm.resume(x)]))
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      // Serialized: sleep unloaded first, then resume re-spawned.
      const info = sm.get(x)
      expect(info.running).toBe(true)
      expect(store.get(x)?.slept).toBe(false)

      // And the other order: resume (no-op, live) then sleep → dormant + slept.
      const again = await within(Promise.allSettled([sm.resume(x), sm.sleep(x)]))
      expect(again.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(sm.list().find((s) => s.id === x)?.running).toBe(false)
      expect(store.get(x)?.slept).toBe(true)
    })

    it("setProfile(X, p, 'now') + restart(X) run serially with the pin persisted", async () => {
      const before = {
        profiles: defaultConfig.profiles,
        activeProfileId: defaultConfig.activeProfileId,
        modelGroups: defaultConfig.modelGroups,
      }
      const profile = (id: string): import('./config.js').ProviderProfile => ({
        id, name: id, authToken: 'sk-' + id, baseUrl: 'https://gw-' + id,
        modelList: ['vendor/model-' + id], modelGroups: [], recapModel: '', commitMessageModel: '',
      })
      try {
        __setConfigForTest({ profiles: [profile('A'), profile('B')], activeProfileId: 'A', modelGroups: [] })
        const x = await liveWithTurn({ profileId: 'A', model: 'vendor/model-A' })
        const { gate, calls } = parkFirstCall('buildResumeOpts')
        const handlesBefore = mockHandles.length

        const pinning = sm.setProfile(x, 'B', 'now')
        const restarting = sm.restart(x)
        for (let i = 0; i < 5; i++) await tick()
        // setProfile's nested restart is parked; the outer restart is queued.
        expect(calls).toHaveLength(1)

        gate.resolve()
        await within(Promise.all([pinning, restarting]))
        expect(calls).toHaveLength(2)
        // One respawn per restart, in order: setProfile's, then the queued one.
        expect(mockHandles.length).toBe(handlesBefore + 2)
        expect(sm.get(x).profileId).toBe('B')
        expect(store.get(x)?.profileId).toBe('B')
        expect(store.get(x)?.model).toBe('vendor/model-B')
      } finally {
        __setConfigForTest({ ...before })
      }
    })

    it('interrupt(X) is not blocked by a parked restart(X)', async () => {
      const x = await liveWithTurn()
      const { gate } = parkFirstCall('buildResumeOpts')
      const restarting = sm.restart(x)
      await tick()
      await within(sm.interrupt(x), 1000)
      gate.resolve()
      await within(restarting)
    })

    it('interrupt(X) is not blocked by a parked clear(X)', async () => {
      const x = await liveWithTurn()
      const { gate } = parkFirstCall('applySessionMcpServers')
      const clearing = sm.clear(x)
      await tick()
      await within(sm.interrupt(x), 1000)
      gate.resolve()
      await within(clearing)
    })

    it('nested public calls re-enter instead of deadlocking', async () => {
      // compact → clear
      const a = await liveWithTurn()
      const compacted = await within(sm.compact(a))
      expect(compacted.id).not.toBe(a)

      // setProfile → setModel + restart
      const before = { profiles: defaultConfig.profiles, activeProfileId: defaultConfig.activeProfileId }
      const profile = (id: string): import('./config.js').ProviderProfile => ({
        id, name: id, authToken: 'sk-' + id, baseUrl: 'https://gw-' + id,
        modelList: ['vendor/model-' + id], modelGroups: [], recapModel: '', commitMessageModel: '',
      })
      try {
        __setConfigForTest({ profiles: [profile('A'), profile('B')], activeProfileId: 'A' })
        const b = await liveWithTurn({ profileId: 'A' })
        const pinned = await within(sm.setProfile(b, 'B', 'now'))
        expect(pinned.profileId).toBe('B')
      } finally {
        __setConfigForTest({ ...before })
      }

      // discard → fork (needs the anchor sidecar for asst-1)
      const c = await liveWithTurn()
      const smAny = sm as unknown as { turnAnchorStore: { load: (id: string) => Promise<Array<{ assistantUuid: string }> | null> } }
      for (let i = 0; i < 60 && ((await smAny.turnAnchorStore.load(c)) ?? []).length === 0; i++) await tick()
      const y = await within(sm.discard(c, 'asst-1'))
      expect(y.id).not.toBe(c)
    })

    it('delete(X) during a live turn resolves', async () => {
      const info = await sm.create({ cwd: dir, model: 'm1' })
      sm.send(info.id, 'long task')
      mockHandles[0].emit({ type: 'assistant', uuid: 'a-mid', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] } })
      await tick()
      expect(sm.get(info.id).phase).toBe('working')
      await within(sm.delete(info.id))
      expect(sm.list().some((s) => s.id === info.id)).toBe(false)
      expect(store.get(info.id)).toBeUndefined()
    })

    it('delete(X) still resolves while a setter is wedged on a control request that never answers', async () => {
      await sm.shutdown()
      sm = new SessionManager({ store, deleteLockMaxWaitMs: 50 })
      const info = await sm.create({ cwd: dir, model: 'm1' })
      const h = mockHandles.at(-1)!
      h.setModel.mockImplementationOnce(() => new Promise<never>(() => { /* CLI never answers */ }))
      const setting = sm.setModel(info.id, 'm2')
      await tick()
      expect(h.setModel).toHaveBeenCalledWith('m2')

      await within(sm.delete(info.id), 1000)
      expect(sm.list().some((s) => s.id === info.id)).toBe(false)
      expect(store.get(info.id)).toBeUndefined()
      void setting
    })

    it('two concurrent resume(X) calls return the identical promise', async () => {
      const x = await liveWithTurn()
      await sm.unload(x)
      const handlesBefore = mockHandles.length
      const p1 = sm.resume(x)
      const p2 = sm.resume(x)
      expect(p2).toBe(p1)
      await within(p1)
      expect(mockHandles.length).toBe(handlesBefore + 1)
    })
  })

  describe('TaskResultStore wiring', () => {
    it('hydrates session.tasks from the sidecar across a manager restart', async () => {
      // 1. Seed the sidecar under a KNOWN session id. `create()` always mints
      //    a fresh UUID and does NOT accept `resume:` (session-manager.ts
      //    documents: "For resume, use resume() instead"), so we seed the
      //    store directly and drive the hydrate path via resume().
      const { TaskResultStore } = await import('./task-result-store.js')
      const seeded = new TaskResultStore(dir)
      await seeded.save('sess-known', [
        { taskId: 't1', toolUseId: 'tu1', description: 'old', status: 'completed',
          result: 'FROM-DISK', updatedAt: 1, endedAt: 2, startedAt: 0 },
      ])

      // 2. hydrateTasks is fire-and-forget on spawn. Create a session (any id),
      //    then call the private hydrate with the KNOWN id + its live session
      //    object, and assert the record lands.
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      const s1 = (sm as unknown as { sessions: Map<string, { tasks: Map<string, { result?: string; description?: string }> }> }).sessions.get(info.id)!
      ;(sm as unknown as { hydrateTasks: (id: string, s: unknown) => void }).hydrateTasks('sess-known', s1)
      await vi.waitFor(() => {
        expect(s1.tasks.get('t1')?.result).toBe('FROM-DISK')
      })

      // 3. Review Focus #3 — a live frame for a DIFFERENT taskId must coexist.
      const { applyTaskNotificationInjection } = await import('./session-pump.js')
      applyTaskNotificationInjection(s1 as never, {
        type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text:
          '<task-notification><task-id>t2</task-id><tool-use-id>tu2</tool-use-id>' +
          '<status>completed</status><result>LIVE-ONE</result></task-notification>' }] },
      } as never)
      expect(s1.tasks.get('t2')?.result).toBe('LIVE-ONE')
      expect(s1.tasks.get('t1')?.result).toBe('FROM-DISK')

      // 4. Review Focus #3 — hydrate must NOT clobber a record that already
      //    exists (a live frame that landed first wins).
      await seeded.save('sess-known', [
        { taskId: 't2', toolUseId: 'tu2', description: 'STALE', status: 'completed',
          result: 'STALE-RESULT', updatedAt: 99, endedAt: 100 },
      ])
      ;(sm as unknown as { hydrateTasks: (id: string, s: unknown) => void }).hydrateTasks('sess-known', s1)
      await new Promise((r) => setTimeout(r, 20))
      expect(s1.tasks.get('t2')?.result).toBe('LIVE-ONE') // unchanged — hydrate only fills holes
      expect(s1.tasks.get('t2')?.description).not.toBe('STALE')
    })

    it('persists after settleTasksOnProcessExit flips a live record terminal (Review Focus #7)', async () => {
      // settleTasksOnProcessExit mutates session.tasks OUTSIDE the pump loop,
      // so the CLI-death call site must persist explicitly. If it skips that,
      // a task settled on CLI death shows terminal live and then vanishes
      // across a restart — exactly when the sidecar matters most.
      //
      // Drive the REAL call-site wiring (handleProcessExit's
      // `if (settledNow) this.persistTasks(s)`) — the test must never invoke
      // persistTasks itself, so deleting that line fails here. The mock Query
      // has no ProcessMonitor behind it (the SDK mock bypasses the CLI spawn),
      // so the cheapest real-path trigger is the registered onProcessExit
      // callback body — the same seam the crash-recovery suite's fireCrash
      // uses. NON-clean exit shape (`code: 1`): the clean-exit branch defers
      // to pump cleanup and never reaches this settle (that half is covered
      // by the cleanup-tail test below).
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      const s1 = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, unknown> }>
      }).sessions.get(info.id)!

      // Seed a running record directly (the XML fold always writes terminal
      // status, so it cannot produce the pre-settle state this test needs).
      s1.tasks.set('tz', {
        taskId: 'tz', toolUseId: 'tuz', description: 'bg', status: 'running', updatedAt: 1,
      })

      ;(sm as unknown as { handleProcessExit: (i: unknown) => void }).handleProcessExit({
        sessionId: info.id, code: 1, signal: null, killed: false,
      })

      // The exit path settled the record terminal and its call-site persist
      // wrote the sidecar. Assert the durable half.
      const { TaskResultStore } = await import('./task-result-store.js')
      await vi.waitFor(async () => {
        const recs = await new TaskResultStore(dir).load(info.id)
        const rec = recs?.find((r) => r.taskId === 'tz')
        expect(rec?.status).toBe('stopped')
      })
    })

    it("fork inherits the parent's task records (result survives)", async () => {
      // A forked session's TasksPanel must not be blank when its parent had
      // completions — the task-result sidecar follows the fork. Drive the
      // parent's record through the REAL pump path (the XML injection folds
      // and persists exactly as a live frame would), then fork and require
      // the fork's live tasks map to carry it after hydrate.
      const source = await sm.create({ cwd: '/tmp', model: 'test-model' })
      const h0 = mockHandles.at(-1)!
      sm.send(source.id, 'hi')
      h0.emit({ type: 'result' })
      await tick()

      h0.emit({
        type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text:
          '<task-notification><task-id>ft1</task-id><tool-use-id>ftu1</tool-use-id>' +
          '<status>completed</status><result>FROM-PARENT</result></task-notification>' }] },
      })
      await tick()
      const parent = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, { result?: string }> }>
      }).sessions.get(source.id)!
      expect(parent.tasks.get('ft1')?.result).toBe('FROM-PARENT')

      const forked = await sm.fork(source.id)
      const child = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, { result?: string }> }>
      }).sessions.get(forked.id)!
      await vi.waitFor(() => {
        expect(child.tasks.get('ft1')?.result).toBe('FROM-PARENT')
      })
    })

    it('persists the clean-exit settle to the sidecar when the pump ends (cleanup tail)', async () => {
      // The pump's CLEAN-exit tail (session-pump cleanupPump →
      // settleTasksOnProcessExit) is a fifth mutation site outside the four
      // fold branches — its recordTasksSnapshot fire is the only thing that
      // makes those rows durable. End the stream normally with one running
      // record and require the sidecar to carry the terminal state; without
      // the cleanup-tail persist the load finds nothing (or the stale
      // 'running' row) and this fails.
      const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
      const s1 = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, unknown> }>
      }).sessions.get(info.id)!
      s1.tasks.set('tc', { taskId: 'tc', toolUseId: 'tuc', description: 'bg', status: 'running', updatedAt: 1 })

      mockHandles.at(-1)!.finish()
      const { TaskResultStore } = await import('./task-result-store.js')
      await vi.waitFor(async () => {
        const recs = await new TaskResultStore(dir).load(info.id)
        expect(recs?.find((r) => r.taskId === 'tc')?.status).toBe('stopped')
      })
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

// ---------------------------------------------------------------------------
// MCP re-spawn semantics: every re-spawn path (resume / fork / clear / …)
// carries the session's OWN persisted selection instead of re-injecting
// whatever is globally enabled right now (the silent-widen bug: a server the
// user never activated for this session appeared after a resume).
// ---------------------------------------------------------------------------

describe('MCP re-spawn semantics', () => {
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

  const lastOpts = () =>
    mockHandles[mockHandles.length - 1].options as { mcpServers?: Record<string, unknown> }
  // The SDK options legitimately include first-party in-process servers
  // (type: 'sdk', injected by spawn AFTER snapshotMeta) — they are not part
  // of the user's selection and must not pollute these assertions.
  const userMcpNames = () => {
    const mcp = lastOpts().mcpServers as Record<string, { type?: string }> | undefined
    return Object.keys(mcp ?? {}).filter((n) => mcp![n].type !== 'sdk')
  }

  it('resume carries the session\'s own selection instead of the current global set', async () => {
    const info = await sm.create({ cwd: dir, enabledMcpServers: ['global-a'] } as any)
    expect(info.mcpServerNames).toEqual(['global-a'])
    await sm.unload(info.id)
    await sm.resume(info.id)
    // global-b is globally enabled but was never selected for this session
    expect(userMcpNames()).toEqual(['global-a'])
  })

  it('an explicit empty selection stays empty across resume', async () => {
    const info = await sm.create({ cwd: dir, enabledMcpServers: [] } as any)
    expect(info.mcpServerNames).toEqual([])
    await sm.unload(info.id)
    const resumed = await sm.resume(info.id)
    expect(userMcpNames()).toEqual([])
    // The explicit-none survives the respawn — a second resume must not
    // widen it to the global set.
    expect(resumed.mcpServerNames).toEqual([])
  })

  it('a legacy session without recorded names falls back to the global set', async () => {
    const info = await sm.create({ cwd: dir } as any)
    expect(info.mcpServerNames).toBeUndefined()
    await sm.unload(info.id)
    const resumed = await sm.resume(info.id)
    // global-off is globally disabled — excluded from the fallback set
    expect(userMcpNames().sort()).toEqual(['global-a', 'global-b'])
    // The fallback resolves ONCE and is then recorded as the session's own
    // list — later re-spawns no longer track global changes.
    expect(resumed.mcpServerNames).toEqual(['global-a', 'global-b'])
  })

  it('names that no longer resolve are dropped instead of blocking the spawn', async () => {
    const info = await sm.create({ cwd: dir, enabledMcpServers: ['global-a', 'ghost'] } as any)
    expect(info.mcpServerNames).toEqual(['global-a', 'ghost'])
    await sm.unload(info.id)
    const resumed = await sm.resume(info.id)
    expect(userMcpNames()).toEqual(['global-a'])
    // Self-healing: the respawn re-snapshots the RESOLVED set
    expect(resumed.mcpServerNames).toEqual(['global-a'])
  })

  it('an explicitly-requested globally-disabled name survives resume', async () => {
    // A globally-disabled server is "off by default", but a create-time
    // opt-in is the user's explicit choice — the carry-forward must honor
    // it, same as the create path does.
    const info = await sm.create({ cwd: dir, enabledMcpServers: ['global-off'] } as any)
    await sm.unload(info.id)
    await sm.resume(info.id)
    expect(userMcpNames()).toEqual(['global-off'])
  })

  it('fork carries the source session\'s own selection', async () => {
    const info = await sm.create({ cwd: dir, enabledMcpServers: ['global-a'] } as any)
    // fork() refuses turn-less sessions — complete one turn first
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.fork(info.id)
    // The fork is a NEW session — its handle is the last one
    expect(userMcpNames()).toEqual(['global-a'])
  })

  it('auto-resume (respawnInPlace) does not leak the app-level MCP selection into the SDK options', async () => {
    // respawnInPlace (autoResume / crash recovery / restart) bypasses
    // spawn()'s app-level-key strip and feeds providerExtras.sdkOptions
    // straight into query() — the applySessionMcpServers stamp must be
    // stripped there too, or the CLI arg builder sees a non-SDK key.
    // Driven via buildResumeOpts → respawnInPlace directly (the exact leak
    // path) rather than through autoResume's lifecycle guards.
    const info = await sm.create({ cwd: dir, enabledMcpServers: ['global-a'] } as any)
    sm.send(info.id, 'first')
    await tick()
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      buildResumeOpts: (session: unknown) => Promise<Record<string, unknown>>
      respawnInPlace: (session: unknown, opts: Record<string, unknown>, reason: string) => void
    }
    const session = internals.sessions.get(info.id)!
    const resumeOpts = await internals.buildResumeOpts(session)
    // Precondition: the stamp is present on the resume opts when they leave
    // buildResumeOpts (snapshotMeta is NOT called on this path, so the stamp
    // is dead weight here — but must not reach the SDK either way).
    expect((resumeOpts as { enabledMcpServers?: string[] }).enabledMcpServers).toEqual(['global-a'])
    internals.respawnInPlace(session, resumeOpts as Record<string, unknown>, 'test')
    expect(mockHandles).toHaveLength(2)
    const opts = mockHandles[1].options as {
      mcpServers?: Record<string, { type?: string }>
      enabledMcpServers?: unknown
    }
    // The resolved selection rides as Options.mcpServers (first-party sdk
    // servers excluded — they are not the user's selection)…
    expect(Object.keys(opts.mcpServers ?? {}).filter((n) => opts.mcpServers![n].type !== 'sdk')).toEqual(['global-a'])
    // …first-party in-process servers ARE re-injected (they exist only when
    // passed per-spawn — without this they'd vanish from the recovered
    // session), and the app-level stamp must NOT reach the SDK.
    expect(Object.values(opts.mcpServers ?? {}).some((c) => c.type === 'sdk')).toBe(true)
    expect(opts.enabledMcpServers).toBeUndefined()
  })

  it('respawnInPlace re-applies the RAM tool profile onto the SDK options', async () => {
    // The tool profile is spawn-time-only (plain Options keys — no Settings
    // layer can re-apply it post-spawn), so an in-place respawn must
    // project it again or the recovered session silently regains the
    // disallowed tools.
    const info = await sm.create({ cwd: dir, enabledMcpServers: ['global-a'] } as any)
    await sm.setToolProfile(info.id, { disallowedTools: ['WebSearch'] } as never)
    sm.send(info.id, 'first')
    await tick()
    mockHandles[0].emit({ type: 'result', session_id: info.id })
    await tick()
    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      buildResumeOpts: (session: unknown) => Promise<Record<string, unknown>>
      respawnInPlace: (session: unknown, opts: Record<string, unknown>, reason: string) => void
    }
    const session = internals.sessions.get(info.id)!
    const resumeOpts = await internals.buildResumeOpts(session)
    internals.respawnInPlace(session, resumeOpts as Record<string, unknown>, 'test')
    const opts = mockHandles[1].options as { disallowedTools?: string[] }
    expect(opts.disallowedTools).toEqual(['WebSearch'])
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

  it('create() with enabledPlugins injects only the selected plugin paths', async () => {
    const info = await sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    expect(mockHandles[0].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
    ])
    expect(info.enabledPlugins).toEqual([MpStore.keyOf('plugA', 'mp1')])
  })

  it('create() without enabledPlugins injects all enabled plugins (default)', async () => {
    await sm.create({ cwd: dir })
    expect(mockHandles[0].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
      { type: 'local', path: '/fake/plugB' },
    ])
  })

  it('create() with enabledPlugins: [] injects no plugins', async () => {
    const info = await sm.create({
      cwd: dir,
      enabledPlugins: [],
    } as any)
    expect(mockHandles[0].options.plugins).toBeUndefined()
    expect(info.enabledPlugins).toEqual([])
  })

  it('resume() re-injects the persisted plugin subset', async () => {
    const info = await sm.create({
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
    const info = await sm.create({
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
    const info = await sm.create({
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

  it('does not leak the app-level enabledPlugins string[] into SDK Options', async () => {
    // SDK Options.enabledPlugins is a {[k:string]: ...} map, not a string[].
    // The app-level selection must be stripped from sdkOptions before reaching
    // query() (only Options.plugins — resolved paths — should reach the SDK).
    await sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as any)
    expect(mockHandles[0].options.enabledPlugins).toBeUndefined()
  })

  // ── per-session toggle materialization ────────────────────────────
  // The SDK offers no read-back of enabledPlugins state (applyFlagSettings is
  // write-only), so the app layer records the override: a MATERIALIZED toggle
  // resolves the session's spawn set (undefined = the global enabled list) and
  // pins the post-toggle list onto SessionMeta.enabledPlugins, giving the
  // client a durable per-session truth source that survives refresh/respawn.

  it('togglePlugin({ materialize }) on an all-enabled session resolves the global list minus the disabled key', async () => {
    const info = await sm.create({ cwd: dir } as any)
    await sm.togglePlugin(info.id, MpStore.keyOf('plugA', 'mp1'), false, { materialize: true })
    // The live switch still forwards to the Query.
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      enabledPlugins: { [MpStore.keyOf('plugA', 'mp1')]: false },
    })
    const expected = [MpStore.keyOf('plugB', 'mp1')]
    expect(sm.get(info.id)?.enabledPlugins).toEqual(expected)
    expect(store.get(info.id)?.enabledPlugins).toEqual(expected)
  })

  it('togglePlugin({ materialize }) enabling an already-enabled key on an unpinned session leaves it unpinned', async () => {
    // Content no-op on the resolved base list: the key is already on, the
    // session follows the global list, so there is nothing to pin.
    const info = await sm.create({ cwd: dir } as any)
    await sm.togglePlugin(info.id, MpStore.keyOf('plugA', 'mp1'), true, { materialize: true })
    expect(sm.get(info.id)?.enabledPlugins).toBeUndefined()
  })

  it('togglePlugin({ materialize }) re-enabling a key on a pinned session appends it to the subset', async () => {
    const info = await sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugB', 'mp1')],
    } as any)
    await sm.togglePlugin(info.id, MpStore.keyOf('plugA', 'mp1'), true, { materialize: true })
    expect(sm.get(info.id)?.enabledPlugins).toEqual([
      MpStore.keyOf('plugB', 'mp1'),
      MpStore.keyOf('plugA', 'mp1'),
    ])
    expect(store.get(info.id)?.enabledPlugins).toEqual([
      MpStore.keyOf('plugB', 'mp1'),
      MpStore.keyOf('plugA', 'mp1'),
    ])
  })

  it('togglePlugin({ materialize }) disabling a key on a pinned session removes it from the subset', async () => {
    const info = await sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1'), MpStore.keyOf('plugB', 'mp1')],
    } as any)
    await sm.togglePlugin(info.id, MpStore.keyOf('plugA', 'mp1'), false, { materialize: true })
    expect(sm.get(info.id)?.enabledPlugins).toEqual([MpStore.keyOf('plugB', 'mp1')])
  })

  it('togglePlugin without materialize (global-ripple path) forwards the live switch but leaves the subset untouched', async () => {
    const info = await sm.create({ cwd: dir } as any)
    await sm.togglePlugin(info.id, MpStore.keyOf('plugA', 'mp1'), false)
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
      enabledPlugins: { [MpStore.keyOf('plugA', 'mp1')]: false },
    })
    // The marketplace ripple must not pin sessions: their next spawn picks up
    // the global state via spawn-time injection (mp-marketplace.ts contract).
    expect(sm.get(info.id)?.enabledPlugins).toBeUndefined()
  })

  it('togglePlugin({ materialize }) that changes nothing leaves the subset undefined (no pin on a no-op)', async () => {
    // Disabling a key that is not in the resolved global list is a content
    // no-op — pinning the session to the toggle-time global set would freeze
    // it against future global ripples for a toggle that changed nothing.
    const info = await sm.create({ cwd: dir } as any)
    // plugC@mp1 is not a marketplace plugin at all → absent from the base list.
    await sm.togglePlugin(info.id, MpStore.keyOf('plugC', 'mp1'), false, { materialize: true })
    expect(sm.get(info.id)?.enabledPlugins).toBeUndefined()
    expect(store.get(info.id)?.enabledPlugins).toBeUndefined()
  })

  it('togglePlugin({ materialize }) without an mpStore leaves the subset untouched', async () => {
    // No mpStore → no global list to resolve and spawn injection is a no-op
    // anyway (applyStandardQueryOpts guards on mpStore) — materializing would
    // record a lie.
    mockHandles.length = 0
    const smNoMp = new SessionManager({ store })
    try {
      const info = await smNoMp.create({ cwd: dir } as any)
      await smNoMp.togglePlugin(info.id, MpStore.keyOf('plugA', 'mp1'), false, { materialize: true })
      expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({
        enabledPlugins: { [MpStore.keyOf('plugA', 'mp1')]: false },
      })
      expect(smNoMp.get(info.id)?.enabledPlugins).toBeUndefined()
    } finally {
      await smNoMp.shutdown()
    }
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
    const info = await sm.create({ cwd: '/tmp' })
    mockHandles[0].setMcpServers.mockRejectedValueOnce(new Error('Connection closed'))
    const err = await rejectOf(sm.setMcpServers(info.id, { x: { type: 'stdio', command: 'node' } }))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(502)
    expect((err as HttpError).message).toBe('dynamic MCP servers failed: Connection closed')
  })

  it('passes an existing HttpError through unchanged', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const original = new HttpError(409, 'phase guard')
    mockHandles[0].getContextUsage.mockRejectedValueOnce(original)
    const err = await rejectOf(sm.contextUsage(info.id))
    expect(err).toBe(original)
  })

  it('wraps a plain SDK error on the timeSdkControl path too', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockHandles[0].getContextUsage.mockRejectedValueOnce(new Error('Connection closed'))
    const err = await rejectOf(sm.contextUsage(info.id))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(502)
    expect((err as HttpError).message).toBe('context usage failed: Connection closed')
  })

  it('forwards classify opt-in from the MCP manager wiring into the structured 502 body', async () => {
    // Guards the deps-arrow wiring in SessionManager's constructor: the
    // SessionMcpManager deps are satisfied by arrows whose fewer parameters
    // still typecheck, so a dropped `opts` would silently turn every
    // `{ classify: true }` into dead plumbing (no code/hint on the wire).
    const info = await sm.create({ cwd: '/tmp' })
    mockHandles[0].toggleMcpServer.mockRejectedValueOnce(new Error('Connection closed'))
    const err = await rejectOf(sm.toggleMcpServer(info.id, 'x', true))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(502)
    const body = (err as HttpError).body as { error?: { code?: string } } | undefined
    expect(body?.error?.code).toBe('connection-closed')
  })

  it('does not attach MCP-flavored hints to non-MCP control actions', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockHandles[0].interrupt.mockRejectedValueOnce(new Error('Connection closed'))
    const err = await rejectOf(sm.interrupt(info.id))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('interrupt failed: Connection closed')
    expect((err as HttpError).body).toBeUndefined()
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
    mockListSubagents.mockReset()
    mockListSubagents.mockImplementation(async () => [])
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

  it('forwards the given servers straight to query.setMcpServers (plus git-tools)', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const servers = { x: { type: 'stdio', command: 'node' } }
    const result = await sm.setMcpServers(info.id, servers)
    // The first-party git-tools server is appended to the map (spawn + live
    // share the injectAppTools path); the user servers pass through verbatim.
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({
      ...servers,
      'git-tools': expect.anything(),
    })
    expect(result).toEqual({ added: ['x', 'git-tools'], removed: [], errors: {} })
  })

  it('spawn sets perTaskStopAffordance so the per-task stop control is declared', async () => {
    await sm.create({ cwd: '/tmp' })
    expect(mockHandles[0].options.perTaskStopAffordance).toBe(true)
  })

  it('setMcpPermissionModeOverride forwards to the handle and surfaces the warning', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockHandles[0].setMcpPermissionModeOverride.mockResolvedValueOnce({ warning: 'unknown server' })
    const result = await sm.setMcpPermissionModeOverride(info.id, 'global-a', 'auto')
    expect(mockHandles[0].setMcpPermissionModeOverride).toHaveBeenCalledWith('global-a', 'auto')
    expect(result).toEqual({ warning: 'unknown server' })
  })

  it('setMcpPermissionModeOverride forwards a null (clear) mode verbatim', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    await sm.setMcpPermissionModeOverride(info.id, 'global-a', null)
    expect(mockHandles[0].setMcpPermissionModeOverride).toHaveBeenCalledWith('global-a', null)
  })

  it('rejects a live setMcpPermissionModeOverride for a ghost session', async () => {
    await expect(sm.setMcpPermissionModeOverride('ghost', 'x', 'default')).rejects.toBeTruthy()
  })

  it('listSubagents forwards to the SDK standalone scanner with the session cwd', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockListSubagents.mockResolvedValueOnce(['agent-1', 'agent-2'])
    const result = await sm.listSubagents(info.id)
    expect(mockListSubagents).toHaveBeenCalledWith(info.id, { dir: '/tmp' })
    expect(result).toEqual(['agent-1', 'agent-2'])
  })

  it('rejects listSubagents for a ghost session', async () => {
    await expect(sm.listSubagents('ghost')).rejects.toBeTruthy()
  })

  it('injects the git-tools server into spawn mcpServers when the session has a cwd', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const mcpServers = mockHandles[0].options.mcpServers as Record<string, unknown>
    expect(mcpServers['git-tools']).toBeDefined()
    expect(mockInjectAll).toHaveBeenCalledWith('/tmp', expect.any(Function), expect.any(Function))
    expect(info.mcpServerNames ?? []).not.toContain('git-tools')
  })

  it('omits git-tools when the session has no cwd', async () => {
    await sm.create({})
    const mcpServers = mockHandles[0].options.mcpServers as Record<string, unknown> | undefined
    expect(mcpServers?.['git-tools']).toBeUndefined()
  })

  it('create() seeds a create-time firstPartyTools override so the first spawn honors it', async () => {
    const info = await sm.create({ cwd: '/tmp', firstPartyTools: { 'git-tools': false } } as Parameters<SessionManager['create']>[0])
    // The override lands on the session (persisted via writeStore) AND the
    // first spawn injection already skips git-tools — no create-then-toggle
    // round-trip needed.
    expect(info.firstPartyTools).toEqual({ 'git-tools': false })
    const mcpServers = mockHandles[0].options.mcpServers as Record<string, unknown> | undefined
    expect(mcpServers?.['git-tools']).toBeUndefined()
  })

  it('create() migrates a pre-rename apptools firstPartyTools key so the first spawn honors it', async () => {
    // A stale client / raw API body still sending the old key must not store
    // a pin that firstPartyEnabled never reads.
    const info = await sm.create({ cwd: '/tmp', firstPartyTools: { apptools: false } } as Parameters<SessionManager['create']>[0])
    expect(info.firstPartyTools).toEqual({ 'git-tools': false })
    expect(info.appToolsGit).toBe(false)
    const mcpServers = mockHandles[0].options.mcpServers as Record<string, unknown> | undefined
    expect(mcpServers?.['git-tools']).toBeUndefined()
  })

  it('create() seeds create-time UI prefs (the client restart flow)', async () => {
    // The restart flow creates a fresh id via POST /sessions; without these
    // riding the body, Y's panel would silently revert to the global defaults.
    const info = await sm.create({
      cwd: '/tmp',
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      autoExpandRunningGroups: false,
      showMessageHeaders: false,
    } as Parameters<SessionManager['create']>[0])
    expect(info.showPinnedUserMessage).toBe(false)
    expect(info.autoRecap).toBe(false)
    expect(info.toolGroupCards).toBe(false)
    expect(info.autoExpandRunningGroups).toBe(false)
    expect(info.showMessageHeaders).toBe(false)
    // Persisted too, so a later resume/fork of Y keeps them.
    const meta = store.get(info.id)
    expect(meta?.autoExpandRunningGroups).toBe(false)
    expect(meta?.showMessageHeaders).toBe(false)
  })

  it('create() with no UI prefs leaves them undefined (inherit global)', async () => {
    const info = await sm.create({ cwd: '/tmp' } as Parameters<SessionManager['create']>[0])
    expect(info.showPinnedUserMessage).toBeUndefined()
    expect(info.autoExpandRunningGroups).toBeUndefined()
    expect(info.showMessageHeaders).toBeUndefined()
  })

  it('create() strips the app-level UI prefs from the SDK options', async () => {
    // They ride the create body (restart flow) but are app state only — the
    // SDK has no such Options keys, and the CLI arg builder would choke on
    // unknown fields.
    await sm.create({
      cwd: '/tmp',
      showPinnedUserMessage: false,
      toolGroupCards: false,
      autoExpandRunningGroups: false,
      showMessageHeaders: false,
    } as Parameters<SessionManager['create']>[0])
    const opts = mockHandles[0].options as Record<string, unknown>
    expect(opts.showPinnedUserMessage).toBeUndefined()
    expect(opts.toolGroupCards).toBeUndefined()
    expect(opts.autoExpandRunningGroups).toBeUndefined()
    expect(opts.showMessageHeaders).toBeUndefined()
  })

  it('omits git-tools from live setMcpServers when the session override disables it', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    // Simulate a per-session override turning git-tools off (setAppTools path).
    const session = (sm as unknown as { sessions: Map<string, { appToolsGit?: boolean }> }).sessions.get(info.id)!
    session.appToolsGit = false
    await sm.setMcpServers(info.id, { x: { type: 'stdio', command: 'node' } })
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({ x: { type: 'stdio', command: 'node' } })
  })

  it('setFirstPartyTool persists the override and re-injects immediately on a live session', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const next = await sm.setFirstPartyTool(info.id, 'git-tools', false)
    expect(next.firstPartyTools?.['git-tools']).toBe(false)
    expect(next.appToolsGit).toBe(false)
    // Live → re-runs the injection path (setMcpServers with the stored user
    // map); git-tools is now disabled so the handle sees only the empty user set.
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({})
    // A later re-enable injects git-tools again.
    await sm.setFirstPartyTool(info.id, 'git-tools', true)
    expect(mockHandles[0].setMcpServers).toHaveBeenLastCalledWith({ 'git-tools': expect.anything() })
  })

  it('setFirstPartyTool normalizes a pre-rename apptools server name', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const next = await sm.setFirstPartyTool(info.id, 'apptools', false)
    expect(next.firstPartyTools?.['git-tools']).toBe(false)
    expect(next.firstPartyTools?.apptools).toBeUndefined()
    expect(next.appToolsGit).toBe(false)
  })

  it('firstPartyEnabled honors an unmigrated apptools session override', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const session = (sm as unknown as { sessions: Map<string, { firstPartyTools?: Record<string, boolean | null> }> }).sessions.get(info.id)!
    session.firstPartyTools = { apptools: false }
    const mcp = (sm as unknown as { mcp: { firstPartyEnabled(s: unknown, name: string): boolean } }).mcp
    expect(mcp.firstPartyEnabled(session, 'git-tools')).toBe(false)
  })

  it('setFirstPartyTool reverts the override when the live re-injection fails', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    mockHandles[0].setMcpServers.mockRejectedValueOnce(new Error('sdk down'))
    await expect(sm.setFirstPartyTool(info.id, 'git-tools', false)).rejects.toThrow('sdk down')
    const session = (sm as unknown as { sessions: Map<string, { firstPartyTools?: Record<string, boolean | null> }> }).sessions.get(info.id)!
    expect(session.firstPartyTools?.['git-tools']).toBeUndefined()
  })

  it('setFirstPartyTool on a non-running session only persists (no SDK call)', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const session = (sm as unknown as { sessions: Map<string, { running: boolean }> }).sessions.get(info.id)!
    session.running = false
    mockHandles[0].setMcpServers.mockClear()
    const next = await sm.setFirstPartyTool(info.id, 'git-tools', true)
    expect(next.firstPartyTools?.['git-tools']).toBe(true)
    expect(mockHandles[0].setMcpServers).not.toHaveBeenCalled()
  })

  it('toolServerStatus reports enabled/injected/hasCwd per registered server', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const status = sm.toolServerStatus(info.id)
    const gitTools = status.find((s) => s.name === 'git-tools')!
    expect(gitTools.enabled).toBe(true)
    expect(gitTools.injected).toBe(true)
    expect(gitTools.requiresCwd).toBe(true)
    expect(gitTools.hasCwd).toBe(true)
    expect(gitTools.error).toBeUndefined()
  })

  it('toolServerStatus embeds the registry static tool listing per server', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const status = sm.toolServerStatus(info.id)
    const gitTools = status.find((s) => s.name === 'git-tools')!
    expect(gitTools.tools).toEqual([{ name: 'stub_tool', description: 'stub', readOnly: true }])
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
    const info = await sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, {
      enabledMcpServers: ['global-a'],
    })
    expect(res.status).toBe(200)
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({
      'global-a': { type: 'stdio', command: 'node', args: ['a.js'] },
      'git-tools': expect.anything(),
    })
  })

  it('merges inline servers with enabled global names', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    await post(`/sessions/${info.id}/mcp/servers`, {
      enabledMcpServers: ['global-a'],
      servers: { inline: { type: 'http', url: 'http://x' } },
    })
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({
      'global-a': { type: 'stdio', command: 'node', args: ['a.js'] },
      inline: { type: 'http', url: 'http://x' },
      'git-tools': expect.anything(),
    })
  })

  it('passes an empty object (clear-all) when nothing resolves', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { servers: {} })
    expect(res.status).toBe(200)
    // Empty user set → only the injected first-party git-tools remains.
    expect(mockHandles[0].setMcpServers).toHaveBeenCalledWith({ 'git-tools': expect.anything() })
  })

  it('400s when neither servers nor enabledMcpServers is provided', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, {})
    expect(res.status).toBe(400)
  })

  it('400s when servers is not an object', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { servers: ['nope'] })
    expect(res.status).toBe(400)
  })

  it('400s when enabledMcpServers is a string (not an array)', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { enabledMcpServers: 'global-a' })
    expect(res.status).toBe(400)
    expect(mockHandles[0].setMcpServers).not.toHaveBeenCalled()
  })

  it('400s when enabledMcpServers contains a non-string element', async () => {
    const info = await sm.create({ cwd: '/tmp' })
    const res = await post(`/sessions/${info.id}/mcp/servers`, { enabledMcpServers: ['global-a', 123] })
    expect(res.status).toBe(400)
    expect(mockHandles[0].setMcpServers).not.toHaveBeenCalled()
  })

  // Mass-assignment guard: SDK Options the client never sets must not ride a
  // request body all the way into the spawned Query.
  it('create route drops pathToClaudeCodeExecutable / executable / unknown fields before spawn', async () => {
    const res = await post('/sessions', {
      cwd: '/tmp',
      pathToClaudeCodeExecutable: 'C:/evil.exe',
      executable: 'node',
      someFutureOption: true,
    })
    expect(res.status).toBe(201)
    expect(mockHandles).toHaveLength(1)
    const opts = mockHandles[0].options as Record<string, unknown>
    expect(opts.pathToClaudeCodeExecutable).not.toBe('C:/evil.exe')
    expect(opts).not.toHaveProperty('executable')
    expect(opts).not.toHaveProperty('someFutureOption')
    expect(opts.cwd).toBe('/tmp')
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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
      // cwd exists (dir) → ENOENT is the binary, not the workspace.
      expect(dormant.error).toMatch(/binary not found/i)
      expect(dormant.error).not.toMatch(/Working directory not found/)
      expect(mockHandles).toHaveLength(1) // no auto-recovery respawn (retrying would fail identically)

      // The binary being missing is transient + user-fixable, so the session
      // must stay resumable: resume re-spawns and clears the stale error.
      await sm.resume(info.id)
      expect(mockHandles.length).toBeGreaterThanOrEqual(2)
      expect(sm.get(info.id).running).toBe(true)
      expect(sm.get(info.id).error).toBeUndefined()
    })

    it('spawn ENOENT with a missing cwd blames the working directory, not the binary', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const missingCwd = join(dir, 'moved-away')
      const info = await sm.create({ cwd: missingCwd })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      fireCrash(sm, info.id, { code: null, signal: null, killed: false, spawnError: { code: 'ENOENT', message: 'spawn claude.exe ENOENT' } })
      await waitFor(() => sm.get(info.id).running === false)

      const dormant = sm.get(info.id)
      expect(dormant.error).toMatch(/Working directory not found/)
      expect(dormant.error).toContain('moved-away')
      // The old blanket message sent users to reinstall a perfectly good CLI.
      expect(dormant.error).not.toMatch(/binary not found/i)
    })

    it('ladder exhausted: a 3rd crash gives up transiently (no auto-fork) so the client can offer Resume/Fork', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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

    it('respawnInPlace drops a start-as agent whose def was disabled (same drop-guard as resume/fork)', async () => {
      const defs: Record<string, { enabled: boolean }> = { reviewer: { enabled: true } }
      const agentStore = {
        get: (n: string) => defs[n],
        getEnabledDefinitions: () => Object.fromEntries(
          Object.entries(defs).filter(([, d]) => d.enabled).map(([n]) => [n, { description: n }]),
        ),
      } as unknown as AgentDefinitionStore
      sm = new SessionManager({ store, agentStore, crashRecovery: true })
      const info = await sm.create({ cwd: dir, agent: 'reviewer' })
      const h0 = mockHandles.at(-1)!
      expect(h0.options.agent).toBe('reviewer')
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

      // Disable the def → the in-place respawn (crash recovery Step 1) must
      // NOT carry the stale agent name; it re-spawns as a normal session.
      defs.reviewer = { enabled: false }
      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => mockHandles.length >= 2)
      expect(mockHandles[1].options.agent).toBeUndefined()
    })

    it('rejects sends during the recovering window (no message loss)', async () => {
      sm = new SessionManager({ store, crashRecovery: true })
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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

    it('settles a still-polling background subagent as stopped when the CLI subprocess crashes', async () => {
      // A background subagent runs INSIDE the CLI subprocess. When that process
      // crashes it can never write another transcript line, so the watcher must
      // NOT wait out its 2 h maxMs backstop — the crash is the certain
      // completion signal. handleProcessExit settles it to `stopped` (no
      // terminal frame on disk), dropping backgroundSubagentCount to 0 at once.
      sm = new SessionManager({ store }) // recovery disabled → terminate on crash
      const info = await sm.create({ cwd: '/tmp/workspace' })
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      try {
        // Arm a watcher via the launch-ack path. No transcript on disk, so it
        // stays polling (would otherwise resolve on the immediate first poll).
        mockHandles.at(-1)!.emit({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tu_crash',
              content: 'Async agent launched successfully.\nagentId: agent-crash\n',
            }],
          },
        })
        await tick()
        expect(sm.get(info.id).backgroundSubagentCount).toBe(1)

        // Crash the subprocess. The settle runs before termination while the
        // session is still live, so the synthesized `stopped` frame lands and
        // the watcher count drops immediately (not after 2 h).
        fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
        await waitFor(() => sm.get(info.id).terminated === true)

        // Watcher settled — no lingering poller, no 2 h strand.
        const settled = (sm as unknown as {
          backgroundWatchers: { count(id: string): number }
        }).backgroundWatchers.count(info.id)
        expect(settled).toBe(0)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })

    it("settles the session's non-terminal TASK records on crash, not just tracked subagents", async () => {
      // The companion to the watcher settle above. That one only holds entries
      // for the subagent dispatches IT tracked, so every other record in the
      // task map — background shell / workflow / ambient — was orphaned by the
      // crash and stayed `running` for the rest of the session's life: a
      // spinner in the TasksPanel on a dead session, with no path that ever
      // clears it (the stop-hook sweep needs a Stop hook, and a terminated
      // session never fires one). Observed live before this fix: a background
      // `sleep` shell record survived its session's CLI being killed.
      sm = new SessionManager({ store }) // recovery disabled → terminate on crash
      const info = await sm.create({ cwd: '/tmp/workspace' })
      const sessions = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, { status: string; endedAt?: number }> }>
      }).sessions
      // Hold the Map itself: termination may drop the session from the pool,
      // but the map the settle mutates is this object.
      const live = sessions.get(info.id)!
      mockHandles.at(-1)!.emit({
        type: 'system', subtype: 'task_started', task_id: 'sh-crash', task_type: 'local_bash', tool_use_id: 'tu_sh',
      })
      await tick()
      expect(live.tasks.get('sh-crash')?.status).toBe('running')

      fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
      await waitFor(() => sm.get(info.id).terminated === true)

      const after = live.tasks.get('sh-crash')!
      expect(after.status).toBe('stopped')
      expect(after.endedAt).toBeGreaterThan(0)
    })

    it('settles task records on the CLEAN-exit dead end too, not only a crash', async () => {
      // The sibling dead end for the same bug: a clean exit (code 0) that
      // declines to resume reaches the terminal state through cleanupPump
      // instead of handleProcessExit's crash branch, and used to strand records
      // identically. `settleTasksOnProcessExit` is not called from the
      // handleProcessExit clean-exit branch (an idle exit is normally followed
      // by auto-resume, where settling would flap stopped→done), so this pins
      // the pump-tail call that covers the terminate-after-clean-exit case.
      sm = new SessionManager({ store }) // no autoResume → the tail terminates
      const info = await sm.create({ cwd: '/tmp/workspace' })
      const sessions = (sm as unknown as {
        sessions: Map<string, { tasks: Map<string, { status: string }> }>
      }).sessions
      const live = sessions.get(info.id)!
      mockHandles.at(-1)!.emit({
        type: 'system', subtype: 'task_started', task_id: 'sh-clean', task_type: 'local_bash', tool_use_id: 'tu_sh2',
      })
      await tick()
      expect(live.tasks.get('sh-clean')?.status).toBe('running')

      fireCrash(sm, info.id, { code: 0, signal: null, killed: false }) // clean exit
      await waitFor(() => sm.get(info.id).terminated === true)

      expect(live.tasks.get('sh-clean')?.status).toBe('stopped')
    })

    it('honours a real terminal frame written just before the crash (completed, not stopped)', async () => {
      // If the subagent finished (terminal stop_reason on disk) moments before
      // the host crashed, the settle prefers its real output over a synthesized
      // `stopped`. The synthesized task_notification then carries status
      // `completed` with the subagent's final text.
      sm = new SessionManager({ store })
      const info = await sm.create({ cwd: '/tmp/workspace' })
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      try {
        // Subscribe so we can observe the synthesized frame on the message
        // channel. Drain the replay first.
        const sub = sm.subscribe(info.id)
        const seen: Array<{ subtype?: string; status?: string; summary?: string }> = []
        ;(async () => {
          for await (const m of sub.iterable) seen.push(m as typeof seen[number])
        })()

        mockHandles.at(-1)!.emit({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tu_done',
              content: 'Async agent launched successfully.\nagentId: agent-done\n',
            }],
          },
        })
        await tick()

        // Pre-write a terminal frame the settle will read instead of stopping.
        const txnPath = subagentTranscriptPath('/tmp/workspace', info.id, 'agent-done')
        mkdirSync(dirname(txnPath), { recursive: true })
        writeFileSync(
          txnPath,
          JSON.stringify({
            type: 'assistant',
            message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'finished just in time' }] },
          }) + '\n',
        )

        fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
        await waitFor(() => sm.get(info.id).terminated === true)

        // The watcher is claimed synchronously by the crash, but its transcript
        // read is async: with recovery disabled the immediate termination has
        // already ended the live subscribers by the time the frame lands, so it
        // reaches the history ring (replay) and the task map rather than `seen`.
        const live = (sm as unknown as {
          sessions: Map<string, { history: Array<{ subtype?: string; status?: string; summary?: string }>; tasks: Map<string, { status: string }> }>
        }).sessions.get(info.id)!
        const notifs = () => live.history.filter((m) => m.subtype === 'task_notification')
        // Wall-clock wait: the read is real fs I/O, which waitFor's
        // setImmediate budget does not reliably span.
        const deadline = Date.now() + 2_000
        while (notifs().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
        expect(notifs()).toHaveLength(1)
        expect(notifs()[0].status).toBe('completed')
        expect(notifs()[0].summary).toBe('finished just in time')
        // The process-exit sweep skipped the watcher's record instead of
        // flashing it to `stopped`; the async settle then folded `completed`.
        expect(live.tasks.get('agent-done')?.status).toBe('completed')
        expect(seen.filter((m) => m.subtype === 'task_notification').length).toBeLessThanOrEqual(1)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })

    it('re-arms cleanly when in-place crash recovery replays the launch ack after a settle', async () => {
      // The scenario settleAllOnProcessExit's doc-comment defends: crash settles
      // the watcher (count → 0, synthesized `stopped`), then the recovery ladder
      // resumes in place and the SDK replays the launch-ack tool_result, which
      // re-arms a FRESH watcher. This must NOT strand a poller or permanently
      // double-count — count cycles 1 → 0 (settle) → 1 (re-arm) → 0 (re-settle),
      // and the per-toolUseId dedup means exactly one watcher is armed at a time.
      sm = new SessionManager({ store, crashRecovery: true })
      const info = await sm.create({ cwd: '/tmp/workspace' })
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      try {
        const h0 = mockHandles.at(-1)!
        // Complete a turn so recovery has a resume anchor, then arm a watcher.
        sm.send(info.id, 'hi')
        h0.emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
        await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)

        h0.emit({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_rearm', content: 'Async agent launched successfully.\nagentId: agent-rearm\n' }],
          },
        })
        await tick()
        const count = () => (sm as unknown as { backgroundWatchers: { count(id: string): number } }).backgroundWatchers.count(info.id)
        expect(count()).toBe(1)

        // Crash: settle deletes the watcher map entry synchronously inside
        // handleProcessExit (before the recovery ladder runs), so the count is
        // 0 the instant the crash is handled — assert it before yielding to the
        // async recovery window (which may re-arm and race the assertion).
        fireCrash(sm, info.id, { code: 1, signal: null, killed: false })
        expect(count()).toBe(0) // settled by the crash, synchronously

        await waitFor(() => mockHandles.length >= 2)
        expect(sm.get(info.id).terminated).toBe(false) // recovered in place

        // The SDK's resume replay re-emits the launch ack on the NEW handle —
        // this re-arms exactly one fresh watcher (the settle deleted the map
        // entry, so the dedup no longer blocks it). Guard against a double-arm:
        // the count must never exceed 1.
        const h1 = mockHandles.at(-1)!
        h1.emit({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_rearm', content: 'Async agent launched successfully.\nagentId: agent-rearm\n' }],
          },
        })
        await tick()
        expect(count()).toBe(1) // re-armed, not doubled

        // The re-armed watcher completes for real → count returns to 0 with no
        // stranded poller. The re-arm went through the production start() with
        // default intervals (2 s fast phase), so poll on wall-clock rather
        // than macrotask ticks — waitFor's setImmediate loop can't span 2 s.
        const txnPath = subagentTranscriptPath('/tmp/workspace', info.id, 'agent-rearm')
        mkdirSync(dirname(txnPath), { recursive: true })
        writeFileSync(
          txnPath,
          JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'rearm done' }] } }) + '\n',
        )
        const settledToZero = await new Promise<boolean>((resolve) => {
          const deadline = Date.now() + 5_000
          const poll = () => {
            if (count() === 0) return resolve(true)
            if (Date.now() > deadline) return resolve(false)
            setTimeout(poll, 50)
          }
          poll()
        })
        expect(settledToZero).toBe(true)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    }, 10_000)
  })

  describe('restart() (in-place respawn on a live pump)', () => {
    // restart() replaces the handle while the OLD pump is still parked on
    // iter.next(). Destroying the handle ends that pump, and its cleanupPump
    // then sees a live, healthy session (the one it just handed to a new
    // pump) — so it must NOT run the auto-resume/terminate tail. Without the
    // supersession guard this cascaded: cleanupPump's autoResume re-entered
    // respawnInPlace, destroying the handle restart() had just created, whose
    // pump then did the same, until the resume budget (20) was exhausted and
    // the session terminated with terminatedReason 'query_ended' — the UI's
    // "Connection closed" banner.
    it('leaves the session running (the superseded pump must not terminate it)', async () => {
      const info = await sm.create({ cwd: '/tmp', model: 'm1' })
      sm.send(info.id, 'hi')
      mockHandles[0].emit({
        type: 'result',
        subtype: 'success',
        session_id: info.id,
        is_error: false,
        usage: { input_tokens: 1, iterations: [] },
        modelUsage: {},
      })
      await tick()
      // Precondition: the restart guard (no in-flight turn / queued input) passes.
      expect(sm.get(info.id).running).toBe(true)

      await sm.restart(info.id)
      // Let the superseded pump's cleanupPump run.
      await tick()
      await tick()

      const s = sm.get(info.id)
      expect(s.terminated).toBe(false)
      expect(s.terminatedReason).toBeUndefined()
      // Exactly one respawn — the restart's own. A cascade would show more.
      expect(mockHandles).toHaveLength(2)
      expect(mockHandles[1].options.resume).toBe(info.id)
    })

    // The production config (cli.ts / app.ts pass autoResume: true). Here the
    // superseded pump's cleanupPump finds a healthy live session and, without
    // the supersession guard, re-enters respawnInPlace via autoResume —
    // destroying the handle restart() just created. That pump then does the
    // same, so the session churns through the whole MAX_AUTO_RESUME budget
    // (~0.7s apart, observed in the field) and dies with 'query_ended'.
    it('does not cascade re-spawns when autoResume is enabled', async () => {
      sm = new SessionManager({ store, autoResume: true })
      const info = await sm.create({ cwd: '/tmp', model: 'm1' })
      sm.send(info.id, 'hi')
      mockHandles[0].emit({
        type: 'result',
        subtype: 'success',
        session_id: info.id,
        is_error: false,
        usage: { input_tokens: 1, iterations: [] },
        modelUsage: {},
      })
      await tick()

      await sm.restart(info.id)
      // Give any cascade room to run (pre-fix the first extra spawn lands on
      // the very next tick, and the budget burns out within ~20).
      for (let i = 0; i < 40; i++) await tick()

      expect(mockHandles).toHaveLength(2)
      const s = sm.get(info.id)
      expect(s.terminated).toBe(false)
      expect(s.running).toBe(true)
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
    const setupQueued = async (n: number) => {
      const info = await sm.create({ cwd: dir })
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
      const { info, h, queuedUuids } = await setupQueued(2)
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

    it('tombstones the withdrawn prompts in the seq store, broadcasts messages-evicted, and does not resurrect them after a restart', async () => {
      // A queued-only prompt never reaches the SDK JSONL — the sidecar row
      // recorded at send time (pushToSession → recordTranscriptFor) is its
      // ONLY durable copy. interrupt(cancelQueued) must tombstone it, or the
      // restart reconcile hydrates the withdrawal right back.
      const { info, queuedUuids } = await setupQueued(1)
      const frames: Array<{ kind?: string; uuids?: string[]; seqs?: number[]; generation?: number }> = []
      const sub = sm.subscribeMessageStatus(info.id)
      void (async () => {
        for await (const v of sub!.iterable) {
          frames.push(v as { kind?: string; uuids?: string[]; seqs?: number[]; generation?: number })
        }
      })()

      await sm.interrupt(info.id, { cancelQueued: true })

      // (a) The seq store's window no longer contains the withdrawn prompt
      // (seq space: in-flight seed = 0, queued-0 = 1).
      await sm.getTranscriptWindow(info.id) // ensure reconcile completed
      const win = await sm.getTranscriptWindow(info.id)
      const winUuids = win.messages.map((m) => (m.msg as { uuid?: string }).uuid)
      expect(winUuids).not.toContain(queuedUuids[0])
      expect(win.totalCount).toBe(1)

      // (b) A tombstone row landed in the sidecar file.
      const sidecarFile = join(dir, 'transcripts', `${info.id}.ndjson`)
      expect(existsSync(sidecarFile)).toBe(true)
      const hasTombstoneRow = async (): Promise<boolean> => {
        const rows = readFileSync(sidecarFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { seq?: number; evicted?: boolean })
        return rows.some((r) => r.evicted === true && typeof r.seq === 'number')
      }
      expect(await waitFor(hasTombstoneRow)).toBe(true)

      // (c) The messages-evicted frame carries the withdrawn prompt's seq
      // (after the messages-withdrawn frame, same channel).
      await waitFor(() => frames.some((f) => f.kind === 'messages-evicted'))
      expect(frames.map((f) => f.kind)).toEqual(['messages-withdrawn', 'messages-evicted'])
      const evicted = frames.find((f) => f.kind === 'messages-evicted')!
      expect(evicted.seqs).toEqual([1])
      expect(evicted.generation).toBe(0)

      // Restart shape: a fresh manager over the same state dir rehydrates
      // from the sidecar — the withdrawn prompt must NOT reappear.
      const store2 = new SessionStore({ stateDir: dir })
      await store2.load()
      const sm2 = new SessionManager({ store: store2 })
      try {
        const reloaded = await sm2.getTranscriptWindow(info.id)
        const reloadedUuids = reloaded.messages.map((m) => (m.msg as { uuid?: string }).uuid)
        expect(reloadedUuids).not.toContain(queuedUuids[0])
        expect(reloaded.totalCount).toBe(1)
      } finally {
        await sm2.shutdown()
      }
      sub!.unsubscribe()
    })

    it('a plain interrupt leaves the queue intact (queued turns start the next turn)', async () => {
      const { info, h, queuedUuids } = await setupQueued(1)
      const removed = await sm.interrupt(info.id)
      expect(removed).toBe(0)
      // The manager forwards opts through; the provider normalizes absent →
      // undefined (the SDK builds the cancel_queued field conditionally).
      expect(h.interrupt).toHaveBeenCalledWith(undefined)
      const ringUuids = ringOf(info.id).map((m) => m.uuid)
      expect(ringUuids).toContain(queuedUuids[0])
    })

    it('folds the interrupt receipt cancellations into the withdrawal set (unknown uuids + overlap dedupe)', async () => {
      const { info, h, queuedUuids } = await setupQueued(1)
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
      const { info, h, queuedUuids } = await setupQueued(1)
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
      const { info, queuedUuids } = await setupQueued(2)
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
      const { info, queuedUuids } = await setupQueued(1)
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
      const { info, queuedUuids } = await setupQueued(1)
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

    /** Read live turn-tracking fields off the manager's internal session. */
    const turnStateOf = (sid: string): { pendingTurns: number; workingSince?: number; turnActive?: boolean } => {
      const smAny = sm as unknown as {
        sessions: Map<string, { pendingTurns: number; workingSince?: number; turnActive?: boolean }>
      }
      return smAny.sessions.get(sid)!
    }

    it('clears the stuck working state when the withdrawn turns were the only pending work (no result will ever arrive)', async () => {
      // Regression for the stuck-WorkingBubble bug: send a message, hit Stop
      // before the CLI starts the turn. The mock SDK has already dequeued the
      // message into its internal queue (spawn-time direct hand-off, so
      // queueDepth is 0) but never echoes or starts it — mirroring the
      // production log where the interrupt receipt cancels it
      // (withdrawn=1, receipt=1). No turn ran, so no `result` frame will ever
      // clear pendingTurns; before this fix the session stayed working=true
      // forever (WorkingBubble pinned, phase-gated routes 409ing, health
      // check only after workingStuckMs).
      const info = await sm.create({ cwd: dir })
      const h = mockHandles.at(-1)!
      const sent = sm.send(info.id, 'stop me before the CLI starts') as { uuid: string }
      h.interrupt.mockResolvedValueOnce({ cancelled: [sent.uuid] })
      const s = turnStateOf(info.id)
      expect(s.pendingTurns).toBe(1)
      expect(typeof s.workingSince).toBe('number')
      expect(s.turnActive).toBeFalsy()

      const updates: Array<{ kind?: string; session?: { id?: string; working?: boolean } }> = []
      const sub = sm.subscribeGlobal()
      void (async () => {
        for await (const v of sub.iterable) updates.push(v as (typeof updates)[number])
      })()

      await sm.interrupt(info.id, { cancelQueued: true })

      expect(s.pendingTurns).toBe(0)
      expect(s.workingSince).toBeUndefined()
      // The session list must report the idle phase again — the client's
      // WorkingBubble and phase-gated routes (rewindFiles/compact) both
      // read it.
      const listed = sm.list().find((x) => x.id === info.id)!
      expect(listed.working).toBe(false)
      expect(listed.phase).toBe('idle')
      // And live tabs get the session-update so the UI flips without a reload.
      await waitFor(() =>
        updates.some((u) => u.kind === 'update' && u.session?.id === info.id && u.session?.working === false),
      )
      sub.unsubscribe()
    })

    it('leaves working state alone while an echoed in-flight turn is owed its result', async () => {
      // The safety half of the fix, in the PRODUCTION shape: the seed turn's
      // echo has already landed (onPromptEcho paired it and set turnActive),
      // so the CLI is mid-turn and an aborted `result` is still owed. Only
      // the 2 queued turns withdraw. The fix must NOT preemptively clear
      // pendingTurns here — the owed result stays the authority. (Guarding
      // on unpaired entries alone would miss this: the in-flight turn's
      // entry is PAIRED.)
      const { info, h } = await setupQueued(2)
      // Land the seed's echo: the pump's top-level-user drop-filter hands the
      // SDK uuid to onPromptEcho, which pairs the oldest unpaired entry.
      h.emit({
        type: 'user',
        uuid: 'sdk-on-disk-uuid-seed',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'in-flight turn seed' }] },
      })
      await waitFor(() => turnStateOf(info.id).turnActive === true)
      const s = turnStateOf(info.id)
      expect(s.pendingTurns).toBe(1)

      const removed = await sm.interrupt(info.id, { cancelQueued: true })
      expect(removed).toBe(2)
      // No clear: the in-flight turn is still owed its result.
      expect(s.pendingTurns).toBe(1)
      expect(s.turnActive).toBe(true)
      expect(typeof s.workingSince).toBe('number')

      // The owed result (aborted turn) lands and the pump clears the state
      // through the normal path — the pre-existing clear path still works
      // with the fix in place.
      h.emit({ type: 'result', subtype: 'success' })
      await waitFor(() => turnStateOf(info.id).pendingTurns === 0)
      expect(turnStateOf(info.id).workingSince).toBeUndefined()
      expect(turnStateOf(info.id).turnActive).toBe(false)
    })

    it('heals an already-stuck session on a repeat Stop (state probe, not withdrawal count)', async () => {
      // A session stuck by the pre-fix bug (pendingTurns=1 with no turn ever
      // started, nothing queued, no unpaired entries) must unstick on the
      // next Stop — the probe reads the live state, not `removed > 0`, so a
      // zero-withdrawal interrupt still clears it without a server restart.
      const info = await sm.create({ cwd: dir })
      const s = turnStateOf(info.id)
      s.pendingTurns = 1
      s.workingSince = Date.now()

      await sm.interrupt(info.id) // plain stop — nothing to withdraw

      expect(s.pendingTurns).toBe(0)
      expect(s.workingSince).toBeUndefined()
      expect(sm.list().find((x) => x.id === info.id)!.working).toBe(false)
    })
  })

  describe('user turn consumedAt (input-queue accounting)', () => {
    /** What a FRESH subscriber (new tab, cache miss, reconnect whose
     *  sinceUuid missed the ring) is actually served. `consumedAt` must live
     *  on these entries, not only on the copy handed to the SDK: the live
     *  `message-consumed` frame reaches attached tabs only, so a replay-only
     *  client would otherwise render an already-processed turn as
     *  permanently 'queued'. */
    const replayOf = (sid: string): Array<{ uuid?: string; receivedAt?: number; consumedAt?: number }> =>
      sm.getHistory(sid) as unknown as Array<{ uuid?: string; receivedAt?: number; consumedAt?: number }>

    it('stamps consumedAt on the replayed copy for the idle direct-handoff path', async () => {
      const info = await sm.create({ cwd: dir })
      const sent = sm.send(info.id, 'hello') as { uuid: string }
      await tick()
      const entry = replayOf(info.id).find((m) => m.uuid === sent.uuid)!
      expect(entry).toBeDefined()
      expect(typeof entry.receivedAt).toBe('number')
      expect(typeof entry.consumedAt).toBe('number')
    })

    it('stamps consumedAt on the replayed copy when a queued turn is consumed later', async () => {
      const info = await sm.create({ cwd: dir })
      const h = mockHandles.at(-1)!
      sm.send(info.id, 'first') // taken by the parked waiter immediately
      const queued = sm.send(info.id, 'second') as { uuid: string } // sits in the queue
      await tick()
      // Genuinely queued behind the in-flight turn — no stamp yet, so the
      // 'queued' badge is honest here.
      expect(replayOf(info.id).find((m) => m.uuid === queued.uuid)!.consumedAt).toBeUndefined()
      h.emit({
        type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id,
        is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {},
      })
      await tick()
      await tick()
      expect(typeof replayOf(info.id).find((m) => m.uuid === queued.uuid)!.consumedAt).toBe('number')
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
      const info = await sm.create({ cwd: dir })
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
      const info = await sm.create({ cwd: dir })
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

    it('discard() seeds Y with the FULL kept prefix, not just the ring window', async () => {
      // Ring cap 2: the kept prefix below is 5 frames, so any seed built from
      // the ring (or a capped tail page) drops the oldest kept messages and
      // Y's transcript starts mid-conversation.
      const smSmall = new SessionManager({ store, historyCap: 2, subagentHistoryCap: 2 })
      try {
        const info = await smSmall.create({ cwd: dir })
        const h0 = mockHandles.at(-1)!
        // Each turn is awaited before the next prompt: send() records the user
        // row synchronously while the mock's emits land via the pump, so
        // back-to-back sends would interleave the two prompts ahead of turn 1.
        smSmall.send(info.id, 'first prompt')
        completeTurn(h0, info.id, 'asst-1')
        await waitFor(async () => (await anchorsOf(info.id)).length >= 1)
        smSmall.send(info.id, 'second prompt')
        completeTurn(h0, info.id, 'asst-2')
        await waitFor(async () => (await anchorsOf(info.id)).length >= 2)

        const y = await smSmall.discard(info.id, 'asst-2')

        // Y's transcript window serves the pre-seed — the full kept prefix of
        // turns 1 and 2, not the last 2 frames the ring could hold.
        const win = await smSmall.getTranscriptWindow(y.id)
        const uuids = win.messages.map((m) => (m.msg as { uuid?: string }).uuid)
        expect(uuids).toEqual([expect.any(String), 'asst-1', 'res-asst-1', expect.any(String), 'asst-2', 'res-asst-2'])
        expect(win.totalCount).toBe(6)
      } finally {
        await smSmall.shutdown()
      }
    })

    it("discard() keeps the cut turn's result frame in the seed", async () => {
      // The result frame closes the anchor turn (its cost/duration summary).
      // It is part of the kept turn — and Y's result-frame sidecar copy keeps
      // it too, so a seed that drops it would make Y's restart re-append it
      // at the tail (out of order).
      const info = await sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      const y = await sm.discard(info.id, 'asst-1')

      const win = await sm.getTranscriptWindow(y.id)
      const uuids = win.messages.map((m) => (m.msg as { uuid?: string }).uuid)
      expect(uuids).toContain('res-asst-1')
    })

    it('discard() fails loudly when the cut point is not in the transcript', async () => {
      const info = await sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      // Hand-seed an anchor whose message never entered the transcript: the
      // sidecar says it is a legal cut point, but there is nothing to cut.
      // Seeding Y with the untruncated tail (the old fallback) would show the
      // messages the user asked to discard — refuse instead.
      const smAnchors = sm as unknown as { turnAnchorStore: { save: (id: string, entries: Array<{ assistantUuid: string; completedAt: number }>) => Promise<void> } }
      await smAnchors.turnAnchorStore.save(info.id, [{ assistantUuid: 'asst-ghost', completedAt: 1000 }])

      await expect(sm.discard(info.id, 'asst-ghost')).rejects.toThrow(/not in the|transcript/i)
    })

    it('discard() of a LIVE session does not mark in-flight background agents stopped', async () => {
      // Launch a background agent whose sidecar has no terminal frame (still
      // in flight — the watcher holds it), then fork. The un-notified ack is
      // in the ring-seed, but X's subprocess is ALIVE: synthesizing
      // 'stopped' would be a lie the fork can never retract (the real
      // completion lands in X's world only).
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      try {
        const info = await sm.create({ cwd: dir })
        const h0 = mockHandles.at(-1)!
        h0.emit({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tu_live',
              content: 'Async agent launched successfully.\nagentId: agent-inflight\n',
            }],
          },
        })
        sm.send(info.id, 'hi')
        completeTurn(h0, info.id, 'asst-1')
        await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
        await waitFor(async () => (await anchorsOf(info.id)).length > 0)

        const y = await sm.discard(info.id, 'asst-1')
        const notifications = (sm.getHistory(y.id) ?? []).filter(
          (m) => (m as { subtype?: string }).subtype === 'task_notification',
        )
        expect(notifications).toHaveLength(0)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })

    it('discard() of a LIVE session with a disk transcript still leaves in-flight agents alone', async () => {
      // The compose path (ensureTranscriptReconciled → composeTranscriptEntries)
      // backfills subagent completions UNCONDITIONALLY — it serves the restart
      // reconcile, where a dead subprocess makes 'stopped' honest. Discarding a
      // LIVE session must not inherit that: the gate is on the discard seed, and
      // the reconcile's own synthesis must not leak through the window either.
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      try {
        const info = await sm.create({ cwd: dir })
        const h0 = mockHandles.at(-1)!
        sm.send(info.id, 'hi')
        completeTurn(h0, info.id, 'asst-1')
        await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
        await waitFor(async () => (await anchorsOf(info.id)).length > 0)
        // The ack is on disk (the CLI persists it) but the agent is still
        // running — no terminal sidecar, no task_notification.
        const jsonlPath = join(dir, 'projects', encodeCwd(dir), `${info.id}.jsonl`)
        mkdirSync(dirname(jsonlPath), { recursive: true })
        writeFileSync(
          jsonlPath,
          [
            JSON.stringify({ type: 'user', uuid: 'disk-u1', sessionId: info.id, parent_tool_use_id: null, message: { role: 'user', content: 'hi' } }),
            ...ackSeed('tu_live_disk', 'agent-live-disk').map((m) => JSON.stringify(m)),
            JSON.stringify({ type: 'assistant', uuid: 'asst-1', sessionId: info.id, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
            '',
          ].join('\n'),
        )

        const y = await sm.discard(info.id, 'asst-1')
        const notifications = (sm.getHistory(y.id) ?? []).filter(
          (m) => (m as { subtype?: string }).subtype === 'task_notification',
        )
        expect(notifications).toHaveLength(0)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })

    it('discard() does not swallow a queued prompt recorded between the anchor and its result', async () => {
      // A user turn can land in the seq store AFTER the anchor's assistant
      // frame but BEFORE that turn's result frame (send() records the prompt
      // synchronously; the pump records the result when it arrives). Extending
      // the cut through the result frame by SEQ would pull that prompt — a
      // message from the discarded future — into Y.
      const info = await sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'first prompt')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] } })
      await tick()
      // Queued while turn 1 is still closing: recorded now, result arrives later.
      sm.send(info.id, 'second prompt (queued)')
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-asst-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      const y = await sm.discard(info.id, 'asst-1')
      const win = await sm.getTranscriptWindow(y.id)
      const texts = win.messages.map((m) => {
        const msg = m.msg as { message?: { content?: unknown } }
        const c = msg.message?.content
        return typeof c === 'string' ? c : JSON.stringify(c)
      })
      expect(texts.join('\n')).not.toContain('second prompt')
      // The cut turn's own result frame is kept (it closes the kept turn).
      const uuids = win.messages.map((m) => (m.msg as { uuid?: string }).uuid)
      expect(uuids).toContain('res-asst-1')
    })

    it('discard() keeps a task_notification that landed between the anchor and its result', async () => {
      // The same interleaving as the queued-prompt case, but a DURABLE frame
      // that belongs to the KEPT history: a background agent whose launch ack
      // is already in the window completes while this turn is closing. Dropping
      // the notification strands the subagent card as 'running' on Y.
      const info = await sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      h0.emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_gap',
            content: 'Async agent launched successfully.\nagentId: agent-gap\n',
          }],
        },
      })
      sm.send(info.id, 'hi')
      h0.emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] } })
      await tick()
      // The agent completes while turn 1 is still closing.
      h0.emit({ type: 'system', subtype: 'task_notification', task_id: 'agent-gap', tool_use_id: 'tu_gap', status: 'completed', summary: 'DONE', uuid: 'notif-gap' })
      h0.emit({ type: 'result', subtype: 'success', uuid: 'res-asst-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      const y = await sm.discard(info.id, 'asst-1')
      const win = await sm.getTranscriptWindow(y.id)
      const uuids = win.messages.map((m) => (m.msg as { uuid?: string }).uuid)
      expect(uuids).toContain('notif-gap')
      expect(uuids).toContain('res-asst-1')
    })

    it('discard() of a DORMANT session backfills completions and copies the sidecars to the fork', async () => {
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = dir
      try {
        const info = await sm.create({ cwd: dir })
        // The agent really finished — its sidecar transcript is durable.
        writeSidecar(dir, info.id, 'agent-dormant', 'end_turn', 'DONE — committed')
        // Anchor sidecar seeded directly (bypasses the pump's async append).
        const smAnchors = sm as unknown as { turnAnchorStore: { save: (id: string, entries: Array<{ assistantUuid: string; completedAt: number }>) => Promise<void> } }
        await smAnchors.turnAnchorStore.save(info.id, [{ assistantUuid: 'asst-1', completedAt: 1000 }])
        // X goes dormant: its subprocess is gone, so every agent it launched
        // is terminal-or-dead and the backfill's 'stopped' fallback is honest.
        mockHandles[0].emit({ type: 'result' })
        await tick()
        await sm.unload(info.id)

        // The on-disk transcript a dormant discard composes its seed from:
        // the ack, no task_notification (the CLI never persists one), plus
        // the anchor. Written as a real JSONL because the unified seed path
        // reads the renderable transcript (ensureTranscriptReconciled →
        // composeTranscriptEntries), not a paged provider read.
        const jsonlPath = join(dir, 'projects', encodeCwd(dir), `${info.id}.jsonl`)
        mkdirSync(dirname(jsonlPath), { recursive: true })
        writeFileSync(
          jsonlPath,
          [
            ...ackSeed('tu_dormant', 'agent-dormant').map((m) => JSON.stringify(m)),
            JSON.stringify({ type: 'assistant', uuid: 'asst-1', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
            '',
          ].join('\n'),
        )

        const y = await sm.discard(info.id, 'asst-1')
        const notifications = (sm.getHistory(y.id) ?? []).filter(
          (m) => (m as { subtype?: string }).subtype === 'task_notification',
        )
        expect(notifications).toHaveLength(1)
        expect(notifications[0]).toMatchObject({
          tool_use_id: 'tu_dormant',
          status: 'completed',
          summary: 'DONE — committed',
        })
        // The sidecar transcript followed the fork, so Y's OWN next resume
        // heals from the real outcome instead of degrading to 'stopped'.
        expect(existsSync(subagentTranscriptPath(dir, y.id, 'agent-dormant'))).toBe(true)
      } finally {
        if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = realConfigDir
      }
    })

    it('discard() refuses a non-anchor uuid (400)', async () => {
      const info = await sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      // 'asst-bogus' was never recorded as a turn anchor.
      await expect(sm.discard(info.id, 'asst-bogus')).rejects.toThrow(/isn't the last reply|Cannot discard/i)
    })

    it('Y inherits X turn anchors truncated to the cut point (composable)', async () => {
      const info = await sm.create({ cwd: dir })
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
      // The cut point (and the turn after it) must be real messages too —
      // the seed is read from the transcript, and a cut point with no
      // message behind it is refused.
      h0.emit({ type: 'assistant', uuid: 'asst-2', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] } })
      h0.emit({ type: 'assistant', uuid: 'asst-3', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply 3' }] } })
      await tick()

      // Discard after asst-2 → Y should inherit anchors [asst-1, asst-2]
      // (the cut point inclusive, asst-3 dropped). A later discard on Y
      // can still cut at asst-1 or asst-2.
      const y = await sm.discard(info.id, 'asst-2')
      await waitFor(async () => (await anchorsOf(y.id)).length > 0)
      const yAnchors = await anchorsOf(y.id)
      expect(yAnchors.map((a) => a.assistantUuid)).toEqual(['asst-1', 'asst-2'])
    })

    it('deleteOriginal unlinks the source transcript + sidecar', async () => {
      const info = await sm.create({ cwd: dir })
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

    it('deleteOriginal also removes the snapshot sidecar for X', async () => {
      const info = await sm.create({ cwd: dir })
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      await waitFor(async () => (await anchorsOf(info.id)).length > 0)

      // Seed the snapshot sidecar with a fake meta so we can assert the
      // remove call cleared it (the real service is a no-op capture for
      // non-git cwds, so we write a placeholder directly).
      const smAny = sm as unknown as { snapshotStore: { save: (id: string, m: unknown) => Promise<void>; load: (id: string) => Promise<unknown> } }
      await smAny.snapshotStore.save(info.id, {
        version: 1, gitDir: '/g', worktree: '/w', scope: '.', byMessage: {}, patches: [],
      })
      expect(await smAny.snapshotStore.load(info.id)).not.toBeNull()
      await sm.discard(info.id, 'asst-1', { deleteOriginal: true })
      expect(await smAny.snapshotStore.load(info.id)).toBeNull()
    })

    it('delete() removes the snapshot sidecar', async () => {
      const info = await sm.create({ cwd: dir })
      const smAny = sm as unknown as { snapshotStore: { save: (id: string, m: unknown) => Promise<void>; load: (id: string) => Promise<unknown>; remove: (id: string) => Promise<void> } }
      await smAny.snapshotStore.save(info.id, {
        version: 1, gitDir: '/g', worktree: '/w', scope: '.', byMessage: {}, patches: [],
      })
      expect(await smAny.snapshotStore.load(info.id)).not.toBeNull()
      await sm.delete(info.id)
      // delete() uses fire-and-forget sidecar removals (matches the
      // existing promptUuid/turnAnchor/resultFrame pattern). Wait for
      // the unlink macrotask to land by polling.
      await waitFor(async () => (await smAny.snapshotStore.load(info.id)) === null)
    })

    it('discard() invokes snapshotStore.copyForFork with keep sets mirroring the cut', async () => {
      const info = await sm.create({ cwd: dir })
      // Seed three turn anchors directly so discard has a cut to make.
      const smAnchors = sm as unknown as { turnAnchorStore: { save: (id: string, entries: Array<{ assistantUuid: string; completedAt: number }>) => Promise<void> } }
      await smAnchors.turnAnchorStore.save(info.id, [
        { assistantUuid: 'asst-1', completedAt: 1000 },
        { assistantUuid: 'asst-2', completedAt: 2000 },
        { assistantUuid: 'asst-3', completedAt: 3000 },
      ])
      // Seed a snapshot sidecar with a byMessage entry for each user uuid
      // and a patch for each assistant uuid, so we can assert copyForFork
      // keeps only the ones at/before the cut.
      const smAny = sm as unknown as { snapshotStore: { save: (id: string, m: unknown) => Promise<void>; load: (id: string) => Promise<unknown>; copyForFork: ReturnType<typeof vi.fn> } }
      await smAny.snapshotStore.save(info.id, {
        version: 1,
        gitDir: '/g',
        worktree: '/w',
        scope: '.',
        byMessage: {
          'u-1': { start: 't1' },
          'u-2': { start: 't2' },
          'u-3': { start: 't3' },
        },
        patches: [
          { messageId: 'asst-1', hash: 't1', files: ['/w/a'] },
          { messageId: 'asst-2', hash: 't2', files: ['/w/b'] },
          { messageId: 'asst-3', hash: 't3', files: ['/w/c'] },
        ],
      })
      // Spy on copyForFork (the real store implementation is used; we
      // intercept to inspect args, then forward by calling the original).
      const real = smAny.snapshotStore.copyForFork
      const spy = vi.fn(real.bind(smAny.snapshotStore))
      ;(smAny.snapshotStore as { copyForFork: typeof spy }).copyForFork = spy

      // Complete one real turn so fork() has a transcript + lastTurnAt.
      const h0 = mockHandles.at(-1)!
      sm.send(info.id, 'hi')
      completeTurn(h0, info.id, 'asst-1')
      await waitFor(() => sm.get(info.id).lastTurnAt !== undefined)
      // The cut point (and the turn after it) must be real messages too —
      // the seed is read from the transcript, and a cut point with no
      // message behind it is refused.
      h0.emit({ type: 'assistant', uuid: 'asst-2', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] } })
      h0.emit({ type: 'assistant', uuid: 'asst-3', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply 3' }] } })
      await tick()

      // Discard after asst-2 — keep [asst-1, asst-2], drop asst-3.
      const y = await sm.discard(info.id, 'asst-2')
      expect(spy).toHaveBeenCalledOnce()
      const [fromId, toId, keepMsg, keepPatch] = spy.mock.calls[0]
      expect(fromId).toBe(info.id)
      expect(toId).toBe(y.id)
      // Patches kept = inherited anchor assistant uuids.
      expect(keepPatch).toEqual(new Set(['asst-1', 'asst-2']))
      // User message ids kept = user uuids in the kept-prefix seed. The mock
      // SDK emits no real disk transcript, so the seed is X's seq store —
      // which holds the 'hi' we sent. Assert it's included.
      expect(keepMsg.size).toBeGreaterThan(0)
    })

    it('listDiscardAnchors returns anchors with previews', async () => {
      const info = await sm.create({ cwd: dir })
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

  it('succeeds when profile B has the group but the active profile does not', async () => {
    __setConfigForTest({
      profiles: [profileA, profileB],
      activeProfileId: 'A',
      modelGroups: [],
    })
    const info = await smLocal.create({
      cwd: '/tmp',
      profileId: 'B',
      modelGroupId: 'g_budget',
    } as Parameters<SessionManager['create']>[0])
    expect(info.modelGroupId).toBe('g_budget')
    expect(info.model).toBe('anthropic/claude-sonnet-4-20250514')
    expect(info.profileId).toBe('B')
  })

  it('rejects a group that belongs to neither profile', async () => {
    __setConfigForTest({
      profiles: [profileA, profileB],
      activeProfileId: 'A',
      modelGroups: [],
    })
    await expect(smLocal.create({
      cwd: '/tmp',
      profileId: 'B',
      modelGroupId: 'nonexistent',
    } as Parameters<SessionManager['create']>[0])).rejects.toThrow('model group nonexistent not found')
  })
})

describe('cliDebug resolution', () => {
  it('resolves the effective cliDebug as session override ?? global default', () => {
    // defaultConfig.cliDebug = false (the DEFAULTS default)
    const smLocal = new SessionManager({ store: new SessionStore({ stateDir: makeTmpDir() }) })
    const sess = { cliDebug: undefined } as Session
    // No override → false (global default)
    expect((smLocal as unknown as { resolveCliDebug(s: Session): boolean }).resolveCliDebug(sess)).toBe(false)
    // Explicit session override → true
    sess.cliDebug = true
    expect((smLocal as unknown as { resolveCliDebug(s: Session): boolean }).resolveCliDebug(sess)).toBe(true)
    // Explicit false override
    sess.cliDebug = false
    expect((smLocal as unknown as { resolveCliDebug(s: Session): boolean }).resolveCliDebug(sess)).toBe(false)
  })
})

describe('cliDebug persistence', () => {
  it('writeStore round-trips cliDebug', async () => {
    const dir = makeTmpDir()
    const store = new SessionStore({ stateDir: dir })
    const smLocal = new SessionManager({ store })
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    // Initially undefined (session-level default)
    expect(store.get(info.id)?.cliDebug).toBeUndefined()
    // Directly mutate the live session's cliDebug to simulate what the
    // PUT route (Task 5) will do, then trigger a persist.
    const session = (smLocal as unknown as { sessions: Map<string, Session> }).sessions.get(info.id)
    expect(session).toBeDefined()
    session!.cliDebug = true
    ;(smLocal as unknown as { writeStore(s: Session): void }).writeStore(session!)
    expect(store.get(info.id)?.cliDebug).toBe(true)
  })
})

describe('setCliDebug', () => {
  it('sets per-session cliDebug to true and persists', async () => {
    const storeLocal = new SessionStore({ stateDir: makeTmpDir() })
    await storeLocal.load()
    const smLocal = new SessionManager({ store: storeLocal })
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    const result = await smLocal.setCliDebug(info.id, { cliDebug: true })
    expect(result.cliDebug.perSession).toBe(true)
    expect(result.cliDebug.effective).toBe(true)
    expect(result.note).toBe('applies on the next session start')
    expect(storeLocal.get(info.id)?.cliDebug).toBe(true)
  })

  it('clears per-session cliDebug with null and persists', async () => {
    const storeLocal = new SessionStore({ stateDir: makeTmpDir() })
    await storeLocal.load()
    const smLocal = new SessionManager({ store: storeLocal })
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await smLocal.setCliDebug(info.id, { cliDebug: true })
    const result = await smLocal.setCliDebug(info.id, { cliDebug: null })
    expect(result.cliDebug.perSession).toBeUndefined()
    expect(result.cliDebug.effective).toBe(false)
    expect(storeLocal.get(info.id)?.cliDebug).toBeUndefined()
  })

  it('throws 400 when cliDebug is missing from body', async () => {
    const smLocal = new SessionManager({ store: new SessionStore({ stateDir: makeTmpDir() }) })
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await expect(smLocal.setCliDebug(info.id, {})).rejects.toThrow(/cliDebug.*required/)
  })
})

describe('getDiagnostics', () => {
  it('returns the expected diagnostics shape', async () => {
    const smLocal = new SessionManager({ store: new SessionStore({ stateDir: makeTmpDir() }) })
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    const result = await smLocal.getDiagnostics(info.id)
    expect(result.cliDebug).toEqual({ global: false, perSession: undefined, effective: false })
    expect(result.stderrTail).toEqual([])
    expect(result.debugLog).toEqual({ exists: false })
  })

  it('reflects per-session override in effective', async () => {
    const smLocal = new SessionManager({ store: new SessionStore({ stateDir: makeTmpDir() }) })
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await smLocal.setCliDebug(info.id, { cliDebug: true })
    const result = await smLocal.getDiagnostics(info.id)
    expect(result.cliDebug.perSession).toBe(true)
    expect(result.cliDebug.effective).toBe(true)
  })

  it('throws 404 for unknown session', async () => {
    const smLocal = new SessionManager({ store: new SessionStore({ stateDir: makeTmpDir() }) })
    await expect(smLocal.getDiagnostics('nonexistent')).rejects.toThrow(/not found/)
  })
})

describe('setAgent (mid-session persona switch)', () => {
  async function makeAgentStore() {
    const store = new AgentDefinitionStore({ stateDir: makeTmpDir() })
    await store.load()
    store.upsert({ name: 'reviewer', description: 'Reviews', prompt: 'P', enabled: true, createdAt: 1, updatedAt: 1 })
    store.upsert({ name: 'off', description: 'Disabled', prompt: 'P', enabled: false, createdAt: 1, updatedAt: 1 })
    return store
  }

  async function setup() {
    const sessionStore = new SessionStore({ stateDir: makeTmpDir() })
    await sessionStore.load()
    const agentStore = await makeAgentStore()
    const smLocal = new SessionManager({ store: sessionStore, agentStore })
    return { sessionStore, agentStore, smLocal }
  }

  it('forwards the name through applyFlagSettings and reports it on SessionInfo', async () => {
    const { smLocal, sessionStore } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    const handle = mockHandles[mockHandles.length - 1]
    handle.applyFlagSettings.mockClear()

    const next = await smLocal.setAgent(info.id, 'reviewer')

    expect(handle.applyFlagSettings).toHaveBeenCalledWith({ agent: 'reviewer' })
    expect(next.agent).toBe('reviewer')
    // Persisted, so every re-spawn path picks it up (see the respawn test).
    expect(sessionStore.get(info.id)?.agent).toBe('reviewer')
    await smLocal.shutdown()
  })

  it('sends null (not undefined) when clearing, so the flag layer is emptied', async () => {
    const { smLocal, sessionStore } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model', agent: 'reviewer' })
    const handle = mockHandles[mockHandles.length - 1]
    handle.applyFlagSettings.mockClear()

    const next = await smLocal.setAgent(info.id, null)

    // `undefined` would be dropped by JSON serialization and silently no-op.
    expect(handle.applyFlagSettings).toHaveBeenCalledWith({ agent: null })
    expect(next.agent).toBeUndefined()
    expect(sessionStore.get(info.id)?.agent).toBeUndefined()
    await smLocal.shutdown()
  })

  it('rejects an unknown or disabled name without touching the SDK', async () => {
    const { smLocal, sessionStore } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    const handle = mockHandles[mockHandles.length - 1]
    handle.applyFlagSettings.mockClear()

    await expect(smLocal.setAgent(info.id, 'ghost')).rejects.toThrow('agent "ghost" is not defined')
    await expect(smLocal.setAgent(info.id, 'off')).rejects.toThrow('agent "off" is disabled')

    expect(handle.applyFlagSettings).not.toHaveBeenCalled()
    expect(sessionStore.get(info.id)?.agent).toBeUndefined()
    await smLocal.shutdown()
  })

  it('rejects every name when no agent store is mounted', async () => {
    const sessionStore = new SessionStore({ stateDir: makeTmpDir() })
    await sessionStore.load()
    const smLocal = new SessionManager({ store: sessionStore }) // no agentStore
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await expect(smLocal.setAgent(info.id, 'reviewer')).rejects.toThrow('agent "reviewer" is not defined')
    // Clearing is still fine — it needs no definition to resolve.
    await expect(smLocal.setAgent(info.id, null)).resolves.toMatchObject({ agent: undefined })
    await smLocal.shutdown()
  })

  it('carries the switched persona into a respawn without any explicit replay', async () => {
    // This is the behaviour that makes setAgent cheaper than setFastMode:
    // `agent` is a real Options field, so persisting s.agent is enough for
    // resume / fork / crash-respawn to come up in the new persona.
    const { smLocal } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await smLocal.setAgent(info.id, 'reviewer')

    await smLocal.unload(info.id)
    await smLocal.resume(info.id)

    expect(mockHandles[mockHandles.length - 1].options.agent).toBe('reviewer')
    await smLocal.shutdown()
  })

  it('carries a SWITCHED persona through fork (not just the create-time one)', async () => {
    // fork reads `live ?? store.get(id)`, a different branch from resume's
    // meta lookup — so resume passing doesn't imply fork does.
    const { smLocal } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await smLocal.setAgent(info.id, 'reviewer')
    // fork refuses a session with no completed turn, so land one first.
    const sourceHandle = mockHandles[mockHandles.length - 1]
    smLocal.send(info.id, 'hi')
    sourceHandle.emit({ type: 'result' })
    await tick()

    await smLocal.fork(info.id)

    expect(mockHandles[mockHandles.length - 1].options.agent).toBe('reviewer')
    await smLocal.shutdown()
  })

  it('carries the persona across /clear', async () => {
    // /clear (and compact, same path) resets the conversation, not the
    // session's configuration — the persona must survive like skillOverride
    // and toolProfile do.
    const { smLocal } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await smLocal.setAgent(info.id, 'reviewer')

    await smLocal.clear(info.id)

    expect(mockHandles[mockHandles.length - 1].options.agent).toBe('reviewer')
    await smLocal.shutdown()
  })

  it('drops the persona on respawn once its definition is disabled', async () => {
    const { smLocal, agentStore } = await setup()
    const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
    await smLocal.setAgent(info.id, 'reviewer')

    // effectiveStartAsAgent's drop-guard: a persona the user turned off must
    // not be resurrected by a respawn.
    agentStore.upsert({ name: 'reviewer', description: 'Reviews', prompt: 'P', enabled: false, createdAt: 1, updatedAt: 2 })
    await smLocal.unload(info.id)
    await smLocal.resume(info.id)

    expect(mockHandles[mockHandles.length - 1].options.agent).toBeUndefined()
    await smLocal.shutdown()
  })

  it('404s on an unknown session', async () => {
    const { smLocal } = await setup()
    await expect(smLocal.setAgent('nope', 'reviewer')).rejects.toThrow(/not found/)
    await smLocal.shutdown()
  })

  describe('via the generic /settings door', () => {
    it('validates a raw Settings.agent and mirrors it onto the session', async () => {
      const { smLocal, sessionStore } = await setup()
      const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
      const handle = mockHandles[mockHandles.length - 1]
      handle.applyFlagSettings.mockClear()

      const next = await smLocal.applySettings(info.id, { agent: 'reviewer' } as never)

      expect(handle.applyFlagSettings).toHaveBeenCalledWith(expect.objectContaining({ agent: 'reviewer' }))
      // Without the mirror, SessionInfo.agent would disagree with the live
      // process forever — the exact desync this feature exists to avoid.
      expect(next.agent).toBe('reviewer')
      expect(sessionStore.get(info.id)?.agent).toBe('reviewer')
      await smLocal.shutdown()
    })

    it('rejects an unknown / disabled name instead of forwarding it', async () => {
      const { smLocal } = await setup()
      const info = await smLocal.create({ cwd: '/tmp', model: 'test-model' })
      const handle = mockHandles[mockHandles.length - 1]
      handle.applyFlagSettings.mockClear()

      await expect(smLocal.applySettings(info.id, { agent: 'ghost' } as never))
        .rejects.toThrow('agent "ghost" is not defined')
      await expect(smLocal.applySettings(info.id, { agent: 'off' } as never))
        .rejects.toThrow('agent "off" is disabled')

      expect(handle.applyFlagSettings).not.toHaveBeenCalled()
      await smLocal.shutdown()
    })

    it('normalizes a blank name to null so the CLI never sees an empty agent', async () => {
      const { smLocal } = await setup()
      const info = await smLocal.create({ cwd: '/tmp', model: 'test-model', agent: 'reviewer' })
      const handle = mockHandles[mockHandles.length - 1]
      handle.applyFlagSettings.mockClear()

      const next = await smLocal.applySettings(info.id, { agent: '  ' } as never)

      expect(handle.applyFlagSettings).toHaveBeenCalledWith(expect.objectContaining({ agent: null }))
      expect(next.agent).toBeUndefined()
      await smLocal.shutdown()
    })

    it('leaves the persona untouched when the payload has no agent key', async () => {
      const { smLocal } = await setup()
      const info = await smLocal.create({ cwd: '/tmp', model: 'test-model', agent: 'reviewer' })

      const next = await smLocal.applySettings(info.id, { autoCompactEnabled: true } as never)

      expect(next.agent).toBe('reviewer')
      await smLocal.shutdown()
    })
  })
})

describe('create() worktree isolation', () => {
  const execFile = promisify(execFileCb)
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('provisions a linked worktree and spawns inside it when isolateWorktree is true', async () => {
    const head = (await execFile('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    const wtPath = join(dir, 'worktrees', info.id)
    expect(info.cwd).toBe(wtPath)
    expect(info.worktree).toEqual({ mainRepoPath: repo, branch: `crw/${info.id.slice(0, 8)}`, baseSha: head, path: wtPath })
    expect(store.get(info.id)?.worktree).toEqual({ mainRepoPath: repo, branch: `crw/${info.id.slice(0, 8)}`, baseSha: head, path: wtPath })
    // the subprocess actually spawned with the worktree as its cwd
    expect(mockHandles[0].options.cwd).toBe(wtPath)
  })

  it('rejects a non-boolean isolateWorktree with 400', async () => {
    await expect(sm.create({ cwd: '/tmp', model: 'test-model', isolateWorktree: 'yes' } as unknown as Parameters<SessionManager['create']>[0]))
      .rejects.toMatchObject({ status: 400 })
  })

  it('rejects worktree isolation outside a git repo with 400', async () => {
    const plain = makeTmpDir()
    await expect(sm.create({ cwd: plain, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0]))
      .rejects.toMatchObject({ status: 400 })
    rmRf(plain)
  })
})

describe('clear() worktree inheritance (legacy path-less meta)', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('backfills worktree.path from X’s cwd onto Y and the orphan sweep spares the inherited dir', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    const wtPath = join(dir, 'worktrees', info.id)
    // Simulate the pre-`path` era: strip the recorded path from the live
    // session AND the persisted meta, then age the dir past the sweep's
    // grace window so sparing it is meaningful.
    const xWt = store.get(info.id)!.worktree!
    const legacyWt = { mainRepoPath: xWt.mainRepoPath, branch: xWt.branch, baseSha: xWt.baseSha }
    const internals = sm as unknown as {
      sessions: Map<string, { worktree?: typeof legacyWt }>
      sweepOrphansTick: () => void
    }
    internals.sessions.get(info.id)!.worktree = legacyWt
    store.upsert({ ...store.get(info.id)!, worktree: legacyWt })
    const back = new Date(Date.now() - 11 * 60_000)
    await nodeFs.utimes(wtPath, back, back)

    const next = await sm.clear(info.id)

    // X is gone; Y's meta carries the isolation WITH the dir backfilled —
    // the successor now claims the inherited dir by recorded path, not by
    // fallback.
    expect(store.get(info.id)).toBeUndefined()
    expect(next.worktree?.path).toBe(wtPath)
    const yMeta = store.get(next.id)
    expect(yMeta?.worktree?.path).toBe(wtPath)
    expect(yMeta?.cwd).toBe(wtPath)

    // The GC tick's sweep must NOT remove the dir Y runs in. A backdated
    // unclaimed canary (name sorts last) gives a deterministic completion
    // signal: once the sweep has removed it, the spared dir was examined.
    const canary = join(dir, 'worktrees', 'zz-orphan-canary')
    await nodeFs.mkdir(canary, { recursive: true })
    await nodeFs.utimes(canary, back, back)
    internals.sweepOrphansTick()
    await waitForIo(() => !existsSync(canary))
    await expect(nodeFs.access(wtPath)).resolves.toBeUndefined()
  })
})

describe('resume() worktree recreate chain', () => {
  const execFile = promisify(execFileCb)
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  /** Create an isolated session, complete one turn, and unload it so the
   *  next resume takes the store→spawn path (the recreate chain's caller). */
  async function dormantIsolatedSession() {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    mockHandles.length = 0
    return info
  }

  it('recreates a GC’d worktree from its branch and resumes inside it', async () => {
    const info = await dormantIsolatedSession()
    const wtPath = join(dir, 'worktrees', info.id)
    expect(existsSync(wtPath)).toBe(true)
    // Realistic manual deletion: plain rm leaves a stale git registration
    // behind — the recreate path must prune it and re-add at the same path.
    await nodeFs.rm(wtPath, { recursive: true, force: true })

    const resumed = await sm.resume(info.id)

    expect(existsSync(wtPath)).toBe(true)
    expect(resumed.cwd).toBe(wtPath)
    // The subprocess was spawned inside the REBUILT worktree, with resume=id.
    expect(mockHandles[0].options.cwd).toBe(wtPath)
    expect(mockHandles[0].options.resume).toBe(info.id)
    // Isolation metadata survived: same branch, still persisted.
    const meta = store.get(info.id)!
    expect(meta.cwd).toBe(wtPath)
    expect(meta.worktree).toEqual({ mainRepoPath: repo, branch: `crw/${info.id.slice(0, 8)}`, baseSha: expect.any(String), path: wtPath })
  })

  it('backfills worktree.path onto a legacy path-less meta when recreate runs', async () => {
    const info = await dormantIsolatedSession()
    const wtPath = join(dir, 'worktrees', info.id)
    // Pre-`path` era meta: strip the recorded path, then delete the dir so
    // resume takes the recreate chain.
    const xWt = store.get(info.id)!.worktree!
    const legacyWt = { mainRepoPath: xWt.mainRepoPath, branch: xWt.branch, baseSha: xWt.baseSha }
    store.upsert({ ...store.get(info.id)!, worktree: legacyWt })
    await nodeFs.rm(wtPath, { recursive: true, force: true })

    await sm.resume(info.id)

    // The recreated meta is healed: the dir it re-landed in is recorded, so
    // later cleanup / dirty-check / sweeps need no cwd-hint fallback.
    const meta = store.get(info.id)!
    expect(meta.cwd).toBe(wtPath)
    expect(meta.worktree).toEqual({ ...legacyWt, path: wtPath })
  })

  it('recreates the worktree from baseSha when the branch was deleted too', async () => {
    const info = await dormantIsolatedSession()
    const wtPath = join(dir, 'worktrees', info.id)
    const branch = `crw/${info.id.slice(0, 8)}`
    await nodeFs.rm(wtPath, { recursive: true, force: true })
    // Clear the stale registration first — git refuses to delete a branch
    // that a registered worktree still references.
    await execFile('git', ['-C', repo, 'worktree', 'prune'])
    await execFile('git', ['-C', repo, 'branch', '-D', branch])

    const resumed = await sm.resume(info.id)

    expect(existsSync(wtPath)).toBe(true)
    expect(resumed.cwd).toBe(wtPath)
    expect(mockHandles[0].options.cwd).toBe(wtPath)
    // The recreate re-created the same-named branch off baseSha.
    await expect(execFile('git', ['-C', repo, 'rev-parse', '--verify', branch])).resolves.toBeDefined()
  })

  it('falls back to the main repo (worktree cleared) when the branch and baseSha are both gone', async () => {
    const info = await dormantIsolatedSession()
    const wtPath = join(dir, 'worktrees', info.id)
    await nodeFs.rm(wtPath, { recursive: true, force: true })
    // Hand-built metadata pointing at a branch and commit that never existed.
    const meta = store.get(info.id)!
    store.upsert({ ...meta, worktree: { ...meta.worktree!, branch: 'crw/nonexistent', baseSha: '0'.repeat(40) } })

    const resumed = await sm.resume(info.id)

    expect(resumed.cwd).toBe(repo)
    expect(resumed.worktree).toBeUndefined()
    // The subprocess spawned in the main repo, and the fallback is persisted
    // so the next resume doesn't re-walk the chain.
    expect(mockHandles[0].options.cwd).toBe(repo)
    expect(store.get(info.id)?.worktree).toBeUndefined()
    expect(store.get(info.id)?.cwd).toBe(repo)
  })

  it('rethrows a transient recreate failure while the main repo is still a git repo (isolation kept)', async () => {
    const info = await dormantIsolatedSession()
    const wtPath = join(dir, 'worktrees', info.id)
    await nodeFs.rm(wtPath, { recursive: true, force: true })
    // The main repo is untouched and still a valid git repo — the recreate
    // throw is transient (e.g. lock contention). Forced via the wrapped
    // module mock; the real chain would be exercised again on retry.
    vi.mocked(ensureWorktreeForResume).mockImplementationOnce(
      () => Promise.reject(new Error('ELOCK: index.lock')),
    )

    // Resume fails LOUDLY with the underlying error instead of silently
    // de-isolating the session.
    await expect(sm.resume(info.id)).rejects.toThrow(/ELOCK/)

    // No persisted de-isolation: meta keeps the worktree + worktree cwd, so
    // a retry walks the recreate chain again.
    expect(store.get(info.id)?.worktree).toEqual(info.worktree)
    expect(store.get(info.id)?.cwd).toBe(wtPath)
  })

  it('falls back to the main repo when mainRepoPath is no longer a git repo (recreate throws)', async () => {    // Task 3 review ruling: ensureWorktreeForResume THROWS (via
    // getGitCommonDir) when mainRepoPath exists but lost its .git. Resume
    // must treat that as "recreate impossible" and fall back — not 500.
    const info = await dormantIsolatedSession()
    const wtPath = join(dir, 'worktrees', info.id)
    await nodeFs.rm(wtPath, { recursive: true, force: true })
    await nodeFs.rm(join(repo, '.git'), { recursive: true, force: true })

    const resumed = await sm.resume(info.id)

    expect(resumed.cwd).toBe(repo)
    expect(resumed.worktree).toBeUndefined()
    expect(mockHandles[0].options.cwd).toBe(repo)
    expect(store.get(info.id)?.worktree).toBeUndefined()
  })
})

describe('fork() worktree fallback', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('fork() of an isolated session lands in the main repo without isolation metadata', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    expect(info.worktree).toBeDefined()
    // Complete one turn so the fork() lastTurnAt guard passes.
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const forked = await sm.fork(info.id)

    // The fork falls back to the user's main repo — two sessions sharing one
    // worktree is a clobber hazard, so the fork never lands in the source's.
    expect(forked.cwd).toBe(info.worktree!.mainRepoPath)
    // worktree is not in forkOpts's explicit copy list — isolation does not
    // propagate; the user re-checks it on the fork's own create path.
    expect(forked.worktree).toBeUndefined()
    expect(store.get(forked.id)?.worktree).toBeUndefined()
    // the fork's subprocess actually spawned in the main repo
    expect(mockHandles[1].options.cwd).toBe(info.worktree!.mainRepoPath)
  })
})

describe('clear() worktree isolation', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('clear keeps the fresh session inside the worktree with the isolation metadata', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    const wtPath = join(dir, 'worktrees', info.id)
    // Complete one turn so clear() passes its phase guards.
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const next = await sm.clear(info.id)

    // Y runs in X's worktree dir (X's cwd IS the worktree path)...
    expect(next.cwd).toBe(wtPath)
    // ...and carries the isolation metadata X had — without it Y would be an
    // unbadged session in a worktree whose delete-confirm dirty check and
    // cleanup never engage.
    expect(next.worktree).toEqual(info.worktree)
    expect(store.get(next.id)?.worktree).toEqual(info.worktree)
    expect(store.get(next.id)?.cwd).toBe(wtPath)
    // The fresh spawn actually happened inside the worktree.
    expect(mockHandles[1].options.cwd).toBe(wtPath)
    // The worktree dir survives the clear (clear unloads X, never deletes it).
    expect(existsSync(wtPath)).toBe(true)
  })

  it('clear of a non-isolated session stays clean of worktree metadata', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model' })
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const next = await sm.clear(info.id)

    expect(next.cwd).toBe(repo)
    expect(next.worktree).toBeUndefined()
    expect(store.get(next.id)?.worktree).toBeUndefined()
  })
})

describe('orphan worktree sweep (health-tick wiring)', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  /** Fire the manager's per-tick sweep (what the 60s health monitor calls)
   *  and give the async fire-and-forget sweep time to settle. */
  const sweepTick = async () => {
    ;(sm as unknown as { sweepOrphansTick(): void }).sweepOrphansTick()
    await new Promise((r) => setTimeout(r, 100))
  }

  it('removes an old orphaned dir no session claims', async () => {
    const orphan = join(dir, 'worktrees', 'orphan-id-1')
    await nodeFs.mkdir(orphan, { recursive: true })
    const old = new Date(Date.now() - 11 * 60_000)
    await nodeFs.utimes(orphan, old, old)

    await sweepTick()

    await waitForIo(() => !existsSync(orphan))
    expect(existsSync(orphan)).toBe(false)
  })

  it('keeps an old dir claimed by a live successor via worktree.path (/clear inheritance)', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    const wtPath = join(dir, 'worktrees', info.id)
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'result' })
    await tick()
    // Backdate BEFORE clear: /clear never touches the dir, so without the
    // worktree.path guard the sweep would see an old dir whose NAME matches
    // no persisted-or-live session (X was removed from both; Y has a new id).
    const old = new Date(Date.now() - 11 * 60_000)
    await nodeFs.utimes(wtPath, old, old)

    await sm.clear(info.id)
    expect(existsSync(wtPath)).toBe(true)

    await sweepTick()

    expect(existsSync(wtPath)).toBe(true)
  })
})

describe('delete() / setCwd() worktree cleanup', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let repo: string

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })
  beforeEach(async () => {
    mockHandles.length = 0
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })
  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('delete removes the worktree dir but keeps the branch', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    const wtPath = join(dir, 'worktrees', info.id)
    expect(existsSync(wtPath)).toBe(true)

    await sm.delete(info.id)

    // The worktree dir is gone — no residual for this session id...
    expect(existsSync(wtPath)).toBe(false)
    expect(existsSync(join(dir, 'worktrees', info.id))).toBe(false)
    // ...but the branch survives (deleted sessions KEEP their branches).
    const branch = `crw/${info.id.slice(0, 8)}`
    expect(await branchExists(repo, branch)).toBe(true)
    // The persistence entry itself is dropped as usual.
    expect(store.get(info.id)).toBeUndefined()
  })

  it('discard tears down the discarded session’s worktree (fork lands in the main repo)', async () => {
    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    const wtPath = join(dir, 'worktrees', info.id)
    expect(existsSync(wtPath)).toBe(true)
    // Complete a turn with a known assistant uuid so the pump records the
    // anchor discard() forks from (success result → turnAnchorStore.append).
    sm.send(info.id, 'hi')
    mockHandles[0].emit({ type: 'assistant', uuid: 'asst-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } })
    mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'res-1', session_id: info.id, is_error: false, usage: { input_tokens: 1, iterations: [] }, modelUsage: {} })
    // The anchor write is async — poll for the sidecar to land.
    const smAny = sm as unknown as { turnAnchorStore: { load: (id: string) => Promise<Array<{ assistantUuid: string }> | null> } }
    for (let i = 0; i < 60; i++) {
      if ((await smAny.turnAnchorStore.load(info.id))?.length) break
      await tick()
    }

    const y = await sm.discard(info.id, 'asst-1')

    // The fork landed in the main repo per the fork ruling, so X's worktree
    // is ownerless after the discard — unload() alone would leak the dir and
    // the git registration forever.
    expect(y.cwd).toBe(repo)
    expect(existsSync(wtPath)).toBe(false)
    // Cleanup removes the dir but keeps the branch (same contract as delete).
    expect(await branchExists(repo, `crw/${info.id.slice(0, 8)}`)).toBe(true)
  })

  it('setCwd clears the worktree field and invalidates the snapshot-store meta', async () => {    const info = await sm.create({ cwd: repo, model: 'test-model', isolateWorktree: true } as Parameters<SessionManager['create']>[0])
    // setCwd is dormant-only — sleep the session first.
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)
    mockHandles.length = 0

    // Seed a snapshot meta for the session through the store's own API
    // (same stateDir the manager's snapshot store writes to).
    const snapStore = new SnapshotStore(dir)
    await snapStore.save(info.id, {
      version: 1, gitDir: '/g', worktree: '/w', scope: '.', byMessage: {}, patches: [],
    })
    expect(await snapStore.load(info.id)).not.toBeNull()

    const newCwd = makeTmpDir()
    try {
      const patched = await sm.setCwd(info.id, newCwd)

      expect(patched.worktree).toBeUndefined()
      expect(store.get(info.id)?.worktree).toBeUndefined()
      expect(store.get(info.id)?.cwd).toBe(newCwd)
      // Fire-and-forget remove — poll until the unlink lands.
      for (let i = 0; i < 50; i++) {
        if ((await snapStore.load(info.id)) === null) break
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(await snapStore.load(info.id)).toBeNull()
    } finally {
      rmRf(newCwd)
    }
    // Sanity: the branch the session kept still exists — setCwd must NOT
    // have tried to clean up the worktree.
    expect(await branchExists(repo, `crw/${info.id.slice(0, 8)}`)).toBe(true)
  })
})

describe('mergeResultFrames', () => {
  const assistant = (uuid: string): SDKMessage =>
    ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: 'hi' }] } }) as unknown as SDKMessage
  const realResult = (assistantUuid: string): SDKMessage =>
    ({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'done', total_cost_usd: 1, assistantUuid }) as unknown as SDKMessage
  // The exact polluted record from session 07790d71: the CLI's queued-
  // completion placeholder persisted to the sidecar before the classifier
  // learned that total_cost_usd is session-cumulative.
  const placeholderResult = (assistantUuid: string): SDKMessage =>
    ({
      type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '',
      total_cost_usd: 18.077710999999997, duration_api_ms: 4877255, terminal_reason: 'completed',
      assistantUuid,
    }) as unknown as SDKMessage

  it('inserts each result after its assistant frame', () => {
    const merged = mergeResultFrames([assistant('a1')], [
      { resultUuid: 'r1', assistantUuid: 'a1', result: realResult('a1') },
    ])
    expect(merged).toHaveLength(2)
    expect((merged[1] as { type: string }).type).toBe('result')
  })

  it('drops sidecar entries the classifier now deems empty (heals pre-fix placeholder records)', () => {
    const merged = mergeResultFrames([assistant('a1'), assistant('a2')], [
      { resultUuid: 'r1', assistantUuid: 'a1', result: placeholderResult('a1') },
      { resultUuid: 'r2', assistantUuid: 'a2', result: realResult('a2') },
    ])
    expect(merged).toHaveLength(3)
    expect((merged[1] as { type: string }).type).toBe('assistant')
    expect((merged[2] as { type: string }).type).toBe('result')
  })
})
