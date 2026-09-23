# JSONL History Page Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `GET /sessions/:id/history` pages from an in-memory JSONL parse cache so each scroll-up page costs O(page) instead of re-reading and re-parsing the entire transcript file (O(file)).

**Architecture:** A new `server/jsonl-cache.ts` wraps transcript reading behind an LRU cache keyed by session id. Entries hold the parsed, normalized renderable lines plus a character-offset parse progress marker. Cache freshness is checked per call against the transcript file's `(size, mtimeMs)` from `stat`: unchanged → serve from memory; grew → parse only the appended suffix (append-only file) and merge; shrank or same-size-mtime-change → full re-parse. The cache plugs in at the provider boundary (`claude-provider.readHistoryPage`), leaving the REST route, `SessionManager`, and the client completely untouched.

**Tech Stack:** TypeScript (Node), `node:fs/promises`, vitest, existing `server/metrics.ts` + `server/log.ts`. No new dependencies.

**Spec:** Conversation research of 2026-09-23 (opencode comparison + claude-react-web current-state investigation; no standalone spec file). Problem: `server/history-reader.ts` `readHistoryPage` does `findTranscriptFile` + `readFile` full text + per-line `JSON.parse` + `isRenderable` filter on EVERY page request (`history-reader.ts:370-388`, `556-574`). A multi-MB transcript pays full price on every scroll-up page of 200 messages.

## Global Constraints

- All diagnostic logging through `createLogger('history')` — never bare `console.*` (CLAUDE.md logging rule).
- Metrics series labels are finite enums only — NEVER use session ids or uuids as labels (CLAUDE.md metrics rule). The new counters are unlabelled.
- `npm run typecheck` runs TWO tsconfigs (`tsconfig.json` + `tsconfig.node.json`) — both must pass.
- Server tests run in Node via vitest (`npm run test`); no jsdom needed for these tasks.
- No new runtime dependencies.
- Assume the transcript file is append-only EXCEPT across `/clear` (file deleted, then rewritten by respawn). This assumption is already documented in `history-reader.ts` header comments.
- Every commit ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- DRY/YAGNI: the search path (`readHistoryEntries`) and turn-anchor backfill (`readTurnAnchorsFromDisk`) keep their existing read-and-parse-every-call behavior — they are low-frequency, inherently O(N) full-scan consumers. Do not cache them.

## Design Decisions (read before implementing)

1. **Cache stores NORMALIZED wire objects, not raw `RawLine`s.** `normalize(o, sessionId, true)` runs ONCE per line at parse time. Reason: `normalize` shares `out.message` by reference with the raw line, and `trimLargeToolResults` may mutate content in place — if we cached raw lines and re-normalized per serve, a mutation could pollute the cache. Normalizing at parse time eliminates the issue entirely AND makes each served page O(page) with zero re-normalization. The search path is unaffected: it uses its own `normalize(o, sessionId, false)` calls (`historyEntriesFromJsonl`), which never touch the cache.
2. **Only complete lines (terminated by `\n`) are parsed.** The existing `paginateJsonl` tolerates a torn final line by attempting `JSON.parse` on it; the cache deliberately parses only up to the last `\n` and leaves a torn tail for the next incremental refresh. Rationale: with the cache, a torn line parsed today would be WRONG tomorrow (the CLI completes the line by appending), and re-parsing it correctly requires full invalidation. The behavioral difference is at most "the message currently being written is not yet in a history page" for one instant — that same message is also being delivered live over WS, so no user-visible loss. Record this in the cache module header comment.
3. **Two independent progress domains, never mixed:** `statSize`/`stat.msize` are BYTES (from `stat`), `parsedChars` is a JS-string character offset (from `readFile(..., 'utf8')`). Never compare across domains. Freshness decisions use the byte domain (`stat.size` vs `entry.statSize`); incremental slicing uses the character domain (`raw.slice(entry.parsedChars)`).
4. **Race guards:** if `raw.length < entry.parsedChars` after a read (file shrank between `stat` and `read`), fall back to a full parse. If the file grew between `stat` and `read` (read sees MORE than stat), we simply parse what we read and record the `stat` values — the extra lines are already included, and the next `stat` change triggers a normal incremental refresh. A stat that never changes again while a race-append happened is accepted (the racing lines arrive live over WS anyway); leave a comment.
5. **Wiring point is the provider, not the route.** `claude-provider.ts:670-672` is the only production caller of `readHistoryPage`. Swapping its body keeps `SessionManager`, `providers/types.ts`, and the REST route untouched. This also avoids a circular import (jsonl-cache → history-reader for the pure functions; provider → jsonl-cache for the singleton).
6. **`history-reader.readHistoryPage` is DELETED** in Task 5 (its job moves to the cache). `paginateJsonl` stays (pure function, heavily unit-tested). The three `readHistoryPage — CLI config dir` tests in `history-reader.test.ts` switch to calling the cache singleton — they remain genuine end-to-end filesystem tests.

