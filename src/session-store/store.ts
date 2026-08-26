import { createInitialSessionState, type ServerMirror, type SessionAction, type SessionSnapshot, type SessionState, type TranscriptItem } from './types'
import { rebuildIndexesFromMessages, reduceSessionState, reapplyDismissed, MEMORY_ITEM_CAP } from './reducer'
import { toTranscriptItem } from './normalize'
import type { SdkMessage } from '../types'
import { PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME } from '../constants/toolNames'
import { projectMessage } from './project'
import {
  openDb,
  applyWrites,
  getMeta,
  scanUuidSeqs,
  cursorRecent,
  cursorOlder,
  clearSession,
  type MessageRecord,
} from './idb'
import type { IDBPDatabase } from 'idb'

type Listener = () => void

const STORAGE_PREFIX = 'claude-web-session:'
// Per-session cap. Kept well below the browser's ~5MB total localStorage
// quota so a single large transcript can't monopolise storage and starve
// unrelated keys (session-groups, sidebar-order, …). A session over this
// is trimmed to its last 500 messages in persistToStorage.
const STORAGE_MAX_BYTES = 2 * 1024 * 1024 // 2MB per session
// Total byte budget across ALL claude-web-session:* entries. The eviction
// pass keeps the sum under this so the cache can never fill the ~5MB quota
// and cause QuotaExceededError on unrelated setItem calls.
const STORAGE_TOTAL_BUDGET = 4 * 1024 * 1024 // 4MB across all sessions
const MAX_CACHED_SESSIONS = 20
/** Floor for the byte-budget trim: even when a projected session still
 *  exceeds STORAGE_MAX_BYTES, keep at least this many most-recent messages
 *  so the cold-load render hint is non-empty. Older messages are re-fetched
 *  on scroll-up via the /history endpoint (loadOlder). */
const STORAGE_TRIM_FLOOR_MESSAGES = 50

/** Remove a session's localStorage cache. Called on explicit delete. */
export function clearSessionStorage(sessionId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + sessionId)
  } catch { /* ignore */ }
}

/** Remove all session localStorage entries. Used by cacheClear() in tests. */
export function clearAllSessionStorage(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(STORAGE_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch { /* ignore */ }
}

/** Evict oldest localStorage entries until BOTH constraints hold:
 *   - total bytes across all claude-web-session:* keys <= STORAGE_TOTAL_BUDGET
 *   - entry count <= MAX_CACHED_SESSIONS
 *  Byte budget is the primary constraint (the count cap alone let a few
 *  large transcripts fill the quota — the bug this fixes). Eviction is
 *  oldest-first by `savedAt`; the session that just wrote has the newest
 *  timestamp and sorts last, so a write never prunes itself.
 *
 *  Throttled to run at most once per minute to avoid repeated JSON.parse
 *  overhead on every persistToStorage call. Pass `force` to bypass the
 *  throttle — used by the QuotaExceededError recovery path, which must
 *  free space immediately rather than wait out the window. */
let _lastPruneAt = 0
function pruneStorageCache(force = false): void {
  const now = Date.now()
  if (!force && now - _lastPruneAt < 60_000) return
  _lastPruneAt = now
  try {
    const entries: Array<{ key: string; ts: number; bytes: number }> = []
    let totalBytes = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      // Approximate byte size by string length — same unit used by the
      // STORAGE_MAX_BYTES check in persistToStorage, so the two agree.
      const bytes = raw.length + key.length
      totalBytes += bytes
      try {
        const data = JSON.parse(raw) as { savedAt?: number }
        // Use the savedAt timestamp written by persistToStorage.
        // Fall back to 0 for entries written by older versions.
        entries.push({ key, ts: typeof data.savedAt === 'number' ? data.savedAt : 0, bytes })
      } catch {
        entries.push({ key, ts: 0, bytes })
      }
    }
    // Sort oldest first — evict the least-recently-saved entries.
    entries.sort((a, b) => a.ts - b.ts)
    let evicted = 0
    while (
      entries.length > 0 &&
      (totalBytes > STORAGE_TOTAL_BUDGET || entries.length > MAX_CACHED_SESSIONS)
    ) {
      const oldest = entries.shift()!
      localStorage.removeItem(oldest.key)
      totalBytes -= oldest.bytes
      evicted++
    }
    if (evicted > 0) {
      console.warn(
        `[pruneStorageCache] Evicted ${evicted} session cache(s), ${entries.length} remaining (${(totalBytes / 1024).toFixed(0)}KB)`,
      )
    }
  } catch { /* ignore */ }
}

/** Persist a session's transcript to localStorage so it survives store
 *  destruction (idle pruning) and page reloads. Only stores the essential
 *  data needed to render the conversation — liveTurn, permissions, and
 *  other ephemeral state are excluded. */
/** True for a quota-exceeded write failure across browsers. Firefox uses
 *  code 1014 / name 'NS_ERROR_DOM_QUOTA_REACHED'; everyone else 22 /
 *  'QuotaExceededError'. */
function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.code === 22 ||
      e.code === 1014 ||
      e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

/** IDB quota error — same DOMException shape as localStorage, plus the
 *  rare `UnknownError`/`ConstraintError` browsers throw when IDB is full. */
function isIdbQuotaError(e: unknown): boolean {
  if (isQuotaError(e)) return true
  if (e instanceof DOMException) {
    return e.name === 'UnknownError' || e.name === 'ConstraintError' || e.name === 'QuotaExceededError'
  }
  return false
}

/** Extract the uuid from a (raw) SdkMessage. Returns '' when absent. */
function msgUuid(msg: SdkMessage): string {
  const u = (msg as { uuid?: unknown }).uuid
  return typeof u === 'string' ? u : ''
}

function persistToStorage(sessionId: string, state: SessionState): void {
  // Only the server-authored mirror is persisted, as a per-field-capped
  // render projection (see project.ts). plainText / items / ClientIntent are
  // NOT persisted — re-derived on hydrate. Optimistic placeholders die with
  // the tab by design. The ONE exception is `dismissedSubagents`: it is the
  // only client-owned, non-derivable flag, so it rides along in the payload
  // to keep dismissed subagents hidden across refresh.
  //
  // v3 addition: `plainText` is ALSO persisted (as a parallel array), even
  // though it is derivable. Re-deriving it on hydrate means running the full
  // unified markdown pipeline (`extractMessagePlainText`) over every cached
  // message on EVERY store construction — hundreds of ms of main-thread work
  // on group switch / cold load for a 600-message transcript. The value is
  // deterministic and was already computed at ingest, so we persist it and
  // hydrate skips the pipeline entirely (loadFromStorage zips it back in).
  // `items[]` itself is still NOT persisted — it is rebuilt cheaply from the
  // messages + cached plainTexts, and its other derived fields
  // (isCompactSummary / hiddenByDefault / deliveryStatus) are cheap flags.
  const mirror = state.mirror
  // Project each message (no-op ref for small messages). Live state is never
  // touched — projection is persist-only.
  const projected: SdkMessage[] = mirror.messages.map(projectMessage)
  // plainText per message, zipped from the already-computed live items.
  // `mirror.items` and `mirror.messages` are strictly index-aligned 1:1 —
  // every mutation path (updateTranscriptMirror / prependMessages / trimFront
  // / evictMessages) appends, slices, and filters them together, and a message
  // only enters `messages` when its toTranscriptItem produced a non-null item.
  // So items[i] IS the item for projected[i]. Zipping by index (rather than a
  // uuid→plainText lookup) also sidesteps the uuid-less-message edge: a
  // message with no string uuid can't be looked up in a uuid-keyed map, which
  // would leave the entry `undefined` — and JSON mangles array-undefined to
  // null, silently corrupting that message's plainText to null on the next
  // hydrate. Index-zipping always yields a real value, so the parallel array
  // stays correct AND never holds undefined (which the budget-trim size
  // estimate below would choke on: JSON.stringify(undefined).length throws).
  const plainTexts: (string | null)[] = projected.map((_, i) => mirror.items[i]?.plainText ?? null)
  const lastMessageUuid = mirror.lastMessageUuid
  const dismissedSubagents = Array.from(state.intent.dismissedSubagents)

  let toWrite: string

  // Fast path: stringify once. The projection caps usually keep a session
  // well under the budget, so this single stringify is the common case.
  const fullPayload = JSON.stringify({
    v: 3,
    savedAt: Date.now(),
    messages: projected,
    plainTexts,
    lastMessageUuid,
    dismissedSubagents,
  })

  if (fullPayload.length <= STORAGE_MAX_BYTES) {
    toWrite = fullPayload
  } else {
    // Over budget: compute per-message sizes (O(n)) to pick the largest
    // suffix that fits, then stringify just that slice. Never drop below the
    // floor — a non-empty render hint is worth more than enforcing the budget
    // on pathological inputs (the on-disk log + loadOlder cover the dropped
    // older messages). +1 per message accounts for the array comma.
    const sizes = projected.map((m, i) => JSON.stringify(m).length + JSON.stringify(plainTexts[i]).length + 1)
    // Include the dismissed-array in the wrapper overhead estimate.
    const wrapperOverhead = 110 + (lastMessageUuid?.length ?? 0) + JSON.stringify(dismissedSubagents).length
    let total = wrapperOverhead
    let kept = 0
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (total + sizes[i] > STORAGE_MAX_BYTES && kept >= STORAGE_TRIM_FLOOR_MESSAGES) break
      total += sizes[i]
      kept++
    }
    const keptMessages = kept < projected.length ? projected.slice(projected.length - kept) : projected
    const keptPlainTexts = kept < plainTexts.length ? plainTexts.slice(plainTexts.length - kept) : plainTexts
    toWrite = JSON.stringify({
      v: 3,
      savedAt: Date.now(),
      messages: keptMessages,
      plainTexts: keptPlainTexts,
      lastMessageUuid,
      dismissedSubagents,
    })
  }

  const key = STORAGE_PREFIX + sessionId
  try {
    localStorage.setItem(key, toWrite)
    pruneStorageCache()
  } catch (e) {
    // Quota full: force an immediate eviction pass (bypassing the 60s
    // throttle) to free space, then retry once. If it still fails, give
    // up — the transcript cache is a non-essential render optimisation,
    // but log so a recurring quota problem is visible rather than silent.
    if (isQuotaError(e)) {
      try {
        pruneStorageCache(true)
        localStorage.setItem(key, toWrite)
      } catch {
        console.warn(
          `[session-store] transcript cache write for ${sessionId} failed after eviction — localStorage still full; skipping`,
        )
      }
    }
    // Non-quota errors (e.g. SecurityError in private mode): silently skip.
  }
}

