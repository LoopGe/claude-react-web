import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearLogFile, enableFileLogging, disableFileLogging, setLogToStderr, createLogger, enableLogRing, disableLogRing, isLogRingEnabled, readLogRing, setLogConfig } from './log.js'

describe('clearLogFile', () => {
  let tempDir: string

  afterEach(() => {
    disableFileLogging()
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('removes old log files and re-creates logs dir when reEnable is true', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'log-test-'))
    enableFileLogging(tempDir)
    const logDir = join(tempDir, 'logs')
    // Write a fake old-dated log file
    writeFileSync(join(logDir, 'server-2020-01-01.log'), 'old log data')

    await clearLogFile(tempDir, true)

    // Old log file should be gone
    expect(existsSync(join(logDir, 'server-2020-01-01.log'))).toBe(false)
    // Logs dir should still exist (re-enabled re-creates it + today's file)
    expect(existsSync(logDir)).toBe(true)
  })

  it('removes logs dir entirely when reEnable is false', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'log-test-'))
    enableFileLogging(tempDir)
    const logDir = join(tempDir, 'logs')
    writeFileSync(join(logDir, 'server-2020-01-01.log'), 'old log data')

    await clearLogFile(tempDir, false)

    // Logs dir should be gone entirely
    expect(existsSync(logDir)).toBe(false)
  })
})

describe('setLogToStderr', () => {
  const origLog = console.log
  const origError = console.error
  afterEach(() => {
    setLogToStderr(false)
    console.log = origLog
    console.error = origError
  })

  it('routes info/debug/trace to stderr when enabled, stdout otherwise', () => {
    const logSpy = vi.fn()
    const errSpy = vi.fn()
    console.log = logSpy as unknown as typeof console.log
    console.error = errSpy as unknown as typeof console.error
    const log = createLogger('logstderr-test')
    setLogToStderr(true)
    log.info('info-msg')
    log.info('info-msg-2')
    expect(errSpy).toHaveBeenCalledWith('[logstderr-test]', 'info-msg')
    expect(errSpy).toHaveBeenCalledWith('[logstderr-test]', 'info-msg-2')
    expect(logSpy).not.toHaveBeenCalled()
    setLogToStderr(false)
    log.info('after-msg')
    expect(logSpy).toHaveBeenCalledWith('[logstderr-test]', 'after-msg')
  })
})

describe('log ring buffer', () => {
  afterEach(() => {
    disableLogRing()
    setLogConfig({ level: 'info', scopes: null })
  })

  it('captures only lines that already passed the level filter', () => {
    setLogConfig({ level: 'warn', scopes: null })
    enableLogRing(10)
    const log = createLogger('ring-a')
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.info('muted')
    log.warn('kept')
    expect(readLogRing().lines.map((l) => l.msg)).toEqual(['kept'])
    expect(readLogRing().lines[0].level).toBe('warn')
    expect(readLogRing().lines[0].scope).toBe('ring-a')
    spyLog.mockRestore()
    spyWarn.mockRestore()
  })

  it('evicts the oldest lines past capacity and accumulates dropped', () => {
    enableLogRing(2)
    const log = createLogger('ring-b')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('1')
    log.info('2')
    log.info('3')
    const { lines, total, dropped } = readLogRing()
    expect(lines.map((l) => l.msg)).toEqual(['2', '3'])
    expect(total).toBe(2)
    expect(dropped).toBe(1)
    spy.mockRestore()
  })

  it('filters by scope (exact match)', () => {
    enableLogRing(50)
    const a = createLogger('ring-x')
    const b = createLogger('ring-y')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    a.info('from x')
    b.info('from y')
    expect(readLogRing({ scope: 'ring-y' }).lines.map((l) => l.msg)).toEqual(['from y'])
    spy.mockRestore()
  })

  it('filters by level as "at least this severe"', () => {
    enableLogRing(50)
    const log = createLogger('ring-l')
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(readLogRing({ level: 'warn' }).lines.map((l) => l.msg)).toEqual(['w', 'e'])
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyErr.mockRestore()
  })

  it('filters by since and by a case-insensitive grep', () => {
    enableLogRing(50)
    const log = createLogger('ring-g')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('alpha hit')
    log.info('beta miss')
    expect(readLogRing({ since: 0 }).lines).toHaveLength(2)
    expect(readLogRing({ since: Number.MAX_SAFE_INTEGER }).lines).toEqual([])
    expect(readLogRing({ grep: 'ALPHA' }).lines.map((l) => l.msg)).toEqual(['alpha hit'])
    spy.mockRestore()
  })

  it('applies limit AFTER filtering, keeping the newest N', () => {
    enableLogRing(50)
    const log = createLogger('ring-lim')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('one')
    log.info('two')
    log.info('three')
    expect(readLogRing({ limit: 2 }).lines.map((l) => l.msg)).toEqual(['two', 'three'])
    expect(readLogRing({ limit: 2 }).total).toBe(3)
    spy.mockRestore()
  })

  it('truncates a single line at 4096 chars including the elision marker', () => {
    enableLogRing(5)
    const log = createLogger('ring-t')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('x'.repeat(5000))
    const [line] = readLogRing().lines
    expect(line.msg).toHaveLength(4096)
    expect(line.msg.endsWith('…')).toBe(true)
    spy.mockRestore()
  })

  it('stops collecting after disable and reports an empty ring', () => {
    enableLogRing(5)
    const log = createLogger('ring-d')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('before')
    expect(readLogRing().lines).toHaveLength(1)
    disableLogRing()
    expect(isLogRingEnabled()).toBe(false)
    log.info('after')
    expect(readLogRing()).toEqual({ lines: [], total: 0, dropped: 0 })
    spy.mockRestore()
  })

  it('is a no-op while disabled', () => {
    expect(isLogRingEnabled()).toBe(false)
    const log = createLogger('ring-off')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('nothing collects this')
    expect(readLogRing().lines).toEqual([])
    spy.mockRestore()
  })
})
