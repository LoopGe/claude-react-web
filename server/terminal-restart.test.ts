import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import headlessPkg, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import { TerminalSession, type TerminalEvents } from './terminal.js'
import { TerminalScreenStore } from './terminal-store.js'
import { getLogConfig, setLogConfig, type LogConfigSnapshot } from './log.js'
import { TERMINAL_DIVIDER_TEXT, TERMINAL_SCROLLBACK, type TerminalState } from '../shared/terminal.js'

// Restart-flow pins: a server restart kills the PTY but the persisted screen
// restores as history. Seeded-store cases write a real PersistedTerminal through
// the real store into a temp dir; the seed screen is produced by the same
// headless + serialize path the session itself uses (SerializeAddon output is
// idempotent under re-parse at the same dimensions, so the restored snapshot's
// screen equals the persisted string byte-for-byte). Cases that spawn a shell
// use real node-pty (cmd.exe on win32) with the terminal.test.ts cleanup
// backstop: record every spawned handle, taskkill leaks in afterEach.
const IS_WIN32 = process.platform === 'win32'
const expectedShell = basename(
  IS_WIN32 ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh'),
)

type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => { pid: number }
const ptyModule = createRequire(import.meta.url)('node-pty') as { spawn: SpawnFn }
const realSpawn = ptyModule.spawn

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

/** A serialize-addon screen for `text` at the given dimensions — the exact
 *  shape a live session persists, so re-parsing it restores byte-identically. */
function seedScreen(text: string, cols: number, rows: number): string {
  const t = new headlessPkg.Terminal({
    cols,
    rows,
    scrollback: TERMINAL_SCROLLBACK,
    allowProposedApi: true,
  })
  const s = new SerializeAddon()
  t.loadAddon(s)
  t.input('')
  t.write(text)
  const out = s.serialize()
  t.dispose()
  return out
}

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