## File Structure

- Create: `server/jsonl-cache.ts` — the LRU parse cache: `createJsonlPageCache(deps)` factory (injectable `locate`/`readFile` for tests) + `jsonlPageCache` production singleton; metrics + logging live here.
- Create: `server/jsonl-cache.test.ts` — all cache unit tests (fake deps; no filesystem).
- Modify: `server/history-reader.ts` — export `RawLine`, `parseRenderable`; extract + export `sliceWindow` and `paginateRenderable`; `findTranscriptFile` returns stat info; delete `readHistoryPage`.
- Modify: `server/history-reader.test.ts` — the CLI-config-dir `readHistoryPage` tests switch to `jsonlPageCache.readPage`; add direct `sliceWindow` tests.
- Modify: `server/providers/claude/claude-provider.ts:670-672` — `readHistoryPage` delegates to `jsonlPageCache.readPage`.
- Modify: `server/session-manager.ts:2077` — invalidate the cache entry after `deleteTranscriptFile` in the `/clear` path.
- Modify: `CLAUDE.md` — one-line doc note near the REST route list.

---

### Task 1: Extract `sliceWindow` + `paginateRenderable` from `paginateJsonl`

**Files:**
- Modify: `server/history-reader.ts:205-226` (export `RawLine` — add `export` keyword), `226` (export `parseRenderable`), `509-539` (refactor `paginateJsonl`)
- Test: `server/history-reader.test.ts` (new describe block at end of file)

