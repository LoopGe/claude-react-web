import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearLogFile, enableFileLogging, disableFileLogging } from './log.js'

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
