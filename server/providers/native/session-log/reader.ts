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
//   1. compact projection — the last LEGACY `session/compact` boundary
//      (`retainHistory !== true`) floors the stream: everything it supersedes
//      is replaced by its synthetic summary line. RETAIN compacts
//      (`retainHistory === true`) keep the surrounding history and render as
//      an inline boundary + summary pair at their seq position;
//   2. `repairRenderableLines`' synthetic tool_result lines for a turn a crash
//      cut short, so an interrupted session renders (and pages) as complete
//      without rewriting the log;
//   3. the side-chat `afterUuid` boundary with parseRenderable's exact
//      semantics: skip the boundary line and everything before it; if the
//      boundary is absent, drop everything.
//
// The legacy compact floor is persistent state on disk, not an in-ring detail:
// a resumed, forked, or reopened session must see only post-compact content
// after a legacy boundary. The RENDERABLE floor here is separate from the
// MODEL-history floor (`historyFromEvents` / `lastCompactIndex` in replay.ts),
// which floors at the last compact of either kind — retain compacts keep the
// transcript visible while the model continues from the summary alone.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { NativeTranscriptPort } from '../ports.js'
import type { HistoryEntry, HistoryPage, HistoryReadResult, RawLine } from '../../../../shared/transcript-format.js'
import { nativeHistoryCache } from './cache.js'
import { isSidechainEvent, NATIVE_SESSION_LOG_V3, parseEventLine, parseEventLineV3, parseHeaderLine } from './format.js'
import { migrateEventToV3 } from './migration.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import { nativeSessionLogPath } from './paths.js'
import { repairRenderableLines } from './replay.js'
import { publicNativeHistoryLine } from '../attachment-projection.js'

/** The neutral compact boundary event (v3 canonical; a v1/v2 boundary is
 *  migrated to this shape in memory). The reader's floor/summary synthesis
 *  reads its `data` payload + envelope `seq`. */
type NeutralCompactEvent = Extract<NativeSessionEvent, { type: 'session/compact' }>

function emptyPage(): HistoryPage {
  return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
}

/** Cached durable lines plus the synthetic tail for unanswered tool_use ids.
 *  The cache itself is never mutated. */
function withRepair(lines: readonly RawLine[]): RawLine[] {
  return [...lines, ...repairRenderableLines(lines)]
}

/** The dual compact verdict the renderable projection keys on: the last
 *  LEGACY compact floors the stream, while every RETAIN compact after that
 *  floor renders as an inline marker pair (ascending seq). */
interface CompactVerdict {
  legacyFloor: NeutralCompactEvent | null
  retainMarkers: NeutralCompactEvent[]
}

