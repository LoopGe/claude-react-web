import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { stat } from 'node:fs/promises'
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

  it('caps the jsonl file at ~5MB, keeping the tail and dropping the head', async () => {
    // Pre-fill past MAX_STDERR_BYTES in ONE write rather than driving the cap
    // with real appends. appendStderrLine does a stat + mkdir + appendFile per
    // call, so the 3000 sequential appends this used to make were ~9000 fs ops
    // — 30s, which then tripped its own 30s timeout under a loaded pool and
    // reddened the suite. The cap branch fires on the first append that would
    // cross the limit, so one oversized seed file reaches the same code path.
    const file = join(logsDir, 'cli-stderr-s1.jsonl')
    const filler = 'y'.repeat(2048)
    const seeded: string[] = []
    let bytes = 0
    for (let i = 0; bytes <= 5 * 1024 * 1024; i++) {
      const entry = JSON.stringify({ ts: Date.now(), line: `seed-${i}-${filler}` })
      seeded.push(entry)
      bytes += entry.length + 1
    }
    writeFileSync(file, seeded.join('\n') + '\n', 'utf8')
    const oldestSeededLine = `seed-0-${filler}`

    await appendStderrLine(logsDir, 's1', 'after-cap-1')
    await appendStderrLine(logsDir, 's1', 'after-cap-2')

    // Rewritten down to KEEP_LAST_BYTES (1MB) + the new entries, not left at 5MB.
    const { size } = await stat(file)
    expect(size).toBeLessThan(2 * 1024 * 1024)
    // The newest lines survive, in order…
    expect(await readStderrTail(logsDir, 's1', 2)).toEqual(['after-cap-1', 'after-cap-2'])
    // …the head was dropped (the point of the cap, previously unasserted)…
    const all = await readStderrTail(logsDir, 's1', 100_000)
    expect(all).not.toContain(oldestSeededLine)
    // …and the kept tail is more than just the two new lines.
    expect(all.length).toBeGreaterThan(2)
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
