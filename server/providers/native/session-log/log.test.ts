// log.test.ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSessionLog, deleteNativeSessionLog, hasNativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { NativeSessionStorageError } from './errors.js'
import { nativeSessionLogPath } from './paths.js'

// Hold the bytes a resume READ returns while the on-disk file keeps growing.
// This reproduces the same-id takeover race deterministically: the previous
// writer commits a complete line after the new writer's read but before it
// decides whether to truncate a torn tail.
const fsRead = vi.hoisted(() => ({ stale: null as Buffer | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs')
  return {
    ...actual,
    readFileSync: ((path: string) => fsRead.stale ?? actual.readFileSync(path)) as typeof actual.readFileSync,
  }
})

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'native-log-')); return dir }

const userEvent = (uuid: string) => ({ type: 'user' as const, uuid, session_id: 's1', parent_tool_use_id: null as null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] } })

const expectStorageError = (fn: () => unknown, kind: NativeSessionStorageError['kind']) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(NativeSessionStorageError)
    expect((err as NativeSessionStorageError).kind).toBe(kind)
    return
  }
  throw new Error(`expected NativeSessionStorageError with kind '${kind}'`)
}

describe('NativeSessionLog', () => {
  it('creates, appends, reloads in order and survives a torn tail', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    log.append({ type: 'turn/end', reason: 'completed' })
    await log.flush()
    await log.close()
    await writeFile(nativeSessionLogPath(stateDir, 's1'), '{"seq":2,"type":"assi', { flag: 'a' })
    const snapped = loadNativeSessionLogSync(stateDir, 's1')!
    expect(snapped.events.map((e) => e.type)).toEqual(['user', 'turn/end'])
    const reopened = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    try {
      reopened.append({ type: 'session/end-seed' })
      await reopened.flush()
      expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.seq)).toEqual([0, 1, 2])
    } finally {
      await reopened.close()
    }
  })
  it('does not truncate a complete line committed after the resume snapshot read', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    await log.flush()
    await log.close()
    const path = nativeSessionLogPath(stateDir, 's1')

    // The bytes a new writer's READ sees (T1). It ends on a newline, so that
    // read reports no torn tail.
    const snapshotBytes = await readFile(path)
    // The previous writer commits one more COMPLETE line after that read. A
    // re-stat would now see more bytes than the snapshot's completeBytes.
    await writeFile(path, JSON.stringify({ seq: 1, type: 'session/end-seed' }) + '\n', { flag: 'a' })
    const sizeAfterCommit = (await stat(path)).size

    fsRead.stale = snapshotBytes
    let resumed: NativeSessionLog | undefined
    try {
      resumed = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    } finally {
      fsRead.stale = null
    }
    // The snapshot's own totalBytes == completeBytes, so nothing is truncated:
    // the committed line survives instead of being silently dropped. The
    // snapshot itself saw only the pre-commit event — proving the stale read
    // was used (otherwise this assertion would see both events).
    expect(resumed.events).toHaveLength(1)
    expect((await stat(path)).size).toBe(sizeAfterCommit)
    expect(await readFile(path, 'utf8')).toContain('"type":"session/end-seed"')
    await resumed.close()
  })
  it('re-buffers the unwritten suffix when a write fails mid-flush', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    let calls = 0
    const written: Buffer[] = []
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        calls++
        // First call: a partial write lands, then the next call fails — the
        // re-buffer must resume at the exact byte offset, not replay or drop.
        if (calls === 1) {
          const n = Math.min(5, length)
          written.push(Buffer.from(chunk.subarray(offset, offset + n)))
          return { bytesWritten: n, buffer: chunk }
        }
        if (calls === 2) throw new Error('transient write failure')
        written.push(Buffer.from(chunk.subarray(offset, offset + length)))
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    // The handle is created lazily; inject a fake one so the failure happens
    // INSIDE writePending (not before it, where the buffer trivially survives).
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    await expect(log.flush()).rejects.toThrow('transient write failure')
    // The events are already in `events`, so the retried flush must deliver
    // the SAME bytes rather than leaving a seq gap or mangled text on disk.
    await log.flush()
    const persisted = Buffer.concat(written).toString('utf8')
    expect(persisted).toContain('"uuid":"u1"')
    expect(persisted).not.toContain('�')
    await log.close()
  })
  it('refuses a fresh open over an existing log', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    expectStorageError(() => NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false }), 'exists')
  })
  it('throws missing when resuming without a log', async () => {
    const stateDir = await fresh()
    expectStorageError(() => NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true }), 'missing')
  })
  it('writes a seeded log with its header counts and events', async () => {
    const stateDir = await fresh()
    const seededEvents = [{ seq: 0, ...userEvent('u1') }, { seq: 1, type: 'session/end-seed' as const }]
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/new', resume: false, seed: { events: seededEvents, inheritedEventCount: 1, isSeeded: true } })
    try {
      log.append({ type: 'session/context', text: 'child context' })
      await log.flush()
    } finally {
      await log.close()
    }
    const snapped = loadNativeSessionLogSync(stateDir, 's1')!
    expect(snapped.header.isSeeded).toBe(true)
    expect(snapped.header.inheritedEventCount).toBe(1)
    expect(snapped.header.cwd).toBe('/new')
    expect(snapped.events.map((e) => e.type)).toEqual(['user', 'session/end-seed', 'session/context'])
    expect(snapped.events.map((e) => e.seq)).toEqual([0, 1, 2])
  })
  it('takes over the writer: committed lines survive, post-takeover appends do not', async () => {
    const stateDir = await fresh()
    const a = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    let b: NativeSessionLog | undefined
    try {
      a.append(userEvent('u1'))
      await a.flush()
      b = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
      a.append(userEvent('stale'))
      b.append({ type: 'session/end-seed' })
      await b.flush()
      expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.type)).toEqual(['user', 'session/end-seed'])
    } finally {
      await a.close()
      if (b) await b.close()
    }
  })
  it('keeps writers for the same id in different state dirs independent', async () => {
    const stateDirA = await fresh()
    const stateDirB = await mkdtemp(join(tmpdir(), 'native-log-'))
    let a: NativeSessionLog | undefined
    let b: NativeSessionLog | undefined
    try {
      a = NativeSessionLog.open({ stateDir: stateDirA, id: 's1', cwd: '/repo', resume: false })
      b = NativeSessionLog.open({ stateDir: stateDirB, id: 's1', cwd: '/repo', resume: false })
      a.append(userEvent('u1'))
      await a.flush()
      expect(loadNativeSessionLogSync(stateDirA, 's1')!.events.map((e) => e.type)).toEqual(['user'])
    } finally {
      if (a) await a.close()
      if (b) await b.close()
      await rm(stateDirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it('ignores appends after close', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    await log.flush()
    await log.close()
    const returned = log.append(userEvent('late'))
    expect(returned.type).toBe('user')
    await log.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.type)).toEqual(['user'])
  })
  it('reports existence without parsing and deletes the directory', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    expect(await hasNativeSessionLog(stateDir, 's1')).toBe(true)
    expect(await deleteNativeSessionLog(stateDir, 's1')).toBe(true)
    expect(await hasNativeSessionLog(stateDir, 's1')).toBe(false)
  })
  it('reports an absent log as not deleted', async () => {
    const stateDir = await fresh()
    expect(await deleteNativeSessionLog(stateDir, 's1')).toBe(false)
  })
  it('rejects an unknown version on load', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    const path = nativeSessionLogPath(stateDir, 's1')
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = lines[0].replace('"v":1', '"v":2')
    await writeFile(path, lines.join('\n'))
    expect(() => loadNativeSessionLogSync(stateDir, 's1')).toThrow(/unsupported|version/i)
  })
})