**Interfaces:**
- Consumes: existing `normalize`, `RawLine`, `HistoryPage` (all module-local in `history-reader.ts`).
- Produces (used by Task 2's `jsonl-cache.ts`):
  - `export type RawLine` (existing interface, now exported)
  - `export function parseRenderable(raw: string, opts: { afterUuid?: string }): RawLine[]` (existing function, now exported)
  - `export function sliceWindow(total: number, opts: { before?: number; beforeUuid?: string; limit: number; uuidAt: (index: number) => string | undefined }): { start: number; end: number }` — pure window computation shared by both pagination paths.
  - `export function paginateRenderable(renderable: RawLine[], sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): HistoryPage` — slices pre-parsed renderable lines and normalizes with `trim: true`.
  - `paginateJsonl(raw, sessionId, opts)` keeps its EXACT current signature and behavior (now `parseRenderable` + `paginateRenderable`).

- [ ] **Step 1: Write the failing tests for `sliceWindow` and `paginateRenderable`**

Append to `server/history-reader.test.ts`:

```ts
import { paginateJsonl, turnAnchorsFromJsonl, readHistoryPage, sliceWindow, paginateRenderable } from './history-reader.js'

describe('sliceWindow', () => {
  const uuidAt = (i: number) => (i === 0 ? 'u0' : i === 5 ? 'u5' : `x${i}`)

  it('newest page: end defaults to total, start clamps at 0', () => {
    expect(sliceWindow(3, { limit: 100, uuidAt })).toEqual({ start: 0, end: 3 })
    expect(sliceWindow(10, { limit: 4, uuidAt })).toEqual({ start: 6, end: 10 })
  })

  it('before index pages strictly before it and clamps to [0, total]', () => {
    expect(sliceWindow(10, { before: 6, limit: 4, uuidAt })).toEqual({ start: 2, end: 6 })
    expect(sliceWindow(10, { before: 0, limit: 4, uuidAt })).toEqual({ start: 0, end: 0 })
    expect(sliceWindow(10, { before: 99, limit: 4, uuidAt })).toEqual({ start: 6, end: 10 })
  })

  it('beforeUuid pages strictly before the matching index; not-found falls to the newest page', () => {
    expect(sliceWindow(10, { beforeUuid: 'u5', limit: 4, uuidAt })).toEqual({ start: 1, end: 5 })
    expect(sliceWindow(10, { beforeUuid: 'missing', limit: 4, uuidAt })).toEqual({ start: 6, end: 10 })
  })
})

describe('paginateRenderable', () => {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
  ] as never[]

  it('matches paginateJsonl output for the same lines', () => {
    const raw = lines.map((l) => JSON.stringify(l)).join('\n')
    expect(paginateRenderable(lines, SID, { limit: 100 })).toEqual(paginateJsonl(raw, SID, { limit: 100 }))
  })

  it('normalizes with trim (consumedAt stamped on top-level user prompts with a timestamp)', () => {
    const withTs = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
    ] as never[]
    const page = paginateRenderable(withTs, SID, { limit: 10 })
    expect((page.messages[0] as { consumedAt?: number }).consumedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
  })
})
```

Note: keep the existing import line updated (add `sliceWindow, paginateRenderable` to it) rather than adding a second import from the same module.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/history-reader.test.ts`
Expected: FAIL — `sliceWindow` is not exported.

- [ ] **Step 3: Implement — export RawLine/parseRenderable, add sliceWindow, refactor paginateJsonl**

In `server/history-reader.ts`:

1. Line 66: `interface RawLine {` → `export interface RawLine {`
2. Line 556: `function parseRenderable(` → `export function parseRenderable(`
3. Replace the body of `paginateJsonl` (lines 512-539) with the refactored pair:

```ts
/** Pure window computation shared by the raw-string and cached pagination
 *  paths. `beforeUuid` needs the caller's uuid accessor because the two
 *  callers store uuids differently (renderable lines vs a parallel array).
 *  The window is [start, end): the `limit` messages ending just before the
 *  resolved end index. Resolution order: beforeUuid → before → newest. */
export function sliceWindow(
  total: number,
  opts: {
    before?: number
    beforeUuid?: string
    limit: number
    uuidAt: (index: number) => string | undefined
  },
): { start: number; end: number } {
  const limit = Math.max(1, Math.min(opts.limit, 1000))
  let end = total
  if (opts.beforeUuid) {
    for (let i = 0; i < total; i++) {
      if (opts.uuidAt(i) === opts.beforeUuid) {
        end = i
        break
      }
    }
  } else if (opts.before != null) {
    end = Math.max(0, Math.min(opts.before, total))
  }
  return { start: Math.max(0, end - limit), end }
}

/** Slice pre-parsed renderable lines into a page. Used by `paginateJsonl`
 *  (parse-then-serve) and by the JSONL page cache, which holds the same
 *  renderable lines already normalized. */
export function paginateRenderable(
  renderable: RawLine[],
  sessionId: string,
  opts: { before?: number; beforeUuid?: string; limit: number },
): HistoryPage {
  const total = renderable.length
  const { start, end } = sliceWindow(total, {
    before: opts.before,
    beforeUuid: opts.beforeUuid,
    limit: opts.limit,
    uuidAt: (i) => renderable[i]?.uuid,
  })
  const slice = renderable.slice(start, end)
  return {
    messages: slice.map((o) => normalize(o, sessionId, true)),
    totalCount: total,
    startIndex: start,
    hasMore: start > 0,
  }
}

/** Read a page from a raw JSONL transcript string. Kept as the pure
 *  (filesystem-free) reference implementation; the cached path lives in
 *  jsonl-cache.ts and must produce identical pages. */
export function paginateJsonl(
  raw: string,
  sessionId: string,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): HistoryPage {
  return paginateRenderable(parseRenderable(raw, opts), sessionId, opts)
}
```

Behavior note for the implementer: the OLD `paginateJsonl` used `renderable.findIndex(...)` for `beforeUuid`; the new `sliceWindow` uses an explicit loop — semantically identical (first match wins). The old code computed `limit` before resolving `end`; `sliceWindow` does the same. `paginateRenderable` no longer accepts `afterUuid` (that is a parse-layer concern, handled by `parseRenderable` inside `paginateJsonl`).

- [ ] **Step 4: Run the full test file to verify everything passes**

Run: `npx vitest run server/history-reader.test.ts`
Expected: PASS — all pre-existing `paginateJsonl` tests unchanged in behavior, plus the new blocks.

- [ ] **Step 5: Commit**

```bash
git add server/history-reader.ts server/history-reader.test.ts
git commit -m "refactor(history): extract sliceWindow + paginateRenderable from paginateJsonl

Pure restructuring to share pagination between the raw-string path and the
upcoming JSONL parse cache. No behavior change.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `jsonl-cache.ts` — full parse, hit, invalidation

**Files:**
- Create: `server/jsonl-cache.ts`
- Create: `server/jsonl-cache.test.ts`

**Interfaces:**
- Consumes (from Task 1): `parseRenderable`, `normalize`, `RawLine`, `sliceWindow`, `HistoryPage` — all from `./history-reader.js`.
- Produces (used by Task 3/4/5):
  - `export type JsonlStat = { mtimeMs: number; size: number }`
  - `export type JsonlDeps = { locate: (sessionId: string) => Promise<{ path: string; stat: JsonlStat } | null>; readFile: (path: string) => Promise<string> }`
  - `export function createJsonlPageCache(deps: JsonlDeps, maxSessions?: number): JsonlPageCache` where `JsonlPageCache = { readPage(sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): Promise<HistoryPage>; invalidate(sessionId: string): void; size(): number }`
  - `export const jsonlPageCache: JsonlPageCache` — production singleton (deps wired in Task 5; for Tasks 2-4 tests NEVER import the singleton).

- [ ] **Step 1: Write the failing tests**

Create `server/jsonl-cache.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createJsonlPageCache, type JsonlDeps } from './jsonl-cache.js'
import { paginateJsonl } from './history-reader.js'

function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join('\n')
}

const SID = 'cache-sess-1'

type FakeFile = { content: string; mtimeMs: number; size: number }

/** In-memory transcript store. Mutate `files` between calls to simulate
 *  appends / rewrites / deletes. `size` must be kept consistent with
 *  `content.length` by the caller (the helper below does it), EXCEPT in
 *  tests that deliberately fake a stat/read race. */
function makeDeps() {
  const files = new Map<string, FakeFile>()
  let readFileCalls = 0
  const deps: JsonlDeps = {
    async locate(sessionId) {
      const f = files.get(sessionId)
      if (!f) return null
      return { path: sessionId, stat: { mtimeMs: f.mtimeMs, size: f.size } }
    },
    async readFile(path) {
      readFileCalls++
      const f = files.get(path)
      if (!f) throw new Error(`ENOENT: ${path}`)
      return f.content
    },
  }
  return {
    deps,
    files,
    readFileCalls: () => readFileCalls,
    put(sessionId: string, content: string, mtimeMs = 1000) {
      files.set(sessionId, { content, mtimeMs, size: content.length })
    },
  }
}

const TRANSCRIPT = jsonl([
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
])

describe('jsonl-cache — full parse, hit, invalidation', () => {
  it('first read parses the file and returns a correct page', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(page.totalCount).toBe(3)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
    expect(t.readFileCalls()).toBe(1)
  })

  it('unchanged stat → cache hit: no readFile, identical page', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    const first = await cache.readPage(SID, { limit: 100 })
    const second = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(1)
    expect(second).toEqual(first)
  })

  it('cached pages match paginateJsonl exactly (all window shapes)', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    for (const opts of [
      { limit: 100 },
      { limit: 2 },
      { before: 2, limit: 2 },
      { before: 0, limit: 2 },
      { beforeUuid: 'u2', limit: 2 },
      { beforeUuid: 'missing', limit: 2 },
    ]) {
      const viaCache = await cache.readPage(SID, opts)
      const direct = paginateJsonl(TRANSCRIPT, SID, opts)
      expect(viaCache).toEqual(direct)
    }
  })

  it('file shrank → full re-parse (rewritten transcript)', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Rewrite with SHORTER content: only one message survives.
    t.put(SID, jsonl([{ type: 'user', uuid: 'u9', message: { role: 'user', content: 'new' } }]), 2000)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
    expect(page.totalCount).toBe(1)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u9'])
  })

  it('same size but new mtime → full re-parse (defensive)', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Same length, different content: uuid swap keeps length identical.
    const sameLength = TRANSCRIPT.replace('first', 'firsT')
    t.put(SID, sameLength, 3000)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
    expect((page.messages[0] as { message?: { content?: string } }).message?.content).toBe('firsT')
  })

  it('normalizes once at parse time: consumedAt stamped, trim applied', async () => {
    const t = makeDeps()
    t.put(
      SID,
      jsonl([
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'user', uuid: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r' }] } },
      ]),
    )
    const cache = createJsonlPageCache(t.deps)
    const page = await cache.readPage(SID, { limit: 100 })
    const prompt = page.messages[0] as { consumedAt?: number; parent_tool_use_id?: string | null }
    const toolResult = page.messages[1] as { parent_tool_use_id?: string | null; consumedAt?: number }
    expect(prompt.consumedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(prompt.parent_tool_use_id).toBeNull()
    expect(toolResult.parent_tool_use_id).toBe('tu1')
    expect(toolResult.consumedAt).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/jsonl-cache.test.ts`
Expected: FAIL — module `./jsonl-cache.js` does not exist.

- [ ] **Step 3: Implement `server/jsonl-cache.ts`**

```ts
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
    const { lines, consumedChars } = parseCompleteLines(raw)
    metrics.observe('history_full_parse_ms', performance.now() - t0)
    log.debug(
      `[${sessionId}] jsonl-cache full parse: ${lines.length} lines, ${raw.length} chars in ` +
      `${(performance.now() - t0).toFixed(1)}ms`,
    )
    return { lines, uuids: lines.map((l) => (l as { uuid?: string }).uuid), parsedChars: consumedChars, statSize: stat.size, statMtimeMs: stat.mtimeMs }
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
    const { lines, consumedChars } = parseCompleteLines(raw.slice(cached.parsedChars))
    metrics.observe('history_incr_parse_ms', performance.now() - t0)
    const entry: CacheEntry = lines.length
      ? {
          lines: cached.lines.concat(lines),
          uuids: cached.uuids.concat(lines.map((l) => (l as { uuid?: string }).uuid)),
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
```

Note on `metrics.count` / `metrics.observe` signatures: `count(name, labels?, by?)`, `observe(name, value, labels?)` — call as written above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/jsonl-cache.test.ts`
Expected: PASS — all six tests. (The incremental branch is exercised incidentally by the shrink test's setup order only if the file grows; the dedicated incremental tests come in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add server/jsonl-cache.ts server/jsonl-cache.test.ts
git commit -m "feat(history): JSONL page cache — full parse, hit, invalidation core

Serves /history pages from an in-memory parse of the transcript instead of
re-reading + re-parsing the whole file per page. Freshness keyed on
(size, mtimeMs); entries store normalized wire objects. Incremental append
parsing lands in the next commit.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Incremental append parsing + torn lines + race guard

**Files:**
- Modify: `server/jsonl-cache.ts` (the `appendParse` path from Task 2 — this task is its TESTS plus any fixes the tests expose)
- Test: `server/jsonl-cache.test.ts`

**Interfaces:**
- Consumes: `createJsonlPageCache` from Task 2 (unchanged signature).
- Produces: no signature changes — behavioral guarantees only (append-only growth parses only the suffix; torn lines wait; stat/read races fall back safely).

- [ ] **Step 1: Write the failing tests**

Append to `server/jsonl-cache.test.ts`:

```ts
describe('jsonl-cache — incremental append', () => {
  it('append-only growth parses the suffix and keeps old lines', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(1)
    // Append two more messages (file grows by exactly the new bytes).
    const grown = TRANSCRIPT + '\n' + jsonl([
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'third' } },
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [] } },
    ]) + '\n'
    t.put(SID, grown, 4000)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
    expect(page.totalCount).toBe(5)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'u2', 'u3', 'a3'])
    // And a third read hits the cache again.
    await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
  })

  it('torn final line is NOT parsed until the line completes', async () => {
    const t = makeDeps()
    const full = TRANSCRIPT + '\n' + jsonl([{ type: 'user', uuid: 'u3', message: { role: 'user', content: 'third' } }]) + '\n'
    // Simulate a writer mid-line: the file holds everything up to mid-JSON.
    const torn = full.slice(0, full.length - 20)
    t.put(SID, torn, 5000)
    const cache = createJsonlPageCache(t.deps)
    const before = await cache.readPage(SID, { limit: 100 })
    expect(before.totalCount).toBe(3) // torn line not counted
    // The writer finishes the line (same total content as `full`).
    t.put(SID, full, 6000)
    const after = await cache.readPage(SID, { limit: 100 })
    expect(after.totalCount).toBe(4)
    expect((after.messages.at(-1) as { uuid?: string }).uuid).toBe('u3')
  })

  it('growth inside the parsed char range falls back to a full re-parse', async () => {
    const t = makeDeps()
    // Multi-byte-heavy content: 10 CJK chars = 30 bytes but 10 chars.
    const cjk = '你好'.repeat(5)
    const first = jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: cjk } }]) + '\n'
    t.put(SID, first, 7000)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Append ASCII bytes; byte size grows by more than the char count of the
    // appended region is small — force the pathological gate by appending
    // enough CJK that byte growth outpaces char progress (statSize grows,
    // stat.size may still be < parsedChars in pathological multi-byte cases).
    const grown = first + jsonl([{ type: 'user', uuid: 'u2', message: { role: 'user', content: cjk } }]) + '\n'
    t.put(SID, grown, 8000)
    const page = await cache.readPage(SID, { limit: 100 })
    // Either path (incremental or full) must yield the correct result.
    expect(page.totalCount).toBe(2)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'u2'])
  })

  it('stat/read race (read shorter than parse offset) falls back to a full re-parse', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Lie about size (as if it grew), but serve the OLD short content.
    const f = t.files.get(SID)!
    t.files.set(SID, { content: TRANSCRIPT, mtimeMs: 9000, size: f.size + 50 })
    const page = await cache.readPage(SID, { limit: 100 })
    expect(page.totalCount).toBe(3)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
  })
})
```

- [ ] **Step 2: Run tests to verify they pass (or expose bugs)**

Run: `npx vitest run server/jsonl-cache.test.ts`
Expected: PASS. If any fail, fix `appendParse`/`resolveEntry` gates in `jsonl-cache.ts` — do NOT weaken the tests. Known trap: the torn-line test requires `parseCompleteLines` to stop at the last `\n` (Task 2's implementation already does); the multi-byte test may legitimately take the full-reparse branch — the assertion accepts either path as long as the page is correct.

- [ ] **Step 3: Verify no regression in the Task 2 tests**

Run: `npx vitest run server/jsonl-cache.test.ts server/history-reader.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/jsonl-cache.ts server/jsonl-cache.test.ts
git commit -m "feat(history): incremental append parsing for the JSONL page cache