interface CompactMemo {
  /** File stat this compact verdict describes — the freshness key. */
  size: number
  mtimeMs: number
  verdict: CompactVerdict
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

/** Scan backwards for the compact verdict, reading only complete lines (a
 *  torn tail is the writer mid-append, which the cache also ignores). The
 *  last LEGACY compact (`retainHistory !== true`) is the renderable floor;
 *  RETAIN compacts seen on the way there (all with seq > floor.seq) become
 *  inline markers, and the scan stops at the floor — anything older is
 *  superseded. With no legacy compact, every retain compact is a marker.
 *  The raw substring pre-filter keeps a boundary-free log from JSON-parsing
 *  every event just to find one, and the backwards `lastIndexOf` walk avoids
 *  materializing the whole line array. */
function findCompactVerdict(text: string, id: string, path: string): CompactVerdict {
  const headerEnd = text.indexOf('\n')
  const header = parseHeaderLine(JSON.parse(text.slice(0, headerEnd)), id, path)
  const retainMarkers: NeutralCompactEvent[] = []
  let legacyFloor: NeutralCompactEvent | null = null
  let end = text.lastIndexOf('\n')
  while (end >= 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    end = start - 1
    if (!line.includes('session/compact')) continue
    const raw = JSON.parse(line) as { seq?: unknown }
    // The header is not an event, and its `cwd` can contain the literal
    // substring (a directory named `session/compact`). Events always carry a
    // numeric seq; skip anything else rather than feeding the header to the
    // event parser.
    if (typeof raw.seq !== 'number') continue
    // Parse the boundary natively: v3 lines are neutral events; a v1/v2
    // boundary is migrated to the same neutral shape (T13 — the read path no
    // longer goes through the legacy projection). Legacy v1/v2 boundaries
    // migrate WITHOUT markers, so they always floor.
    const event = header.v === NATIVE_SESSION_LOG_V3
      ? parseEventLineV3(raw, raw.seq, id, path)
      : migrateEventToV3(parseEventLine(raw, raw.seq, id, path, header.v))
    if (event.type !== 'session/compact') continue
    if (event.data.retainHistory === true) {
      retainMarkers.push(event)
      continue
    }
    legacyFloor = event
    break
  }
  // Collected newest-first; the projection walks markers in seq order.
  retainMarkers.reverse()
  return { legacyFloor, retainMarkers }
}

/** The compact verdict for the log, memoized on (size, mtimeMs) — the values
 *  the line cache already stat'd. A hit costs a Map lookup; a miss reads the
 *  log once and caches the verdict (including "no compact"). */
async function loadCompactVerdict(
  stateDir: string,
  id: string,
  size: number,
  mtimeMs: number,
): Promise<CompactVerdict> {
  const path = nativeSessionLogPath(stateDir, id)
  const key = resolve(path)
  const memo = compactMemo.get(key)
  if (memo && memo.size === size && memo.mtimeMs === mtimeMs) {
    return touchCompact(key, memo).verdict
  }
  const verdict = findCompactVerdict(await readFile(path, 'utf8'), id, path)
  touchCompact(key, { size, mtimeMs, verdict })
  return verdict
}

/** The synthetic summary line a compact boundary renders as. String content
 *  matches the live compact seed (and the CLI's summary frames); `normalize`
 *  passes it through unchanged, and `isCompactSummary` distinguishes it from
 *  a real user prompt. The uuid is the summary's own identity (`summaryUuid`,
 *  which the live summary frame also carries) so disk replay and the live
 *  frame dedupe to one card; legacy events without it keep the event uuid. */
function compactSummaryLine(event: NeutralCompactEvent): RawLine {
  return {
    type: 'user',
    uuid: event.data.summaryUuid ?? event.data.uuid,
    timestamp: event.data.timestamp,
    isCompactSummary: true,
    message: { role: 'user', content: event.data.text },
  }
}

/** The single compact-aware projection shared by all three read paths.
 *  A legacy floor drops every line it supersedes and prepends its synthetic
 *  projection (`legacyBoundary` picks the path's shape: entries/page render
 *  the summary only, the reconcile snapshot renders boundary + summary).
 *  Each retain marker inserts its boundary + summary pair inline at its seq
 *  position — before the first renderable line with seq > marker.seq — in
 *  every path, keeping the surrounding history. No compact → unchanged. */
function projectCompactAware(
  lines: readonly RawLine[],
  verdict: CompactVerdict,
  legacyBoundary: boolean,
): RawLine[] {
  const { legacyFloor, retainMarkers } = verdict
  const out: RawLine[] = []
  if (legacyFloor) {
    if (legacyBoundary) out.push(compactBoundaryLine(legacyFloor))
    out.push(compactSummaryLine(legacyFloor))
  }
  let next = 0
  for (const line of lines) {
    // Cached lines carry the event's `seq`; everything at or before the
    // legacy boundary is superseded.
    const seq = typeof line.seq === 'number' ? line.seq : null
    if (legacyFloor && (seq === null || seq <= legacyFloor.seq)) continue
    while (next < retainMarkers.length && seq !== null && retainMarkers[next].seq < seq) {
      const marker = retainMarkers[next++]
      out.push(compactBoundaryLine(marker), compactSummaryLine(marker))
    }
    out.push(line)
  }
  // Markers past the last renderable line (a retain compact as the log's
  // final event) still render their pair, at the tail.
  while (next < retainMarkers.length) {
    const marker = retainMarkers[next++]
    out.push(compactBoundaryLine(marker), compactSummaryLine(marker))
  }
  return out
}

/** Cached renderable lines under the compact projection (legacy floor +
 *  inline retain markers), summary-only legacy shape. */
async function loadProjectedLines(stateDir: string, id: string): Promise<RawLine[] | null> {
  const loaded = await nativeHistoryCache.load(stateDir, id)
  if (!loaded) return null
  return projectCompactAware(
    loaded.lines,
    await loadCompactVerdict(stateDir, id, loaded.size, loaded.mtimeMs),
    false,
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
  transcriptPort: NativeTranscriptPort,
  opts: { afterUuid?: string } = {},
): Promise<HistoryEntry[]> {
  const lines = await loadProjectedLines(stateDir, id)
  if (!lines) return []
  const stream = filterAfterUuid(withRepair(lines), opts.afterUuid).map(publicNativeHistoryLine)
  // This path feeds searchMessages and the transcript seq backfill, both of
  // which must see only top-level turns. Entries keep their FULL-STREAM index
  // — the same index `readNativeHistoryPage` assigns — so a hit's
  // `messageIndex` still addresses the right page row. Sidechain entries are
  // dropped AFTER indexing, leaving a sparse (but aligned) index space.
  const entries: HistoryEntry[] = []
  for (const [index, line] of stream.entries()) {
    if (isSidechainEvent(line)) continue
    entries.push({
      index,
      // Full-stream ordinal (computed before the sidechain drop above), so
      // filtering never renumbers it (spec §4).
      sourceOrdinal: index,
      // No trim: this path feeds search, which reads content to build snippets
      // and never ships the full message over WS.
      message: transcriptPort.normalize(line, id, false),
    })
  }
  return entries
}

export async function readNativeHistoryPage(
  stateDir: string,
  id: string,
  transcriptPort: NativeTranscriptPort,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): Promise<HistoryPage> {
  const lines = await loadProjectedLines(stateDir, id)
  if (!lines) return emptyPage()
  const stream = filterAfterUuid(withRepair(lines), opts.afterUuid).map(publicNativeHistoryLine)
  return transcriptPort.paginateRenderable(stream, id, opts)
}

/** The compact boundary occurrence. The legacy floor's public entries/page
 *  projection synthesizes it away (summary only), while the reconcile
 *  snapshot and every retain marker render it: ordered reconcile must see
 *  BOTH boundary and summary as distinct occurrences (spec §11 compact).
 *  The boundary uses the event uuid; the summary uses `summaryUuid ?? uuid`
 *  — they share the event uuid only for legacy compacts and differ for
 *  retain compacts; frameKind tells the two occurrences apart. */
function compactBoundaryLine(event: NeutralCompactEvent): RawLine {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: event.data.uuid,
    timestamp: event.data.timestamp,
  }
}

/** True when the log's final non-empty line is a torn (unparseable) event —
 *  the writer mid-append. The cache already ignores it; reconcile reports it. */
async function nativeLogTornTail(stateDir: string, id: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(nativeSessionLogPath(stateDir, id), 'utf8')
  } catch {
    return false
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      JSON.parse(line)
      return false
    } catch {
      return true
    }
  }
  return false
}

