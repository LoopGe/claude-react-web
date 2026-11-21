import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { TerminalSession, type TerminalEvents } from './terminal.js'
import { TerminalScreenStore } from './terminal-store.js'
import { HttpError } from './errors.js'
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_SCREEN_DEBOUNCE_MS,
  type TerminalState,
} from '../shared/terminal.js'

// Real-node-pty pins for the terminal session core. Every test spawns a real
// shell (cmd.exe on win32, the user's SHELL on posix) into a temp cwd; a thin
// spawn wrapper records the pid so the kill tests can assert process death,
// and afterEach taskkills any leaked pid as a backstop so a failed assertion
// never leaves a shell running.
const IS_WIN32 = process.platform === 'win32'
const expectedShell = basename(
  IS_WIN32 ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh'),
)

type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => { pid: number }
const ptyModule = createRequire(import.meta.url)('node-pty') as { spawn: SpawnFn }
const realSpawn = ptyModule.spawn

/** Poll a predicate by yielding to the event loop (setImmediate is never
 *  faked), bounded by wall-clock deadline. Works under both real and fake
 *  timers — the fake-timer test fakes only setTimeout/clearTimeout. */
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

function expectHttpError(fn: () => void, status: number): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HttpError)
  expect((caught as HttpError).status).toBe(status)
}

interface OutputRec {
  id: string
  seq: number
  data: string
}
interface StateRec {
  id: string
  state: TerminalState
}

class Recorder {
  outputs: OutputRec[] = []
  states: StateRec[] = []
  readonly events: TerminalEvents = {
    onOutput: (id, seq, data) => {
      this.outputs.push({ id, seq, data })
    },
    onState: (id, state) => {
      this.states.push({ id, state })
    },
  }

  text(id?: string): string {
    return this.outputs
      .filter((o) => id === undefined || o.id === id)
      .map((o) => o.data)
      .join('')
  }
}