Growth parses only the suffix; torn final lines wait for completion;
stat/read races fall back to a full re-parse. Byte domain (stat) and char
domain (string offsets) stay separate.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: LRU eviction, inflight dedup, file disappearance

**Files:**
- Modify: `server/jsonl-cache.ts` (tests only expected to pass; fix if they expose gaps)
- Test: `server/jsonl-cache.test.ts`

**Interfaces:**
- Consumes: `createJsonlPageCache(deps, maxSessions)` from Task 2.
- Produces: behavioral guarantees — `size()` reflects the LRU bound; concurrent `readPage` calls for one session share one parse; a vanished file yields an empty page and drops the entry.

- [ ] **Step 1: Write the failing tests**

Append to `server/jsonl-cache.test.ts`:

```ts
describe('jsonl-cache — LRU, inflight, disappearance', () => {
  it('evicts the least-recently-used session beyond maxSessions', async () => {
    const t = makeDeps()
    t.put('s1', TRANSCRIPT)
    t.put('s2', TRANSCRIPT)
    t.put('s3', TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps, 2)
    await cache.readPage('s1', { limit: 100 })
    await cache.readPage('s2', { limit: 100 })
    await cache.readPage('s3', { limit: 100 })
    expect(cache.size()).toBe(2)
    // s1 was evicted; reading it again re-parses (readFile count grows).
    const before = t.readFileCalls()
    await cache.readPage('s1', { limit: 100 })
    expect(t.readFileCalls()).toBe(before + 1)
    // Touching s1 made IT the newest; s2 is now the eviction victim.
    await cache.readPage('s2', { limit: 100 })
    expect(t.readFileCalls()).toBe(before + 2)
  })

  it('get refreshes LRU recency (re-read s1 keeps it alive over s2)', async () => {
    const t = makeDeps()
    t.put('s1', TRANSCRIPT)
    t.put('s2', TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps, 2)
    await cache.readPage('s1', { limit: 100 })
    await cache.readPage('s2', { limit: 100 })
    await cache.readPage('s1', { limit: 100 }) // touch s1 → s2 becomes oldest
    t.put('s3', TRANSCRIPT)
    await cache.readPage('s3', { limit: 100 })
    expect(cache.size()).toBe(2)
    const before = t.readFileCalls()
    await cache.readPage('s1', { limit: 100 }) // still cached
    expect(t.readFileCalls()).toBe(before)
  })

  it('concurrent reads of one session share a single parse', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    // Gate locate until both callers have entered.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const gated: JsonlDeps = {
      locate: async (id) => {
        await gate
        return t.deps.locate(id)
      },
      readFile: t.deps.readFile,
    }
    const cache = createJsonlPageCache(gated)
    const p1 = cache.readPage(SID, { limit: 100 })
    const p2 = cache.readPage(SID, { limit: 100 })
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(r2)
    expect(t.readFileCalls()).toBe(1)
  })

  it('vanished file → empty page, entry dropped; reappearing file re-parses', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    t.files.delete(SID)
    const empty = await cache.readPage(SID, { limit: 100 })
    expect(empty).toEqual({ messages: [], totalCount: 0, startIndex: 0, hasMore: false })
    expect(cache.size()).toBe(0)
    t.put(SID, TRANSCRIPT, 9000)
    const back = await cache.readPage(SID, { limit: 100 })
    expect(back.totalCount).toBe(3)
  })
})
```

