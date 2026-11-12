// server/providers/native/session-log/cache.ts
//
// LRU parse cache for native session logs, mirroring jsonl-cache's freshness
// machinery without touching the claude hot path:
//
//   - Freshness key: (stat.size, stat.mtimeMs) checked on every load.
//     Unchanged          → serve from cache (zero IO beyond the stat).
//     size grew          → read the file and parse only the appended complete
//                          lines (the log is append-only).
//     size shrank / same size with a new mtime → full re-parse (a rewritten
//     log).
//   - Invalidation advances a per-key generation. Full and incremental loads
//     hold a lease on that generation across every await, so a superseded read
//     retries against current state instead of committing over a replacement.
//   - Entries store RENDERABLE raw lines — the shared isRenderableSdkMessage
//     set PLUS sidechain user/assistant frames (parent_tool_use_id != null),
//     which the transcript UI renders under their Agent card but the main
//     history/search exclude. That is the exact input `normalize` /
//     `paginateRenderable` expect. The `session/header` line is validated but
//     not stored. The same entry also holds the all-event subagent catalog:
//     a descriptor-only append can replace the catalog while retaining the
//     identical `lines` array.
//   - Only COMPLETE lines (up to the last '\n') are parsed. A torn final line
//     (the writer is mid-append) stays unparsed until the file grows past it.
//   - Every parsed line is validated with the same header/event validators the
//     log writer uses, so corruption and unknown versions propagate as
//     NativeSessionStorageError instead of being skipped as a bad row.
//   - A missing log resolves to null. The reader turns that into an empty
//     page / entry list; corruption is NOT swallowed.
//
// Incremental appends slice the file in the BYTE domain (the byte offset kept
// from the log snapshot), which is exact: `completeBytes` always sits just
// past a '\n', so the slice starts on a UTF-8 boundary.

import { readFile, stat } from 'node:fs/promises'
import type { RawLine } from '../../../history-reader.js'
import { isRenderableSdkMessage } from '../../../history-utils.js'
import { NativeSessionStorageError } from './errors.js'
import { isSidechainEvent, parseEventLine } from './format.js'
import type { NativeLogEvent } from './format.js'
import { loadNativeSessionLog } from './log.js'
import { nativeSessionLogPath } from './paths.js'
import { buildNativeSubagentCatalog, extendNativeSubagentCatalog } from './subagents.js'
import type { NativeSubagentCatalog } from './subagents.js'

/** A loaded, freshness-checked view of a native log. */
export interface NativeHistoryLoad {
  lines: RawLine[]
  subagents: NativeSubagentCatalog
  size: number
  mtimeMs: number
}

export interface NativeHistoryCache {
  load(stateDir: string, id: string): Promise<NativeHistoryLoad | null>
  invalidate(id: string): void
}

const CACHE_CAP = 4

interface CacheEntry extends NativeHistoryLoad {
  id: string
  /** Byte offset just past the last parsed complete line (header included). */
  parsedBytes: number
  /** `seq` the next appended event must carry. */
  nextSeq: number
}

const cache = new Map<string, CacheEntry>()

interface CacheOwner {
  id: string
  generation: number
  inFlight: number
}

interface LoadLease {
  key: string
  owner: CacheOwner
  generation: number
}

const owners = new Map<string, CacheOwner>()

function cleanupOwner(key: string): void {
  if (cache.has(key)) return
  const owner = owners.get(key)
  if (owner?.inFlight === 0) owners.delete(key)
}

function acquire(key: string, id: string): LoadLease {
  let owner = owners.get(key)
  if (!owner) {
    owner = { id, generation: 0, inFlight: 0 }
    owners.set(key, owner)
  }
  owner.inFlight++
  return { key, owner, generation: owner.generation }
}

function release(lease: LoadLease): void {
  lease.owner.inFlight--
  cleanupOwner(lease.key)
}

function isCurrent(lease: LoadLease): boolean {
  return owners.get(lease.key) === lease.owner && lease.owner.generation === lease.generation
}

function keyOf(stateDir: string, id: string): string {
  return `${stateDir}\0${id}`
}

function touch(key: string, entry: CacheEntry): CacheEntry {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
    cleanupOwner(oldest)
  }
  return entry
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

