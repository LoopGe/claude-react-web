import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendStderrLine, readStderrTail, cliLogInfo, cleanupCliLogs } from './cli-diagnostics.js'

let dir: string
let logsDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-clidiag-'))
  logsDir = join(dir, 'logs')
  mkdirSync(logsDir, { recursive: true })
})

describe('cli-diagnostics', () => {
  it('appends and reads back a stderr tail', async () => {
    await appendStderrLine(logsDir, 's1', 'line one')
    await appendStderrLine(logsDir, 's1', 'line two')
    expect(await readStderrTail(logsDir, 's1')).toEqual(['line one', 'line two'])
    expect(await readStderrTail(logsDir, 's1', 1)).toEqual(['line two'])
  })

  it('no-ops on missing logsDir / sid', async () => {
    await expect(appendStderrLine(undefined, 's1', 'x')).resolves.toBeUndefined()
    await expect(readStderrTail(undefined, 's1')).resolves.toEqual([])
    await expect(cliLogInfo(undefined, 's1')).resolves.toEqual({ exists: false })
  })

  it('caps the jsonl file at ~5MB keeping the tail', { timeout: 30_000 }, async () => {
    const big = 'x'.repeat(2048)
    for (let i = 0; i < 3000; i++) await appendStderrLine(logsDir, 's1', `${i}-${big}`)
    const file = join(logsDir, 'cli-stderr-s1.jsonl')
    const stat = await import('node:fs/promises').then((f) => f.stat(file))
    expect(stat.size).toBeLessThan(5 * 1024 * 1024 + 4096)
    const tail = await readStderrTail(logsDir, 's1', 5)
    expect(tail.length).toBeLessThanOrEqual(5)
  })

  it('cliLogInfo reports file existence and size', async () => {
    expect(await cliLogInfo(logsDir, 's1')).toEqual({ exists: false })
    writeFileSync(join(logsDir, 'cli-s1.log'), 'debug output', 'utf8')
    const info = await cliLogInfo(logsDir, 's1')
    expect(info.exists).toBe(true)
    expect(info.size).toBeGreaterThan(0)
    expect(info.path).toContain('cli-s1.log')
  })

  it('cleanupCliLogs removes stale cli logs and keeps fresh ones', async () => {
    writeFileSync(join(logsDir, 'cli-s1.log'), 'a', 'utf8')
    writeFileSync(join(logsDir, 'cli-stderr-s1.jsonl'), '{}', 'utf8')
    writeFileSync(join(logsDir, 'unrelated.log'), 'keep', 'utf8')
    const old = (Date.now() - 15 * 24 * 3600 * 1000) / 1000
    utimesSync(join(logsDir, 'cli-s1.log'), old, old)
    utimesSync(join(logsDir, 'cli-stderr-s1.jsonl'), old, old)

    const removed = await cleanupCliLogs(logsDir, 14 * 24 * 3600 * 1000)
    expect(removed).toBe(2)
    expect(existsSync(join(logsDir, 'cli-s1.log'))).toBe(false)
    expect(existsSync(join(logsDir, 'cli-stderr-s1.jsonl'))).toBe(false)
    expect(existsSync(join(logsDir, 'unrelated.log'))).toBe(true)
  })
})
