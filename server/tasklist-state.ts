// Server-side derivation of the TaskCreate/TaskUpdate checklist state from
// the FULL transcript (the durable CLI JSONL via jsonl-cache). The client
// folds only its in-memory window, so creates beyond the ring/memory cap
// degrade to `Task #N` stubs — this module is the authoritative base layer
// the client merges under its window fold (shared/task-list.ts#mergeTaskList).
//
// No new persistence: the transcript IS the persistence. Every call re-folds
// the cached parsed lines (O(lines) over already-parsed JS objects — ms at
// multi-thousand-line scale), so state is always a pure function of the
// transcript: no write path, no crash-recovery divergence.
//
// Coverage note: CLI 2.x persists subagent turns under `<sid>/subagents/`
// and this module folds them in (their Task* events exist nowhere else).
// PRE-2.x transcripts that wrote sidechain lines INLINE into the main JSONL
// stay invisible — jsonl-cache's parseRenderable drops isSidechain lines —
// so tasks completed by inline sidechains on those old sessions still read
// as in_progress here.

import { performance } from 'node:perf_hooks'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { jsonlPageCache } from './jsonl-cache.js'
import { findTranscriptFile } from './history-reader.js'
import { resolveSubagentDir, splitCompleteLines, parseRawJsonLines } from './subagent-transcripts.js'
import { metrics } from './metrics.js'
import { createLogger } from './log.js'
import {
  buildTaskStateMap,
  countTaskEvents,
  isGenuineUserInputFrame,
  type TasklistSnapshotPayload,
  type TasklistSnapshotTask,
} from '../shared/task-list.js'

const log = createLogger('tasklist')

/** Pure fold over transcript lines. `boundary` is the line index of the
 *  last genuine human input; a resolved task last touched strictly before
 *  it is flagged stale (the "user has moved on" cleanup, computed with
 *  full-transcript coordinates the client window cannot see).
 *
 *  The boundary scan adds the DISK-side exclusion on top of the shared
 *  live-frame discriminator: subagent-transcript lines (folded in here)
 *  carry isSidechain:true but NO parent_tool_use_id — that field exists
 *  only on live wire frames — and a subagent's prompt is not the user
 *  moving on. */
export function deriveTaskListFromLines(lines: readonly unknown[]): TasklistSnapshotPayload {
  let boundary = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as Parameters<typeof isGenuineUserInputFrame>[0]
    if (isGenuineUserInputFrame(line) && line.isSidechain !== true) {
      boundary = i
      break
    }
  }
  const tasks = buildTaskStateMap(lines)
  const rev = countTaskEvents(lines)
  if (!tasks) return { rev: 0, tasks: [] }
  const out: TasklistSnapshotTask[] = []
  for (const t of tasks.values()) {
    // In-flight creates (result not yet on disk) never enter the snapshot —
    // the client's window fold owns them via its pending:<toolUseId> key.
    if (t.provisional) continue
    const resolved = t.status === 'completed' || t.status === 'cancelled'
    out.push({
      id: t.id,
      subject: t.subject,
      ...(t.description !== undefined ? { description: t.description } : {}),
      status: t.status,
      ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
      stale: resolved && t.lastTouched < boundary,
    })
  }
  return { rev, tasks: out }
}

/** Stable timestamp merge of the main transcript lines and the subagent
 *  transcript lines. The two sides arrive in DIFFERENT shapes — main lines
 *  are jsonl-cache's NORMALIZED wire frames (ISO timestamp already turned
 *  into `receivedAt` epoch ms by history-reader's normalize), subagent
 *  lines are raw CLI disk lines still carrying the ISO `timestamp` — so
 *  the sort key must unify both, or every main line sorts first and the
 *  interleaving (and with it the stale boundary) is garbage. Sorting a
 *  [main…, sub…] concatenation with the standard stable sort keeps
 *  main-first on ties. The fold's `lastTouched` coordinates are only
 *  meaningful in this merged order — appending subagent lines at the END
 *  would push their events past the stale boundary and make every
 *  subagent-completed task look current. */
export function mergeTranscriptLines(
  main: readonly unknown[],
  sub: readonly unknown[],
): unknown[] {
  // Decorate-sort-undecorate: sortInstantOf re-runs Date.parse per
  // comparison on raw subagent lines, so precompute the instant once.
  const decorated = main.concat(sub).map((line) => ({ line, key: sortInstantOf(line) }))
  decorated.sort((a, b) => a.key - b.key)
  return decorated.map((e) => e.line)
}