describe('TerminalSession', () => {
  let dir: string
  let store: TerminalScreenStore
  let lastPty: { pid: number } | null = null
  const sessions: TerminalSession[] = []
  const spawned: Array<{ pid: number }> = []
  const fileFor = (): string => join(dir, 'terminal-screens', 'term-test.json')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crw-terminal-'))
    store = new TerminalScreenStore(dir)
    lastPty = null
    // node-pty's Windows pid is 0 until the pseudoconsole is ready, so record
    // the handle and read its pid lazily (after first output) rather than at
    // spawn time.
    ptyModule.spawn = (...args) => {
      const p = realSpawn(...args)
      lastPty = p
      spawned.push(p)
      return p
    }
  })

  afterEach(async () => {
    for (const s of sessions.splice(0)) s.close()
    vi.useRealTimers()
    const handles = spawned.splice(0)
    // Yield until node-pty readiness/deferred kills settle so every pid is
    // readable (a shell closed before its first output has pid 0 until ready).
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
        } catch {
          /* already gone */
        }
      }
    }
    // Wait for the shells to die so Windows releases the temp cwd handle.
    await waitUntil(() => leaked.every((p) => !alive(p)), 5000, 'leaked shells to die')
    // rmSync can EPERM while Windows finishes releasing the cwd handle; retry.
    await waitUntil(
      () => {
        try {
          rmSync(dir, { recursive: true, force: true })
          return true
        } catch {
          return false
        }
      },
      3000,
      'temp dir removal',
    )
  })

  function makeSession(): { ts: TerminalSession; rec: Recorder } {
    const rec = new Recorder()
    const ts = new TerminalSession({ sessionId: 'term-test', cwd: dir, store, events: rec.events })
    sessions.push(ts)
    return { ts, rec }
  }

  /** Create a session and wait for the shell's first output (banner/prompt). */
  async function startSession(
    cols = 80,
    rows = 24,
  ): Promise<{ ts: TerminalSession; rec: Recorder; pid: number; id: string }> {
    const { ts, rec } = makeSession()
    const snap = ts.create(cols, rows)
    expect(snap.state.status).toBe('running')
    const id = snap.terminalId
    await waitUntil(() => rec.outputs.some((o) => o.id === id), 15000, 'first shell output')
    // The pid is valid once the shell has produced its first output.
    const pid = lastPty!.pid
    expect(pid).toBeGreaterThan(0)
    return { ts, rec, pid, id }
  }

  it('snapshot before create is idle; input without a live generation is 409', () => {
    const { ts } = makeSession()
    const snap = ts.snapshot()
    expect(snap.terminalId).toBe('')
    expect(snap.seq).toBe(0)
    expect(snap.screen).toBe('')
    expect(snap.restored).toBe(false)
    expect(snap.state.status).toBe('idle')
    expect(snap.state.shell).toBe(expectedShell)
    expect(snap.state.cwd).toBe(dir)
    expect(ts.running).toBe(false)
    expectHttpError(() => ts.input('anything', 'x'), 409)
    expectHttpError(() => ts.resize('anything', 80, 24), 409)
  })

  it('create spawns a running shell; a second create attaches without a second spawn', async () => {
    const { ts, rec, id } = await startSession()
    expect(rec.states).toHaveLength(1)
    expect(rec.states[0].id).toBe(id)
    expect(rec.states[0].state.status).toBe('running')
    const snap = ts.snapshot()
    expect(snap.terminalId).toBe(id)
    expect(snap.state.shell).toBe(expectedShell)
    expect(snap.state.cwd).toBe(dir)
    expect(snap.state.cols).toBe(80)
    expect(snap.state.rows).toBe(24)
    expect(snap.restored).toBe(false)
    expect(ts.running).toBe(true)

    const ptyBefore = lastPty
    const snap2 = ts.create(100, 30)
    expect(snap2.terminalId).toBe(id)
    // Attach is idempotent: the requested dimensions do not resize the live shell.
    expect(snap2.state.cols).toBe(80)
    expect(snap2.state.rows).toBe(24)
    expect(lastPty).toBe(ptyBefore)
    expect(rec.states).toHaveLength(1)
  })

  it('input round-trips through the pty with seq strictly monotonic from 1', async () => {
    const { ts, rec, id } = await startSession()
    ts.input(id, 'echo crw-pty-marker\r')
    await waitUntil(() => rec.text(id).includes('crw-pty-marker'), 15000, 'marker echo')
    const outs = rec.outputs.filter((o) => o.id === id)
    expect(outs[0].seq).toBe(1)
    for (let i = 1; i < outs.length; i++) {
      expect(outs[i].seq).toBe(outs[i - 1].seq + 1)
    }
    // The headless screen is parsed synchronously, so the snapshot seq always
    // equals the last emitted seq (the resync-consistency invariant).
    expect(ts.snapshot().seq).toBe(outs[outs.length - 1].seq)
    expect(ts.snapshot().screen).toContain('crw-pty-marker')
  })

  it('exit transitions to exited with exitCode and retains the serialized screen', async () => {
    const { ts, rec, id } = await startSession()
    ts.input(id, 'echo crw-exit-marker\r')
    await waitUntil(() => rec.text(id).includes('crw-exit-marker'), 15000, 'exit marker')
    ts.input(id, 'exit\r')
    await waitUntil(() => rec.states.some((s) => s.state.status === 'exited'), 15000, 'exited state')
    const ex = rec.states.find((s) => s.state.status === 'exited')!
    expect(ex.id).toBe(id)
    expect(ex.state.exitCode).toBe(0)
    expect(ts.running).toBe(false)
    const snap = ts.snapshot()
    expect(snap.state.status).toBe('exited')
    expect(snap.state.exitCode).toBe(0)
    expect(snap.terminalId).toBe(id)
    expect(snap.screen).toContain('crw-exit-marker')
    // The exited generation is dead for input purposes.
    expectHttpError(() => ts.input(id, 'x'), 409)
    // create after exit spawns a fresh generation (manual restart).
    const snap2 = ts.create(80, 24)
    expect(snap2.terminalId).not.toBe(id)
    expect(snap2.state.status).toBe('running')
    expect(snap2.seq).toBe(0)
  })

  it('stale-generation input/resize reject with 409 and never reach the new shell', async () => {
    const { ts, rec, id: oldId } = await startSession()
    ts.close()
    const snap = ts.create(80, 24)
    const newId = snap.terminalId
    expect(newId).not.toBe(oldId)
    await waitUntil(() => rec.outputs.some((o) => o.id === newId), 15000, 'new shell output')
    expectHttpError(() => ts.input(oldId, 'crw-stale-leak\r'), 409)
    expectHttpError(() => ts.resize(oldId, 100, 30), 409)
    // The new shell is responsive and never saw the stale payload.
    ts.input(newId, 'echo crw-fresh-marker\r')
    await waitUntil(() => rec.text(newId).includes('crw-fresh-marker'), 15000, 'fresh marker')
    expect(rec.text(newId)).not.toContain('crw-stale-leak')
    const newOuts = rec.outputs.filter((o) => o.id === newId)
    expect(newOuts[0].seq).toBe(1)
  })

  it('oversize input and out-of-bounds dimensions reject with 400; the generation fence wins', async () => {
    const { ts, id } = await startSession()
    expectHttpError(() => ts.input(id, 'x'.repeat(TERMINAL_MAX_INPUT_BYTES + 1)), 400)
    expect(() => ts.input(id, 'x'.repeat(TERMINAL_MAX_INPUT_BYTES))).not.toThrow()
    // Stale generation + oversize: the 409 fence is checked first.
    expectHttpError(() => ts.input('stale-id', 'x'.repeat(TERMINAL_MAX_INPUT_BYTES + 1)), 409)
    expectHttpError(() => ts.resize(id, TERMINAL_MAX_COLS + 1, 24), 400)
    expectHttpError(() => ts.resize(id, 80, TERMINAL_MAX_ROWS + 1), 400)
    expectHttpError(() => ts.resize(id, 0, 24), 400)
    expectHttpError(() => ts.resize(id, 80.5, 24), 400)
    expectHttpError(() => ts.resize('stale-id', TERMINAL_MAX_COLS + 1, 24), 409)
    ts.resize(id, 100, 30)
    expect(ts.snapshot().state.cols).toBe(100)
    expect(ts.snapshot().state.rows).toBe(30)
    // Bounds apply to a spawning create, not to an idempotent attach.
    ts.close()
    expectHttpError(() => ts.create(TERMINAL_MAX_COLS + 1, 24), 400)
    expectHttpError(() => ts.create(80, TERMINAL_MAX_ROWS + 1), 400)
  })

  it('close kills the shell, removes the persisted file, and resets to idle', async () => {
    const { ts, rec, pid, id } = await startSession()
    ts.input(id, 'echo crw-close-marker\r')
    await waitUntil(() => rec.text(id).includes('crw-close-marker'), 15000, 'close marker')
    ts.flush()
    expect(existsSync(fileFor())).toBe(true)
    expect(readFileSync(fileFor(), 'utf8')).toContain('crw-close-marker')

    ts.close()
    expect(ts.running).toBe(false)
    const snap = ts.snapshot()
    expect(snap.terminalId).toBe('')
    expect(snap.seq).toBe(0)
    expect(snap.screen).toBe('')
    expect(snap.state.status).toBe('idle')
    expect(existsSync(fileFor())).toBe(false)
    const lastState = rec.states[rec.states.length - 1]
    expect(lastState.id).toBe('')
    expect(lastState.state.status).toBe('idle')
    await waitUntil(() => !alive(pid), 5000, 'shell process death')
    expectHttpError(() => ts.input(id, 'x'), 409)
    // A second close is a no-op, not a throw.
    expect(() => ts.close()).not.toThrow()
  })

  it('dispose kills the shell but keeps persistence', async () => {
    const { ts, rec, pid, id } = await startSession()
    ts.input(id, 'echo crw-dispose-marker\r')
    await waitUntil(() => rec.text(id).includes('crw-dispose-marker'), 15000, 'dispose marker')
    ts.flush()
    expect(existsSync(fileFor())).toBe(true)

    ts.dispose()
    expect(ts.running).toBe(false)
    await waitUntil(() => !alive(pid), 5000, 'shell process death')
    expect(existsSync(fileFor())).toBe(true)
    expect(readFileSync(fileFor(), 'utf8')).toContain('crw-dispose-marker')
    // flush after dispose is a safe no-op (nothing pending).
    expect(() => ts.flush()).not.toThrow()
    expect(existsSync(fileFor())).toBe(true)
  })

  it('burst: >1MB of output keeps seq contiguous and the producer settles', async () => {
    const { ts, rec, id } = await startSession()
    // Indexed lines so the LAST line is a unique completion marker that cannot
    // be confused with the echoed command text.
    const burst = IS_WIN32
      ? 'for /L %i in (1,1,60000) do @echo crw-burst-%i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r'
      : 'for i in $(seq 1 60000); do echo crw-burst-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done\r'
    ts.input(id, burst)
    await waitUntil(() => rec.text(id).includes('crw-burst-60000-'), 60000, 'burst completion')
    const outs = rec.outputs.filter((o) => o.id === id)
    expect(outs[0].seq).toBe(1)
    for (let i = 1; i < outs.length; i++) {
      expect(outs[i].seq).toBe(outs[i - 1].seq + 1)
    }
    const totalBytes = outs.reduce((n, o) => n + Buffer.byteLength(o.data, 'utf8'), 0)
    expect(totalBytes).toBeGreaterThan(1_000_000)
    const snap = ts.snapshot()
    expect(snap.seq).toBe(outs[outs.length - 1].seq)
    expect(snap.screen).toContain('crw-burst-60000-')
    // The shell is still responsive after the flood.
    ts.input(id, 'echo crw-after-burst\r')
    await waitUntil(() => rec.text(id).includes('crw-after-burst'), 15000, 'post-burst responsiveness')
  }, 90000)

  it('schedules persistence on output (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ts, rec, pid, id } = await startSession()
    ts.input(id, 'echo crw-sched-marker\r')
    await waitUntil(() => rec.text(id).includes('crw-sched-marker'), 15000, 'sched marker')
    // The trailing debounce has not elapsed: nothing on disk yet.
    expect(existsSync(fileFor())).toBe(false)
    vi.advanceTimersByTime(TERMINAL_SCREEN_DEBOUNCE_MS - 1)
    expect(existsSync(fileFor())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(existsSync(fileFor())).toBe(true)
    const persisted = JSON.parse(readFileSync(fileFor(), 'utf8')) as { screen: string; state: TerminalState }
    expect(persisted.screen).toContain('crw-sched-marker')
    expect(persisted.state.status).toBe('running')
    expect(persisted.state.shell).toBe(expectedShell)
    // Tear down under fake timers: close kills via taskkill (real), then the
    // node-pty drain timer needs advancing so the process handles release.
    ts.close()
    vi.advanceTimersByTime(3000)
    await waitUntil(() => !alive(pid), 5000, 'shell death after close')
  }, 30000)
})