function loadFromStorage(sessionId: string): { messages: TranscriptItem[]; rawMessages: unknown[]; lastMessageUuid: string | null; dismissedSubagents: string[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sessionId)
    if (!raw) return null
    const data = JSON.parse(raw)
    // v3 shape: { v:3, savedAt, messages: SdkMessage[], plainTexts,
    //             lastMessageUuid }. v2 caches (same shape, no plainTexts) are
    // still accepted — hydrate re-derives plainText through the markdown
    // pipeline as before, and the next persist upgrades the cache to v3.
    // v1 caches (which stored a duplicated items[] array) are discarded —
    // the cache is a non-essential render hint and the WS replay repopulates
    // within seconds.
    if (!data || (data.v !== 3 && data.v !== 2) || !Array.isArray(data.messages)) return null
    const plainTexts = Array.isArray(data.plainTexts) ? (data.plainTexts as (string | null | undefined)[]) : null
    // Strip transient `api_retry` from old caches (pre-cutover caches stored
    // it inside messages; it now lives in the apiRetry slot and must not be
    // re-persisted to IDB). toTranscriptItem already drops it from items;
    // this keeps the raw messages array clean too. `rawPlainTexts` rides the
    // SAME filter pass so it stays index-aligned with `rawMessages` even if a
    // malformed v3 cache somehow contained api_retry — the plainText for the
    // surviving message after a dropped one keeps its own (not the dropped
    // one's) cached value.
    const rawMessages: SdkMessage[] = []
    const rawPlainTexts: (string | null | undefined)[] = []
    for (let i = 0; i < (data.messages as SdkMessage[]).length; i++) {
      const m = (data.messages as SdkMessage[])[i]
      if (m.type === 'system' && m.subtype === 'api_retry') continue
      rawMessages.push(m)
      rawPlainTexts.push(plainTexts ? plainTexts[i] : undefined)
    }
    // Re-derive TranscriptItems from the messages via the SAME producer the
    // live store uses (toTranscriptItem with prev-threading), so the hydrated
    // items are byte-identical to what a live build would produce. This drops
    // the duplicated items[] array the v1 cache stored. For v3 caches the
    // precomputed plainText rides along (index-aligned via the filter above),
    // so the markdown pipeline is skipped.
    const messages: TranscriptItem[] = []
    let prev: TranscriptItem | undefined
    for (let i = 0; i < rawMessages.length; i++) {
      // A missing entry (v2 cache, or a malformed/short plainTexts array)
      // reads as undefined → toTranscriptItem recomputes via markdown.
      const item = toTranscriptItem(rawMessages[i], prev, rawPlainTexts[i])
      if (item) {
        messages.push(item)
        prev = item
      }
    }
    return {
      messages,
      rawMessages,
      lastMessageUuid: typeof data.lastMessageUuid === 'string' ? data.lastMessageUuid : null,
      dismissedSubagents: Array.isArray(data.dismissedSubagents)
        ? (data.dismissedSubagents as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
    }
  } catch {
    return null
  }
}

/** Save scheduling parameters.
 *  - DEBOUNCE: quiet-period before persist after the last write.
 *  - MAX_DEFER: hard ceiling on how long the very first dirty write can
 *    sit unsaved during an active stream. Without this, the debounce
 *    keeps resetting and a session that streams faster than DEBOUNCE
 *    never persists at all. */
const SAVE_DEBOUNCE_MS = 2000
const SAVE_MAX_DEFER_MS = 10_000

/** How often the live (in-progress) assistant turn is flushed to a new
 *  snapshot during streaming. Each flush re-renders the streaming footer,
 *  so this directly bounds the per-second render cost of an active turn.
 *  ~80ms (~12fps) reads as smooth for streaming prose while cutting the
 *  render volume to roughly a third of a per-frame (33ms / 30fps) flush. */
const LIVE_TURN_FLUSH_MS = 80

export class SessionStore {
  private state: SessionState
  private snapshot: SessionSnapshot
  private listeners = new Set<Listener>()
  private flushTimer: number | null = null
  private saveTimer: number | null = null
  /** Epoch ms of the first dirty write since the last save. Used together
   *  with SAVE_MAX_DEFER_MS to bound the window even under a tight write
   *  loop that keeps resetting the debounce. */
  private saveDirtySince: number | null = null
  /** Set once the constructor's deferred localStorage hydrate has completed
   *  (or been skipped for a cache-less session). Mirrored into SessionSnapshot
   *  as `hydrateReady` so React consumers can gate subscriptions on it. */
  private hydrateReady = false
  /** Resolves when the deferred localStorage hydrate has finished (or was
   *  skipped). Mirrors `hydrateReady` as a Promise for tests and async callers
   *  that construct a store and then read its hydrated state. */
  readonly hydrateDone: Promise<void>
  private resolveHydrate!: () => void
  /** Per-instance subagent filter cache — moved off module scope so
   *  multiple SessionStore instances (multi-panel layouts) don't
   *  thrash a shared single-slot cache against each other. */
  private cachedSubagentsMap: ServerMirror['activeSubagents'] | null = null
  private cachedRunningSubagents: SessionSnapshot['activeSubagents'] = []
  /** Per-instance Workflow filter cache — mirrors cachedSubagentsMap so
   *  the running-workflow list only reallocates when activeWorkflows
   *  actually changes (drives any future Workflow chip in WorkingBubble). */
  private cachedWorkflowsMap: ServerMirror['activeWorkflows'] | null = null
  private cachedRunningWorkflows: SessionSnapshot['activeWorkflows'] = []

