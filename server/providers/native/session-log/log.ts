// server/providers/native/session-log/log.ts
//
// The append-only writer/loader for native session logs. A log is a JSONL file:
// one `session/header` line followed by `seq`-numbered events. Appends are
// buffered and flushed explicitly; `flush` writes and fsyncs through a single
// serialized chain so concurrent callers cannot interleave.
//
// A module-level registry owns one live writer per resolved log path. Opening
// a new writer for the same path (resume, fork seed, fresh create) supersedes
// the previous one: its unflushed buffer is dropped and later appends stay in
// memory only, so a stale writer cannot append after a newer one has taken
// over. The registry key goes through `resolve()` so different spellings of
// the same directory share it; the same session id under different state dirs
// never does.
//
// Residual takeover window: a write that was already submitted when takeover
// happened can still land. The new writer loads the file before that write
// completes, so that one chunk is not visible to it on load. It is left in
// place rather than truncated: a resume only truncates a torn tail its own
// read observed, so a complete line committed by the previous writer survives
// (dropping it would be silent data loss).

import { mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { open as openFile, readFile, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NativeSessionStorageError } from './errors.js'
import {
  NATIVE_SESSION_LOG_VERSION,
  parseEventLine,
  parseHeaderLine,
  serializeEvent,
  serializeHeader,
} from './format.js'
import type { NativeEventInput, NativeLogEvent, NativeSessionHeader } from './format.js'
import { nativeSessionDir, nativeSessionLogPath } from './paths.js'

export interface NativeSessionLogSnapshot {
  header: NativeSessionHeader
  events: NativeLogEvent[]
  path: string
  /** Byte offset just past the last complete line; a torn tail starts here. */
  completeBytes: number
  /** Total bytes read into this snapshot (the whole file at read time).
   *  `totalBytes > completeBytes` means the read ended in a torn tail; the
   *  truncation decision compares these two values from the SAME read so a
   *  line another writer commits after the read is never truncated. */
  totalBytes: number
}

export interface NativeSeed {
  events: NativeLogEvent[]
  inheritedEventCount: number
  isSeeded: boolean
}

export interface OpenNativeSessionLogOptions {
  stateDir: string
  id: string
  cwd: string
  resume: boolean
  seed?: NativeSeed
}

const writers = new Map<string, NativeSessionLog>()

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

function corrupt(sessionId: string, path: string, message: string): never {
  throw new NativeSessionStorageError('corrupt', message, sessionId, path)
}

function parseLine(line: string, lineNo: number, sessionId: string, path: string): unknown {
  try {
    return JSON.parse(line)
  } catch (err) {
    corrupt(sessionId, path, `invalid JSON on line ${lineNo}: ${(err as Error).message}`)
  }
}

function parseLogBuffer(buffer: Buffer, sessionId: string, path: string): NativeSessionLogSnapshot {
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline < 0) corrupt(sessionId, path, 'session log has no complete header line')
  const completeBytes = lastNewline + 1
  const lines = buffer.subarray(0, completeBytes).toString('utf8').split('\n')
  lines.pop() // the committed region ends with '\n', so split leaves a trailing ''

  const header = parseHeaderLine(parseLine(lines[0], 1, sessionId, path), sessionId, path)
  const events = lines
    .slice(1)
    .map((line, index) =>
      parseEventLine(parseLine(line, index + 2, sessionId, path), index, sessionId, path),
    )
  return { header, events, path, completeBytes, totalBytes: buffer.length }
}

function serializeLog(header: NativeSessionHeader, events: NativeLogEvent[]): string {
  return serializeHeader(header) + '\n' + events.map((event) => serializeEvent(event) + '\n').join('')
}

export function loadNativeSessionLogSync(
  stateDir: string,
  id: string,
): NativeSessionLogSnapshot | null {
  const path = nativeSessionLogPath(stateDir, id)
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  return parseLogBuffer(buffer, id, path)
}

