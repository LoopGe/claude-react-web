import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real shells + real persistence: every terminal op spawns a real PTY
// (cmd.exe on win32, the user's SHELL on posix) into a temp cwd, so the
// kill-on-delete/unload/shutdown pins assert actual process death. The
// SDK side is the session-manager.test.ts fake provider — a dormant
// session's terminal must never spawn a Query, and mockHandles.length is
// the proof. Leaked-pid backstop + temp-dir cleanup follow terminal.test.ts.
vi.setConfig({ testTimeout: 30_000 })

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import headlessPkg, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import { rmRf } from './__test-utils__/index.js'
import { TerminalScreenStore } from './terminal-store.js'
import { TERMINAL_SCROLLBACK } from '../shared/terminal.js'
import type { WsTerminalOutput, WsTerminalSnapshot, WsTerminalState } from './ws-protocol.js'

const IS_WIN32 = process.platform === 'win32'

// --- capability mock ---------------------------------------------------------
// terminalCapability() caches for the process lifetime; the unsupported-400
// case needs a controllable probe. Both the manager gate and TerminalSession
// read this same mocked module.
const { mockCapability } = vi.hoisted(() => ({
  mockCapability: vi.fn<() => { supported: boolean; reason?: string }>(() => ({ supported: true })),
}))
vi.mock('./terminal-capability.js', () => ({ terminalCapability: mockCapability }))

// --- SDK mock (session-manager.test.ts harness) ------------------------------
// The real `query({ prompt, options })` spawns the `claude` CLI; replace it
// with a controllable async generator and record every call so tests can
// assert NO spawn happened for dormant-session terminal ops.
interface MockQueryHandle {
  options: Record<string, unknown>
  consumed: unknown[]
  emit: (msg: unknown) => void
  finish: () => void
}
const mockHandles: MockQueryHandle[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    getSessionInfo: async (id: string) => ({ sessionId: id }),
    listSessions: async () => [],
    listSubagents: async () => [],
    renameSession: async () => {},
    query({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) {
      const queue: unknown[] = []
      let waiter: ((v: IteratorResult<unknown>) => void) | null = null
      let done = false

      const promptIter = (prompt as AsyncIterable<unknown>)?.[Symbol.asyncIterator]?.()
      let drainInFlight = false
      const drainOne = () => {
        if (!promptIter || done || drainInFlight) return
        drainInFlight = true
        promptIter.next().then((r) => {
          if (!r.done) {
            handle.consumed.push(r.value)
            const consumedCb = (options as { onUserMessageConsumed?: (m: unknown) => void })
              .onUserMessageConsumed
            if (typeof consumedCb === 'function') {
              try { consumedCb(r.value) } catch { /* never break iteration */ }
            }
          }
        }).finally(() => { drainInFlight = false })
      }
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
          if ((msg as { type?: string })?.type === 'result') drainOne()
        },
        finish: () => {
          done = true
          pushResolved({ value: undefined, done: true })
        },
      }
      mockHandles.push(handle)

      const noop = async () => {}
      const q = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
              if (done) return Promise.resolve({ value: undefined, done: true })
              return new Promise((r) => { waiter = r })
            },
            return(): Promise<IteratorResult<unknown>> {
              done = true
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
        interrupt: noop,
        backgroundTasks: async () => false,
        stopTask: noop,
        close: () => {
          done = true
          pushResolved({ value: undefined, done: true })
        },
        setMaxThinkingTokens: noop,
        setModel: noop,
        setPermissionMode: noop,
        applyFlagSettings: noop,
        supportedModels: async () => [],
        supportedCommands: async () => [],
        supportedAgents: async () => [],
        mcpServerStatus: async () => ({}),
        readMcpResource: async () => ({ contents: [] }),
        toggleMcpServer: noop,
        reconnectMcpServer: noop,
        setMcpServers: async (servers: Record<string, unknown>) => ({
          added: Object.keys(servers), removed: [], errors: {},
        }),
        setMcpPermissionModeOverride: async () => ({}),
        getContextUsage: async () => ({}),
        accountInfo: async () => ({}),
        generateSessionTitle: async () => 'Mock auto title',
        readFile: async () => ({ available: false }),
        seedReadState: noop,
      }
      return q
    },
  }
})

