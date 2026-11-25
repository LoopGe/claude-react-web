// server/providers/native-resumable-listing.ts
//
// Host-side selective listing scan for native session discovery (the /resume
// picker and disk-session adoption). Enumerates <stateDir>/native-sessions and
// extracts per-session row facts — header cwd/createdAt, stat lastModified,
// first/last eligible user prompt, latest durable session/title — with ONE
// streaming pass per log, JSON-parsing only the lines that can carry those
// facts (the writer serializes with compact JSON.stringify, so the substring
// prefilter cannot false-negative; false positives are parsed and rejected by
// the validators). Display-only and fail-soft: the authoritative resume path
// still full-validates at open and surfaces corruption loudly.
//
// This module lives OUTSIDE native/ on purpose (the native-host-adapters.ts
// precedent): it composes the core session-log parsers with the host display
// cleaners (history-reader), and the native host-free pin bans value-importing
// host services from inside native/. The row cache is in-memory only — no
// durable checkpoints; freshness is the (size, mtimeMs) stat key shared with
// the jsonl page cache and lastPromptCache.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createLogger } from '../log.js'
import { isSafeSessionId } from '../../shared/transcript-format.js'
import { stripHandles } from '../../shared/attachment-handle.js'
import { condensePromptPreview } from '../../shared/prompt-preview.js'
import {
  SYNTHETIC_FRAME_PREFIX_RE,
  attachmentNameFallback,
  isInterruptPlaceholder,
} from '../history-reader.js'
import { NativeSessionStorageError } from './native/session-log/errors.js'
import {
  NATIVE_SESSION_LOG_V3,
  parseEventLine,
  parseEventLineV3,
  parseHeaderLine,
  type NativeSessionHeader,
} from './native/session-log/format.js'
import { migrateEventToV3 } from './native/session-log/migration.js'
import { nativeSessionLogPath } from './native/session-log/paths.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'

const log = createLogger('native-resumable')

export interface NativeResumableRow {
  sessionId: string
  cwd: string
  createdAt: number
  lastModified: number
  title?: string
  firstPrompt?: string
  lastPrompt?: string
}

/** Bounded concurrent row scans — the claude listResumable precedent: an
 *  unbounded Promise.all would spike file handles + stats in one burst right
 *  as the picker opens. */
const LIST_CHUNK = 16

interface RowCacheEntry {
  size: number
  mtimeMs: number
  row: NativeResumableRow
}

/** Keyed `${stateDir}\0${id}` (a path cannot contain NUL, so the split is
 *  unambiguous). Entries hold only the small row facts, never event arrays. */
const rowCache = new Map<string, RowCacheEntry>()
const ROW_CACHE_CAP = 256

function cacheKey(stateDir: string, id: string): string {
  return `${stateDir}\0${id}`
}

function cacheGet(key: string, size: number, mtimeMs: number): NativeResumableRow | undefined {
  const entry = rowCache.get(key)
  if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) return undefined
  // Refresh LRU position on hit.
  rowCache.delete(key)
  rowCache.set(key, entry)
  return entry.row
}

function cachePut(key: string, entry: RowCacheEntry): void {
  rowCache.delete(key)
  rowCache.set(key, entry)
  if (rowCache.size > ROW_CACHE_CAP) {
    const oldest = rowCache.keys().next().value
    if (oldest !== undefined) rowCache.delete(oldest)
  }
}

/** Drop every cached row for this session id (any state dir) so the next
 *  listing/adoption read rescans — the delete/re-create path calls it beside
 *  the history cache invalidation. */
