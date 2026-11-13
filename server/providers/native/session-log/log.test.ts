// log.test.ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSessionLog, deleteNativeSessionLog, hasNativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { NativeSessionStorageError } from './errors.js'
import { nativeSessionDir, nativeSessionLogPath, nativeSessionMigrationTempPath } from './paths.js'

const fsMigration = vi.hoisted(() => ({
  beforeRename: null as (() => void) | null,
  failRename: false,
  renameCompleted: false,
  appendOpenFailurePath: null as string | null,
  directorySyncFailurePath: null as string | null,
  closed: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises')
  return {
    ...actual,
    open: (async (path: string, flags: string, mode?: number) => {
      if (fsMigration.renameCompleted && fsMigration.appendOpenFailurePath === path && flags === 'a') {
        fsMigration.appendOpenFailurePath = null
        throw new Error('reopen after rename failed')
      }
      const handle = await actual.open(path, flags, mode)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              fsMigration.closed.push(String(path))
              return target.close()
            }
          }
          if (property === 'sync' && fsMigration.directorySyncFailurePath === String(path)) {
            return async () => { throw new Error('directory fsync failed') }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }) as typeof actual.open,
    rename: (async (oldPath: string, newPath: string) => {
      fsMigration.beforeRename?.()
      if (fsMigration.failRename) throw new Error('rename failed')
      await actual.rename(oldPath, newPath)
      fsMigration.renameCompleted = true
    }) as typeof actual.rename,
  }
})

// Hold the bytes a resume READ returns while the on-disk file keeps growing.
// This reproduces the same-id takeover race deterministically: the previous
// writer commits a complete line after the new writer's read but before it
// decides whether to truncate a torn tail.
const fsRead = vi.hoisted(() => ({ stale: null as Buffer | null }))
const fsTruncate = vi.hoisted(() => ({ calls: [] as Array<{ path: string; length: number }> }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs')
  return {
    ...actual,
    readFileSync: ((path: string) => fsRead.stale ?? actual.readFileSync(path)) as typeof actual.readFileSync,
    truncateSync: ((path: string, length: number) => {
      fsTruncate.calls.push({ path, length })
      actual.truncateSync(path, length)
    }) as typeof actual.truncateSync,
  }
})

let dir: string
const originalPlatform = process.platform
afterEach(async () => {
  fsMigration.beforeRename = null
  fsMigration.failRename = false
  fsMigration.renameCompleted = false
  fsMigration.appendOpenFailurePath = null
  fsMigration.directorySyncFailurePath = null
  fsMigration.closed = []
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'native-log-')); return dir }