  // ── IndexedDB (Plan C) ───────────────────────────────────────────
  // IDB is a progressive-enhancement full-transcript cache. localStorage
  // (Plan B) remains the sync first-paint path + fallback. If IDB is
  // unavailable (private mode / quota), `idbAvailable=false` and every IDB
  // op is a no-op — behavior regresses to Plan B.
  private idbAvailable = true
  /** Resolves when the async IDB open + scan + cold-load has settled. Tests
   *  await this to assert post-hydrate IDB state; Phase 2's loadOlder gates on it. */
  readonly idbReady: Promise<void>
  /** uuids known to be in IDB, for O(1) delta-diff on save. NOT trimmed by
   *  trimFront — tracks IDB, not memory. */
  private persistedUuids = new Set<string>()
  /** uuid → seq, for O(1) lookup on loadOlder (Phase 2). Mirrors persistedUuids. */
  private uuidToSeq = new Map<string, number>()
  /** Per-session seq watermarks. Live/replay appends → ++maxSeq; loadOlder
   *  backfill → --minSeq. Assigned once per uuid at persist time, stable.
   *  `minSeq` uses +Infinity as its "nothing persisted yet" sentinel (NOT 0):
   *  real seqs are ≥ 1, so a 0 sentinel never lowers on the suffix-only path,
   *  stays stale, and the first prefix backfill then assigns seqs below 0
   *  leaving a hole in the seq space — which makes loadOlder's contiguity
   *  check false-fire. Infinity lowers correctly on the first assigned seq. */
  private maxSeq = 0
  private minSeq = Number.POSITIVE_INFINITY
  /** In-flight IDB write chain; clearPersisted/destroy await the tail. Writes
   *  are CHAINED (each saveIdb awaits the previous) so flushIdb awaiting the
   *  tail awaits every queued write — no write is orphaned to land after a
   *  clear and resurrect records. */
  private pendingIdbWrite: Promise<void> = Promise.resolve()
  /** Monotonic counter bumped on every clearPersisted. saveIdb captures the
   *  value at start and re-checks after each await; if a clear happened
   *  mid-save, the save bails (writes nothing) instead of resurrecting. This
   *  replaces a boolean `cleared` flag, which couldn't distinguish "a clear
   *  happened during my await" from "a clear happened and finished." */
  private clearGeneration = 0
  private idbClearPromise: Promise<void> | null = null
  /** True after we've already warned about the current IDB write-failure
   *  streak. Re-armed on a successful write so a recurring failure warns
   *  once per streak (not once per save, which would spam every 2-10s during
   *  a stream) while still surfacing a fresh failure after a recovery. */
  private idbWriteFailureWarned = false

  constructor(sessionId: string) {
    registerStoreForDebug(sessionId, this)
    // NEVER block render on the localStorage cache. Hydrating here used to
    // re-derive every TranscriptItem through the full markdown pipeline
    // (`extractMessagePlainText`) on the store's construction path — which
    // runs inside React's render on group switch (getSessionStore → new
    // SessionStore). For a 600-message transcript that was ~800ms of frozen
    // main thread before the panel's first paint. The constructor now returns
    // an empty state synchronously and hydrates from cache in a microtask —
    // which still completes before the browser's first paint (microtasks drain
    // at the end of the current task) and before any WS replay frame can
    // arrive, so the first frame already shows cached content. Consumers that
    // need the hydrated `lastMessageUuid` before subscribing (useChatStream)
    // gate on `hydrateReady` (see the SessionSnapshot doc).
    //
    // A session with NO cache has nothing to hydrate, so it is marked ready
    // synchronously (a single key probe — µs, not the JSON.parse + markdown
    // re-derivation, which still happens off-render in the microtask). Only a
    // session whose key actually exists waits for the microtask. This keeps
    // cache-less mounts subscribing immediately (full replay) while cached
    // mounts defer just long enough to pick up the incremental sinceUuid.
    let hasCache = false
    try {
      hasCache = localStorage.getItem(STORAGE_PREFIX + sessionId) != null
    } catch {
      // localStorage unavailable (private mode) — nothing readable to hydrate.
    }
    this.hydrateReady = !hasCache
    this.state = createInitialSessionState(sessionId)
    this.snapshot = this.buildSnapshot(this.state)
    this.hydrateDone = new Promise((resolve) => {
      this.resolveHydrate = resolve
    })
    queueMicrotask(() => this.hydrateFromCache(sessionId, hasCache))
    // Kick off async IDB hydration (open + scan + cold-load). Does not block
    // construction — the LS tail is painted via the microtask above. IDB
    // supersedes it with a fuller recent window when ready.
    this.idbReady = this.initIdb()
  }

  /** Restore the localStorage cache (v2/v3) into the store, off the render
   *  path. Runs once, as a microtask from the constructor. With the v3 cache
   *  the markdown pipeline is skipped entirely (plainText is persisted), so
   *  this is ~10-20ms even for a 2MB cache; with a legacy v2 cache it pays the
   *  one-time re-derive and the next persist upgrades the cache to v3. */
  private hydrateFromCache(sessionId: string, hadCache: boolean): void {
    try {
      const cached = loadFromStorage(sessionId)
      if (cached && cached.messages.length > 0) {
        // Only `messages`/`items` are persisted — the lifecycle index
        // maps (toolStatus, planStatus, planContent, questionAnswers,
        // activeSubagents) are derived state and start empty after
        // hydrate. We MUST replay the cached messages through
        // updateIndexes() to rebuild them; otherwise every cached
        // tool_use card renders 'running' forever (useToolStatus
        // defaults to 'running' for unknown ids, and the live-replay
        // path only sees frames AFTER lastMessageUuid). This was the
        // "older Grep/Read cards stuck spinning after several turns"
        // bug — cards from previous turns lived in the cached items
        // but their toolStatus entries had been thrown away.
        const fresh = createInitialSessionState(sessionId)
        const seededMirror: ServerMirror = {
          ...fresh.mirror,
          items: cached.messages,
          messages: cached.rawMessages as ServerMirror['messages'],
          lastMessageUuid: cached.lastMessageUuid,
          replayReady: true, // Treat cached data as "replayed"
        }
        const seeded: SessionState = {
          sessionId,
          mirror: seededMirror,
          intent: {
            ...fresh.intent,
            dismissedSubagents: new Set(cached.dismissedSubagents),
          },
        }
        // Rebuild indexes from the cached messages, THEN re-apply persisted
        // dismissals so dismissed subagents stay hidden across refresh.
        this.state = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
      }
      // No cache (or empty): leave the empty state as-is — replayReady stays
      // false so the skeleton shows until the WS replay lands.
    } finally {
      // Flip the flag BEFORE rebuilding the snapshot: buildSnapshot reads
      // `this.hydrateReady`, so building while it's still false would publish
      // a snapshot whose hydrateReady never reads true — useSessionField
      // subscribers (useChatStream's subscribe gate) would never re-render
      // and the WS subscribe would never fire with the cached sinceUuid.
      this.hydrateReady = true
      this.resolveHydrate()
      // Re-snapshot + emit ONLY when the constructor's synchronous snapshot is
      // stale — i.e. when a cache key existed (hadCache). For a cache-less
      // session the constructor already published the final empty snapshot with
      // hydrateReady=true, so emitting would be a redundant no-op render on
      // every panel mount (useSyncExternalStore re-renders on a fresh-but-
      // identical snapshot reference). The condition is `hadCache`, not
      // `hydrated`: if the key existed at construction but the cache vanished
      // before this microtask, the constructor snapshot still carries
      // hydrateReady=false and MUST be refreshed (empty content, hydrateReady
      // true) or the WS-subscribe gate never opens.
      if (hadCache) {
        this.snapshot = this.buildSnapshot(this.state)
        this.emit()
      }
    }
  }