// First-party in-process servers: mock the registry so no real MCP server is
// constructed at spawn (same mock as session-manager.test.ts).
const { mockInjectAll } = vi.hoisted(() => ({ mockInjectAll: vi.fn() }))
mockInjectAll.mockImplementation((cwd: string | null, enabled: (name: string) => boolean) => {
  if (enabled('git-tools') && cwd) return { 'git-tools': { type: 'sdk', name: 'git-tools' } }
  return undefined
})
vi.mock('./sdk-tools/registry.js', () => ({
  firstPartyRegistry: {
    injectAll: mockInjectAll,
    readOnlyToolFqns: () => new Set(['mcp__git-tools__git_status']),
    mutatingToolFqns: () => new Set(['mcp__git-tools__git_stage']),
    list: () => [{ name: 'git-tools', description: '', defaultEnabled: true, requiresCwd: true, buildTools: () => [] }],
    listToolDefs: () => [{ name: 'git-tools', description: '', tools: [{ name: 'stub_tool', description: 'stub', readOnly: true }] }],
  },
}))
vi.mock('./sdk-tools/app-tools.js', () => ({
  APP_TOOLS_SERVER_NAME: 'git-tools',
  buildAppToolsServer: vi.fn((cwd: string) => ({ type: 'sdk', name: 'git-tools', instance: { cwd } })),
}))

// Import AFTER vi.mock so the manager picks up the mocked SDK + capability.
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'
import { HttpError } from './errors.js'
import { metrics } from './metrics.js'

// --- real-node-pty spawn wrapper (terminal.test.ts pattern) ------------------
type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => { pid: number }
const ptyModule = createRequire(import.meta.url)('node-pty') as { spawn: SpawnFn }
const realSpawn = ptyModule.spawn

