// LRU parse cache for per-session transcript JSONL files.
//
// readHistoryPage used to readFile + JSON.parse + isRenderable-filter the
// ENTIRE transcript on every scroll-up page (200 messages out of tens of
// thousands of lines). This cache parses once per file version and serves
// subsequent pages from memory:
//
//   - Freshness key: (stat.size, stat.mtimeMs) checked on every readPage.
//     Unchanged            → serve from cache (zero IO).
//     size grew            → readFile, parse only the appended suffix
//                            (JSONL is append-only), merge (Task 3).
//     size shrank          → full re-parse (rewritten transcript, /clear).
//     same size, new mtime → full re-parse (defensive; same-size rewrites).
//   - Entries store NORMALIZED wire objects (normalize(o, sessionId, true)),
//     not raw lines: normalize shares `message` by reference with the raw
//     line and trimLargeToolResults mutates content in place, so caching
//     raws and re-normalizing per serve would let a mutation pollute the
//     cache. Normalizing once at parse time removes the hazard and makes
//     each serve pure slicing.
//   - Only COMPLETE lines (up to the last '\n') are parsed; a torn final
//     line stays unparsed until the file grows past it (Task 3). This
//     differs from paginateJsonl, which attempts the torn final line —
//     with a cache, parsing a line that the CLI is still appending would
//     cache a WRONG prefix permanently. The in-flight message arrives
//     live over WS regardless.
//   - Freshness uses the BYTE domain (stat.size vs entry.statSize); slicing
//     uses the CHARACTER domain (string offsets after utf8 decode). The two
//     are never compared to each other.
//
// Memory: an entry holds the full renderable transcript as JS objects —
// roughly 2-4x the file size on the V8 heap. maxSessions (default 4) bounds
// total cost; the LRU order is Map insertion order (get re-inserts).

import { normalize, parseRenderable, sliceWindow, type HistoryPage } from './history-reader.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'

const log = createLogger('history')

export type JsonlStat = { mtimeMs: number; size: number }

export type JsonlDeps = {
  /** Resolve a session id to its transcript file + stat. null = no file. */
  locate: (sessionId: string) => Promise<{ path: string; stat: JsonlStat } | null>
  /** Read the whole file as utf8. (Full-file IO stays: it is page-cache-hot
   *  and cheap next to parsing; incremental parsing removes the CPU cost.) */
  readFile: (path: string) => Promise<string>
}

type CacheEntry = {
  /** Renderable lines, already normalize(o, sessionId, true)-shaped. */
  lines: unknown[]
  /** Parallel uuids for beforeUuid lookup (undefined where a line has none). */
  uuids: (string | undefined)[]
  /** Character offset just past the last parsed complete line. */
  parsedChars: number
  /** stat values the entry was refreshed against (BYTE domain). */
  statSize: number
  statMtimeMs: number
}

export type JsonlPageCache = {
  readPage(sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): Promise<HistoryPage>
  invalidate(sessionId: string): void
  size(): number
}

/** Parse every COMPLETE line in `chunk` (up to and including the last '\n').
 *  Returns the renderable lines and how many characters they consumed. */
function parseCompleteLines(chunk: string): { lines: ReturnType<typeof parseRenderable>; consumedChars: number } {
  const lastNl = chunk.lastIndexOf('\n')
  if (lastNl < 0) return { lines: [], consumedChars: 0 }
  return { lines: parseRenderable(chunk.slice(0, lastNl + 1), {}), consumedChars: lastNl + 1 }
}