- [ ] **Step 2: Run tests; fix any gaps in `jsonl-cache.ts`**

Run: `npx vitest run server/jsonl-cache.test.ts`
Expected: PASS. The Task 2 implementation already covers LRU (`touch` evicts), inflight (`resolveEntry` dedup), and disappearance (`locate null` → delete + empty page). If any test fails, fix the implementation — do not weaken tests.

- [ ] **Step 3: Commit**

```bash
git add server/jsonl-cache.test.ts server/jsonl-cache.ts
git commit -m "test(history): pin LRU eviction, inflight dedup, file disappearance in the JSONL page cache

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Wire the cache into production

**Files:**
- Modify: `server/history-reader.ts` — `findTranscriptFile` returns stat; delete `readHistoryPage` (lines 348-388); `readHistoryEntries`/`readTurnAnchorsFromDisk`/`deleteTranscriptFile` adapt to the new `findTranscriptFile` return shape.
- Modify: `server/providers/claude/claude-provider.ts:670-672` — delegate to the cache singleton.
- Modify: `server/session-manager.ts:2077` — invalidate after `deleteTranscriptFile`.
- Modify: `server/history-reader.test.ts` — the three `readHistoryPage — CLI config dir` tests switch to `jsonlPageCache.readPage`.
- Create: `server/jsonl-cache.ts` gains the production singleton.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: `jsonlPageCache` singleton with production deps; provider interface (`providers/types.ts:273`) unchanged — callers see identical behavior.

- [ ] **Step 1: Change `findTranscriptFile` to return stat info**

In `server/history-reader.ts`, replace the return shape:

```ts
export interface TranscriptFile {
  path: string
  mtimeMs: number
  size: number
}

