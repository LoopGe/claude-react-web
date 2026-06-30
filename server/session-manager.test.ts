import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmRf } from './__test-utils__/index.js'

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
  setModel: ReturnType<typeof vi.fn>
  setPermissionMode: ReturnType<typeof vi.fn>
  applyFlagSettings: ReturnType<typeof vi.fn>
  supportedModels: ReturnType<typeof vi.fn>
  supportedCommands: ReturnType<typeof vi.fn>
  supportedAgents: ReturnType<typeof vi.fn>
  mcpServerStatus: ReturnType<typeof vi.fn>
  setMcpServers: ReturnType<typeof vi.fn>
  getContextUsage: ReturnType<typeof vi.fn>
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
          if ((msg as { type?: string }).type === 'result') drainOne()
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
        setModel: handle.setModel,
        setPermissionMode: handle.setPermissionMode,
        applyFlagSettings: handle.applyFlagSettings,
        supportedModels: handle.supportedModels,
        supportedCommands: handle.supportedCommands,
        supportedAgents: handle.supportedAgents,
        mcpServerStatus: handle.mcpServerStatus,
        setMcpServers: handle.setMcpServers,
        getContextUsage: handle.getContextUsage,
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

// Helper: yield to the event loop so the SessionManager's pump() can
// process whatever the mock just emitted. The pump iterates asynchronously,
// so a `setImmediate`-tick is enough to drain one message.
const tick = () => new Promise((r) => setImmediate(r))

// Import AFTER vi.mock so the SessionManager picks up the mocked SDK.
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'
import { config as defaultConfig } from './config.js'
import { McpConfigStore } from './mcp-config.js'
import { MpStore } from './mp-store.js'
import { execCommand as mockExecCommand } from './exec.js'
import { buildSessionRouter } from './routes/sessions.js'

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

  it('clear() tears down the old Query and respawns a fresh one (no /clear control message)', async () => {
    const info = sm.create({})
    expect(mockHandles).toHaveLength(1)
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(1)

    await sm.clear(info.id)

    // A brand-new Query was spawned (old handle destroyed, fresh one created).
    expect(mockHandles).toHaveLength(2)
    // Fresh conversation: no `resume`, but the SDK session_id is pinned to
    // our id so the new transcript anchor lands in the existing file.
    expect(mockHandles[1].options.resume).toBeUndefined()
    expect(mockHandles[1].options.sessionId).toBe(info.id)
    // We never push a `/clear` slash command into either Query's input
    // queue (the headless binary rejects it; the respawn IS the clear).
    for (const h of mockHandles) {
      const sawClear = h.consumed.some(
        (m) => (m as { message?: { content?: unknown } }).message?.content === '/clear',
      )
      expect(sawClear).toBe(false)
    }
  })

  it('clear() empties the in-memory history synchronously', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()
    expect(sm.getHistory(info.id)!).toHaveLength(1)

    await sm.clear(info.id)

    // History is wiped as part of the respawn d no waiting for an SDK init.
    expect(sm.getHistory(info.id)!).toHaveLength(0)
  })

  it('clear() broadcasts session-cleared and captures the boundary uuid from the post-respawn init', async () => {
    const info = sm.create({})
    mockHandles[0].emit({ type: 'assistant', uuid: 'before', message: { content: 'before' } })
    await tick()

    const cleared = sm.subscribeSessionCleared(info.id)!
    const nextCleared = cleared.iterable[Symbol.asyncIterator]().next()

    await sm.clear(info.id)
    // The session-cleared signal fires during clear() (synchronous respawn).
    await expect(nextCleared).resolves.toMatchObject({ value: { kind: 'session-cleared', sessionId: info.id } })

    // The fresh Query's first init frame anchors the new conversation.
    mockHandles[1].emit({ type: 'system', subtype: 'init', uuid: 'clear-init', session_id: info.id })
    await tick()

    expect(sm.getHistory(info.id)!.map((m) => (m as { uuid?: string }).uuid)).toEqual(['clear-init'])
    expect(store.get(info.id)?.clearBoundaryUuid).toBe('clear-init')
    cleared.unsubscribe()
  })

  it('clear() resets stale working state from the interrupted turn', async () => {
    const info = sm.create({})
    sm.send(info.id, 'busy')
    expect(sm.get(info.id).working).toBe(true)

    await sm.clear(info.id)

    expect(sm.get(info.id).working).toBe(false)
    expect(sm.get(info.id).phase).toBe('idle')
  })

  it('clear() drops hook run records', async () => {
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

    await sm.clear(info.id)

    // Hook history is dropped as part of the respawn d no SDK round-trip.
    expect(sm.subscribeHookRuns(info.id)!.snapshot).toHaveLength(0)
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
      ctx: { signal: AbortSignal; toolUseID: string; suggestions: unknown },
    ) => Promise<{ behavior: string; message: string }>
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

  it('resume() refuses terminated sessions', async () => {
    const info = sm.create({})
    // Simulate the pump finishing naturally — queue a result then close.
    mockHandles[0].emit({ type: 'result' })
    mockHandles[0].finish()
    await tick()
    // pump's finally block sets terminated=true, persists, and the session
    // is still in memory. Unload to persist the terminal state.
    await sm.unload(info.id)
    await expect(sm.resume(info.id)).rejects.toThrow(/ended/i)
  })

  it('resume() preserves lastTurnAt so a second resume after going dormant still works', async () => {
    // Regression: spawn() used to drop lastTurnAt from the persisted meta
    // on resume (it carried gitStartSha/fastMode/hooks/clearBoundaryUuid
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
    ) => Promise<{ behavior: string; message: string; interruptd: boolean; toolUseID: string }>
    const ctrl = new AbortController()
    const promise = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which languaged',
            options: [{ label: 'english' }, { label: 'chinese' }],
          },
          {
            question: 'Which frameworksd',
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
      { question: 'Which languaged', answer: 'chinese' },
      { question: 'Which frameworksd', answer: ['react', 'svelte'] },
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
    ) => Promise<{ behavior: string; message: string }>
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
    ) => Promise<{ behavior: string; message: string }>
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
    // mockHandles[0] is the original spawn. clear() respawns → mockHandles[1].
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
})