  /** Open IDB, rebuild persistedUuids/uuidToSeq/seq watermarks, and cold-load
   *  up to MEMORY_ITEM_CAP most-recent messages from IDB (superseding the tiny
   *  LS tail). Fire-and-forget from the constructor; failures set
   *  idbAvailable=false and silently regress to Plan B. */
  private async initIdb(): Promise<void> {
    let db: IDBPDatabase | null
    try {
      db = await openDb()
    } catch {
      db = null
    }
    if (!db) {
      this.idbAvailable = false
      return
    }
    const sessionId = this.state.sessionId
    try {
      // Rebuild tracking from IDB. scanUuidSeqs reads every record's uuid+seq.
      const uuidSeqs = await scanUuidSeqs(db, sessionId)
      for (const [uuid, seq] of uuidSeqs) {
        this.persistedUuids.add(uuid)
        this.uuidToSeq.set(uuid, seq)
        if (seq > this.maxSeq) this.maxSeq = seq
        if (seq < this.minSeq) this.minSeq = seq
      }
      // If meta has watermarks beyond what scan found (scan is authoritative,
      // but meta is the cheap path), reconcile — scan already sets them.
      // Guard minSeq against a stale 0 sentinel from a pre-fix meta: real seqs
      // are ≥ 1 (or negative after prefix backfill, which scan already caught),
      // so a 0 in meta is always the empty sentinel, never a real minimum.
      const meta = await getMeta(db, sessionId)
      if (meta) {
        if (meta.maxSeq > this.maxSeq) this.maxSeq = meta.maxSeq
        if (meta.minSeq > 0 && meta.minSeq < this.minSeq) this.minSeq = meta.minSeq
      }
      // Cold-load: only if IDB has more recent history than memory currently
      // holds. Fetch up to MEMORY_ITEM_CAP most-recent and PREPEND (dedup vs
      // the LS tail by uuid). Skip if memory is already at the cap (a live
      // session mid-stream) to avoid a re-render jump.
      if (this.state.mirror.items.length < MEMORY_ITEM_CAP && this.maxSeq > 0) {
        const records = await cursorRecent(db, sessionId, MEMORY_ITEM_CAP)
        if (records.length > 0) {
          // IDB's job is to extend the view BACKWARD. If the LS tail is stale
          // (LS write skipped/failed while IDB kept newer records), the recent
          // window from IDB can include records NEWER than the in-memory tail.
          // Naively prepending those would invert the transcript (newer ahead
          // of older). So drop any record whose seq is >= the oldest in-memory
          // message's seq — those are either duplicates (handled by uuid dedup
          // anyway) or newer-than-LS (the WS replay fills them in order). Only
          // records strictly older than the in-memory tail are prepended.
          const items = this.state.mirror.items
          let msgs: SdkMessage[] | null = null
          if (items.length === 0) {
            // No in-memory tail — load the full recent window (no anchor needed).
            msgs = records.map((r) => r.msg)
          } else {
            const oldestInMemorySeq = this.uuidToSeq.get(items[0].id)
            if (oldestInMemorySeq !== undefined) {
              // Anchor known — keep only strictly-older records (extend backward).
              msgs = records.filter((r) => r.seq < oldestInMemorySeq).map((r) => r.msg)
            }
            // else: the oldest in-memory message isn't in IDB (LS has a record
            // IDB never got — a partial-write edge). We can't safely anchor a
            // seq filter, and prepending the IDB window (which may be newer)
            // would risk inverting the transcript. Skip the cold-load prepend
            // entirely — the WS replay fills the full history in correct order
            // within seconds. Leave msgs null.
          }
          if (msgs && msgs.length > 0) {
            // PREPEND_MESSAGES dedups by uuid against the in-memory LS tail,
            // so any residual overlap doesn't duplicate.
            this.dispatch({ type: 'PREPEND_MESSAGES', messages: msgs })
          }
        }
      }
    } catch {
      // IDB read failure — disable IDB for this store, regress to Plan B.
      this.idbAvailable = false
    }
  }

  getState(): SessionState {
    return this.state
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispatch(action: SessionAction): void {
    const next = reduceSessionState(this.state, action)
    if (next === this.state) return
    // CLEAR_TRANSCRIPT (the /clear wipe) resets IDB tracking so the next save
    // re-persists the fresh empty → new state from scratch.
    if (action.type === 'CLEAR_TRANSCRIPT') {
      this.resetIdbTracking()
    }
    this.state = next
    this.snapshot = this.buildSnapshot(next)
    this.scheduleFlush()
    this.scheduleSave()
    // A dismiss must survive an immediate refresh: bypass the 2s save
    // debounce so the dismissed set is persisted synchronously (sync LS write
    // is what hydrate reads; IDB write is chained async but fire-and-forget).
    if (action.type === 'DISMISS_SUBAGENT') this.persistNow()
    this.emit()
  }

  dispatchMany(actions: SessionAction[]): void {
    if (actions.length === 0) return
    let next = this.state
    for (const action of actions) {
      next = reduceSessionState(next, action)
    }
    if (next === this.state) return
    this.state = next
    this.snapshot = this.buildSnapshot(next)
    this.scheduleFlush()
    this.scheduleSave()
    this.emit()
  }

  /** Wipe both layers and mark the transcript ready (replayReady=true).
   *  Shared by reset() and clearPersisted(). The post-wipe state is "live
   *  and empty" — there is no pending replay, so replayReady MUST be true or
   *  MessageList sits on the skeleton forever (the WS subscription persists
   *  across the wipe, the server doesn't re-replay, system/init isn't
   *  broadcast). Cancels the flushTimer first so a pending live-turn flush
   *  can't fire after the mirror is rebuilt. */
  private wipe(): void {
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dispatch({ type: 'CLEAR_TRANSCRIPT' })
  }

  reset(): void {
    this.wipe()
  }

  /** Reset in-memory state AND erase the localStorage cache, with no
   *  pending write left behind. Used by the /clear flow. wipe() dispatches
   *  CLEAR_TRANSCRIPT, which schedules a debounced save that would later
   *  rewrite the key with the empty state — cancel that timer and remove the
   *  key synchronously here so the cache is gone and stays gone.
   *
   *  IDB clear: bump `clearGeneration` so any in-flight saveIdb bails (writes
   *  nothing) instead of resurrecting after the clear. clearIdb does NOT await
   *  pendingIdbWrite — the generation check in saveIdb is the serialization,
   *  so there's no mutual-await deadlock. Fire-and-forget; the LS key is gone
   *  synchronously above. */
  clearPersisted(): void {
    this.wipe()
    // Cancel the debounced save that wipe()'s dispatch just scheduled —
    // otherwise it fires later and re-creates the key.
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveDirtySince = null
    clearSessionStorage(this.state.sessionId)
    if (this.idbAvailable) {
      this.clearGeneration++
      this.idbClearPromise = this.clearIdb()
    }
  }

  /** Permanently purge a session's cache (registry.delete path). Unlike
   *  destroy() (which SAVES the final state for idle-evict durability), purge
   *  writes NOTHING — it drains in-flight writes (which bail via the
   *  generation bump), then clears LS + IDB. This avoids both the "write then
   *  clear" waste and the window where a rapid re-open hydrates from a stale
   *  LS key that destroy()'s save() would have written. */
  async purge(): Promise<void> {
    unregisterStoreForDebug(this.state.sessionId, this)
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveDirtySince = null
    // Bump generation so any in-flight saveIdb bails; drain the write chain.
    this.clearGeneration++
    await this.flushIdb()
    clearSessionStorage(this.state.sessionId)
    if (this.idbAvailable) {
      this.idbClearPromise = this.clearIdb()
      await this.idbClearPromise
    }
    this.listeners.clear()
  }

  private async clearIdb(): Promise<void> {
    try {
      const db = await openDb()
      if (!db) {
        this.idbAvailable = false
        return
      }
      await clearSession(db, this.state.sessionId)
    } catch {
      // best-effort
    } finally {
      this.idbClearPromise = null
    }
  }

  /** Tear down the store: persist final state (sync LS + async IDB), cancel
   *  timers, drop listeners. Used by the idle sweep (save-then-teardown for
   *  durability). registry.delete uses purge() instead (no save). */
  async destroy(): Promise<void> {
    unregisterStoreForDebug(this.state.sessionId, this)
    // Persist messages to localStorage before tearing down so they survive
    // idle pruning and page reloads.
    this.save()
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveDirtySince = null
    this.listeners.clear()
    // Await the in-flight IDB write so it lands before teardown. The write
    // holds `this` alive via its closure, but awaiting makes the contract
    // explicit and lets registry.delete sequence its IDB clear after.
    await this.flushIdb()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private scheduleFlush(): void {
    if (!this.state.mirror.liveTurn?.dirty || this.flushTimer != null) return
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      this.dispatch({ type: 'LIVE_TURN_FLUSH' })
    }, LIVE_TURN_FLUSH_MS)
  }

