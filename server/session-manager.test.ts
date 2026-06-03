import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- SDK mock ---------------------------------------------------------------
//
// The real `query({ prompt, options })` spawns the `claude` CLI. For tests
// we replace it with a controllable async generator. Each mocked call is
// captured so tests can inspect what options the SessionManager passed in
// (e.g. the `resume` field) and drive messages into the generator.

interface MockQueryHandle {
  options: Record<string, unknown>
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
        promptIter.next().finally(() => { drainInFlight = false })
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
        setModel: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        applyFlagSettings: vi.fn(async () => {}),
        supportedModels: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []),
        supportedAgents: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => ({})),
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
        getContextUsage: handle.getContextUsage,
      }
      return q
    },
  }
})

// Helper: yield to the event loop so the SessionManager's pump() can
// process whatever the mock just emitted. The pump iterates asynchronously,
// so a `setImmediate`-tick is enough to drain one message.
const tick = () => new Promise((r) => setImmediate(r))

// Import AFTER vi.mock so the SessionManager picks up the mocked SDK.
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'

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
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmSync(dir, { recursive: true, force: true })
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
      { signal: ctrl.signal, toolUseID: 'tu-1' },
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

  it('setModel() updates the session and forwards to the Query', async () => {
    const info = sm.create({ model: 'old' })
    await sm.setModel(info.id, 'new-model')
    expect(mockHandles[0].setModel).toHaveBeenCalledWith('new-model')
    expect(sm.get(info.id).model).toBe('new-model')
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

  it('setPermissionMode() only updates local state, does not call the SDK', async () => {
    const info = sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'acceptEdits')
    expect(sm.get(info.id).permissionMode).toBe('acceptEdits')
    // The SDK-level setter must NOT be invoked. Previous implementation
    // forwarded every change, which fell over when switching INTO
    // bypassPermissions mid-session.
    expect(mockHandles[0].setPermissionMode).not.toHaveBeenCalled()
  })

  it('setPermissionMode() allows transitioning into bypassPermissions', async () => {
    const info = sm.create({ permissionMode: 'default' })
    await sm.setPermissionMode(info.id, 'bypassPermissions')
    expect(sm.get(info.id).permissionMode).toBe('bypassPermissions')
  })

  it('spawn does not forward permissionMode to the SDK options', () => {
    sm.create({ permissionMode: 'acceptEdits' })
    // The SDK sees options with permissionMode cleared — the server's own
    // canUseTool owns the semantics.
    expect(mockHandles[0].options.permissionMode).toBeUndefined()
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
    expect(resolved.interrupt).toBe(false)
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
    expect(() => sm.decide(info.id, pid, { behavior: 'deny' })).toThrow(
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
        { sessionId: 'titled', customTitle: 'My Title', summary: 'ignored', lastModified: 400, gitBranch: 'main' },
      ])

      const list = await sm.listResumable()

      // Sorted newest-first by lastModified: cli-xyz(500) > titled(400) > live(300)
      expect(list.map((s) => s.sessionId)).toEqual(['cli-xyz', 'titled', live.id])

      const cli = list.find((s) => s.sessionId === 'cli-xyz')!
      expect(cli.known).toBe(false)
      expect(cli.running).toBe(false)
      expect(cli.title).toBe('Hello from CLI')

      const liveRow = list.find((s) => s.sessionId === live.id)!
      expect(liveRow.known).toBe(true)
      expect(liveRow.running).toBe(true)
      expect(liveRow.title).toBe('Live one')

      const titled = list.find((s) => s.sessionId === 'titled')!
      expect(titled.title).toBe('My Title')
      expect(titled.gitBranch).toBe('main')
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
})