describe('TerminalSession restart flow', () => {
  let dir: string
  let store: TerminalScreenStore
  const sessions: TerminalSession[] = []
  const spawned: Array<{ pid: number }> = []
  const fileFor = (): string => join(dir, 'terminal-screens', 'term-restart.json')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crw-terminal-restart-'))
    store = new TerminalScreenStore(dir)
    ptyModule.spawn = (...args) => {
      const p = realSpawn(...args)
      spawned.push(p)
      return p
    }
  })

  afterEach(async () => {
    for (const s of sessions.splice(0)) s.close()
    const handles = spawned.splice(0)
    // Windows pid is 0 until the pseudoconsole is ready; yield until readable.
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
    await waitUntil(() => leaked.every((p) => !alive(p)), 5000, 'leaked shells to die')
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
    const ts = new TerminalSession({ sessionId: 'term-restart', cwd: dir, store, events: rec.events })
    sessions.push(ts)
    return { ts, rec }
  }

  /** Seed the real store with a persisted screen + meta (the state a server
   *  restart finds on disk). */
  function seedPersistence(status: 'running' | 'exited', marker: string, cols = 80, rows = 24): string {
    const screen = seedScreen(`${marker}\r\n`, cols, rows)
    const state: TerminalState = {
      status,
      ...(status === 'exited' ? { exitCode: 7 } : {}),
      shell: expectedShell,
      cwd: dir,
      cols,
      rows,
    }
    store.schedule('term-restart', { screen, state, savedAt: Date.now() })
    store.flush('term-restart')
    return screen
  }

  it('restored running persistence: snapshot before create is idle with the persisted screen, no spawn', () => {
    const screen = seedPersistence('running', 'crw-restart-history', 100, 30)
    const { ts } = makeSession()
    const snap = ts.snapshot()
    expect(snap.restored).toBe(true)
    expect(snap.terminalId).toBe('')
    expect(snap.seq).toBe(0)
    expect(snap.screen).toBe(screen)
    expect(snap.state).toEqual({
      status: 'idle',
      shell: expectedShell,
      cwd: dir,
      cols: 100,
      rows: 30,
    })
    expect(ts.running).toBe(false)
    expect(spawned).toHaveLength(0)
  })

  it('create on a restored session: divider is the first output chunk, history stays above it, new output appends below', async () => {
    seedPersistence('running', 'crw-restart-history')
    const { ts, rec } = makeSession()
    const snap = ts.create(80, 24)
    const id = snap.terminalId
    expect(snap.state.status).toBe('running')
    expect(snap.restored).toBe(true)
    // The create-time snapshot already carries history + divider at seq 1.
    expect(snap.seq).toBe(1)
    expect(snap.screen).toContain('crw-restart-history')
    expect(snap.screen).toContain(TERMINAL_DIVIDER_TEXT)
    expect(snap.screen.indexOf('crw-restart-history')).toBeLessThan(
      snap.screen.indexOf(TERMINAL_DIVIDER_TEXT),
    )

    // The divider fanned out as the FIRST output chunk of the new generation,
    // dim-styled, before any shell output.
    const outs = () => rec.outputs.filter((o) => o.id === id)
    expect(outs()).toHaveLength(1)
    expect(outs()[0].seq).toBe(1)
    expect(outs()[0].data).toContain(TERMINAL_DIVIDER_TEXT)
    expect(outs()[0].data).toContain('\x1b[2m')
    expect(outs()[0].data).toContain('\x1b[0m')

    // The real shell's output arrives AFTER the divider and appends below it.
    await waitUntil(() => outs().length >= 2, 15000, 'first shell output')
    ts.input(id, 'echo crw-restart-new\r')
    await waitUntil(() => rec.text(id).includes('crw-restart-new'), 15000, 'new shell marker')
    const text = rec.text(id)
    expect(text.indexOf(TERMINAL_DIVIDER_TEXT)).toBeLessThan(text.indexOf('crw-restart-new'))
    const final = ts.snapshot()
    expect(final.screen.indexOf('crw-restart-history')).toBeLessThan(
      final.screen.indexOf(TERMINAL_DIVIDER_TEXT),
    )
    expect(final.screen.indexOf(TERMINAL_DIVIDER_TEXT)).toBeLessThan(final.screen.indexOf('crw-restart-new'))
    // Screen == seq consistency holds across the divider chunk.
    expect(final.seq).toBe(outs()[outs().length - 1].seq)
    for (let i = 1; i < outs().length; i++) {
      expect(outs()[i].seq).toBe(outs()[i - 1].seq + 1)
    }
  }, 30000)

  it('restored exited persistence keeps exited + exitCode and spawns nothing until create', async () => {
    const screen = seedPersistence('exited', 'crw-exited-history')
    const { ts, rec } = makeSession()
    const snap = ts.snapshot()
    expect(snap.restored).toBe(true)
    expect(snap.state.status).toBe('exited')
    expect(snap.state.exitCode).toBe(7)
    expect(snap.screen).toBe(screen)
    expect(snap.terminalId).toBe('')
    expect(snap.seq).toBe(0)
    expect(ts.running).toBe(false)
    expect(spawned).toHaveLength(0)

    // Manual restart is allowed and runs the same restore flow: history +
    // divider + a fresh shell.
    const snap2 = ts.create(80, 24)
    expect(snap2.state.status).toBe('running')
    expect(snap2.restored).toBe(true)
    expect(snap2.screen).toContain('crw-exited-history')
    expect(snap2.screen).toContain(TERMINAL_DIVIDER_TEXT)
    const id = snap2.terminalId
    await waitUntil(() => rec.outputs.some((o) => o.id === id && o.seq >= 2), 15000, 'fresh shell output')
    expect(spawned).toHaveLength(1)
  }, 30000)

  it('no persistence: plain idle, restored false, create spawns without a divider', async () => {
    const { ts, rec } = makeSession()
    const snap = ts.snapshot()
    expect(snap.restored).toBe(false)
    expect(snap.state.status).toBe('idle')
    expect(snap.screen).toBe('')
    const created = ts.create(80, 24)
    expect(created.restored).toBe(false)
    expect(created.seq).toBe(0)
    const id = created.terminalId
    await waitUntil(() => rec.outputs.some((o) => o.id === id), 15000, 'first shell output')
    expect(rec.text(id)).not.toContain(TERMINAL_DIVIDER_TEXT)
    expect(ts.snapshot().screen).not.toContain(TERMINAL_DIVIDER_TEXT)
  }, 30000)

  it('corrupt persistence loads as plain idle without throwing', () => {
    mkdirSync(join(dir, 'terminal-screens'), { recursive: true })
    // Crash mid-write leaves truncated JSON — the store's proven failure mode.
    writeFileSync(fileFor(), '{"screen": "half-writ')
    const prevLog: LogConfigSnapshot = getLogConfig()
    setLogConfig({ level: 'info', scopes: null })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ts } = makeSession()
      const snap = ts.snapshot()
      expect(snap.restored).toBe(false)
      expect(snap.state.status).toBe('idle')
      expect(snap.screen).toBe('')
      expect(ts.running).toBe(false)
      // The store's corrupt guard fired exactly once (not silently absent).
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toBe('[terminal]')
      expect(spawned).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      setLogConfig(prevLog)
    }
  })

  it('close on a never-created restored slot clears the history and removes persistence', () => {
    seedPersistence('running', 'crw-restart-close')
    const { ts, rec } = makeSession()
    expect(ts.snapshot().restored).toBe(true)
    ts.close()
    const snap = ts.snapshot()
    expect(snap.state.status).toBe('idle')
    expect(snap.screen).toBe('')
    expect(snap.restored).toBe(false)
    expect(existsSync(fileFor())).toBe(false)
    const lastState = rec.states[rec.states.length - 1]
    expect(lastState.id).toBe('')
    expect(lastState.state.status).toBe('idle')
    expect(spawned).toHaveLength(0)
  })

  it('dispose on a never-created restored slot releases the screen but keeps persistence', () => {
    seedPersistence('running', 'crw-restart-dispose')
    const { ts } = makeSession()
    ts.dispose()
    const snap = ts.snapshot()
    expect(snap.state.status).toBe('idle')
    expect(snap.screen).toBe('')
    expect(snap.restored).toBe(false)
    expect(existsSync(fileFor())).toBe(true)
    expect(spawned).toHaveLength(0)
  })

  it('one divider per restart: after the restored shell exits, a manual create starts fresh', async () => {
    seedPersistence('running', 'crw-restart-once')
    const { ts, rec } = makeSession()
    const first = ts.create(80, 24)
    const id1 = first.terminalId
    await waitUntil(() => rec.outputs.some((o) => o.id === id1 && o.seq >= 2), 15000, 'first shell output')
    ts.input(id1, 'exit\r')
    await waitUntil(
      () => rec.states.some((s) => s.id === id1 && s.state.status === 'exited'),
      15000,
      'exited state',
    )
    expect(ts.snapshot().restored).toBe(true)

    // Manual restart within the same server lifetime: no second "server
    // restarted" divider, and the discarded history clears the restored flag.
    const second = ts.create(80, 24)
    const id2 = second.terminalId
    expect(id2).not.toBe(id1)
    expect(second.seq).toBe(0)
    expect(second.restored).toBe(false)
    expect(second.screen).toBe('')
    await waitUntil(() => rec.outputs.some((o) => o.id === id2), 15000, 'second shell output')
    expect(rec.text(id2)).not.toContain(TERMINAL_DIVIDER_TEXT)
    expect(ts.snapshot().screen).not.toContain(TERMINAL_DIVIDER_TEXT)
    expect(ts.snapshot().screen).not.toContain('crw-restart-once')
  }, 30000)
})