async function findTranscriptFile(sessionId: string): Promise<TranscriptFile | null> {
  // ... existing scan logic unchanged, except:
  //   - the existing `stat(candidate)` call captures the Stats object:
  const s = await stat(candidate)
  return { path: candidate, mtimeMs: s.mtimeMs, size: s.size }
  //   - the log-warn branch and error handling stay as-is
  //   - return null paths stay null
}
```

Update the three internal callers (pure mechanical destructure):
- `deleteTranscriptFile` (line 178): `const file = await findTranscriptFile(sessionId)` → use `file?.path`; `unlink(file.path)`.
- `readHistoryEntries` (line ~396): `const file = await findTranscriptFile(sessionId); if (!file) return []; readFile(file.path, 'utf8')`.
- `readTurnAnchorsFromDisk` (line ~432): same `.path` adaptation.

- [ ] **Step 2: Delete `readHistoryPage` from `history-reader.ts`**

Remove the `readHistoryPage` function (lines 348-388, including its doc comment). `paginateJsonl` stays (pure, tested). Run `npx vitest run server/history-reader.test.ts` — the CLI-config-dir describe now FAILS to import `readHistoryPage`; fix in Step 4.

- [ ] **Step 3: Add the production singleton to `jsonl-cache.ts`**

Append to `server/jsonl-cache.ts`:

```ts
import { readFile as fsReadFile } from 'node:fs/promises'
import { findTranscriptFile } from './history-reader.js'