  /** Debounced save to localStorage. Fires SAVE_DEBOUNCE_MS after the last
   *  state change so rapid message bursts don't thrash storage writes —
   *  but capped at SAVE_MAX_DEFER_MS from the FIRST dirty write so an
   *  unbroken stream still gets persisted in bounded time. */
  private scheduleSave(): void {
    const now = Date.now()
    if (this.saveDirtySince == null) this.saveDirtySince = now
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer)
    const elapsed = now - this.saveDirtySince
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_DEFER_MS - elapsed))
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, delay)
  }

  private save(): void {
    this.saveDirtySince = null
    persistToStorage(this.state.sessionId, this.state)
    // CHAIN the IDB write onto any in-flight one. This makes flushIdb
    // (which awaits the tail) await EVERY queued write, so destroy/purge
    // can't return while an earlier write is still outstanding — closing the
    // "overwrite pendingIdbWrite, lose the earlier write" hole that let a
    // write land after a clear and resurrect records.
    if (this.idbAvailable) {
      this.pendingIdbWrite = this.pendingIdbWrite
        .catch(() => {})
        .then(() => this.saveIdb())
    }
  }

  /** Await the in-flight IDB write chain + any pending clear. For tests,
   *  destroy(), and purge(). */
  async flushIdb(): Promise<void> {
    await this.pendingIdbWrite
    if (this.idbClearPromise) await this.idbClearPromise
  }

  /** Bypass the save debounce and persist immediately (sync LS + async IDB).
   *  Used by `destroy()` and tests. */
  persistNow(): void {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveDirtySince = null
    this.save()
  }

  /** Read up to `n` messages older than the current oldest in-memory message
   *  from IDB (Phase 2 loadOlder path). Returns null if IDB is unavailable,
   *  not ready, or the oldest in-memory message isn't persisted yet (caller
   *  falls back to the server). `contiguous` is false when there's a seq gap
   *  at the boundary (tab closed mid-write) — the caller should probe the
   *  server to bridge it. `messages` is oldest-first (ready to PREPEND). */
  async loadOlderFromIdb(
    n: number,
  ): Promise<{ messages: SdkMessage[]; hasMore: boolean; contiguous: boolean } | null> {
    if (!this.idbAvailable) return null
    const items = this.state.mirror.items
    if (items.length === 0) return null
    const oldestUuid = items[0].id
    const oldestSeq = this.uuidToSeq.get(oldestUuid)
    if (oldestSeq === undefined) return null
    let db: IDBPDatabase | null
    try {
      db = await openDb()
    } catch {
      db = null
    }
    if (!db) {
      this.idbAvailable = false
      return null
    }
    try {
      const { records, hasMore } = await cursorOlder(db, this.state.sessionId, oldestSeq, n)
      // records descend (newest-older first); reverse to oldest-first for PREPEND.
      records.reverse()
      const messages = records.map((r) => r.msg)
      // Contiguous iff the newest-returned record abuts the oldest in memory
      // (seq == oldestSeq - 1). A gap signals missing IDB records — caller
      // probes the server to bridge.
      const contiguous = messages.length === 0 || records[records.length - 1].seq === oldestSeq - 1
      return { messages, hasMore, contiguous }
    } catch {
      return null
    }
  }

  /** Reset in-memory IDB tracking. Called on CLEAR_TRANSCRIPT (the wipe) so the
   *  post-clear state re-persists from scratch. Does NOT touch IDB itself —
   *  clearPersisted drives the IDB clear. */
  private resetIdbTracking(): void {
    this.persistedUuids.clear()
    this.uuidToSeq.clear()
    this.maxSeq = 0
    this.minSeq = Number.POSITIVE_INFINITY
    // Re-arm the write-failure warning so a fresh failure streak after a
    // /clear surfaces its first warning (the streak ended with the clear).
    this.idbWriteFailureWarned = false
  }

  /** Delta-write new in-memory messages to IDB, assigning each a stable `seq`
   *  (chronological rank) at persist time. New messages only ever arrive at
   *  the ends of `mirror.messages` (live/replay append at the tail; loadOlder
   *  backfill at the head), so the unpersisted set forms a prefix (older →
   *  --minSeq) and/or suffix (newer → ++maxSeq). `api_retry` never reaches
   *  `messages` (transient slot), so it is never written to IDB — no
   *  supersession/deletion path needed. */
  private async saveIdb(): Promise<void> {
    if (!this.idbAvailable) return
    const gen = this.clearGeneration
    let db: IDBPDatabase | null
    try {
      db = await openDb()
    } catch {
      db = null
    }
    if (!db) {
      this.idbAvailable = false
      return
    }
    // A clear may have bumped the generation while we awaited openDb. Bail
    // before touching IDB — clearIdb will (or already did) wipe the session.
    if (this.clearGeneration !== gen) return
    const sessionId = this.state.sessionId
    const messages = this.state.mirror.messages

    // Find the first and last persisted indices. New messages sit before the
    // first persisted (prefix) or after the last (suffix). A middle gap
    // (unpersisted between two persisted) shouldn't occur given trimFront +
    // splitReplayAgainstCache semantics; if it does, treat as suffix.
    let firstPersisted = -1
    let lastPersisted = -1
    for (let i = 0; i < messages.length; i++) {
      const uuid = msgUuid(messages[i])
      if (uuid && this.persistedUuids.has(uuid)) {
        if (firstPersisted === -1) firstPersisted = i
        lastPersisted = i
      }
    }

    const newRecords: MessageRecord[] = []

    // Prefix (older than the persisted window) → --minSeq. mirror.messages is
    // oldest-first, so prefix[0] is oldest → smallest seq.
    if (firstPersisted > 0) {
      const len = firstPersisted
      for (let i = 0; i < len; i++) {
        const uuid = msgUuid(messages[i])
        if (!uuid || this.persistedUuids.has(uuid)) continue
        const seq = this.minSeq - (len - i) // oldest (i=0) → minSeq-len
        newRecords.push({ sessionId, uuid, seq, msg: projectMessage(messages[i]) })
        this.persistedUuids.add(uuid)
        this.uuidToSeq.set(uuid, seq)
      }
      this.minSeq -= len
    }

    // Suffix (newer than the persisted window) → ++maxSeq, in arrival order.
    const suffixStart = lastPersisted === -1 ? (firstPersisted === -1 ? 0 : messages.length) : lastPersisted + 1
    for (let i = suffixStart; i < messages.length; i++) {
      const uuid = msgUuid(messages[i])
      if (!uuid || this.persistedUuids.has(uuid)) continue
      this.maxSeq += 1
      const seq = this.maxSeq
      // First suffix assignment lowers minSeq off the +Infinity sentinel to
      // the real minimum (suffix seqs ascend from 1, so the first is the min).
      if (seq < this.minSeq) this.minSeq = seq
      newRecords.push({ sessionId, uuid, seq, msg: projectMessage(messages[i]) })
      this.persistedUuids.add(uuid)
      this.uuidToSeq.set(uuid, seq)
    }

    // Middle-unpersisted (gap fill, rare) → ++maxSeq.
    if (firstPersisted !== -1) {
      for (let i = firstPersisted + 1; i < lastPersisted; i++) {
        const uuid = msgUuid(messages[i])
        if (!uuid || this.persistedUuids.has(uuid)) continue
        this.maxSeq += 1
        const seq = this.maxSeq
        if (seq < this.minSeq) this.minSeq = seq
        newRecords.push({ sessionId, uuid, seq, msg: projectMessage(messages[i]) })
        this.persistedUuids.add(uuid)
        this.uuidToSeq.set(uuid, seq)
      }
    }

    if (newRecords.length === 0) return

    // If a clear started while we built records (sync, no await above), bail —
    // writing now would resurrect what clearIdb is about to wipe.
    if (this.clearGeneration !== gen) return
    // If a clear is in flight, wait for it to finish before our write so IDB
    // orders our tx AFTER the clear's tx (clearIdb doesn't await us, so no
    // deadlock). Then re-check generation: if the clear bumped it, bail.
    if (this.idbClearPromise) await this.idbClearPromise
    if (this.clearGeneration !== gen) return

    const meta = {
      sessionId,
      maxSeq: this.maxSeq,
      // minSeq is +Infinity until the first record persists; persisting
      // Infinity would round-trip badly through structured clone / JSON, so
      // store 0 for the empty case (scan reconciles to the real value on the
      // next cold-load anyway — meta is just a cheap hint).
      minSeq: Number.isFinite(this.minSeq) ? this.minSeq : 0,
    }
    try {
      // Single atomic tx (put records + put meta). A racing clearSession
      // (separate tx) now serializes wholly before or wholly after — never a
      // delete-then-put that resurrects.
      await applyWrites(db, newRecords, meta)
      // Success re-arms the per-streak warning so a later fresh failure is
      // surfaced again.
      this.idbWriteFailureWarned = false
    } catch (e) {
      if (isIdbQuotaError(e)) {
        this.idbAvailable = false
      } else {
        // Non-quota error (stale handle after terminated(), tx abort, version
        // conflict). Warn ONCE PER FAILURE STREAK — a persistent failure
        // would otherwise console.warn every debounced save (every 2-10s
        // during a stream). The LS cache is the fallback; don't permanently
        // disable IDB (transient aborts self-heal on the next openDb(), and
        // a healed write re-arms the warning above).
        if (!this.idbWriteFailureWarned) {
          this.idbWriteFailureWarned = true
          console.warn(`[session-store] IDB write for ${sessionId} failed:`, e)
        }
      }
    }
  }

  /** Per-instance equivalent of the old module-global running-subagents
   *  cache. The Map reference is compared by identity so the filtered
   *  array is only reallocated when activeSubagents actually changes.
   *
   *  Includes `background` (async subagents whose launch ack has landed but
   *  whose real completion hasn't — they're still working in the background
   *  and must stay in the WorkingBubble chip row) alongside `running`, AND
   *  `pending` (the post-turn-end form of `background`): the WorkingBubble
   *  stays mounted in its `Waiting` state while any `pending` subagent
   *  remains, so the user sees that background work is still in flight after
   *  the parent turn ended. `pending` chips are dismissible. */
  private getRunningSubagents(map: ServerMirror['activeSubagents']): SessionSnapshot['activeSubagents'] {
    if (map === this.cachedSubagentsMap) return this.cachedRunningSubagents
    this.cachedSubagentsMap = map
    this.cachedRunningSubagents = Array.from(map.values())
      .filter((s) => s.status === 'running' || s.status === 'background' || s.status === 'pending')
    return this.cachedRunningSubagents
  }

  /** Workflow analogue of getRunningSubagents. The Map reference is compared
   *  by identity so the filtered array is only reallocated when activeWorkflows
   *  actually changes. Drives the WorkingBubble workflow chip row (if/when
   *  wired); the full index (workflowIndex) is exposed unfiltered so
   *  WorkflowCard can read completed records too. */
  private getRunningWorkflows(map: ServerMirror['activeWorkflows']): SessionSnapshot['activeWorkflows'] {
    if (map === this.cachedWorkflowsMap) return this.cachedRunningWorkflows
    this.cachedWorkflowsMap = map
    this.cachedRunningWorkflows = Array.from(map.values()).filter((w) => w.status === 'running')
    return this.cachedRunningWorkflows
  }

  private buildSnapshot(state: SessionState): SessionSnapshot {
    const mirror = state.mirror
    const intent = state.intent
    // Render-time merge: optimistic placeholders live in intent (so server
    // frame handlers can't wipe them) but components see them at the tail
    // of items/messages, same as pre-refactor. Identity-stable short-circuit
    // when no placeholders are pending (the common case).
    const items = intent.pendingPlaceholders.size === 0
      ? mirror.items
      : [...mirror.items, ...intent.pendingPlaceholders.values()]
    const messages = intent.pendingPlaceholders.size === 0
      ? mirror.messages
      : [...mirror.messages, ...Array.from(intent.pendingPlaceholders.values()).map((p) => p.msg)]
    return {
      replayReady: mirror.replayReady,
      hydrateReady: this.hydrateReady,
      items,
      messages,
      streamingContent: mirror.liveTurn?.flushedText ?? null,
      activePhase: mirror.liveTurn?.phase ?? null,
      tokenRate: mirror.liveTurn?.tokenRate ?? null,
      contextUsage: mirror.contextUsage,
      promptSuggestion: mirror.promptSuggestion ?? null,
      tasks: mirror.tasks,
      apiRetry: mirror.apiRetry,
      thinkingTokens: mirror.thinkingTokens,
      error: intent.error,
      permissionDecisions: mirror.permissionDecisions,
      planStatus: mirror.planStatus,
      planContent: mirror.planContent,
      questionAnswers: mirror.questionAnswers,
      toolStatus: mirror.toolStatus,
      toolResults: mirror.toolResults,
      activeSubagents: this.getRunningSubagents(mirror.activeSubagents),
      subagentIndex: mirror.activeSubagents,
      activeWorkflows: this.getRunningWorkflows(mirror.activeWorkflows),
      workflowIndex: mirror.activeWorkflows,
      lastMessageUuid: mirror.lastMessageUuid,
    }
  }
}