/** Ordered-reconcile snapshot for the native log (spec §7.1). Emits the compact
 *  boundary + summary dual occurrence, sourceOrdinal-bearing entries, and an
 *  explicit read status. The summary-only projection in the public
 *  entries/page paths above applies to the legacy floor only; retain
 *  markers render boundary + summary in every path. */
export async function readNativeHistorySnapshot(
  stateDir: string,
  id: string,
  transcriptPort: NativeTranscriptPort,
  opts: { afterUuid?: string } = {},
): Promise<HistoryReadResult> {
  const loaded = await nativeHistoryCache.load(stateDir, id)
  if (!loaded) return { status: 'missing', entries: [] }
  const verdict = await loadCompactVerdict(stateDir, id, loaded.size, loaded.mtimeMs)
  const repaired = withRepair(projectCompactAware(loaded.lines, verdict, true))
  if (opts.afterUuid && !repaired.some((line) => line.uuid === opts.afterUuid)) {
    return { status: 'boundary-not-found', entries: [] }
  }
  const stream = filterAfterUuid(repaired, opts.afterUuid).map(publicNativeHistoryLine)
  const entries: HistoryEntry[] = []
  for (const [index, line] of stream.entries()) {
    if (isSidechainEvent(line)) continue
    entries.push({ index, sourceOrdinal: index, message: transcriptPort.normalize(line, id, false) })
  }
  const tornTail = await nativeLogTornTail(stateDir, id)
  return tornTail ? { status: 'ok', entries, tornTail: true } : { status: 'ok', entries }
}
