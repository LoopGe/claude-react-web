import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearLogFile, enableFileLogging, disableFileLogging, setLogToStderr, createLogger } from './log.js'

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