// ---------------------------------------------------------------------------
// On-demand debug dump
// ---------------------------------------------------------------------------
//
// When a tool card is visibly stuck on 'running', you don't need to reproduce
// anything or trawl localStorage — just open the DevTools console and run:
//
//     __crwDumpToolStatus()
//
// It prints, per live session, every toolStatus entry plus a focused list of
// the ones still 'running'. For each stuck id it tries to find the originating
// tool_use (so you see the tool name) and reports whether a tool_result with
// that id exists anywhere in the message log. That single dump distinguishes
// the failure modes:
//   • running + NO tool_result in log  → result never arrived (interrupt /
//     disconnect / process died). The reducer's turn-end sweep only helps if
//     a `result` frame later lands.
//   • running + tool_result EXISTS in log → id-mismatch: the result is there
//     but its tool_use_id didn't match the seeded id (normalize.ts bug).
//
// It ALSO reports `orphans`: every tool_result that did NOT merge into its
// card (so MessageList draws a standalone bubble). Each orphan is tagged
// `isExcludedByDesign` and carries a `diagnosis`. Subagent orphans get a
// `subagentRecord` cross-check (present? status? result captured?) so a
// healthy merged subagent (suppressed, never an orphan) is told apart from a
// degraded one (record pruned / result lost → bare card + reappearing bubble,
// the turn-end-wipe failure mode). The orphan "consumed" test mirrors
// MessageList.makeResultConsumed EXACTLY — including subagentResultIds — so
// the dump agrees with what's actually on screen.
//
// And `subagents`: a snapshot of the activeSubagents index (label / status /
// toolCount / hasResult) — the map SubagentCard reads from. Empty or missing
// records here while a card is on screen = the card is rendering its fallback.
//
// Multiple records may share a sessionId in split-panel mode; `storeIndex`
// disambiguates them.
//
// Paste the output back and we can name the root cause with certainty.

const debugStores = new Map<string, Set<SessionStore>>()

function registerStoreForDebug(sessionId: string, store: SessionStore): void {
  if (!import.meta.env.DEV) return
  let set = debugStores.get(sessionId)
  if (!set) {
    set = new Set()
    debugStores.set(sessionId, set)
  }
  set.add(store)
}

function unregisterStoreForDebug(sessionId: string, store: SessionStore): void {
  if (!import.meta.env.DEV) return
  const set = debugStores.get(sessionId)
  if (!set) return
  set.delete(store)
  if (set.size === 0) debugStores.delete(sessionId)
}

// --- DEV-only on-demand dump infrastructure ---
// Gated on import.meta.env.DEV so Vite tree-shakes it out of the production
// bundle (matching __dumpGroupState in App.tsx). `debugStores` +
// register/unregister stay live because the SessionStore constructor/destroy
// paths call them, but they no-op outside dev. The block below is intentionally
// NOT re-indented to keep the diff reviewable.
if (import.meta.env.DEV) {
interface ToolEntryDump {
  toolUseId: string
  status: string
  toolName: string | null
  /** A tool_result block with this exact tool_use_id exists somewhere in
   *  the message log. */
  hasToolResultInLog: boolean
  /** The is_error flag on that tool_result (null when no result found). */
  resultIsError: boolean | null
  /** The parent_tool_use_id of the user frame carrying the tool_result
   *  (null = main-thread / undefined field; string = subagent-internal).
   *  Critical for diagnosing the pump-drop failure mode: if a result
   *  exists ONLY on disk but never reached the live reducer, the live
   *  message log won't contain it at all. */
  resultParentToolUseId: string | null | 'no-result'
  diagnosis: string
}

/** One tool_result block in the live message log that did NOT get merged
 *  into its originating tool card (so MessageList draws it as a standalone
 *  "orphan" bubble). The headline field is `isExcludedByDesign`: it splits
 *  expected orphans (Plan/Question/Subagent — excluded from the merge map
 *  on purpose, they own their own rendering) from REAL orphans (a generic
 *  tool whose result should have merged but didn't — a matching bug). */
interface OrphanResultDump {
  toolUseId: string
  /** Tool name resolved from the originating tool_use, null if none found
   *  in the live log (result with no matching tool_use — a different bug). */
  toolName: string | null
  /** True when the tool is in TOOL_STATUS_EXCLUDE — orphan bubble is the
   *  EXPECTED fallback, the specific card (PlanCard/QuestionCard/Subagent)
   *  should be the real renderer. False = unexpected, investigate. */
  isExcludedByDesign: boolean
  /** Whether the id was seeded into toolStatus (a generic card exists for
   *  it). True here with an orphan result means the merge step skipped it. */
  hasSeededStatus: boolean
  /** parent_tool_use_id of the carrying user frame (null = main thread). */
  parentToolUseId: string | null
  /** Cross-check against the activeSubagents index (only populated for
   *  Subagent tools). Lets the dump tell apart a healthy merged subagent
   *  (record present + result captured → suppressed, NOT an orphan) from a
   *  broken one (record pruned / result lost → falls back to a bare card and
   *  the orphan bubble reappears — exactly the turn-end-wipe failure mode).
   *  null for non-subagent orphans. */
  subagentRecord: {
    present: boolean
    status: string | null
    hasResult: boolean
  } | null
  diagnosis: string
}

/** One entry of the activeSubagents index. The previous dump ignored this
 *  map entirely, so subagent merge/fallback bugs were invisible: the card
 *  reads its label/status/result straight from here, and MessageList derives
 *  orphan-suppression from `result`. Surfacing it makes "card degraded to a
 *  bare running placeholder" / "merged result vanished" diagnosable at a glance. */
interface SubagentDump {
  toolUseId: string
  label: string
  status: string
  toolCount: number
  /** True once the subagent's own tool_result merged into the card (record
   *  .result set). MessageList suppresses the orphan bubble exactly when this
   *  is true; false on a completed subagent means the result was lost. */
  hasResult: boolean
  resultIsError: boolean | null
  startedAt: number | null
  endedAt: number | null
}

interface ToolStatusDump {
  sessionId: string
  /** Index of the store within this session's store set — disambiguates the
   *  split-panel case where two panels hold the same session (the previous
   *  dump emitted two identical records with no way to tell them apart). */
  storeIndex: number
  total: number
  /** Quick counts so the headline failure mode is visible at a glance. */
  counts: { running: number; success: number; error: number }
  /** Every non-success tool entry, with per-id result analysis. The
   *  previous version only analyzed 'running' entries — useless once the
   *  turn-end sweep has flipped lingering 'running' tools to 'error'. */
  problems: ToolEntryDump[]
  /** tool_result blocks rendered as standalone orphan bubbles (not merged
   *  into a card). Each is tagged expected-vs-real so you can tell a
   *  by-design fallback from a genuine merge failure at a glance. */
  orphans: OrphanResultDump[]
  /** Snapshot of the activeSubagents index: every Agent/Task/Explore record
   *  with its status + whether its result merged into the card. */
  subagents: SubagentDump[]
  all: Record<string, string>
}

/** Per-message tool index, built ONCE per store so the problem/orphan scans
 *  are O(messages) instead of O(messages × ids). Maps every tool_use id to
 *  its name, and every tool_result's tool_use_id to its result metadata. */
interface ToolIndex {
  nameById: Map<string, string>
  resultById: Map<string, { isError: boolean; parentToolUseId: string | null }>
}

function buildToolIndex(messages: readonly SdkMessage[]): ToolIndex {
  const nameById = new Map<string, string>()
  const resultById = new Map<string, { isError: boolean; parentToolUseId: string | null }>()
  for (const m of messages) {
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    const parent = m.parent_tool_use_id
    const parentToolUseId = typeof parent === 'string' ? parent : null
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') {
        const id = typeof b.id === 'string' ? b.id : typeof b.tool_use_id === 'string' ? b.tool_use_id : null
        if (id && typeof b.name === 'string') nameById.set(id, b.name)
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resultById.set(b.tool_use_id, { isError: b.is_error === true, parentToolUseId })
      }
    }
  }
  return { nameById, resultById }
}

