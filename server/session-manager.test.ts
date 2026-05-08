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

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query({ options }: { prompt: unknown; options: Record<string, unknown> }) {
      const queue: unknown[] = []
      let waiter: ((v: IteratorResult<unknown>) => void) | null = null
      let done = false
      let errored: unknown = null

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
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    // Short idle window so the GC-related test doesn't wait in real time.
    sm = new SessionManager({ store, idleMs: 50 })
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

  it('pendingTurns tracks multiple sends before any result', async () => {
    const info = sm.create({})
    sm.send(info.id, 'first')
    sm.send(info.id, 'second')
    expect(sm.get(info.id).working).toBe(true)

    mockHandles[0].emit({ type: 'result' })
    await tick()
    // Still working — one more turn to clear.
    expect(sm.get(info.id).working).toBe(true)

    mockHandles[0].emit({ type: 'result' })
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

  it('idle GC unloads an inactive session but keeps its metadata', async () => {
    const info = sm.create({ title: 'persistable' })
    // Immediately "age" the session by backdating lastActivityAt so the
    // next GC tick catches it. Reaching into the internal map beats
    // actually waiting for 50ms + a 60s GC interval.
    // @ts-expect-error — test-only access to a private field.
    const internalSessions = sm.sessions as Map<string, { lastActivityAt: number }>
    const internal = internalSessions.get(info.id)!
    internal.lastActivityAt = Date.now() - 10_000

    // @ts-expect-error — invoke the private gc() deterministically.
    sm.gc()
    await tick()
    expect(() => sm.get(info.id)).not.toThrow()
    // Session is still visible in list() as dormant, not deleted.
    const fromList = sm.list().find((s) => s.id === info.id)!
    expect(fromList.running).toBe(false)
    await store.flush()
    expect(store.get(info.id)).toBeDefined()
  })

  it('resume() spawns a new Query with options.resume set to the original id', async () => {
    const info = sm.create({ cwd: '/tmp', model: 'm1' })
    mockHandles[0].emit({ type: 'result' })
    await tick()
    await sm.unload(info.id)

    // Live map no longer contains it, but persistence does.
    const resumed = sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBe(info.id)
    expect(mockHandles[1].options.cwd).toBe('/tmp')
    expect(mockHandles[1].options.model).toBe('m1')
  })

  it('resume() is idempotent when the session is already live', () => {
    const info = sm.create({})
    const again = sm.resume(info.id)
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
    // is still in memory until next GC. Force the dormant state for the
    // assertion by unloading.
    await sm.unload(info.id)
    expect(() => sm.resume(info.id)).toThrow(/ended/i)
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

  it('setPinned() on a live session toggles pinned and persists it', async () => {
    const info = sm.create({ title: 'to pin' })
    const pinned = sm.setPinned(info.id, true)
    expect(pinned.pinned).toBe(true)
    await store.flush()
    expect(store.get(info.id)?.pinned).toBe(true)
    // Unpin flips it back to undefined (we don't persist false — absence
    // means not pinned, keeps the JSON compact).
    const unpinned = sm.setPinned(info.id, false)
    expect(unpinned.pinned).toBeUndefined()
  })

  it('setPinned() works on a dormant session too', async () => {
    const info = sm.create({})
    await sm.unload(info.id)
    const pinned = sm.setPinned(info.id, true)
    expect(pinned.pinned).toBe(true)
    await store.flush()
    expect(store.get(info.id)?.pinned).toBe(true)
  })

  it('fork() spawns a new session with resume=sourceId + forkSession=true', () => {
    const source = sm.create({ cwd: '/tmp', model: 'm1', permissionMode: 'default', title: 'parent' })
    const forked = sm.fork(source.id)
    expect(forked.id).not.toBe(source.id)
    expect(mockHandles).toHaveLength(2)
    // The forked Query's options must carry the resume + forkSession combo;
    // cwd/model should be inherited, and title suffixed to disambiguate.
    expect(mockHandles[1].options.resume).toBe(source.id)
    expect(mockHandles[1].options.forkSession).toBe(true)
    expect(mockHandles[1].options.cwd).toBe('/tmp')
    expect(mockHandles[1].options.model).toBe('m1')
    expect(forked.title).toBe('parent (fork)')
  })

  it('fork() works on dormant (unloaded) sessions too', async () => {
    const source = sm.create({ title: 'dormant-source' })
    await sm.unload(source.id)
    const forked = sm.fork(source.id)
    expect(forked.id).not.toBe(source.id)
    // sm now has 2 live sessions: the original was unloaded, fork is new
    expect(mockHandles).toHaveLength(2)
    expect(mockHandles[1].options.resume).toBe(source.id)
  })

  it('fork() broadcasts a created event for the new session', async () => {
    const sub = sm.subscribeGlobal()
    const it = sub.iterable[Symbol.asyncIterator]()
    const source = sm.create({})
    await it.next() // consume the source's created event
    const forked = sm.fork(source.id)
    const next = await it.next()
    expect(next.done).toBe(false)
    expect(next.value).toMatchObject({ kind: 'created', session: { id: forked.id } })
    sub.unsubscribe()
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
})
