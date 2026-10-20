import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import {
  daemonDirOf, statusPathOf, readStatusFile, writeStatusFile, isStatusFresh,
  writeMarker, readMarker, clearMarker,
  HEARTBEAT_FRESH_MS, type DaemonStatusFile,
} from './control.js'

function sampleStatus(over: Partial<DaemonStatusFile> = {}): DaemonStatusFile {
  return {
    daemonPid: 111, childPid: 222, state: 'running', startedAt: 1_000,
    childStartedAt: 2_000, restartCount: 0, consecutiveFailures: 0,
    lastError: null, lastExitReason: null, updatedAt: 2_000, ...over,
  }
}

describe('daemon control file protocol', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-control') })
  afterEach(() => rmRf(dir))

  it('writes status atomically and reads it back', async () => {
    await writeStatusFile(dir, sampleStatus())
    const s = await readStatusFile(dir)
    expect(s).toEqual(sampleStatus())
    expect(JSON.parse(readFileSync(statusPathOf(dir), 'utf8')).daemonPid).toBe(111)
  })

  it('returns null for a missing or corrupt status file', async () => {
    expect(await readStatusFile(dir)).toBeNull()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, 'daemon'), { recursive: true })
    writeFileSync(join(dir, 'daemon', 'status.json'), '{broken', 'utf8')
    expect(await readStatusFile(dir)).toBeNull()
  })

  it('freshness honors the 10s threshold', async () => {
    const now = 1_000_000
    expect(isStatusFresh(sampleStatus({ updatedAt: now - HEARTBEAT_FRESH_MS + 1 }), now)).toBe(true)
    expect(isStatusFresh(sampleStatus({ updatedAt: now - HEARTBEAT_FRESH_MS - 1 }), now)).toBe(false)
    expect(isStatusFresh(null, now)).toBe(false)
  })

  it('markers write, read and clear independently', async () => {
    expect(await readMarker(dir, 'stop')).toBe(false)
    await writeMarker(dir, 'stop')
    expect(await readMarker(dir, 'stop')).toBe(true)
    expect(await readMarker(dir, 'restart')).toBe(false)
    await clearMarker(dir, 'stop')
    expect(await readMarker(dir, 'stop')).toBe(false)
    await clearMarker(dir, 'stop') // idempotent: clearing a missing marker never throws
    expect(daemonDirOf(dir)).toBe(join(dir, 'daemon'))
  })
})