/** Epoch-ms instant of a line in either shape; -Infinity for lines with no
 *  usable time. Every user/assistant line the CLI writes carries an ISO
 *  timestamp (verified against real session files), so -Infinity exists for
 *  hypothetical corrupt lines only; front-positioning is the documented
 *  guess for a shape we cannot date.
 *
 *  Clock caveat: main lines' receivedAt is stamped when the host RECEIVED
 *  the frame (>= the CLI's write instant), subagent lines carry the CLI's
 *  own write time — millisecond skew between the two clocks is inherent.
 *  The stale boundary is a coarse "user moved on" heuristic (human inputs
 *  are seconds apart from task events), so the skew is immaterial there. */
function sortInstantOf(line: unknown): number {
  const l = line as { receivedAt?: unknown; timestamp?: unknown } | undefined
  if (typeof l?.receivedAt === 'number' && Number.isFinite(l.receivedAt)) return l.receivedAt
  if (typeof l?.timestamp === 'string') {
    const t = Date.parse(l.timestamp)
    if (Number.isFinite(t)) return t
  }
  return Number.NEGATIVE_INFINITY
}

/** Injected IO for {@link createSubagentLineReader} — the minimal slice the
 *  reader uses, so tests can stub with plain lambdas. */
export interface SubagentIo {
  readdir: (path: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ size: number; mtimeMs: number }>
}

const subagentIo: SubagentIo = {
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, 'utf8'),
  stat: (p) => stat(p),
}

/** One cached subagent file: freshness key + parsed user/assistant lines.
 *  Same (size, mtimeMs) freshness model as jsonl-cache — JSONL is
 *  append-only, so growth is the only normal change. */
type CachedSubagentFile = { statSize: number; statMtimeMs: number; lines: unknown[] }

/** File-count backstop. Only live sessions receiving Task* events get
 *  derive calls, so in practice this holds a handful of sessions'
 *  sidechain files; the byte budget below is the real bound. */
const SUBAGENT_CACHE_MAX_FILES = 256

/** Source-byte budget for the parsed-line cache (parsed JS heap runs a few
 *  times this). Sized so a session like the 15MB/23-file reference one fits
 *  whole while a handful of concurrent heavy sessions stay bounded. */
const DEFAULT_SUBAGENT_CACHE_BYTES = 64 * 1024 * 1024

/** Create the subagent-line reader. The derived derive path fires per Task
 *  tool_result AND per echoed top-level user message, and a subagent-heavy
 *  session's `subagents/` dir can reach tens of MB (API-request blobs are
 *  the bulk) — re-reading + re-parsing all of it per fire measured ~50ms of
 *  event-loop-blocking JSON.parse on a real 15MB/23-file session. This cache
 *  makes the steady-state derive a few stats + in-memory array reuse; the
 *  main transcript's equivalent guarantee lives in jsonlPageCache.
 *
 *  The budget is on SOURCE bytes (parsed heap runs a few times that) with a
 *  file-count backstop; entries evict LRU (Map insertion order). Deleted
 *  sessions' entries age out through the same LRU — no delete hook needed. */
