// server/providers/native/session-log/log.ts
//
// The append-only writer/loader for native session logs. A log is a JSONL file:
// one `session/header` line followed by `seq`-numbered events. Appends are
// buffered and flushed explicitly; `flush` writes and fsyncs through a single
// serialized chain so concurrent callers cannot interleave.
//
// A module-level registry owns one live writer per log path. Opening a new
// writer for the same path (resume, fork seed, fresh create) supersedes the
// previous one: its unflushed buffer is dropped and later appends stay in
// memory only, so a stale writer can never append after a newer one has taken
// over the file. The key is the fully resolved path, not the session id, so
// the same id under different state dirs cannot supersede across dirs.

import { mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { open as openFile, readFile, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
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
  return { header, events, path, completeBytes }
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

  private pending: string[] = []
  private handle: FileHandle | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | null = null
  private superseded = false
  private closed = false

  private constructor(header: NativeSessionHeader, events: NativeLogEvent[], path: string) {
    this.header = header
    this.events = events
    this.path = path
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
      if (statSync(path).size > snapshot.completeBytes) truncateSync(path, snapshot.completeBytes)
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

    const previous = writers.get(path)
    if (previous) previous.markSuperseded()
    const log = new NativeSessionLog(header, events, path)
    writers.set(path, log)
    return log
  }

  append(input: NativeEventInput): NativeLogEvent {
    const event = { ...input, seq: this.events.length } as NativeLogEvent
    this.events.push(event)
    // A superseded or closed writer must never buffer again: its file belongs
    // to another writer, or its own handle is about to be destroyed.
    if (!this.superseded && !this.closed) this.pending.push(serializeEvent(event) + '\n')
    return event
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
    // takeover that happened while an earlier flush ran must not let this
    // writer's stale buffer reach the file. A closed writer (that is not the
    // close's own final flush) leaves its pending buffer alone — the close
    // flush queued right behind this one writes it.
    if (this.superseded) {
      this.pending = []
      return
    }
    if (this.closed && !allowClosed) return
    if (this.pending.length === 0) return
    const chunk = this.pending.join('')
    this.pending = []
    const handle = await this.ensureHandle()
    if (this.superseded) return
    await handle.write(chunk)
    await handle.sync()
  }

  private async ensureHandle(): Promise<FileHandle> {
    this.handle ??= await openFile(this.path, 'a')
    return this.handle
  }

  private async doClose(): Promise<void> {
    this.closed = true
    await this.enqueueFlush(true)
    if (this.handle) {
      const handle = this.handle
      this.handle = null
      await handle.close()
    }
    if (writers.get(this.path) === this) writers.delete(this.path)
  }

  private markSuperseded(): void {
    this.superseded = true
    this.pending = []
  }
}