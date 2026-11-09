// server/providers/native/session-log/reader.ts
//
// History read surface over the native session log. Mirrors history-reader's
// two read paths so search, paging, and side-chat boundaries work unchanged:
//
//   - entries: every renderable line as { index, message }, untrimmed (search
//     reads content for snippets and must not lose recall);
//   - pages: the shared `paginateRenderable` window (before / beforeUuid /
//     limit), trimmed for the wire.
//
// Both paths apply the same transformations in this order:
//   1. compact floor — everything before the LAST `session/compact` boundary
//      is superseded by that boundary's synthetic summary line;
//   2. `repairRenderableLines`' synthetic tool_result lines for a turn a crash
//      cut short, so an interrupted session renders (and pages) as complete
//      without rewriting the log;
//   3. the side-chat `afterUuid` boundary with parseRenderable's exact
//      semantics: skip the boundary line and everything before it; if the
//      boundary is absent, drop everything.
//
// The compact floor is persistent state on disk, not an in-ring detail: a
// resumed, forked, or reopened session must see only post-compact content here
// (matching `historyFromEvents`' model-history floor).

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalize, paginateRenderable } from '../../../history-reader.js'
import type { HistoryEntry, HistoryPage, RawLine } from '../../../history-reader.js'
import { nativeHistoryCache } from './cache.js'
import { parseEventLine } from './format.js'
import type { NativeCompactEvent } from './format.js'
import { nativeSessionLogPath } from './paths.js'
import { repairRenderableLines } from './replay.js'

function emptyPage(): HistoryPage {
  return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
}

/** Cached durable lines plus the synthetic tail for unanswered tool_use ids.
 *  The cache itself is never mutated. */
function withRepair(lines: readonly RawLine[]): RawLine[] {
  return [...lines, ...repairRenderableLines(lines)]
}

interface CompactMemo {
  /** File stat this compact verdict describes — the freshness key. */
  size: number
  mtimeMs: number
  compact: NativeCompactEvent | null
}

/** The renderable-line cache deliberately stores only transcript frames
 *  (`isRenderableSdkMessage`), so the compact boundary is not in `lines`. The
 *  boundary is resolved from the log bytes and memoized with the same
 *  (size, mtimeMs) freshness rule as `cache.ts`, so a warm reader call pays
 *  zero extra IO: the stat the cache load already performed IS the memo key. */
const compactMemo = new Map<string, CompactMemo>()
const COMPACT_MEMO_CAP = 8

function touchCompact(key: string, entry: CompactMemo): CompactMemo {
  compactMemo.delete(key)
  compactMemo.set(key, entry)
  // LRU-bounded like the line cache: reader calls span sessions over a
  // process lifetime, so the memo cannot be allowed to grow without bound.
  while (compactMemo.size > COMPACT_MEMO_CAP) {
    const oldest = compactMemo.keys().next().value
    if (oldest === undefined) break
    compactMemo.delete(oldest)
  }
  return entry
}

/** Scan backwards for the LAST compact boundary, reading only complete lines
 *  (a torn tail is the writer mid-append, which the cache also ignores). The
 *  raw substring pre-filter keeps a boundary-free log from JSON-parsing every
 *  event just to find one, and the backwards `lastIndexOf` walk avoids
 *  materializing the whole line array. */
function findLastCompact(text: string, id: string, path: string): NativeCompactEvent | null {
  let end = text.lastIndexOf('\n')
  while (end >= 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    if (line.includes('session/compact')) {
      const raw = JSON.parse(line) as { seq?: unknown }
      const event = parseEventLine(raw, typeof raw.seq === 'number' ? raw.seq : -1, id, path)
      if (event.type === 'session/compact') return event
    }
    end = start - 1
  }
  return null
}

/** The last compact boundary in the log, memoized on (size, mtimeMs) — the
 *  values the line cache already stat'd. A hit costs a Map lookup; a miss
 *  reads the log once and caches the verdict (including "no compact"). */
async function lastCompactEvent(
  stateDir: string,
  id: string,
  size: number,
  mtimeMs: number,
): Promise<NativeCompactEvent | null> {
  const path = nativeSessionLogPath(stateDir, id)
  const key = resolve(path)
  const memo = compactMemo.get(key)
  if (memo && memo.size === size && memo.mtimeMs === mtimeMs) {
    return touchCompact(key, memo).compact
  }
  const compact = findLastCompact(await readFile(path, 'utf8'), id, path)
  touchCompact(key, { size, mtimeMs, compact })
  return compact
}

/** The synthetic summary line a compact boundary renders as. String content
 *  matches the live compact seed (and the CLI's summary frames); `normalize`
 *  passes it through unchanged, and `isCompactSummary` distinguishes it from
 *  a real user prompt. */
function compactSummaryLine(event: NativeCompactEvent): RawLine {
  return {
    type: 'user',
    uuid: event.uuid,
    timestamp: event.timestamp,
    isCompactSummary: true,
    message: { role: 'user', content: event.text },
  }
}

/** Start the renderable stream at the LAST compact boundary: drop every line
 *  the summary supersedes and prepend the summary line in their place. A log
 *  with no compact is unchanged. */
function floorAtCompact(lines: readonly RawLine[], compact: NativeCompactEvent | null): RawLine[] {
  if (!compact) return [...lines]
  return [
    compactSummaryLine(compact),
    // Cached lines carry the event's `seq`; everything at or before the
    // boundary is superseded.
    ...lines.filter((line) => typeof line.seq === 'number' && line.seq > compact.seq),
  ]
}

/** Cached renderable lines floored at the last compact boundary. */
async function loadFlooredLines(stateDir: string, id: string): Promise<RawLine[] | null> {
  const loaded = await nativeHistoryCache.load(stateDir, id)
  if (!loaded) return null
  return floorAtCompact(
    loaded.lines,
    await lastCompactEvent(stateDir, id, loaded.size, loaded.mtimeMs),
  )
}

/** Mirror history-reader.parseRenderable's afterUuid filter: nothing is
 *  included until the boundary uuid has been seen (and skipped). */
function filterAfterUuid(lines: readonly RawLine[], afterUuid?: string): RawLine[] {
  if (!afterUuid) return [...lines]
  const out: RawLine[] = []
  let past = false
  for (const line of lines) {
    if (!past) {
      if (line.uuid === afterUuid) past = true
      continue
    }
    out.push(line)
  }
  return out
}

export async function readNativeHistoryEntries(
  stateDir: string,
  id: string,
  opts: { afterUuid?: string } = {},
): Promise<HistoryEntry[]> {
  const lines = await loadFlooredLines(stateDir, id)
  if (!lines) return []
  return filterAfterUuid(withRepair(lines), opts.afterUuid).map((line, index) => ({
    index,
    // No trim: this path feeds search, which reads content to build snippets
    // and never ships the full message over WS.
    message: normalize(line, id, false),
  }))
}

export async function readNativeHistoryPage(
  stateDir: string,
  id: string,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): Promise<HistoryPage> {
  const lines = await loadFlooredLines(stateDir, id)
  if (!lines) return emptyPage()
  return paginateRenderable(filterAfterUuid(withRepair(lines), opts.afterUuid), id, opts)
}