export async function loadNativeSessionLog(
  stateDir: string,
  id: string,
): Promise<NativeSessionLogSnapshot | null> {
  const path = nativeSessionLogPath(stateDir, id)
  let buffer: Buffer
  try {
    buffer = await readFile(path)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  return parseLogBuffer(buffer, id, path)
}

export async function hasNativeSessionLog(stateDir: string, id: string): Promise<boolean> {
  try {
    await stat(nativeSessionLogPath(stateDir, id))
    return true
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

export async function deleteNativeSessionLog(stateDir: string, id: string): Promise<boolean> {
  const directory = nativeSessionDir(stateDir, id)
  let existed = true
  try {
    await stat(directory)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) existed = false
    else throw err
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return existed
}

export class NativeSessionLog {
  readonly header: NativeSessionHeader
  readonly events: NativeLogEvent[]
  readonly path: string

  private readonly registryKey: string
  // Buffered as raw UTF-8 bytes, not strings: a write that fails mid-codepoint
// must be re-buffered byte-for-byte, and decoding a split sequence would
// replace it with U+FFFD.
  private pending: Buffer[] = []
  private handle: FileHandle | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | null = null
  private superseded = false
  private closed = false

  private constructor(
    header: NativeSessionHeader,
    events: NativeLogEvent[],
    path: string,
    registryKey: string,
  ) {
    this.header = header
    this.events = events
    this.path = path
    this.registryKey = registryKey
  }

  static open(opts: OpenNativeSessionLogOptions): NativeSessionLog {
    const { stateDir, id, cwd, resume, seed } = opts
    const path = nativeSessionLogPath(stateDir, id)

    let header: NativeSessionHeader
    let events: NativeLogEvent[]

    if (resume) {
      const snapshot = loadNativeSessionLogSync(stateDir, id)
      if (!snapshot) {
        throw new NativeSessionStorageError(
          'missing',
          `no session log to resume at ${path}`,
          id,
          path,
        )
      }
      // Only a torn tail this read actually saw is truncated. Re-stating the
      // file here would race the previous writer: in the same-id takeover
      // `spawn()` performs, it can flush a COMPLETE line between the read and
      // the stat, and truncating to `completeBytes` would silently destroy it.
      if (snapshot.totalBytes > snapshot.completeBytes) truncateSync(path, snapshot.completeBytes)
      header = snapshot.header
      events = snapshot.events
    } else {
      mkdirSync(nativeSessionDir(stateDir, id), { recursive: true })
      header = {
        type: 'session/header',
        v: NATIVE_SESSION_LOG_VERSION,
        id,
        cwd,
        createdAt: Date.now(),
        isSeeded: seed?.isSeeded ?? false,
        inheritedEventCount: seed?.inheritedEventCount ?? 0,
      }
      events = seed ? [...seed.events] : []
      try {
        writeFileSync(path, serializeLog(header, events), { flag: 'wx' })
      } catch (err) {
        if (isErrno(err, 'EEXIST')) {
          throw new NativeSessionStorageError(
            'exists',
            `session log already exists at ${path}`,
            id,
            path,
          )
        }
        throw err
      }
    }

    const registryKey = resolve(path)
    const previous = writers.get(registryKey)
    if (previous) previous.markSuperseded()
    const log = new NativeSessionLog(header, events, path, registryKey)
    writers.set(registryKey, log)
    return log
  }

  append(input: NativeEventInput): NativeLogEvent {
    const event = { ...input, seq: this.events.length } as NativeLogEvent
    this.events.push(event)
    // A superseded or closed writer must never buffer again: its file belongs
    // to another writer, or its own handle is about to be destroyed.
    if (!this.superseded && !this.closed) this.pending.push(Buffer.from(serializeEvent(event) + '\n', 'utf8'))
    return event
  }

  /** Append one control event as an atomic durable reservation. Ordinary
   *  append/flush keeps its crash-recovery semantics; this stricter path is for
   *  selections that must not become visible in memory OR replay after a
   *  genuine write failure. Every non-rejected event appended after the prior
   *  flush is preserved with a fresh contiguous seq on rollback. */
  async appendDurable(input: NativeEventInput): Promise<NativeLogEvent> {
    await this.flush()
    this.assertDurableWriterActive()
    const preEventCount = this.events.length
    const preSize = (await stat(this.path)).size
    this.assertDurableWriterActive()
    let reservation: NativeLogEvent | undefined
    let flushSucceeded = false
    try {
      reservation = this.append(input)
      await this.flush()
      flushSucceeded = true
      // writePending deliberately no-ops after takeover/close. A resolved flush
      // is durable only while this writer still owns the path.
      this.assertDurableWriterActive()
      return reservation
    } catch (err) {
      // A close observed after a successful flush is not a write failure. Its
      // allowClosed flush still owns the ordinary pending bytes.
      if (flushSucceeded && this.closed && !this.superseded) throw err
      const appended = this.events.splice(preEventCount)
      this.pending = []
      // A replacement writer may already have committed newer events. Never
      // truncate its file; only discard this stale writer's uncommitted state.
      if (this.superseded) throw err
      try {
        truncateSync(this.path, preSize)
        for (const event of appended) {
          if (event === reservation) continue
          this.restoreAfterDurableRollback(event)
        }
      } catch (rollbackErr) {
        throw new AggregateError([err, rollbackErr], `failed to roll back durable append: ${this.path}`)
      }
      throw err
    }
  }

  private restoreAfterDurableRollback(event: NativeLogEvent): void {
    const { seq: _seq, ...rest } = event
    const restored = { ...rest, seq: this.events.length } as NativeLogEvent
    this.events.push(restored)
    // Restoration belongs to the durable operation, not the public append
    // contract. A racing close disables new public buffering, but its queued
    // allowClosed flush still owns these restored bytes.
    this.pending.push(Buffer.from(serializeEvent(restored) + '\n', 'utf8'))
  }

  private assertDurableWriterActive(): void {
    if (this.superseded) throw new Error(`session log writer is superseded: ${this.path}`)
    if (this.closed) throw new Error(`session log writer is closed: ${this.path}`)
  }

  flush(): Promise<void> {
    return this.enqueueFlush(false)
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose()
    return this.closePromise
  }

  private enqueueFlush(allowClosed: boolean): Promise<void> {
    const run = this.flushChain.then(() => this.writePending(allowClosed))
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async writePending(allowClosed: boolean): Promise<void> {
    // Re-checked after this flush acquired its slot in the write chain: a
    // takeover or close that happened while an earlier flush ran must not let
    // this writer capture its buffer for writing. This cannot cover a write
    // that was already submitted when takeover happened; that chunk can still
    // land (see the module header).
    if (this.superseded) {
      this.pending = []
      return
    }
    if (this.closed && !allowClosed) return
    if (this.pending.length === 0) return
    // Open before taking the buffer: a rejected `open` must leave the pending
    // lines in place so a retried flush can still write them.
    const handle = await this.ensureHandle()
    if (this.superseded) return
    const chunk = Buffer.concat(this.pending)
    this.pending = []
    let offset = 0
    try {
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
        if (bytesWritten === 0) throw new Error(`session log write made no progress: ${this.path}`)
        offset += bytesWritten
      }
    } catch (err) {
      // The events are already in `events`, so a later append's `seq` counts
      // them. Re-buffer exactly the bytes that did not reach the file: drop
      // them and the on-disk chain develops a seq gap, which the next load
      // rejects as corrupt. A `sync` failure is NOT re-buffered — those bytes
      // were written, and replaying them would duplicate lines.
      const unwritten = chunk.subarray(offset)
      if (unwritten.length > 0) this.pending.unshift(unwritten)
      throw err
    }
    await handle.sync()
  }

  private async ensureHandle(): Promise<FileHandle> {
    this.handle ??= await openFile(this.path, 'a')
    return this.handle
  }

  private async doClose(): Promise<void> {
    this.closed = true
    try {
      await this.enqueueFlush(true)
    } finally {
      if (this.handle) {
        const handle = this.handle
        this.handle = null
        await handle.close()
      }
      if (writers.get(this.registryKey) === this) writers.delete(this.registryKey)
    }
  }

  private markSuperseded(): void {
    this.superseded = true
    this.pending = []
  }
}