const userEvent = (uuid: string) => ({ type: 'user' as const, uuid, session_id: 's1', parent_tool_use_id: null as null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] } })
const nativeAttachment = {
  id: 'upload-1',
  name: 'notes.txt',
  size: 123,
  digest: 'b'.repeat(64),
  path: '/registry/notes.txt',
  mediaType: 'text/plain',
  modelForm: 'handle' as const,
}
const nativeFileUser = {
  type: 'user' as const,
  uuid: 'file-user',
  session_id: 's1',
  parent_tool_use_id: null,
  timestamp: '2026-11-13T00:00:00.000Z',
  message: { role: 'user' as const, content: [{ type: 'file', attachment: nativeAttachment }] },
}

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
  it('appendDurable rolls back a partial selection and resequences later appends', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('committed'))
    await log.flush()
    log.append(userEvent('prior-pending'))
    const path = nativeSessionLogPath(stateDir, 's1')
    let selectionStartSize = 0
    let selectionWrites = 0
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        if (chunk.toString('utf8').includes('"type":"session/agent"')) {
          selectionWrites++
          if (selectionWrites === 1) selectionStartSize = (await stat(path)).size
          const bytes = chunk.subarray(offset, offset + Math.min(5, length))
          await writeFile(path, bytes, { flag: 'a' })
          if (selectionWrites === 1) return { bytesWritten: bytes.length, buffer: chunk }
          log.append({ type: 'turn/end', reason: 'completed' })
          throw new Error('partial selection write')
        }
        await writeFile(path, chunk.subarray(offset, offset + length), { flag: 'a' })
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    await expect(log.appendDurable({
      type: 'session/agent',
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })).rejects.toThrow('partial selection write')

    expect((await stat(path)).size).toBe(selectionStartSize)
    expect(log.events.map((event) => event.type)).toEqual(['user', 'user', 'turn/end'])
    expect(log.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(log.events.some((event) => event.type === 'session/agent')).toBe(false)

    await log.flush()
    const persisted = loadNativeSessionLogSync(stateDir, 's1')!
    expect(persisted.events.map((event) => event.type)).toEqual(['user', 'user', 'turn/end'])
    expect(persisted.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(persisted.events.some((event) => event.type === 'session/agent')).toBe(false)
    await log.close()
  })

  it('appendDurable preserves an ordinary append that lands during the initial baseline flush', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('pre-existing-pending'))
    const path = nativeSessionLogPath(stateDir, 's1')
    let injected = false
    let selectionWrites = 0
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        const bytes = chunk.subarray(offset, offset + length)
        const text = chunk.toString('utf8')
        if (!injected && text.includes('"uuid":"pre-existing-pending"') && !text.includes('"type":"session/agent"')) {
          injected = true
          // This lands AFTER the initial flush captured its chunk but BEFORE
          // that write resolves. Its bytes belong to a later queued flush.
          log.append(userEvent('ordinary-during-initial-flush'))
        }
        if (text.includes('"type":"session/agent"')) {
          selectionWrites++
          if (selectionWrites > 1) throw new Error('selection failed after initial-flush append')
          const partial = bytes.subarray(0, Math.min(5, bytes.length))
          await writeFile(path, partial, { flag: 'a' })
          return { bytesWritten: partial.length, buffer: chunk }
        }
        await writeFile(path, bytes, { flag: 'a' })
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    await expect(log.appendDurable({
      type: 'session/agent',
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })).rejects.toThrow('selection failed after initial-flush append')

    expect(log.events.map((event) => event.type)).toEqual(['user', 'user'])
    expect(log.events.map((event) => event.seq)).toEqual([0, 1])
    expect(log.events.map((event) => event.type === 'user' && event.uuid)).toEqual([
      'pre-existing-pending',
      'ordinary-during-initial-flush',
    ])
    expect(log.events.some((event) => event.type === 'session/agent')).toBe(false)

    await log.flush()
    const persisted = loadNativeSessionLogSync(stateDir, 's1')!
    expect(persisted.events.map((event) => event.seq)).toEqual([0, 1])
    expect(persisted.events.map((event) => event.type === 'user' && event.uuid)).toEqual([
      'pre-existing-pending',
      'ordinary-during-initial-flush',
    ])
    log.append(userEvent('after-rollback'))
    await log.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((event) => event.seq)).toEqual([0, 1, 2])
    await log.close()
  })

  it('appendDurable preserves an ordinary append that lands between preSize and reservation', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('committed'))
    await log.flush()
    const path = nativeSessionLogPath(stateDir, 's1')
    const originalAppend = log.append.bind(log)
    let injected = false
    log.append = (input) => {
      if (input.type === 'session/agent' && !injected) {
        injected = true
        originalAppend(userEvent('ordinary-before-reservation'))
      }
      return originalAppend(input)
    }
    let selectionWrites = 0
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        if (chunk.toString('utf8').includes('"type":"session/agent"')) {
          selectionWrites++
          const bytes = chunk.subarray(offset, offset + Math.min(5, length))
          await writeFile(path, bytes, { flag: 'a' })
          if (selectionWrites === 1) return { bytesWritten: bytes.length, buffer: chunk }
          originalAppend({ type: 'turn/end', reason: 'completed' })
          throw new Error('selection failed after ordinary append')
        }
        await writeFile(path, chunk.subarray(offset, offset + length), { flag: 'a' })
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    await expect(log.appendDurable({
      type: 'session/agent',
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })).rejects.toThrow('selection failed after ordinary append')
    expect(log.events.map((event) => event.type)).toEqual(['user', 'user', 'turn/end'])
    expect(log.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(log.events.some((event) => event.type === 'session/agent')).toBe(false)

    await log.flush()
    const persisted = loadNativeSessionLogSync(stateDir, 's1')!
    expect(persisted.events.map((event) => event.type)).toEqual(['user', 'user', 'turn/end'])
    expect(persisted.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(persisted.events[1]).toMatchObject({ type: 'user', uuid: 'ordinary-before-reservation' })
    await log.close()
  })

  it('appendDurable rejects takeover during reservation without truncating replacement events', async () => {
    const stateDir = await fresh()
    const original = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    original.append(userEvent('committed'))
    await original.flush()
    let replacement: NativeSessionLog | undefined
    const handle = {
      write: async (chunk: Buffer, _offset: number, length: number) => {
        if (chunk.toString('utf8').includes('"type":"session/agent"')) {
          replacement = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
          replacement.append({ type: 'turn/end', reason: 'completed' })
          await replacement.flush()
        }
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    ;(original as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    try {
      await expect(original.appendDurable({
        type: 'session/agent',
        name: null,
        base: { model: 'base-model', permissionMode: 'default' },
        timestamp: '2026-11-11T00:00:00.000Z',
      })).rejects.toThrow(/superseded/)
      expect(original.events.some((event) => event.type === 'session/agent')).toBe(false)
      const persisted = loadNativeSessionLogSync(stateDir, 's1')!
      expect(persisted.events.map((event) => event.type)).toEqual(['user', 'turn/end'])
      expect(persisted.events.map((event) => event.seq)).toEqual([0, 1])
    } finally {
      await original.close()
      if (replacement) await replacement.close()
    }
  })

  it('appendDurable close flush restores ordinary events after a partial selection write', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('committed'))
    await log.flush()
    const path = nativeSessionLogPath(stateDir, 's1')
    const bytesBeforeSelection = await readFile(path)
    let closePromise: Promise<void> | undefined
    let selectionWrites = 0
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        if (chunk.toString('utf8').includes('"type":"session/agent"')) {
          selectionWrites++
          if (selectionWrites === 1) {
            const bytes = chunk.subarray(offset, offset + Math.min(5, length))
            await writeFile(path, bytes, { flag: 'a' })
            return { bytesWritten: bytes.length, buffer: chunk }
          }
          log.append(userEvent('ordinary-during-close'))
          closePromise = log.close()
          throw new Error('partial selection write during close')
        }
        await writeFile(path, chunk.subarray(offset, offset + length), { flag: 'a' })
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    await expect(log.appendDurable({
      type: 'session/agent',
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })).rejects.toThrow('partial selection write during close')
    expect(closePromise).toBeDefined()
    await closePromise

    const ordinary = userEvent('ordinary-during-close')
    const expectedBytes = Buffer.concat([
      bytesBeforeSelection,
      Buffer.from(JSON.stringify({ ...ordinary, seq: 1 }) + '\n', 'utf8'),
    ])
    expect((await readFile(path)).equals(expectedBytes)).toBe(true)
    const persisted = loadNativeSessionLogSync(stateDir, 's1')!
    expect(persisted.events.map((event) => event.type)).toEqual(['user', 'user'])
    expect(persisted.events.map((event) => event.seq)).toEqual([0, 1])
    expect(persisted.events[1]).toMatchObject({ type: 'user', uuid: 'ordinary-during-close' })
  })

  it('appendDurable close flush restores ordinary events after selection sync failure', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('committed'))
    await log.flush()
    const path = nativeSessionLogPath(stateDir, 's1')
    const bytesBeforeSelection = await readFile(path)
    let closePromise: Promise<void> | undefined
    let syncCalls = 0
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        await writeFile(path, chunk.subarray(offset, offset + length), { flag: 'a' })
        if (chunk.toString('utf8').includes('"type":"session/agent"')) {
          log.append(userEvent('ordinary-during-close'))
          closePromise = log.close()
        }
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => {
        syncCalls++
        if (syncCalls === 1) throw new Error('selection sync failure during close')
      },
    }
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle

    await expect(log.appendDurable({
      type: 'session/agent',
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })).rejects.toThrow('selection sync failure during close')
    expect(closePromise).toBeDefined()
    await closePromise

    const ordinary = userEvent('ordinary-during-close')
    const expectedBytes = Buffer.concat([
      bytesBeforeSelection,
      Buffer.from(JSON.stringify({ ...ordinary, seq: 1 }) + '\n', 'utf8'),
    ])
    expect((await readFile(path)).equals(expectedBytes)).toBe(true)
    const persisted = loadNativeSessionLogSync(stateDir, 's1')!
    expect(persisted.events.map((event) => event.type)).toEqual(['user', 'user'])
    expect(persisted.events.map((event) => event.seq)).toEqual([0, 1])
    expect(persisted.events[1]).toMatchObject({ type: 'user', uuid: 'ordinary-during-close' })
  })

  it('appendDurable does not roll back a successful reservation when close races its flush', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('committed'))
    await log.flush()
    const path = nativeSessionLogPath(stateDir, 's1')
    let closePromise: Promise<void> | undefined
    let bytesAfterSelection: Buffer | undefined
    const handle = {
      write: async (chunk: Buffer, offset: number, length: number) => {
        await writeFile(path, chunk.subarray(offset, offset + length), { flag: 'a' })
        if (chunk.toString('utf8').includes('"type":"session/agent"')) {
          bytesAfterSelection = await readFile(path)
          log.append(userEvent('ordinary-during-close'))
          closePromise = log.close()
        }
        return { bytesWritten: length, buffer: chunk }
      },
      sync: async () => undefined,
    }
    ;(log as unknown as { ensureHandle: () => Promise<unknown> }).ensureHandle = async () => handle
    fsTruncate.calls.length = 0

    await expect(log.appendDurable({
      type: 'session/agent',
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })).rejects.toThrow(/closed/)
    expect(closePromise).toBeDefined()
    await closePromise

    expect(fsTruncate.calls).toEqual([])
    expect(bytesAfterSelection).toBeDefined()
    const ordinary = userEvent('ordinary-during-close')
    const expectedBytes = Buffer.concat([
      bytesAfterSelection!,
      Buffer.from(JSON.stringify({ ...ordinary, seq: 2 }) + '\n', 'utf8'),
    ])
    expect((await readFile(path)).equals(expectedBytes)).toBe(true)
    const persisted = loadNativeSessionLogSync(stateDir, 's1')!
    expect(persisted.events.map((event) => event.type)).toEqual(['user', 'session/agent', 'user'])
    expect(persisted.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(persisted.events[2]).toMatchObject({ type: 'user', uuid: 'ordinary-during-close' })
  })

  it('appendDurable refuses closed and superseded writers without reserving an event', async () => {
    const stateDir = await fresh()
    const original = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    const replacement = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    const selection = {
      type: 'session/agent' as const,
      name: null,
      base: { model: 'base-model', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    }
    await expect(original.appendDurable(selection)).rejects.toThrow(/superseded/)
    expect(original.events).toHaveLength(0)

    replacement.append({ type: 'turn/end', reason: 'completed' })
    await replacement.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((event) => event.seq)).toEqual([0])
    await replacement.close()
    await expect(replacement.appendDurable(selection)).rejects.toThrow(/closed/)
    expect(replacement.events.map((event) => event.type)).toEqual(['turn/end'])
    await original.close()
  })

  it('migrates a drained v1 log to v2 and persists structured attachments and their catalog', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('before-migration'))
    await log.flush()
    expect(log.header.v).toBe(1)

    await log.migrateToV2()
    log.append(nativeFileUser)
    log.append({ type: 'session/attachments', attachments: [nativeAttachment], timestamp: '2026-11-13T00:00:01.000Z' })
    await log.flush()
    await log.close()

    const snapshot = loadNativeSessionLogSync(stateDir, 's1')!
    expect(snapshot.header.v).toBe(2)
    expect(snapshot.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(snapshot.events[1]).toMatchObject({ uuid: 'file-user', message: { content: [{ type: 'file', attachment: nativeAttachment }] } })
    expect(snapshot.events[2]).toMatchObject({ type: 'session/attachments', attachments: [nativeAttachment] })
  })

  it('closes both the live writer and temp file before rename', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    await log.flush()
    const path = nativeSessionLogPath(stateDir, 's1')
    const temp = nativeSessionMigrationTempPath(stateDir, 's1')
    fsMigration.beforeRename = () => {
      expect(fsMigration.closed).toContain(path)
      expect(fsMigration.closed).toContain(temp)
    }

    await log.migrateToV2()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.header.v).toBe(2)
    await log.close()
  })

  it('reopens v1 and accepts later durable turns when rename fails', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    await log.flush()
    fsMigration.failRename = true

    await expect(log.migrateToV2()).rejects.toThrow('rename failed')
    fsMigration.failRename = false
    expect(log.header.v).toBe(1)
    expect(loadNativeSessionLogSync(stateDir, 's1')!.header.v).toBe(1)
    await log.appendDurable({ type: 'turn/end', reason: 'completed' })
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((event) => event.type)).toEqual(['user', 'turn/end'])
    await log.close()
  })

  it('closes the live session after a post-rename directory fsync failure', async () => {
    const stateDir = await fresh()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    await log.flush()
    fsMigration.directorySyncFailurePath = nativeSessionDir(stateDir, 's1')

    await expect(log.migrateToV2()).rejects.toThrow('directory fsync failed')
    expect(loadNativeSessionLogSync(stateDir, 's1')!.header.v).toBe(2)
    await expect(log.appendDurable({ type: 'turn/end', reason: 'completed' })).rejects.toThrow(/closed/)
    expect(() => log.append(userEvent('must-not-be-accepted'))).toThrow(/closed/)
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events).toHaveLength(1)
    await log.close()
  })

  it('closes the live session after a post-rename reopen failure', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    await log.flush()
    fsMigration.appendOpenFailurePath = nativeSessionLogPath(stateDir, 's1')

    await expect(log.migrateToV2()).rejects.toThrow('reopen after rename failed')
    expect(loadNativeSessionLogSync(stateDir, 's1')!.header.v).toBe(2)
    await expect(log.appendDurable({ type: 'turn/end', reason: 'completed' })).rejects.toThrow(/closed/)
    expect(() => log.append(userEvent('must-not-be-accepted'))).toThrow(/closed/)
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
    lines[0] = lines[0].replace('"v":1', '"v":3')
    await writeFile(path, lines.join('\n'))
    expect(() => loadNativeSessionLogSync(stateDir, 's1')).toThrow(/unsupported|version/i)
  })
})