export function invalidateNativeResumableCache(id: string): void {
  for (const key of rowCache.keys()) {
    if (key.slice(key.indexOf('\0') + 1) === id) rowCache.delete(key)
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

function parseJson(line: string, id: string, path: string): unknown {
  try {
    return JSON.parse(line)
  } catch (err) {
    throw new NativeSessionStorageError('corrupt', `invalid JSON: ${(err as Error).message}`, id, path)
  }
}

/** The event types that can carry row facts. Compact JSON.stringify puts
 *  `"type":"<kind>"` verbatim in every serialized event, so a substring miss
 *  is a guaranteed non-hit; a hit inside a string payload only costs one
 *  validated parse (the validator reads the actual type field). */
function isFactLine(line: string): boolean {
  return line.includes('"type":"user/message"')
    || line.includes('"type":"session/title"')
    || line.includes('"type":"user"') // legacy v1/v2 user event
}

/** Prompt eligibility mirrors parseLastUserPrompt's display contract
 *  (history-reader): main-thread only, no compaction summaries, no interrupt
 *  placeholders, no CLI-synthetic markup frames; text blocks joined and
 *  handle-stripped, condensed to the shared preview cap; an attachment-only
 *  message falls back to its attachment names. Neutral tool results are
 *  separate tool/result events, so no tool_result-block filter is needed. */
function eligiblePrompt(event: Extract<NativeSessionEvent, { type: 'user/message' }>): string | undefined {
  if (event.parentToolUseId != null) return undefined
  const data = event.data
  if (data.isCompactSummary === true) return undefined
  const content = data.content
  if (isInterruptPlaceholder(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text)
  }
  const joined = stripHandles(texts.join(' '))
  if (joined) {
    if (SYNTHETIC_FRAME_PREFIX_RE.test(joined)) return undefined
    return condensePromptPreview(joined)
  }
  return attachmentNameFallback(content)
}

interface ScanFacts {
  header: NativeSessionHeader
  title?: string
  firstPrompt?: string
  lastPrompt?: string
}

/** One streaming pass over the log. Only complete lines count toward the seq
 *  chain: readline yields a final unterminated line too, and the writer may be
 *  mid-append, so the last line is processed only when the bytes actually read
 *  end with '\n' (a torn tail is dropped, never parsed, never seq-counted). */
async function scanLog(stateDir: string, id: string): Promise<ScanFacts> {
  const path = nativeSessionLogPath(stateDir, id)
  const stream = createReadStream(path)
  let lastByte = -1
  stream.on('data', (chunk: string | Buffer) => {
    // No encoding is set on the stream, so every chunk is a Buffer.
    const bytes = chunk as Buffer
    lastByte = bytes[bytes.length - 1]
  })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let header: NativeSessionHeader | undefined
  let title: string | undefined
  let firstPrompt: string | undefined
  let lastPrompt: string | undefined
  let seq = 0

  const processLine = (line: string): void => {
    if (!header) {
      // The first complete line is the header (it is not seq-numbered).
      header = parseHeaderLine(parseJson(line, id, path), id, path)
      return
    }
    if (isFactLine(line)) {
      const raw = parseJson(line, id, path)
      const event = header.v === NATIVE_SESSION_LOG_V3
        ? parseEventLineV3(raw, seq, id, path)
        : migrateEventToV3(parseEventLine(raw, seq, id, path, header.v))
      if (event.type === 'session/title') {
        title = event.data.title // latest wins by file position
      } else if (event.type === 'user/message') {
        const text = eligiblePrompt(event)
        if (text !== undefined) {
          if (firstPrompt === undefined) firstPrompt = text
          lastPrompt = text
        }
      }
    }
    // Every complete event line advances the chain — the validators check seq
    // equality on each parsed hit, so non-hit lines must count too.
    seq++
  }

  try {
    // One-line delay: the final line's completeness is only known at EOF.
    let pending: string | undefined
    for await (const line of rl) {
      if (pending !== undefined) processLine(pending)
      pending = line
    }
    if (pending !== undefined && lastByte === 0x0a) processLine(pending)
  } finally {
    rl.close()
    stream.destroy()
  }
  if (!header) {
    throw new NativeSessionStorageError('corrupt', 'session log has no complete header line', id, path)
  }
  return { header, title, firstPrompt, lastPrompt }
}

/** Stat-keyed row read shared by the listing and single-id adoption probe.
 *  A failed scan caches nothing — a transient failure (delete race, Windows
 *  lock) must not pin a verdict for the process lifetime. */
async function rowFor(stateDir: string, id: string, size: number, mtimeMs: number): Promise<NativeResumableRow> {
  const key = cacheKey(stateDir, id)
  const cached = cacheGet(key, size, mtimeMs)
  if (cached) return cached
  const facts = await scanLog(stateDir, id)
  const row: NativeResumableRow = {
    sessionId: id,
    cwd: facts.header.cwd,
    createdAt: facts.header.createdAt,
    lastModified: mtimeMs,
    ...(facts.title !== undefined ? { title: facts.title } : {}),
    ...(facts.firstPrompt !== undefined ? { firstPrompt: facts.firstPrompt } : {}),
    ...(facts.lastPrompt !== undefined ? { lastPrompt: facts.lastPrompt } : {}),
  }
  cachePut(key, { size, mtimeMs, row })
  return row
}

/** Enumerate native session logs and extract picker-row facts. Per-row
 *  fail-soft: a corrupt/unreadable log is skipped with a warn (the listing is
 *  display-only); a log deleted mid-scan is skipped and never cached as
 *  absent. `opts.dir` scopes to an exact header.cwd match. */
export async function listNativeResumableRows(
  stateDir: string,
  opts?: { dir?: string },
): Promise<NativeResumableRow[]> {
  let entries
  try {
    entries = await readdir(join(stateDir, 'native-sessions'), { withFileTypes: true })
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return []
    throw err
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && isSafeSessionId(entry.name))
    .map((entry) => entry.name)
  const rows: NativeResumableRow[] = []
  for (let start = 0; start < ids.length; start += LIST_CHUNK) {
    const chunk = ids.slice(start, start + LIST_CHUNK)
    const part = await Promise.all(chunk.map(async (id): Promise<NativeResumableRow | undefined> => {
      try {
        let fileStat
        try {
          fileStat = await stat(nativeSessionLogPath(stateDir, id))
        } catch (err) {
          // No log file (empty/junk directory) — not a failure, just no row.
          if (isErrno(err, 'ENOENT')) return undefined
          throw err
        }
        return await rowFor(stateDir, id, fileStat.size, fileStat.mtimeMs)
      } catch (err) {
        log.warn(`listing skipped session=${id}: ${(err as Error).message ?? err}`)
        return undefined
      }
    }))
    for (const row of part) {
      if (row !== undefined) rows.push(row)
    }
  }
  return opts?.dir !== undefined ? rows.filter((row) => row.cwd === opts.dir) : rows
}

/** Single-id row read for disk-session adoption. Missing log → undefined;
 *  corrupt log → THROW (the multi-provider adoption probe catches per
 *  provider). A delete between stat and read resolves as missing. */
export async function readNativeResumableRow(
  stateDir: string,
  id: string,
): Promise<NativeResumableRow | undefined> {
  const path = nativeSessionLogPath(stateDir, id)
  let fileStat
  try {
    fileStat = await stat(path)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined
    throw err
  }
  try {
    return await rowFor(stateDir, id, fileStat.size, fileStat.mtimeMs)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined
    throw err
  }
}