export function createSubagentLineReader(
  io: SubagentIo,
  opts?: { maxBytes?: number; maxFiles?: number },
) {
  const maxBytes = opts?.maxBytes ?? DEFAULT_SUBAGENT_CACHE_BYTES
  const maxFiles = opts?.maxFiles ?? SUBAGENT_CACHE_MAX_FILES
  const cache = new Map<string, CachedSubagentFile>()
  let totalBytes = 0
  return async function readSubagentTranscriptLines(
    mainPath: string,
    sessionId: string,
  ): Promise<unknown[]> {
    const dir = resolveSubagentDir(mainPath, sessionId)
    let names: string[]
    try {
      names = (await io.readdir(dir)).filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl')).sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    // Batch the independent stats; a sequential loop made the cold derive
    // pay one fs round-trip per file.
    const located = await Promise.all(names.map(async (name) => {
      const file = path.join(dir, name)
      try {
        return { name, file, st: await io.stat(file) }
      } catch (err) {
        // Deleted (or otherwise unstatable) between readdir and here — skip
        // this file, the rest of the session's sidechain evidence still folds.
        log.warn(`[${sessionId}] subagent transcript stat failed for ${name}: ${(err as Error).message}`)
        return null
      }
    }))
    const out: unknown[] = []
    const misses: { name: string; file: string; st: { size: number; mtimeMs: number } }[] = []
    for (const entry of located) {
      if (!entry) continue
      const cached = cache.get(entry.file)
      if (cached && cached.statSize === entry.st.size && cached.statMtimeMs === entry.st.mtimeMs) {
        cache.delete(entry.file)
        cache.set(entry.file, cached) // LRU refresh
        for (const line of cached.lines) out.push(line)
      } else {
        misses.push(entry)
      }
    }
    const read = await Promise.all(misses.map(async ({ name, file, st }) => {
      try {
        return { file, st, lines: parseSubagentFileLines(await io.readFile(file)) }
      } catch (err) {
        log.warn(`[${sessionId}] subagent transcript read failed for ${name}: ${(err as Error).message}`)
        return null
      }
    }))
    for (const entry of read) {
      if (!entry) continue
      const prev = cache.get(entry.file)
      if (prev) { totalBytes -= prev.statSize; cache.delete(entry.file) }
      cache.set(entry.file, { statSize: entry.st.size, statMtimeMs: entry.st.mtimeMs, lines: entry.lines })
      totalBytes += entry.st.size
      for (const line of entry.lines) out.push(line)
    }
    while (totalBytes > maxBytes || cache.size > maxFiles) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      totalBytes -= cache.get(oldest)!.statSize
      cache.delete(oldest)
    }
    return out
  }
}

/** Parse one subagent transcript file down to the lines the tasklist fold
 *  reads (user / assistant). `splitCompleteLines` excludes a torn final
 *  line; blank + corrupt tolerance comes from the shared parseRawJsonLines
 *  (the ONE tolerance rule for this file format). Raw lines, not normalized
 *  frames — the fold and the stale-boundary guard read isSidechain, which
 *  normalize() drops. */
function parseSubagentFileLines(chunk: string): unknown[] {
  return parseRawJsonLines(splitCompleteLines(chunk).lines).filter(
    (o) => (o as { type?: unknown }).type === 'user' || (o as { type?: unknown }).type === 'assistant',
  )
}

/** Production reader. */
export const readSubagentTranscriptLines = createSubagentLineReader(subagentIo)

/** Derive the snapshot for one session. [] payload on any failure — the
 *  client degrades to its window fold (today's behavior).
 *
 *  rev note: rev counts Task* tool_use events over main+sub lines, so a
 *  degraded derive (a subagent file unreadable → main-only) yields a LOWER
 *  rev than the last healthy one. The client's monotone-rev guard then
 *  drops that frame and keeps its last good state — which is the desired
 *  keep-the-richer-snapshot behavior — and folding resumes once the reads
 *  recover and new events push rev back up to the high-water mark. */
export async function deriveTaskListForSession(sessionId: string): Promise<TasklistSnapshotPayload> {
  const t0 = performance.now()
  const observeMs = () => metrics.observe('tasklist_derive_ms', performance.now() - t0)
  try {
    const found = await findTranscriptFile(sessionId)
    if (!found) { observeMs(); return { rev: 0, tasks: [] } }
    const main = await jsonlPageCache.readAll(sessionId)
    if (main.length === 0) {
      // The file exists but readAll came back empty — its contract swallows
      // read/parse errors into []. Folding the subagent half alone would
      // publish stub-subject (`Task #N`) tasks as the authoritative base
      // layer, so degrade fully (pre-subagent-fold behavior) instead.
      log.warn(`[${sessionId}] main transcript unreadable, tasklist snapshot degraded to empty`)
      observeMs()
      return { rev: 0, tasks: [] }
    }
    let sub: unknown[] = []
    // Contained failure: a broken subagents dir must not wipe the
    // main-transcript snapshot (rev 0 hides tasks the main file shows).
    try {
      sub = await readSubagentTranscriptLines(found.path, sessionId)
    } catch (err) {
      log.warn(`[${sessionId}] subagent transcript read failed, main-only derive: ${(err as Error).message}`)
    }
    const payload = deriveTaskListFromLines(mergeTranscriptLines(main, sub))
    observeMs()
    return payload
  } catch (err) {
    // Observing the degraded paths too: a session stuck failing derives
    // must show up in tasklist_derive_ms, not vanish from the histogram.
    observeMs()
    log.warn(`[${sessionId}] tasklist derive failed: ${err instanceof Error ? err.message : String(err)}`)
    return { rev: 0, tasks: [] }
  }
}