function parseLine(line: string, id: string, path: string): unknown {
  try {
    return JSON.parse(line)
  } catch (err) {
    throw new NativeSessionStorageError(
      'corrupt',
      `invalid JSON in session log: ${(err as Error).message}`,
      id,
      path,
    )
  }
}

function collectRenderable(events: Iterable<unknown>): RawLine[] {
  const lines: RawLine[] = []
  for (const event of events) {
    const line = event as RawLine
    if (isRenderableSdkMessage(line) || isSidechainEvent(line)) lines.push(line)
  }
  return lines
}

/** Parse the whole log. `loadNativeSessionLog` validates the header version,
 *  every committed event, and the seq chain — so corruption throws here. */
async function fullParse(
  stateDir: string,
  id: string,
  key: string,
  lease: LoadLease,
  size: number,
  mtimeMs: number,
): Promise<NativeHistoryLoad | null> {
  const snapshot = await loadNativeSessionLog(stateDir, id)
  if (!isCurrent(lease)) return load(stateDir, id)
  if (!snapshot) {
    cache.delete(key)
    return null
  }
  return touch(key, {
    id,
    lines: collectRenderable(snapshot.events),
    subagents: buildNativeSubagentCatalog(snapshot.events),
    parsedBytes: snapshot.completeBytes,
    nextSeq: snapshot.events.length,
    size,
    mtimeMs,
  })
}

/** Parse only the lines appended after the cached byte offset. */
async function appendParse(
  stateDir: string,
  id: string,
  key: string,
  lease: LoadLease,
  cached: CacheEntry,
  size: number,
  mtimeMs: number,
): Promise<NativeHistoryLoad | null> {
  const path = nativeSessionLogPath(stateDir, id)
  const buffer = await readFile(path)
  if (!isCurrent(lease)) return load(stateDir, id)
  if (buffer.length < cached.parsedBytes) {
    // The file shrank between stat and read — the cached lines describe
    // content that no longer exists. Rebuild from scratch.
    return fullParse(stateDir, id, key, lease, size, mtimeMs)
  }

  const suffix = buffer.subarray(cached.parsedBytes)
  const lastNewline = suffix.lastIndexOf(0x0a)
  if (lastNewline < 0) {
    // Only a torn partial line was appended: nothing to parse yet, but adopt
    // the new stat so the next identical stat is a hit.
    return touch(key, { ...cached, size, mtimeMs })
  }

  const chunk = suffix.subarray(0, lastNewline + 1).toString('utf8')
  const rawLines = chunk.split('\n')
  rawLines.pop() // the chunk ends with '\n', so split leaves a trailing ''

  const events: NativeLogEvent[] = []
  let nextSeq = cached.nextSeq
  for (const line of rawLines) {
    events.push(parseEventLine(parseLine(line, id, path), nextSeq++, id, path))
  }
  const lines = collectRenderable(events)

  return touch(key, {
    id,
    lines: lines.length > 0 ? cached.lines.concat(lines) : cached.lines,
    subagents: extendNativeSubagentCatalog(cached.subagents, events),
    parsedBytes: cached.parsedBytes + lastNewline + 1,
    nextSeq,
    size,
    mtimeMs,
  })
}

async function load(stateDir: string, id: string): Promise<NativeHistoryLoad | null> {
  const key = keyOf(stateDir, id)
  const lease = acquire(key, id)
  try {
    const path = nativeSessionLogPath(stateDir, id)
    let fileStat: { size: number; mtimeMs: number }
    try {
      fileStat = await stat(path)
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err
      if (!isCurrent(lease)) return await load(stateDir, id)
      cache.delete(key)
      return null
    }

    if (!isCurrent(lease)) return await load(stateDir, id)
    const cached = cache.get(key)
    if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
      return touch(key, cached)
    }
    if (cached && fileStat.size > cached.size) {
      return await appendParse(stateDir, id, key, lease, cached, fileStat.size, fileStat.mtimeMs)
    }
    return await fullParse(stateDir, id, key, lease, fileStat.size, fileStat.mtimeMs)
  } finally {
    release(lease)
  }
}

export const nativeHistoryCache: NativeHistoryCache = {
  load,
  invalidate(id) {
    for (const [key, owner] of owners) {
      if (owner.id !== id) continue
      owner.generation++
      cache.delete(key)
      cleanupOwner(key)
    }
  },
}