/** Mirrors normalize.ts's TOOL_STATUS_EXCLUDE (not exported there). Tools
 *  here are intentionally kept out of the generic toolStatus/toolResults
 *  maps because they have dedicated renderers, so their tool_result lands
 *  as an orphan bubble by design. */
function isExcludedFromMerge(toolName: string | null): boolean {
  if (!toolName) return false
  return (
    PLAN_TOOL_NAMES.has(toolName) ||
    SUBAGENT_TOOL_NAMES.has(toolName) ||
    toolName === ENTER_PLAN_MODE_TOOL_NAME ||
    toolName === 'AskUserQuestion'
  )
}

function dumpToolStatus(): ToolStatusDump[] {
  const out: ToolStatusDump[] = []
  for (const [sessionId, stores] of debugStores) {
    let storeIndex = 0
    for (const store of stores) {
      const thisStoreIndex = storeIndex++
      const state = store.getState()
      const mirror = state.mirror
      const messages = mirror.messages
      // Build the id→name / id→result indexes once. The previous dump
      // re-scanned the full message log for every problem AND every orphan
      // (O(messages × ids)); on a 500-entry ring with many tools the dump
      // itself stalled. One pass up front makes every lookup O(1).
      const index = buildToolIndex(messages)
      // Subagent result ids: an Agent/Task/Explore whose own tool_result
      // merged into its card (record.result set). MessageList folds these
      // into makeResultConsumed to suppress the orphan bubble — the dump
      // MUST mirror that, or it misclassifies a healthy merged subagent as
      // an orphan (and, worse, tags it EXPECTED so the real turn-end-wipe
      // bug reads as "working as designed").
      const subagentResultIds = new Set<string>()
      for (const [id, sub] of mirror.activeSubagents) {
        if (sub.result) subagentResultIds.add(id)
      }
      const counts = { running: 0, success: 0, error: 0 }
      for (const status of mirror.toolStatus.values()) {
        if (status === 'running') counts.running++
        else if (status === 'success') counts.success++
        else if (status === 'error') counts.error++
      }
      const problems: ToolEntryDump[] = []
      for (const [id, status] of mirror.toolStatus) {
        // 'success' is the healthy terminal state — skip it.
        if (status === 'success') continue
        const toolName = index.nameById.get(id) ?? null
        const resultMeta = index.resultById.get(id)
        const hasResult = resultMeta != null
        const resultIsError = resultMeta ? resultMeta.isError : null
        const resultParent: string | null | 'no-result' = resultMeta
          ? resultMeta.parentToolUseId
          : 'no-result'
        let diagnosis: string
        if (!hasResult) {
          diagnosis =
            'NO tool_result in live message log — either the result never arrived ' +
            '(interrupt / disconnect / process died) OR the pump dropped it as an ' +
            'echoed user frame (parent_tool_use_id == null). Compare with the on-disk ' +
            'transcript: if the result IS on disk but missing here, it is a pump-drop bug.'
        } else if (status === 'error' && resultIsError === false) {
          diagnosis =
            'ID-MISMATCH / FLIP-FAILURE: a SUCCESS tool_result exists in the log but the ' +
            'status is error — the reducer did not flip it (id extraction mismatch in ' +
            'normalize.ts, or the result message reached the reducer out of band).'
        } else if (status === 'error' && resultIsError === true) {
          diagnosis = 'Genuine tool failure — tool_result carried is_error: true.'
        } else {
          diagnosis = `status=${status} with hasResult=${hasResult} isError=${resultIsError}`
        }
        problems.push({
          toolUseId: id,
          status,
          toolName,
          hasToolResultInLog: hasResult,
          resultIsError,
          resultParentToolUseId: resultParent,
          diagnosis,
        })
      }
      // EnterPlanMode ids — it has no lifecycle map (renders as a stateless
      // marker) yet still emits a tool_result. MessageList's predicate folds
      // these in to suppress the stray bubble; mirror that here so the
      // diagnostic agrees with what's actually rendered.
      const enterPlanIds = new Set<string>()
      for (const [id, name] of index.nameById) {
        if (name === ENTER_PLAN_MODE_TOOL_NAME) enterPlanIds.add(id)
      }
      // Orphan scan: the inverse of the loop above. Instead of starting
      // from seeded ids, walk every tool_result block in the live log and
      // ask "did this get consumed by a card?" The ones that didn't are
      // exactly what MessageList draws as standalone orphan bubbles.
      const orphans: OrphanResultDump[] = []
      const seenOrphanIds = new Set<string>()
      for (const m of messages) {
        const content = m.message?.content
        if (!Array.isArray(content)) continue
        const parent = m.parent_tool_use_id
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
          const id = b.tool_use_id
          // Consumed → not an orphan. This MUST mirror the render predicate
          // (MessageList.tsx makeResultConsumed): generic inline merge
          // (toolResults), PlanCard (planStatus), QuestionCard
          // (questionAnswers), the EnterPlanMode marker (enterPlanIds), OR a
          // subagent whose result already merged into its card
          // (subagentResultIds). The last term was the gap: without it a
          // healthy merged subagent was reported as an orphan AND tagged
          // EXPECTED, so the turn-end-wipe regression read as "by design".
          if (
            mirror.toolResults.has(id) ||
            mirror.planStatus.has(id) ||
            mirror.questionAnswers.has(id) ||
            enterPlanIds.has(id) ||
            subagentResultIds.has(id)
          ) {
            continue
          }
          if (seenOrphanIds.has(id)) continue
          seenOrphanIds.add(id)
          const toolName = index.nameById.get(id) ?? null
          const excluded = isExcludedFromMerge(toolName)
          const hasSeededStatus = mirror.toolStatus.has(id)
          // Subagent cross-check: for an Agent/Task/Explore orphan, look at
          // the activeSubagents record. It tells apart the two cases the old
          // dump conflated under one "EXPECTED" blanket.
          const isSubagentTool = toolName != null && SUBAGENT_TOOL_NAMES.has(toolName)
          const subRecord = isSubagentTool ? mirror.activeSubagents.get(id) : undefined
          const subagentRecord = isSubagentTool
            ? {
                present: subRecord != null,
                status: subRecord?.status ?? null,
                hasResult: subRecord?.result != null,
              }
            : null
          let diagnosis: string
          if (isSubagentTool) {
            // We only reach here when subagentResultIds did NOT contain the id
            // (else it was skipped as consumed above). So either the record is
            // gone or its result was never captured — the card has degraded to
            // a bare placeholder and this orphan bubble is the regression, not
            // a by-design fallback.
            if (!subRecord) {
              diagnosis =
                `REAL ORPHAN — subagent "${toolName}" has NO activeSubagents record, so ` +
                'SubagentCard falls back to a bare "running" placeholder and the result ' +
                'is not merged. Classic turn-end wipe: the record was pruned at the result ' +
                'frame (reducer.ts) before its result could be read.'
            } else if (!subRecord.result) {
              if (subRecord.status === 'background' || subRecord.status === 'pending') {
                diagnosis =
                  `OK (${subRecord.status}) — subagent "${toolName}" is an async subagent mid-flight ` +
                  '(launch ack landed, real completion not yet arrived). Its ack tool_result is ' +
                  'suppressed via the background consumed-set; no result is captured yet by design. ' +
                  "('pending' = the parent turn ended and the sweep moved it out of the running set; " +
                  'completion is still expected.)'
              } else {
                diagnosis =
                  `REAL ORPHAN — subagent "${toolName}" record exists (status=${subRecord.status}) ` +
                  'but result was never captured, so the card cannot merge it. The merge step ' +
                  'in updateIndexes did not run (record not "running" when the result landed, ' +
                  'or an id mismatch).'
              }
            } else {
              // Shouldn't happen — result present means it was consumed above.
              diagnosis =
                `UNEXPECTED — subagent "${toolName}" has a captured result yet still surfaced ` +
                'as an orphan. subagentResultIds / makeResultConsumed are out of sync.'
            }
          } else if (excluded) {
            // Plan / Question results are normally consumed by their card
            // (planStatus / questionAnswers) and skipped above, so reaching
            // here for those is unusual — it means the lifecycle map was
            // pruned away while the result still lingers in the log.
            diagnosis =
              `EXPECTED-ish — "${toolName}" is excluded from the generic merge map by design ` +
              '(PlanCard / QuestionCard own it). Reaching here means its lifecycle map ' +
              '(planStatus / questionAnswers) no longer holds the id, so the card stopped ' +
              'consuming the result — investigate if a card is visibly missing.'
          } else if (toolName == null) {
            diagnosis =
              'NO matching tool_use in live log — the result arrived without (or before) ' +
              'its tool_use. Likely an out-of-order frame or a pump-drop of the assistant turn.'
          } else if (hasSeededStatus) {
            diagnosis =
              `REAL ORPHAN — "${toolName}" WAS seeded into toolStatus but its result was not ` +
              'merged into toolResults. The reducer merge step skipped it (see reducer.ts ' +
              'getToolResultEntries gate: toolStatus.has(id) && !toolResults.has(id)).'
          } else {
            diagnosis =
              `REAL ORPHAN — generic tool "${toolName}" never seeded into toolStatus, so its ` +
              'result could not merge. Likely an id-extraction mismatch in normalize.ts ' +
              '(getToolUseStarts) between the tool_use id and the tool_result tool_use_id.'
          }
          orphans.push({
            toolUseId: id,
            toolName,
            // A subagent orphan that reaches here is NEVER by-design (the
            // by-design ones were already skipped via subagentResultIds).
            isExcludedByDesign: excluded && !isSubagentTool,
            hasSeededStatus,
            parentToolUseId: typeof parent === 'string' ? parent : null,
            subagentRecord,
            diagnosis,
          })
        }
      }
      // Snapshot the activeSubagents index so subagent merge/fallback bugs
      // are directly visible (the old dump ignored this map entirely).
      const subagents: SubagentDump[] = []
      for (const [id, sub] of mirror.activeSubagents) {
        subagents.push({
          toolUseId: id,
          label: sub.label,
          status: sub.status,
          toolCount: sub.toolCount,
          hasResult: sub.result != null,
          resultIsError: sub.result ? sub.result.isError === true : null,
          startedAt: sub.startedAt ?? null,
          endedAt: sub.endedAt ?? null,
        })
      }
      const all: Record<string, string> = {}
      for (const [id, status] of mirror.toolStatus) all[id] = status
      out.push({
        sessionId,
        storeIndex: thisStoreIndex,
        total: mirror.toolStatus.size,
        counts,
        problems,
        orphans,
        subagents,
        all,
      })
    }
  }
  return out
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __crwDumpToolStatus?: () => ToolStatusDump[] }).__crwDumpToolStatus =
    dumpToolStatus

  /** Debug helper: dump liveTurn state for all sessions.
   *  Usage in DevTools console: __crwDumpLiveTurn() */
  ;(window as unknown as { __crwDumpLiveTurn?: () => void }).__crwDumpLiveTurn = () => {
    console.group('🔍 LiveTurn Debug')
    for (const [sessionId, stores] of debugStores) {
      let i = 0
      for (const store of stores) {
        const state = store.getState()
        const liveTurn = state.mirror.liveTurn
        const now = Date.now()
        const elapsed = liveTurn?.startedAt ? ((now - liveTurn.startedAt) / 1000).toFixed(2) : 'N/A'
        const writingElapsed = liveTurn?.writingStartedAt
          ? ((now - liveTurn.writingStartedAt) / 1000).toFixed(2)
          : 'N/A'
        console.log(`Session ${sessionId} (store ${i++}):`, {
          liveTurn,
          tokenRate: liveTurn?.tokenRate ?? null,
          outputTokens: liveTurn?.outputTokens ?? undefined,
          phase: liveTurn?.phase ?? null,
          hasTextChunks: liveTurn?.textChunks?.length ?? 0,
          totalChars: liveTurn?.totalChars ?? 0,
          elapsed: `${elapsed}s`,
          writingElapsed: `${writingElapsed}s`,
        })
      }
    }
    console.groupEnd()
  }

  /** Debug helper: dump the ordered message log the client holds for a
   *  session (live ring + disk-paged, already merged). This is the
   *  authoritative client-side view — what MessageList renders from.
   *  Usage in DevTools console:
   *    __crwDumpMessages('7a7a1959-...')           // returns an array
   *    __crwDumpMessages('7a7a1959-...', true)     // also console.log a summary
   *  With no arg, dumps every active session. */
  ;(window as unknown as { __crwDumpMessages?: (sessionId?: string, print?: boolean) => unknown }).__crwDumpMessages =
    (sessionId?: string, print?: boolean) => {
      const dumpOne = (sid: string, stores: Set<SessionStore>) => {
        const store = stores.values().next().value
        if (!store) return null
        const messages = store.getState().mirror.messages
        if (print) {
          console.group(`🔍 Messages for ${sid} (${messages.length})`)
          messages.forEach((m, i) => {
            const c = m.message?.content
            let desc = ''
            if (typeof c === 'string') desc = c.slice(0, 80).replace(/\n/g, ' ')
            else if (Array.isArray(c)) desc = c.map((b: Record<string, unknown>) => {
              if (b.type === 'text') return 'text:"' + String(b.text ?? '').slice(0, 60).replace(/\n/g, ' ') + '"'
              if (b.type === 'thinking') return '[thinking]'
              if (b.type === 'tool_use') return '[tool_use:' + b.name + ']'
              if (b.type === 'tool_result') return '[tool_result:' + (b.is_error ? 'err' : 'ok') + ']'
              return '[' + b.type + ']'
            }).join(' ')
            console.log(
              String(i + 1).padStart(3),
              'type=' + (m.type as string).padEnd(12),
              'parent=' + (m.parent_tool_use_id == null ? 'null' : String(m.parent_tool_use_id).slice(0, 6)),
              'isMeta=' + (m.isMeta ? 'T' : 'F'),
              'replay=' + (m.isReplay ? 'T' : 'F'),
              'uuid=' + String(m.uuid ?? '-').slice(0, 8),
              desc,
            )
          })
          console.groupEnd()
        }
        return { sessionId: sid, count: messages.length, messages }
      }
      if (sessionId) {
        const stores = debugStores.get(sessionId)
        return stores ? dumpOne(sessionId, stores) : null
      }
      const all: unknown[] = []
      for (const [sid, stores] of debugStores) all.push(dumpOne(sid, stores))
      return all
    }
}
}