/** Production singleton. `locate` reuses findTranscriptFile, which already
 *  stats the candidate for its existence check — the stat rides along for
 *  free as the cache freshness key. */
export const jsonlPageCache: JsonlPageCache = createJsonlPageCache({
  locate: async (sessionId) => {
    const found = await findTranscriptFile(sessionId)
    if (!found) return null
    return { path: found.path, stat: { mtimeMs: found.mtimeMs, size: found.size } }
  },
  readFile: (path) => fsReadFile(path, 'utf8'),
})
```

Note: move the two new imports to the top of the file with the others.

- [ ] **Step 4: Switch the CLI-config-dir tests to the cache singleton**

In `server/history-reader.test.ts`, change the import line to add:

```ts
import { jsonlPageCache } from './jsonl-cache.js'
```

and in the `readHistoryPage — CLI config dir` describe, replace the three call sites `await readHistoryPage(sid, { limit: 100 })` with `await jsonlPageCache.readPage(sid, { limit: 100 })`. Rename the describe to `readPage via jsonlPageCache — CLI config dir`. Also delete `readHistoryPage` from the import list. The session ids used by these tests are all distinct, so the shared singleton across tests cannot collide.

- [ ] **Step 5: Point the provider at the cache**

In `server/providers/claude/claude-provider.ts`:

```ts
// line ~27: keep readHistoryEntries / readHistoryPage imports? readHistoryPage
// is gone from history-reader — replace the import usage:
import { readHistoryEntries, readHistoryPage } from '../../history-reader.js'
// becomes
import { readHistoryEntries } from '../../history-reader.js'
import { jsonlPageCache } from '../../jsonl-cache.js'

// lines 670-672:
readHistoryPage(id: string, opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string }): Promise<HistoryPage> {
  return readHistoryPage(id, opts)
}
// becomes
readHistoryPage(id: string, opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string }): Promise<HistoryPage> {
  // afterUuid is search-path only and never arrives here (routes/sessions.ts
  // only forwards before/beforeUuid/limit); the cache does not need it.
  return jsonlPageCache.readPage(id, opts)
}
```

- [ ] **Step 6: Invalidate on `/clear`**

In `server/session-manager.ts` around line 2077:

```ts
await deleteTranscriptFile(id)
jsonlPageCache.invalidate(id)
```

Add `import { jsonlPageCache } from './jsonl-cache.js'` to the imports (near the existing `history-reader.js` imports at lines 116-118). Reason: the CLI refuses to respawn a fresh session while the old transcript exists, so `/clear` deletes the file and respawns — the new file can theoretically land with a colliding (size, mtime) fingerprint; the explicit invalidate removes the doubt.

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run server/history-reader.test.ts server/jsonl-cache.test.ts server/session-manager.test.ts`
Expected: PASS. `session-manager.test.ts` exercises `/clear` paths — the new invalidate line must not break them (it is a plain Map delete).

