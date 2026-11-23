// server/providers/native/session-log/log.ts
//
// The append-only writer/loader for native session logs. A log is a JSONL file:
// one `session/header` line followed by `seq`-numbered events. Appends are
// buffered and flushed explicitly; flushes, durable reservations/rollbacks,
// and migration all pass through one serialized writer-operation queue so
// concurrent callers cannot interleave file mutations.
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
import { open as openFile, readFile, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createLogger } from '../../../log.js'
import { NativeSessionStorageError } from './errors.js'
import {
  NATIVE_SESSION_LOG_VERSION,
  NATIVE_SESSION_LOG_V2,
  NATIVE_SESSION_LOG_V3,
  parseEventLine,
  parseEventLineV3,
  projectNeutralEventToLegacy,
  parseHeaderLine,
  serializeEvent,
  serializeHeader,
} from './format.js'
import type { NativeEventInput, NativeLogEvent, NativeSessionHeader } from './format.js'
import type { NativeSessionEvent, SessionEvent, SessionEventMap } from '../vocabulary/session-event.js'
import { migrateEventToV3 } from './migration.js'
import { nativeSessionDir, nativeSessionLogPath, nativeSessionMigrationTempPath } from './paths.js'

const logger = createLogger('native-session-log')

/** A neutral v3 event input: the durable event minus its log-assigned seq.
 *  Mapped key-by-key so `type` and `data` stay correlated (mirrors
 *  NativeEventInput for the legacy union). */
export type NativeNeutralEventInput = {
  [T in keyof SessionEventMap]: Omit<SessionEvent<T>, 'seq'>
}[keyof SessionEventMap]

export interface NativeSessionLogSnapshot {
  header: NativeSessionHeader
  events: NativeLogEvent[]
  /** Canonical neutral events for a v3 log (undefined for v1/v2). `events`
   *  remains the legacy read view read-side consumers use (attachment index,
   *  PDF budgets, usage restore); the core WRITE path is neutral-only. */
  neutralEvents?: NativeSessionEvent[]
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
  /** A fork seed carries NEUTRAL events (always v3 — a legacy source is
   *  migrated in memory by buildForkSeed). Fresh seeds and the writer's v1/v2
   *  compat contract may carry legacy events; `open` normalizes legacy entries
   *  to neutral for a v3 log. */
  events: Array<NativeLogEvent | NativeSessionEvent>
  inheritedEventCount: number
  isSeeded: boolean
  /** Explicit seed version for the writer's v1/v2 compat contract; fork seeds
   *  are v3. Absent defaults to v3. */
  version?: number
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

function eventRequiresV2(event: NativeEventInput | NativeLogEvent): boolean {
  if (event.type === 'session/attachments') return true
  if (event.type !== 'user') return false
  const containsFile = (content: unknown[]): boolean => content.some((block) => {
    if (typeof block !== 'object' || block === null) return false
    const candidate = block as { type?: unknown; content?: unknown }
    if (candidate.type === 'file') return true
    return candidate.type === 'tool_result' && Array.isArray(candidate.content) && containsFile(candidate.content)
  })
  return containsFile(event.message.content)
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
  if (header.v === NATIVE_SESSION_LOG_V3) {
    const neutralEvents = lines
      .slice(1)
      .map((line, index) =>
        parseEventLineV3(parseLine(line, index + 2, sessionId, path), index, sessionId, path),
      )
    const events = neutralEvents.map((event) => projectNeutralEventToLegacy(event, sessionId))
    return { header, events, neutralEvents, path, completeBytes, totalBytes: buffer.length }
  }
  const events = lines
    .slice(1)
    .map((line, index) =>
      parseEventLine(parseLine(line, index + 2, sessionId, path), index, sessionId, path, header.v),
    )
  return { header, events, path, completeBytes, totalBytes: buffer.length }
}

function serializeLog(
  header: NativeSessionHeader,
  events: NativeLogEvent[],
  neutralEvents: NativeSessionEvent[] | null,
): string {
  const list: Array<NativeLogEvent | NativeSessionEvent> =
    header.v === NATIVE_SESSION_LOG_V3 ? (neutralEvents ?? []) : events
  return serializeHeader(header) + '\n' + list.map((event) => serializeEvent(event) + '\n').join('')
}

async function writeAll(handle: FileHandle, chunk: Buffer, path: string): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
    if (bytesWritten === 0) throw new Error(`session log write made no progress: ${path}`)
    offset += bytesWritten
  }
}