export function createJsonlPageCache(deps: JsonlDeps, maxSessions = 4): JsonlPageCache {
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<CacheEntry | null>>()

  const touch = (sessionId: string, entry: CacheEntry) => {
    cache.delete(sessionId)
    cache.set(sessionId, entry)
    while (cache.size > maxSessions) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const fullParse = async (sessionId: string, path: string, stat: JsonlStat): Promise<CacheEntry> => {
    const t0 = performance.now()
    const raw = await deps.readFile(path)
    // Parse the entire content — parseRenderable already skips non-renderable
    // and malformed lines. Using parseCompleteLines here would drop the last
    // line when the file lacks a trailing '\n', which is valid for the full
    // initial parse (the torn-line protection is only needed for incremental
    // append-parse where a partial line must not be cached).
    const rawLines = parseRenderable(raw, {})
    const lines = rawLines.map((l) => normalize(l, sessionId, true))
    metrics.observe('history_full_parse_ms', performance.now() - t0)
    log.debug(
      `[${sessionId}] jsonl-cache full parse: ${lines.length} lines, ${raw.length} chars in ` +
      `${(performance.now() - t0).toFixed(1)}ms`,
    )
    return { lines, uuids: rawLines.map((l) => l.uuid), parsedChars: raw.length, statSize: stat.size, statMtimeMs: stat.mtimeMs }
  }

  const resolveEntry = (sessionId: string): Promise<CacheEntry | null> => {
    const pending = inflight.get(sessionId)
    if (pending) return pending
    const job = (async () => {
      try {
        const located = await deps.locate(sessionId)
        if (!located) {
          // No transcript (never started, /clear deleted it, GC'd). Drop any
          // entry so a same-size rewrite can never hit stale content.
          cache.delete(sessionId)
          return null
        }
        const cached = cache.get(sessionId)
        if (cached) {
          if (located.stat.size === cached.statSize && located.stat.mtimeMs === cached.statMtimeMs) {
            touch(sessionId, cached)
            metrics.count('history_cache_hit')
            return cached
          }
          if (located.stat.size < cached.statSize) {
            log.debug(`[${sessionId}] jsonl-cache invalidating: file shrank (${cached.statSize} → ${located.stat.size})`)
          } else if (located.stat.size === cached.statSize) {
            log.debug(`[${sessionId}] jsonl-cache invalidating: mtime changed at constant size`)
          } else if (located.stat.size >= cached.parsedChars) {
            // Grew (or stat/read race landed us past parsedChars) — incremental
            // append parse. Can only trigger when the growth lands at/after the
            // char offset; since domains differ (bytes vs chars) this is a
            // heuristic gate: readFile below re-checks the real length.
            return appendParse(sessionId, cached, located.path, located.stat)
          }
          // else: grew in the byte domain but the growth sits INSIDE the
          // already-parsed char range (multi-byte-heavy growth or a stat/read
          // race) — full re-parse is the only safe move.
          const entry = await fullParse(sessionId, located.path, located.stat)
          touch(sessionId, entry)
          metrics.count('history_cache_miss_full')
          return entry
        }
        const entry = await fullParse(sessionId, located.path, located.stat)
        touch(sessionId, entry)
        metrics.count('history_cache_miss_full')
        return entry
      } finally {
        inflight.delete(sessionId)
      }
    })()
    inflight.set(sessionId, job)
    return job
  }

  // Defined after resolveEntry but referenced by it — function hoisting makes
  // this safe (function declaration).
  async function appendParse(sessionId: string, cached: CacheEntry, path: string, stat: JsonlStat): Promise<CacheEntry> {
    const t0 = performance.now()
    const raw = await deps.readFile(path)
    // Race guard: the file shrank between stat and read → the cached lines
    // may describe content that no longer exists. Rebuild from scratch.
    if (raw.length < cached.parsedChars) {
      log.debug(`[${sessionId}] jsonl-cache race (read shorter than parse offset) — full re-parse`)
      const entry = await fullParse(sessionId, path, stat)
      touch(sessionId, entry)
      metrics.count('history_cache_miss_full')
      return entry
    }
    const { lines: rawLines, consumedChars } = parseCompleteLines(raw.slice(cached.parsedChars))
    const lines = rawLines.map((l) => normalize(l, sessionId, true))
    metrics.observe('history_incr_parse_ms', performance.now() - t0)
    const entry: CacheEntry = lines.length
      ? {
          lines: cached.lines.concat(lines),
          uuids: cached.uuids.concat(rawLines.map((l) => l.uuid)),
          parsedChars: cached.parsedChars + consumedChars,
          statSize: stat.size,
          statMtimeMs: stat.mtimeMs,
        }
      : // Growth was a torn partial line (or whitespace) — nothing parsed yet,
        // but adopt the new stat so the hit-check sees this version as fresh.
        { ...cached, statSize: stat.size, statMtimeMs: stat.mtimeMs }
    touch(sessionId, entry)
    metrics.count('history_cache_miss_incremental')
    log.debug(`[${sessionId}] jsonl-cache incremental: +${lines.length} lines (${consumedChars} chars)`)
    return entry
  }

  return {
    async readPage(sessionId, opts) {
      const entry = await resolveEntry(sessionId)
      if (!entry) return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
      const { start, end } = sliceWindow(entry.lines.length, {
        before: opts.before,
        beforeUuid: opts.beforeUuid,
        limit: opts.limit,
        uuidAt: (i) => entry.uuids[i],
      })
      return {
        messages: entry.lines.slice(start, end),
        totalCount: entry.lines.length,
        startIndex: start,
        hasMore: start > 0,
      }
    },
    invalidate(sessionId) {
      cache.delete(sessionId)
      inflight.delete(sessionId)
    },
    size() {
      return cache.size
    },
  }
}