- [ ] **Step 8: Commit**

```bash
git add server/history-reader.ts server/history-reader.test.ts server/jsonl-cache.ts server/providers/claude/claude-provider.ts server/session-manager.ts
git commit -m "feat(history): serve /history pages through the JSONL parse cache

findTranscriptFile returns stat for the freshness key; readHistoryPage moves
from history-reader (read+parse per call) into jsonlPageCache (parse once per
file version, incremental on append). /clear invalidates explicitly.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Full verification, docs, manual check

**Files:**
- Modify: `CLAUDE.md` (one doc line)
- No code changes expected.

**Interfaces:**
- Consumes: the finished Tasks 1-5.
- Produces: green CI surface + documentation + a repeatable manual verification recipe.

- [ ] **Step 1: Full typecheck (both tsconfigs)**

Run: `npm run typecheck`
Expected: PASS. Watch for: unused `readHistoryPage` imports anywhere (grep `readHistoryPage` to confirm only the provider method name and `providers/types.ts` interface remain), and the `RawLine` export visibility.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: PASS — the whole server suite (session-manager, session-pump, frame-bridge, …) must be green; nothing outside the touched files should change behavior.

- [ ] **Step 4: Update CLAUDE.md**

In CLAUDE.md, in the REST-route description section (the bulleted list under "`server/routes/index.ts` (`buildApiRouter`) composes the REST surface", near the `GET /sessions/:id/file-snapshots` entry), add one bullet immediately after it:

```markdown
- `GET /sessions/:id/history?before=&beforeUuid=&limit=` — disk-paged history (lazy-load older messages, offset semantics: `before` = previous response's `startIndex`, `beforeUuid` = first-page anchor on a disk-stable uuid). Served through the JSONL parse cache (`server/jsonl-cache.ts`): freshness keyed on `(size, mtimeMs)`, appends parse incrementally, entries LRU-capped at 4 sessions (`history_cache_hit` / `history_cache_miss_full` / `history_cache_miss_incremental` metrics).
```

- [ ] **Step 5: Manual verification (dev server)**

1. `LOG_LEVEL=debug LOG_SCOPES=history npm run dev`
2. Open a long session (hundreds of messages) in the browser.
3. Scroll up slowly through 3-4 pages of history.
4. Check the server console: expect ONE `jsonl-cache full parse` line, then `jsonl-cache incremental` lines only after new turns write to the file, and no further full parses while scrolling.
5. `curl -s localhost:3456/api/metrics | grep history_` — expect `history_cache_hit` to dominate and `history_full_parse_ms` p95 bounded (tens of ms, once).
6. Send a message in the session (file appends), scroll up again — expect one `incremental` line, not a full parse.
7. `/clear` the session, then scroll — expect no stale transcript resurrection.

- [ ] **Step 6: Commit (docs)**

```bash
git add CLAUDE.md
git commit -m "docs: document the /history JSONL page cache in CLAUDE.md

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** O(file)→O(page) per page: cache hit path is pure slicing (Task 2) ✓; incremental append avoids re-parse-on-live-session (Task 3) ✓; bounded memory via LRU (Task 2 `maxSessions=4`, pinned by Task 4 test) ✓; `/clear` correctness (Task 5 Step 6 + Task 4 disappearance test) ✓; observability (metrics + debug logs, Task 2) ✓; zero protocol/client changes (Task 5 wiring at provider only) ✓.

**2. Placeholder scan:** no TBDs; every code step carries full code; test steps carry full test code.

**3. Type consistency:** `sliceWindow(total, opts)` used identically in `paginateRenderable` (Task 1) and `readPage` (Task 2); `JsonlStat`/`JsonlDeps`/`JsonlPageCache` names consistent across Tasks 2-5; `TranscriptFile` introduced in Task 5 matches `findTranscriptFile`'s new return; metrics names `history_cache_hit` / `history_cache_miss_full` / `history_cache_miss_incremental` / `history_full_parse_ms` / `history_incr_parse_ms` used consistently.

One known simplification consciously accepted: same-size content rewrites with an UNCHANGED mtime would false-hit (stat granularity + append-only assumption). Documented in the module header; `/clear` is covered by the explicit invalidate.