async function syncDirectory(stateDir: string, id: string): Promise<void> {
  // NTFS metadata journaling owns directory-entry durability; Windows refuses
  // fsync on a directory handle. This is the same explicit exception used by
  // the attachment object store.
  if (process.platform === 'win32') return
  const handle = await openFile(nativeSessionDir(stateDir, id), 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
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
  /** The legacy v1/v2 event view. For a v3 log this is the projection of
   *  `neutralEvents` (read-side consumers read it); for v1/v2 it is the
   *  canonical event list. The core WRITE path appends neutral events only. */
  readonly events: NativeLogEvent[]
  /** Canonical neutral events for a v3 log; null for v1/v2. Reassigned by the
   *  eager-at-open v3 migration (a v1/v2 writer upgrades to a neutral baseline). */
  neutralEvents: NativeSessionEvent[] | null
  readonly path: string

  private readonly registryKey: string
  // Buffered as raw UTF-8 bytes, not strings: a write that fails mid-codepoint
// must be re-buffered byte-for-byte, and decoding a split sequence would
// replace it with U+FFFD.
  private pending: Buffer[] = []
  private handle: FileHandle | null = null
  private operationChain: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | null = null
  private migrationPromise: Promise<void> | null = null
  /** Events accepted after the migration gate are buffered separately, so the
   *  pre-gate drain cannot accidentally write them into the v1 source. */
  private migrationAppends: NativeLogEvent[] | null = null
  /** Canonical NEUTRAL form of the post-gate appends, buffered in lockstep with
   *  `migrationAppends` for a v3-target migration so v3-only facts (packed stream
   *  records, tool error/meta, interrupted) are not lost through the legacy
   *  compat projection. Null for a v2-target migration (legacy bytes suffice). */
  private migrationNeutralAppends: NativeSessionEvent[] | null = null
  /** The version the in-flight migration upgrades to (2 or 3); null when no
   *  migration gate is installed. While a v3 gate is active the writer is still
   *  v1/v2 on disk, but appends canonicalize to neutral so the post-rename
   *  release writes v3 bytes. */
  private migrationTargetVersion: number | null = null
  private migrationFatal: unknown = null
  private superseded = false
  private closed = false

  private constructor(
    header: NativeSessionHeader,
    events: NativeLogEvent[],
    neutralEvents: NativeSessionEvent[] | null,
    path: string,
    private readonly stateDir: string,
    registryKey: string,
  ) {
    this.header = header
    this.events = events
    this.neutralEvents = neutralEvents
    this.path = path
    this.registryKey = registryKey
  }

  static open(opts: OpenNativeSessionLogOptions): NativeSessionLog {
    const { stateDir, id, cwd, resume, seed } = opts
    const path = nativeSessionLogPath(stateDir, id)

    let header: NativeSessionHeader
    let events: NativeLogEvent[]
    let neutralEvents: NativeSessionEvent[] | null

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
      neutralEvents = snapshot.neutralEvents ?? null
      // Eager-at-open migration (R7): a resumed v1/v2 log upgrades to neutral v3
      // before the first durable append. The gate installs synchronously inside
      // migrateToV3 (below, after the writer is registered); post-gate appends
      // buffer behind it. A fork seed is already neutral v3 (a legacy source is
      // migrated in memory); an explicit legacy seed version is the writer's
      // v1/v2 compat contract (see the else branch).
    } else {
      mkdirSync(nativeSessionDir(stateDir, id), { recursive: true })
      header = {
        type: 'session/header',
        // Fresh seeds and fork seeds default to the neutral v3 format
        // (buildForkSeed migrates a legacy source in memory). An explicit legacy
        // `version` is the writer's v1/v2 compat contract.
        v: seed?.version ?? NATIVE_SESSION_LOG_V3,
        id,
        cwd,
        createdAt: Date.now(),
        isSeeded: seed?.isSeeded ?? false,
        inheritedEventCount: seed?.inheritedEventCount ?? 0,
      }
      if (header.v === NATIVE_SESSION_LOG_V3) {
        // A v3 seed may carry neutral events (a fork seed) or legacy events
        // (openFreshLog's context, the writer's legacy-seed compat); normalize
        // every entry to neutral, renumbering seq to the seed order.
        neutralEvents = (seed ? seed.events : []).map((event, index) =>
          'data' in event
            ? { ...event, seq: index } as NativeSessionEvent
            : migrateEventToV3({ ...event, seq: index } as NativeLogEvent),
        )
        events = neutralEvents.map((event) => projectNeutralEventToLegacy(event, id))
      } else {
        neutralEvents = null
        events = (seed ? [...seed.events] : []) as NativeLogEvent[]
      }
      try {
        writeFileSync(path, serializeLog(header, events, neutralEvents), { flag: 'wx' })
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
    const log = new NativeSessionLog(header, events, neutralEvents, path, stateDir, registryKey)
    writers.set(registryKey, log)
    // Eager-at-open migration (R7): a RESUMED v1/v2 log upgrades to neutral v3
    // before the first durable append (a v3 writer cannot append neutral events
    // to an unmigrated legacy log). The gate installs synchronously inside
    // migrateToV3; post-gate appends buffer behind it. A failure closes the
    // writer (migrationFatal) and surfaces on the next append/flush — the
    // durable-retry pause owns recovery — so the eager promise is caught here
    // only to avoid an unhandled rejection. A fork seed is already neutral v3;
    // only a resumed legacy log needs this upgrade.
    if (resume && log.header.v < NATIVE_SESSION_LOG_V3) {
      void log.migrateToV3().catch((err) => {
        logger.error(`[${id}] eager v1/v2→v3 migration failed:`, err)
      })
    }
    return log
  }

  append(input: NativeEventInput | NativeNeutralEventInput): NativeLogEvent {
    if (this.migrationFatal) {
      throw new Error(`session log writer is closed after a failed migration: ${this.path}`, { cause: this.migrationFatal })
    }
    const seq = this.events.length
    // Neutral v3 inputs carry a `data` envelope; legacy v1/v2 inputs never do.
    const isNeutral = 'data' in input
    // A v3 log — or a v1/v2 log with an in-flight v3 migration gate —
    // canonicalizes every append to neutral. The core write path appends
    // NEUTRAL v3 events only (option C; pinned by vocabulary/neutrality.test.ts).
    // A legacy input is still migrated losslessly rather than rejected: that
    // write-compat serves the writer's own v1/v2 contract (log.test.ts) and
    // legacy seeds, never the core. A neutral input is stored verbatim (its
    // v3-only facts preserved).
    const targetV3 = this.header.v === NATIVE_SESSION_LOG_V3 || this.migrationTargetVersion === NATIVE_SESSION_LOG_V3
    let legacy: NativeLogEvent
    let neutral: NativeSessionEvent | null = null
    if (targetV3) {
      neutral = isNeutral
        ? { ...input, seq } as NativeSessionEvent
        : migrateEventToV3({ ...input, seq } as NativeLogEvent)
      // A legacy input's exact shape is the lossless read view; a neutral input
      // projects to legacy (v3-only facts drop from the VIEW only — the canonical
      // neutral above keeps them).
      legacy = isNeutral ? projectNeutralEventToLegacy(neutral, this.header.id) : { ...input, seq } as NativeLogEvent
    } else if (isNeutral) {
      // A neutral append into a v1/v2 log with no v3 gate: project to the legacy
      // shape (version compat lives here, not in the core). v3-only facts drop.
      legacy = projectNeutralEventToLegacy({ ...input, seq } as NativeSessionEvent, this.header.id)
    } else {
      legacy = { ...input, seq } as NativeLogEvent
    }
    this.events.push(legacy)
    if (this.neutralEvents && neutral) this.neutralEvents.push(neutral)
    // A superseded or closed writer must never buffer again: its file belongs
    // to another writer, or its own handle is about to be destroyed.
    if (!this.superseded && !this.closed) {
      if (this.migrationAppends) {
        this.migrationAppends.push(legacy)
        if (this.migrationNeutralAppends) this.migrationNeutralAppends.push(neutral!)
      } else {
        this.bufferEvent(legacy, neutral)
      }
    }
    return legacy
  }

  /** Buffer one event's serialized bytes: neutral for a v3 log, legacy for
   *  v1/v2. The on-disk format follows the header version, never the input. */
  private bufferEvent(legacy: NativeLogEvent, neutral: NativeSessionEvent | null): void {
    const event = this.header.v === NATIVE_SESSION_LOG_V3 ? neutral! : legacy
    this.pending.push(Buffer.from(serializeEvent(event) + '\n', 'utf8'))
  }

  /** Atomically upgrade this writer's v1 log in place. The gate is installed
   *  synchronously, before the first await, so later flushes and durable
   *  appends queue behind the whole copy/fsync/rename/reopen sequence. */
  migrateToV2(): Promise<void> {
    if (this.migrationPromise) return this.migrationPromise
    this.assertDurableWriterActive()
    // Already v2 or v3: nothing to upgrade. A v3 migration in flight supersedes
    // any v2 upgrade (the log is heading straight to neutral).
    if (this.header.v >= NATIVE_SESSION_LOG_V2 || this.migrationTargetVersion === NATIVE_SESSION_LOG_V3) {
      return Promise.resolve()
    }
    this.migrationAppends = []
    this.migrationTargetVersion = NATIVE_SESSION_LOG_V2
    const run = this.enqueueWriterOperation(() => this.performMigration())
    const tracked = run.finally(() => {
      // A pre-rename failure leaves a live v1 writer that may retry. A fatal
      // post-rename failure stays closed and can never be retried on this object.
      if (!this.closed && this.header.v === NATIVE_SESSION_LOG_VERSION) this.migrationPromise = null
    })
    this.migrationPromise = tracked
    return tracked
  }

  /** Atomically upgrade this writer's v1/v2 log to the neutral v3 format,
   *  rewriting EVERY event (not header-only). Eager-at-open (R7): `open`
   *  triggers this before the writer is returned, so the first durable append
   *  lands on a v3 baseline. Idempotent (a v3 log no-ops). Reuses migrateToV2's
   *  safety — the gate is installed synchronously before the first await, and
   *  the copy/fsync/rename/re-parse/cache-invalidate sequence runs behind the
   *  serialized writer-operation queue. Post-gate appends canonicalize to
   *  neutral (see `append`) and are released as v3 bytes after the rename. */
  migrateToV3(): Promise<void> {
    if (this.migrationPromise) return this.migrationPromise
    this.assertDurableWriterActive()
    if (this.header.v >= NATIVE_SESSION_LOG_V3) return Promise.resolve()
    this.migrationAppends = []
    this.migrationNeutralAppends = []
    this.migrationTargetVersion = NATIVE_SESSION_LOG_V3
    const run = this.enqueueWriterOperation(() => this.performMigrationV3())
    const tracked = run.finally(() => {
      // A pre-rename failure leaves a live v1/v2 writer that may retry. A fatal
      // post-rename failure stays closed and can never be retried on this object.
      if (!this.closed && this.header.v < NATIVE_SESSION_LOG_V3) this.migrationPromise = null
    })
    this.migrationPromise = tracked
    return tracked
  }

  private async performMigrationV3(): Promise<void> {
    const queued = this.migrationAppends
    const queuedNeutral = this.migrationNeutralAppends
    if (!queued || !queuedNeutral) throw new Error('v3 migration gate is not installed')
    const temp = nativeSessionMigrationTempPath(this.stateDir, this.header.id)
    let renamed = false
    try {
      // Flush every pre-gate event (legacy bytes) before rewriting the file.
      while (this.pending.length > 0) await this.writePending(false)
      this.assertDurableWriterActive()
      await this.closeHandle()

      // Rewrite EVERY event into the neutral v3 language. The source snapshot is
      // re-read and parsed with its own version validator, then each legacy
      // event is migrated losslessly (uuid/seq/parent/usage/signatures preserved).
      const original = await readFile(this.path)
      const snapshot = parseLogBuffer(original, this.header.id, this.path)
      const neutralEvents = snapshot.events.map((event) => migrateEventToV3(event))
      const migrated = Buffer.from(
        serializeHeader({ ...snapshot.header, v: NATIVE_SESSION_LOG_V3 }) + '\n' +
        neutralEvents.map((event) => serializeEvent(event) + '\n').join(''),
        'utf8',
      )
      const tempHandle = await openFile(temp, 'w')
      try {
        await writeAll(tempHandle, migrated, temp)
        await tempHandle.sync()
      } finally {
        await tempHandle.close()
      }
      this.assertDurableWriterActive()
      await rename(temp, this.path)
      renamed = true
      this.header.v = NATIVE_SESSION_LOG_V3
      await syncDirectory(this.stateDir, this.header.id)

      // Re-read the replacement with the v3 parser before accepting any queued
      // append: proves the on-disk seq chain and establishes the neutral baseline.
      const reloaded = await loadNativeSessionLog(this.stateDir, this.header.id)
      if (!reloaded || reloaded.header.v !== NATIVE_SESSION_LOG_V3 || !reloaded.neutralEvents) {
        throw new Error(`migrated session log did not reload as v3: ${this.path}`)
      }
      this.handle = await openFile(this.path, 'a')
      this.neutralEvents = reloaded.neutralEvents
      this.events.splice(0, this.events.length, ...reloaded.events, ...queued)
      const { nativeHistoryCache } = await import('./cache.js')
      nativeHistoryCache.invalidate(this.header.id)
      this.releaseMigrationAppends(queued)
    } catch (err) {
      if (this.superseded) {
        this.migrationAppends = null
        this.migrationNeutralAppends = null
        this.migrationTargetVersion = null
        throw err
      }
      if (!renamed) {
        // The source is still v1/v2. Reopen it at its original version and
        // release the queued appends as legacy bytes (a neutral append's v3-only
        // facts degrade to the compat projection — the status quo ante a failed
        // migration). If even the reopen fails, the writer closes rather than
        // pretending to be live.
        try {
          await this.closeHandle()
          this.handle = await openFile(this.path, 'a')
          this.migrationTargetVersion = null
          this.migrationNeutralAppends = null
          this.releaseMigrationAppends(queued)
        } catch (reopenErr) {
          await this.failMigration(err)
          throw new AggregateError([err, reopenErr], `failed to reopen v1/v2 session log: ${this.path}`)
        }
        try {
          await rm(temp, { force: true })
        } catch (cleanupErr) {
          throw new AggregateError([err, cleanupErr], `failed to clean migration temp: ${temp}`)
        }
      } else {
        // The replacement already happened. Never roll it back; close rather
        // than acknowledge another turn while durability/reopen state is unknown.
        await this.failMigration(err)
      }
      throw err
    }
  }

  private async performMigration(): Promise<void> {
    const queued = this.migrationAppends
    if (!queued) throw new Error('migration gate is not installed')
    const temp = nativeSessionMigrationTempPath(this.stateDir, this.header.id)
    let renamed = false
    try {
      // Flush every event accepted before the gate. Post-gate appends live in
      // `queued`, not `pending`, and therefore cannot leak into the v1 copy.
      while (this.pending.length > 0) await this.writePending(false)
      this.assertDurableWriterActive()
      await this.closeHandle()

      // Preserve every source byte after the header, including event ordering
      // and serialization. Only header.v changes.
      const original = await readFile(this.path)
      const snapshot = parseLogBuffer(original, this.header.id, this.path)
      const firstNewline = original.indexOf(0x0a)
      const migrated = Buffer.concat([
        Buffer.from(serializeHeader({ ...snapshot.header, v: NATIVE_SESSION_LOG_V2 }), 'utf8'),
        original.subarray(firstNewline),
      ])
      const tempHandle = await openFile(temp, 'w')
      try {
        await writeAll(tempHandle, migrated, temp)
        await tempHandle.sync()
      } finally {
        // Windows requires both handles closed before the replacement rename.
        await tempHandle.close()
      }
      this.assertDurableWriterActive()
      await rename(temp, this.path)
      renamed = true
      this.header.v = NATIVE_SESSION_LOG_V2
      await syncDirectory(this.stateDir, this.header.id)

      // Re-read the replacement with the v2 parser before accepting any queued
      // append. This proves the on-disk seq chain and drops any stale v1 cache
      // snapshot as the source of the writer's new baseline.
      const reloaded = await loadNativeSessionLog(this.stateDir, this.header.id)
      if (!reloaded || reloaded.header.v !== NATIVE_SESSION_LOG_V2) {
        throw new Error(`migrated session log did not reload as v2: ${this.path}`)
      }
      this.handle = await openFile(this.path, 'a')
      this.events.splice(0, this.events.length, ...reloaded.events, ...queued)
      const { nativeHistoryCache } = await import('./cache.js')
      nativeHistoryCache.invalidate(this.header.id)
      this.releaseMigrationAppends(queued)
    } catch (err) {
      if (this.superseded) {
        this.migrationAppends = null
        throw err
      }
      if (!renamed && queued.some(eventRequiresV2)) {
        // Reopening v1 is safe only for v1-compatible queued events. A queued
        // structured occurrence still requires the migration that just failed;
        // discard the uncommitted gate and close rather than corrupting v1.
        this.events.splice(this.events.length - queued.length, queued.length)
        await this.failMigration(err)
        throw err
      }
      if (!renamed) {
        // The source is still v1. Reopen it before releasing the gate; if even
        // that fails, the writer is closed rather than pretending to be live.
        try {
          await this.closeHandle()
          this.handle = await openFile(this.path, 'a')
          this.releaseMigrationAppends(queued)
        } catch (reopenErr) {
          await this.failMigration(err)
          throw new AggregateError([err, reopenErr], `failed to reopen v1 session log: ${this.path}`)
        }
        try {
          await rm(temp, { force: true })
        } catch (cleanupErr) {
          throw new AggregateError([err, cleanupErr], `failed to clean migration temp: ${temp}`)
        }
      } else {
        // The replacement has already happened. Never roll it back, and never
        // acknowledge another turn while directory durability or the writer's
        // reopened state is unknown.
        await this.failMigration(err)
      }
      throw err
    }
  }

  private releaseMigrationAppends(queued: NativeLogEvent[]): void {
    if (!this.closed && !this.superseded) {
      if (this.migrationNeutralAppends) {
        // v3 target: the canonical neutral appends become the durable bytes and
        // join the neutral baseline in lockstep with the legacy view (already
        // spliced into `events` by the caller).
        for (const neutral of this.migrationNeutralAppends) {
          this.neutralEvents!.push(neutral)
          this.pending.push(Buffer.from(serializeEvent(neutral) + '\n', 'utf8'))
        }
      } else {
        for (const event of queued) this.pending.push(Buffer.from(serializeEvent(event) + '\n', 'utf8'))
      }
    }
    this.migrationAppends = null
    this.migrationNeutralAppends = null
    this.migrationTargetVersion = null
  }

  private async failMigration(cause: unknown): Promise<void> {
    this.migrationFatal = cause
    this.closed = true
    this.pending = []
    this.migrationAppends = null
    this.migrationNeutralAppends = null
    this.migrationTargetVersion = null
    await this.closeHandle()
  }

  private async closeHandle(): Promise<void> {
    if (!this.handle) return
    const handle = this.handle
    this.handle = null
    await handle.close()
  }
  /** Append one control event as an atomic durable reservation. Ordinary
   *  append/flush keeps its crash-recovery semantics; this stricter path is for
   *  selections that must not become visible in memory OR replay after a
   *  genuine write failure. Every non-rejected event appended after the prior
   *  flush is preserved with a fresh contiguous seq on rollback. */
  appendDurable(input: NativeEventInput | NativeNeutralEventInput): Promise<NativeLogEvent> {
    // The reservation AND any rollback share the writer-operation queue with
    // migration. No stat/truncate/restore step can interleave with its copy.
    return this.enqueueWriterOperation(() => this.performAppendDurable(input))
  }

  private async performAppendDurable(input: NativeEventInput | NativeNeutralEventInput): Promise<NativeLogEvent> {
    this.assertDurableReservationNotGated()
    // A resolved flush can still leave pending bytes: its captured chunk may
    // have excluded an ordinary append that landed while the write was in
    // flight. Drain until the buffer is quiescent, checking writer ownership
    // after every await so a close/superseded no-op flush cannot spin here.
    while (true) {
      await this.writePending(false)
      this.assertDurableWriterActive()
      if (this.pending.length === 0) break
    }
    // No await between the quiescence check and this snapshot: every earlier
    // ordinary event is in the durable baseline. Appends during the async stat
    // are after the baseline and will be restored by rollback below.
    const preEventCount = this.events.length
    const preSize = (await stat(this.path)).size
    this.assertDurableWriterActive()
    this.assertDurableReservationNotGated()
    let reservation: NativeLogEvent | undefined
    let flushSucceeded = false
    try {
      reservation = this.append(input)
      await this.writePending(false)
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
      const appendedNeutral = this.neutralEvents ? this.neutralEvents.splice(preEventCount) : null
      this.pending = []
      if (this.migrationAppends) {
        const rolledBack = new Set(appended)
        const keep = this.migrationAppends.map((event) => !rolledBack.has(event))
        this.migrationAppends = this.migrationAppends.filter((_event, index) => keep[index])
        if (this.migrationNeutralAppends) {
          this.migrationNeutralAppends = this.migrationNeutralAppends.filter((_event, index) => keep[index])
        }
      }
      // A replacement writer may already have committed newer events. Never
      // truncate its file; only discard this stale writer's uncommitted state.
      if (this.superseded) throw err
      try {
        truncateSync(this.path, preSize)
        for (let i = 0; i < appended.length; i++) {
          const event = appended[i]
          if (event === reservation) continue
          this.restoreAfterDurableRollback(event, appendedNeutral ? appendedNeutral[i] : null)
        }
      } catch (rollbackErr) {
        throw new AggregateError([err, rollbackErr], `failed to roll back durable append: ${this.path}`)
      }
      throw err
    }
  }

  private restoreAfterDurableRollback(event: NativeLogEvent, neutral: NativeSessionEvent | null): void {
    const { seq: _seq, ...rest } = event
    const restored = { ...rest, seq: this.events.length } as NativeLogEvent
    this.events.push(restored)
    let restoredNeutral: NativeSessionEvent | null = null
    if (this.neutralEvents && neutral) {
      restoredNeutral = { ...neutral, seq: restored.seq } as NativeSessionEvent
      this.neutralEvents.push(restoredNeutral)
    }
    // Restoration belongs to the durable operation, not the public append
    // contract. It re-enters the active migration gate when one exists, so a
    // restored structured event cannot be drained into the v1 source copy.
    // Otherwise a racing close's queued allowClosed flush owns these bytes.
    if (this.migrationAppends) {
      this.migrationAppends.push(restored)
      // A v3 gate buffers the canonical neutral form too. (Unreachable in
      // practice — a durable reservation refuses to start behind a migration
      // gate — but kept lockstep-correct should the ordering ever change.)
      if (this.migrationNeutralAppends) this.migrationNeutralAppends.push(migrateEventToV3(restored))
    } else {
      this.bufferEvent(restored, restoredNeutral)
    }
  }

  private assertDurableReservationNotGated(): void {
    if (this.migrationAppends) {
      throw new Error(`session log migration prevents a new durable reservation: ${this.path}`)
    }
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

  private enqueueWriterOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation)
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private enqueueFlush(allowClosed: boolean): Promise<void> {
    return this.enqueueWriterOperation(() => this.writePending(allowClosed))
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
