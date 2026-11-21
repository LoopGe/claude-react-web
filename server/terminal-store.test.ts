import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalScreenStore, type PersistedTerminal } from './terminal-store.js'
import { TERMINAL_SCREEN_DEBOUNCE_MS, type TerminalState } from '../shared/terminal.js'
import { getLogConfig, setLogConfig, type LogConfigSnapshot } from './log.js'

const state: TerminalState = {
  status: 'running',
  shell: 'cmd.exe',
  cwd: 'C:\\work',
  cols: 80,
  rows: 24,
}

function data(screen: string, savedAt = 1_700_000_000_000): PersistedTerminal {
  return { screen, state, savedAt }
}

describe('TerminalScreenStore', () => {
  let dir: string
  let store: TerminalScreenStore
  let prevLogConfig: LogConfigSnapshot

  const fileFor = (sessionId: string): string =>
    join(dir, 'terminal-screens', `${sessionId}.json`)

  beforeEach(() => {
    vi.useFakeTimers()
    // Deterministic logger config: the corrupt-file test counts warn lines,
    // which must pass regardless of any boot-time LOG_LEVEL / LOG_SCOPES.
    prevLogConfig = getLogConfig()
    setLogConfig({ level: 'info', scopes: null })
    dir = mkdtempSync(join(tmpdir(), 'crw-terminal-store-'))
    store = new TerminalScreenStore(dir)
  })

  afterEach(() => {
    vi.useRealTimers()
    setLogConfig(prevLogConfig)
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists after the full 2000ms trailing debounce, not 1ms before', () => {
    const d = data('hello\r\n$ ')
    store.schedule('s1', d)
    vi.advanceTimersByTime(1999)
    expect(existsSync(fileFor('s1'))).toBe(false)
    vi.advanceTimersByTime(1)
    expect(readFileSync(fileFor('s1'), 'utf8')).toBe(JSON.stringify(d, null, 2))
  })

  it('coalesces two schedules within the window into ONE write of the last data', () => {
    store.schedule('s1', data('first'))
    vi.advanceTimersByTime(1000)
    expect(existsSync(fileFor('s1'))).toBe(false)
    store.schedule('s1', data('second'))
    // t=2000: the FIRST schedule's original deadline — the window restarted,
    // so no write may land here.
    vi.advanceTimersByTime(1000)
    expect(existsSync(fileFor('s1'))).toBe(false)
    // t=3000: the second schedule's deadline — the one coalesced write.
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(readFileSync(fileFor('s1'), 'utf8'))).toEqual(data('second'))
    // Exactly one write: with the file gone, no leftover timer may rewrite it.
    rmSync(fileFor('s1'))
    vi.advanceTimersByTime(TERMINAL_SCREEN_DEBOUNCE_MS)
    expect(existsSync(fileFor('s1'))).toBe(false)
  })

  it('flush writes immediately and cancels the pending timer', () => {
    const d = data('flushed')
    store.schedule('s1', d)
    store.flush('s1')
    // Written synchronously — no timer advance needed.
    expect(readFileSync(fileFor('s1'), 'utf8')).toBe(JSON.stringify(d, null, 2))
    // The cancelled timer must not fire a second write: delete the file and
    // advance past the window — a live timer would recreate it.
    rmSync(fileFor('s1'))
    vi.advanceTimersByTime(TERMINAL_SCREEN_DEBOUNCE_MS * 2)
    expect(existsSync(fileFor('s1'))).toBe(false)
    // Flushing a session with nothing pending is a no-op.
    store.flush('never-scheduled')
    expect(existsSync(fileFor('never-scheduled'))).toBe(false)
  })

  it('load round-trips persisted data; an absent file loads null', () => {
    const d = data('round trip', 123)
    store.schedule('s1', d)
    store.flush('s1')
    expect(store.load('s1')).toEqual(d)
    // A fresh store instance (server restart) reads the same file.
    expect(new TerminalScreenStore(dir).load('s1')).toEqual(d)
    expect(store.load('absent')).toBeNull()
  })

  it('corrupt/truncated JSON loads as null with one warn, never throws', () => {
    mkdirSync(join(dir, 'terminal-screens'), { recursive: true })
    // Crash mid-write leaves truncated JSON — the proven failure mode.
    writeFileSync(fileFor('s1'), '{"screen": "half-writ')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(store.load('s1')).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toBe('[terminal]')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('a failed debounced write is logged, never crashes; flush still throws', () => {
    // The rename target exists as a DIRECTORY: writeFileSync(tmp) succeeds,
    // renameSync onto it fails on every platform (EISDIR / EPERM).
    mkdirSync(fileFor('s1'), { recursive: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      store.schedule('s1', data('doomed'))
      // Fake timers run the callback synchronously, so an uncaught write
      // error would propagate out of advanceTimersByTime and fail here.
      expect(() => vi.advanceTimersByTime(TERMINAL_SCREEN_DEBOUNCE_MS)).not.toThrow()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0][0]).toBe('[terminal]')
      // The caller-driven synchronous path still surfaces the failure.
      store.schedule('s1', data('doomed'))
      expect(() => store.flush('s1')).toThrow()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('remove deletes the file and cancels a pending timer', () => {
    store.schedule('s1', data('old'))
    store.flush('s1')
    expect(existsSync(fileFor('s1'))).toBe(true)
    store.schedule('s1', data('new'))
    store.remove('s1')
    expect(existsSync(fileFor('s1'))).toBe(false)
    // The cancelled pending write must not resurrect the file.
    vi.advanceTimersByTime(TERMINAL_SCREEN_DEBOUNCE_MS * 2)
    expect(existsSync(fileFor('s1'))).toBe(false)
    // Removing a session that never persisted is a no-op, not a throw.
    expect(() => store.remove('never')).not.toThrow()
  })
})