async function waitUntil(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms}ms waiting for ${label}`)
    await new Promise<void>((r) => setImmediate(r))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function expectHttpError(fn: () => void, status: number, message?: RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HttpError)
  expect((caught as HttpError).status).toBe(status)
  if (message) expect((caught as HttpError).message).toMatch(message)
}

// Same createRequire + local structural type as terminal.ts: the addon's own
// typings reference lib.dom, which the DOM-free server program must not import.
interface SerializeAddonLike {
  serialize(): string
  activate(terminal: HeadlessTerminal): void
  dispose(): void
}
const { SerializeAddon } = createRequire(import.meta.url)('@xterm/addon-serialize') as {
  SerializeAddon: new () => SerializeAddonLike
}

/** A serialize-addon screen for `text` — the exact shape a live session
 *  persists, so re-parsing it restores byte-identically. */
function seedScreen(text: string, cols: number, rows: number): string {
  const t = new headlessPkg.Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })
  const s = new SerializeAddon()
  t.loadAddon(s)
  t.input('')
  t.write(text)
  const out = s.serialize()
  t.dispose()
  return out
}

type TerminalChannelFrame = WsTerminalSnapshot | WsTerminalOutput | WsTerminalState

describe('SessionManager embedded terminal', () => {
  let dir: string
  let cwd: string
  let store: SessionStore
  let sm: SessionManager
  const spawned: Array<{ pid: number }> = []
  const fileFor = (id: string): string => join(dir, 'terminal-screens', `${id}.json`)

  beforeEach(async () => {
    mockHandles.length = 0
    mockCapability.mockReset()
    mockCapability.mockReturnValue({ supported: true })
    dir = mkdtempSync(join(tmpdir(), 'crw-sm-terminal-'))
    cwd = mkdtempSync(join(tmpdir(), 'crw-sm-terminal-cwd-'))
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
    ptyModule.spawn = (...args) => {
      const p = realSpawn(...args)
      spawned.push(p)
      return p
    }
  })

  afterEach(async () => {
    await sm.shutdown()
    ptyModule.spawn = realSpawn
    const handles = spawned.splice(0)
    // Yield until node-pty readiness settles so every pid is readable (a
    // shell closed before its first output has pid 0 on win32 until ready).
    const settle = Date.now() + 2000
    while (Date.now() < settle && handles.some((h) => h.pid === 0)) {
      await new Promise<void>((r) => setImmediate(r))
    }
    const leaked = handles.map((h) => h.pid).filter((pid) => pid > 0)
    for (const pid of leaked) {
      if (IS_WIN32) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch { /* already gone */ }
      }
    }
    await waitUntil(() => leaked.every((p) => !alive(p)), 5000, 'leaked shells to die').catch(() => {})
    rmRf(dir)
    rmRf(cwd)
  })

  /** Create a session and spawn its terminal; wait for the shell's first
   *  output so the win32 pid is readable and the kill fence is armed. */
  async function startTerminal(id: string): Promise<{ terminalId: string; pid: number }> {
    const snap = sm.terminalCreate(id, 80, 24)
    expect(snap.state.status).toBe('running')
    await waitUntil(() => sm.terminalSnapshot(id).seq > 0, 15000, 'first shell output')
    const pid = spawned[spawned.length - 1]!.pid
    expect(pid).toBeGreaterThan(0)
    return { terminalId: snap.terminalId, pid }
  }

  it('(a) terminalCreate on a DORMANT session spawns a shell, never a Query', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    expect(info.terminalSupported).toBe(true)
    await sm.sleep(info.id)
    expect(sm.get(info.id).running).toBe(false)
    expect(mockHandles).toHaveLength(1)

    const { terminalId, pid } = await startTerminal(info.id)
    // The terminal runs in the session's persisted cwd without waking the SDK.
    expect(sm.terminalSnapshot(info.id).state.cwd).toBe(cwd)
    expect(sm.get(info.id).running).toBe(false)
    expect(mockHandles).toHaveLength(1)

    // Input + resize work on the dormant session's live generation too.
    sm.terminalResize(info.id, terminalId, 100, 30)
    expect(sm.terminalSnapshot(info.id).state.cols).toBe(100)
    sm.terminalInput(info.id, terminalId, 'echo hi\r')
    await waitUntil(() => sm.terminalSnapshot(info.id).screen.includes('hi'), 15000, 'echo output')
    expect(mockHandles).toHaveLength(1)
    expect(alive(pid)).toBe(true)
  })

  it('(b) sleep rejects 409 blaming the terminal while running; close unblocks; exited does not block', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    await startTerminal(info.id)

    let caught: unknown
    try {
      await sm.sleep(info.id)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).status).toBe(409)
    expect((caught as HttpError).message).toMatch(/running terminal/)
    // Untouched — still live.
    expect(sm.get(info.id).running).toBe(true)

    // Explicit close unblocks sleep.
    sm.terminalClose(info.id)
    const slept = await sm.sleep(info.id)
    expect(slept.running).toBe(false)

    // An EXITED terminal does not block sleep.
    const other = await sm.create({ cwd, model: 'test-model' })
    const { terminalId } = await startTerminal(other.id)
    sm.terminalInput(other.id, terminalId, 'exit\r')
    await waitUntil(() => sm.terminalSnapshot(other.id).state.status === 'exited', 15000, 'shell exit')
    const sleptOther = await sm.sleep(other.id)
    expect(sleptOther.running).toBe(false)
  })

  it('(c) phaseOf reads working while the terminal runs, idle after close', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    expect(sm.get(info.id).phase).toBe('idle')
    await startTerminal(info.id)
    expect(sm.get(info.id).phase).toBe('working')
    sm.terminalClose(info.id)
    expect(sm.get(info.id).phase).toBe('idle')
  })

  it('(d) delete kills the shell and removes the persisted screen (live session)', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const { pid } = await startTerminal(info.id)
    // Let the debounced persistence write land so the file provably exists
    // before delete (otherwise "removed" would be vacuous).
    await waitUntil(() => existsSync(fileFor(info.id)), 5000, 'persisted screen')
    await sm.delete(info.id)
    expect(existsSync(fileFor(info.id))).toBe(false)
    await waitUntil(() => !alive(pid), 5000, 'shell death')
  })

  it('(d2) delete kills a DORMANT session\'s running terminal and removes the file', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    await sm.sleep(info.id)
    const { pid } = await startTerminal(info.id)
    await waitUntil(() => existsSync(fileFor(info.id)), 5000, 'persisted screen')
    await sm.delete(info.id)
    expect(existsSync(fileFor(info.id))).toBe(false)
    await waitUntil(() => !alive(pid), 5000, 'shell death')
    expect(mockHandles).toHaveLength(1)
  })

  it('(d3) delete removes a persisted screen even when no terminal slot exists', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    await sm.sleep(info.id)
    // A prior server lifetime's screen: persisted file, no live slot.
    const seed = new TerminalScreenStore(dir)
    seed.schedule(info.id, () => ({
      screen: seedScreen('prior life', 80, 24),
      state: { status: 'running', shell: 'cmd.exe', cwd, cols: 80, rows: 24 },
      savedAt: Date.now(),
    }))
    seed.flush(info.id)
    expect(existsSync(fileFor(info.id))).toBe(true)
    await sm.delete(info.id)
    expect(existsSync(fileFor(info.id))).toBe(false)
  })

  it('(e) shutdown kills the shell but KEEPS the persisted screen (live session)', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const { pid } = await startTerminal(info.id)
    await sm.shutdown()
    expect(existsSync(fileFor(info.id))).toBe(true)
    await waitUntil(() => !alive(pid), 5000, 'shell death')
  })

  it('(e2) shutdown kills a DORMANT session\'s terminal too, keeping the screen', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    await sm.sleep(info.id)
    const { pid } = await startTerminal(info.id)
    await sm.shutdown()
    expect(existsSync(fileFor(info.id))).toBe(true)
    await waitUntil(() => !alive(pid), 5000, 'shell death')
  })

  it('(f) unsupported capability rejects every terminal op with 400', async () => {
    mockCapability.mockReturnValue({ supported: false, reason: 'node-pty unavailable' })
    const info = await sm.create({ cwd, model: 'test-model' })
    expect(sm.get(info.id).terminalSupported).toBe(false)
    expectHttpError(() => sm.terminalCreate(info.id, 80, 24), 400, /terminal not supported/)
    expectHttpError(() => sm.terminalInput(info.id, 'tid', 'x'), 400, /terminal not supported/)
    expectHttpError(() => sm.terminalResize(info.id, 'tid', 80, 24), 400, /terminal not supported/)
    expectHttpError(() => sm.terminalClose(info.id), 400, /terminal not supported/)
    expectHttpError(() => sm.terminalSnapshot(info.id), 400, /terminal not supported/)
    expectHttpError(() => sm.subscribeTerminal(info.id), 400, /terminal not supported/)
    expect(spawned).toHaveLength(0)
  })

  it('(g) subscribeTerminal seeds the snapshot, fans output/state, unsubscribe stops fan-out', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const sub = sm.subscribeTerminal(info.id)
    expect(sub).not.toBeNull()
    expect(sub!.snapshot).toMatchObject({ terminalId: '', seq: 0, state: { status: 'idle' } })

    const frames: TerminalChannelFrame[] = []
    const done = (async () => {
      for await (const frame of sub!.iterable) frames.push(frame)
    })()

    const { terminalId } = await startTerminal(info.id)
    await waitUntil(
      () => frames.some((f) => f.kind === 'terminal-state' && f.state.status === 'running'),
      5000,
      'running state frame',
    )
    await waitUntil(() => frames.some((f) => f.kind === 'terminal-output'), 5000, 'output frame')
    // Output frames carry the live generation and contiguous seq from 1.
    const outputs = frames.filter((f): f is WsTerminalOutput => f.kind === 'terminal-output')
    expect(outputs.every((f) => f.terminalId === terminalId && f.sessionId === info.id)).toBe(true)
    expect(outputs.map((f) => f.seq)).toEqual(outputs.map((_, i) => i + 1))

    // Close fans the idle state frame (terminalId '' — no live generation).
    sm.terminalClose(info.id)
    await waitUntil(
      () => frames.some((f) => f.kind === 'terminal-state' && f.state.status === 'idle'),
      5000,
      'idle state frame',
    )

    sub!.unsubscribe()
    await done
    const before = frames.length
    // A new generation after unsubscribe must not reach the old subscriber.
    await startTerminal(info.id)
    expect(frames.length).toBe(before)
  })

  it('(g2) one subscriber leaving does not affect another; unknown session yields null', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    expect(sm.subscribeTerminal('no-such-session')).toBeNull()
    expectHttpError(() => sm.terminalSnapshot('no-such-session'), 404)

    const sub1 = sm.subscribeTerminal(info.id)!
    const sub2 = sm.subscribeTerminal(info.id)!
    const frames2: TerminalChannelFrame[] = []
    const done2 = (async () => {
      for await (const frame of sub2.iterable) frames2.push(frame)
    })()
    // Drain sub1 minimally so its queue never matters; it leaves first.
    const done1 = (async () => {
      for await (const _frame of sub1.iterable) { /* drain */ }
    })()

    await startTerminal(info.id)
    await waitUntil(() => frames2.some((f) => f.kind === 'terminal-output'), 5000, 'sub2 output')
    sub1.unsubscribe()
    await done1
    // sub2 keeps receiving after sub1 left.
    const before = frames2.length
    sm.terminalInput(info.id, sm.terminalSnapshot(info.id).terminalId, 'echo more\r')
    await waitUntil(() => frames2.length > before, 15000, 'sub2 keeps receiving')
    sub2.unsubscribe()
    await done2
  })

  it('(g3) a stale unsubscribe after re-subscribe does not kill the new viewer', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const old = sm.subscribeTerminal(info.id)!
    const oldDone = (async () => {
      for await (const _frame of old.iterable) { /* drain */ }
    })()

    // unload/sleep ends the old channel (endTerminalSubscribers) and drops
    // the map entry, but the old SET object still holds the old pushable.
    await sm.unload(info.id)
    await oldDone

    // Re-subscribe on the now-dormant session → a FRESH set in the map.
    const fresh = sm.subscribeTerminal(info.id)!
    const frames: TerminalChannelFrame[] = []
    const done = (async () => {
      for await (const frame of fresh.iterable) frames.push(frame)
    })()

    // The OLD consumer's cleanup runs late: it empties the old set, but must
    // NOT delete the newer set the map now holds (identity guard).
    old.unsubscribe()

    // The new viewer still receives frames.
    await startTerminal(info.id)
    await waitUntil(() => frames.some((f) => f.kind === 'terminal-output'), 5000, 'new viewer output')
    fresh.unsubscribe()
    await done
  })

  it('(h) subscribe seeds restored history for a dormant session with a persisted screen', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    await sm.sleep(info.id)
    const seed = new TerminalScreenStore(dir)
    seed.schedule(info.id, () => ({
      screen: seedScreen('restored history line', 80, 24),
      state: { status: 'running', shell: 'cmd.exe', cwd, cols: 80, rows: 24 },
      savedAt: Date.now(),
    }))
    seed.flush(info.id)

    const sub = sm.subscribeTerminal(info.id)!
    expect(sub.snapshot).not.toBeNull()
    expect(sub.snapshot!.restored).toBe(true)
    expect(sub.snapshot!.screen).toContain('restored history line')
    // Persisted 'running' restores as idle — the process died with the server.
    expect(sub.snapshot!.state.status).toBe('idle')
    expect(mockHandles).toHaveLength(1)
    sub.unsubscribe()
  })

  it('(i) metrics: spawn_total counts spawns not attaches; output_bytes accumulates', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const before = metrics.snapshot().counters
    const { terminalId } = await startTerminal(info.id)
    // Attach while running — idempotent, NOT a second spawn.
    const attached = sm.terminalCreate(info.id, 80, 24)
    expect(attached.terminalId).toBe(terminalId)
    sm.terminalInput(info.id, terminalId, 'echo metric\r')
    await waitUntil(() => sm.terminalSnapshot(info.id).screen.includes('metric'), 15000, 'echo output')
    const after = metrics.snapshot().counters
    expect((after['terminal_spawn_total'] ?? 0) - (before['terminal_spawn_total'] ?? 0)).toBe(1)
    expect((after['terminal_output_bytes'] ?? 0) - (before['terminal_output_bytes'] ?? 0)).toBeGreaterThan(0)
  })

  // ── I2 + I5: the terminalRunning lifecycle fact ─────────────────────

  /** Collect global session events for one session id. */
  function collectUpdates(id: string) {
    const global = sm.subscribeGlobal()
    const updates: Array<{ terminalRunning?: boolean }> = []
    const done = (async () => {
      for await (const ev of global.iterable) {
        if (ev.kind === 'update' && ev.session.id === id) updates.push(ev.session)
      }
    })()
    return {
      updates,
      /** The latest broadcast terminalRunning value (undefined = none yet). */
      latest: () => updates.at(-1)?.terminalRunning,
      stop: async () => {
        global.unsubscribe()
        await done
      },
    }
  }

  it('(j) session-update broadcasts terminalRunning on spawn / exit / close', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const feed = collectUpdates(info.id)
    expect(feed.latest()).toBeUndefined()

    const { terminalId } = await startTerminal(info.id)
    expect(feed.latest()).toBe(true)
    const spawns = feed.updates.length

    // Attach while running: no transition, no extra terminal lifecycle fact
    // (other metadata churn may broadcast, but the value stays true).
    sm.terminalCreate(info.id, 80, 24)
    expect(feed.latest()).toBe(true)

    // Output churn is NOT a lifecycle event: a command round-trip broadcasts
    // no session-update at all (the render-isolation contract).
    const beforeOutput = feed.updates.length
    sm.terminalInput(info.id, terminalId, 'echo quiet\r')
    await waitUntil(() => sm.terminalSnapshot(info.id).screen.includes('quiet'), 15000, 'echo output')
    expect(feed.updates.length).toBe(beforeOutput)

    sm.terminalInput(info.id, terminalId, 'exit\r')
    await waitUntil(() => sm.terminalSnapshot(info.id).state.status === 'exited', 15000, 'shell exit')
    await waitUntil(() => feed.latest() === false, 5000, 'exit lifecycle broadcast')
    expect(feed.updates.length).toBeGreaterThan(spawns)

    sm.terminalClose(info.id)
    await waitUntil(() => feed.latest() === false, 5000, 'close lifecycle broadcast')
    await feed.stop()
  })

  it('(j2) the dormant projection carries terminalRunning (no live Query needed)', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    await sm.sleep(info.id)
    const feed = collectUpdates(info.id)
    expect(sm.get(info.id).terminalRunning).toBe(false)

    await startTerminal(info.id)
    // Dormant session, live shell: the indicator reads true from the meta
    // projection, and the transition broadcast reaches global subscribers.
    expect(sm.get(info.id).terminalRunning).toBe(true)
    expect(sm.get(info.id).running).toBe(false)
    expect(feed.latest()).toBe(true)
    expect(sm.list().find((s) => s.id === info.id)?.terminalRunning).toBe(true)

    sm.terminalClose(info.id)
    expect(sm.get(info.id).terminalRunning).toBe(false)
    await waitUntil(() => feed.latest() === false, 5000, 'close lifecycle broadcast')
    expect(mockHandles).toHaveLength(1)
    await feed.stop()
  })

  it('(j3) dispose pushes an idle state frame BEFORE ending the channel and broadcasts terminalRunning=false', async () => {
    const info = await sm.create({ cwd, model: 'test-model' })
    const sub = sm.subscribeTerminal(info.id)!
    const frames: TerminalChannelFrame[] = []
    const done = (async () => {
      for await (const frame of sub.iterable) frames.push(frame)
    })()
    const feed = collectUpdates(info.id)

    const { pid } = await startTerminal(info.id)
    expect(feed.latest()).toBe(true)

    // The I5 path: a server-side channel end (unload / GC force-unload)
    // must heal attached viewers instead of freezing them at 'running'.
    await sm.unload(info.id)
    await done // the channel ended — the idle frame must have landed FIRST
    const last = frames.at(-1)
    expect(last).toMatchObject({ kind: 'terminal-state', terminalId: '', state: { status: 'idle' } })
    await waitUntil(() => feed.latest() === false, 5000, 'dispose lifecycle broadcast')
    await waitUntil(() => !alive(pid), 5000, 'shell death')
    await feed.stop()
  })
})
