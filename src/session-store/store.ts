import { createInitialSessionState, type SessionAction, type SessionSnapshot, type SessionState, type TranscriptItem } from './types'
import { rebuildIndexesFromMessages, reduceSessionState } from './reducer'
import { extractMessagePlainText } from '../search'
import type { SdkMessage } from '../types'
import { PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME } from '../constants/toolNames'

type Listener = () => void

const STORAGE_PREFIX = 'claude-web-session:'
// Per-session cap. Kept well below the browser's ~5MB total localStorage
// quota so a single large transcript can't monopolise storage and starve
// unrelated keys (session-groups, sidebar-order, …). A session over this
// is trimmed to its last 200 messages in persistToStorage.
const STORAGE_MAX_BYTES = 1 * 1024 * 1024 // 1MB per session
// Total byte budget across ALL claude-web-session:* entries. The eviction
// pass keeps the sum under this so the cache can never fill the ~5MB quota
// and cause QuotaExceededError on unrelated setItem calls. ~1.5MB headroom
// is left for every other (small) key.
const STORAGE_TOTAL_BUDGET = 3.5 * 1024 * 1024 // 3.5MB across all sessions
const MAX_CACHED_SESSIONS = 20

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
    while (
      entries.length > 0 &&
      (totalBytes > STORAGE_TOTAL_BUDGET || entries.length > MAX_CACHED_SESSIONS)
    ) {
      const oldest = entries.shift()!
      localStorage.removeItem(oldest.key)
      totalBytes -= oldest.bytes
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

function persistToStorage(sessionId: string, state: SessionState): void {
  // plainText is derived from msg via extractMessagePlainText — we never
  // persist it. loadFromStorage re-derives on hydrate so format upgrades
  // to the extractor land automatically.
  const payload = JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    messages: state.messages,
    items: state.items.map((i) => ({
      id: i.id,
      isCompactSummary: i.isCompactSummary,
      hiddenByDefault: i.hiddenByDefault,
      // Store msg as raw object — SdkMessage is loosely typed
      msg: i.msg,
    })),
    lastMessageUuid: state.lastMessageUuid,
  })
  // Trim oversized transcripts to their last 200 messages so a single
  // session can't blow past STORAGE_MAX_BYTES.
  const toWrite =
    payload.length > STORAGE_MAX_BYTES
      ? JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          messages: state.messages.slice(-200),
          items: state.items.slice(-200).map((i) => ({
            id: i.id,
            msg: i.msg,
            isCompactSummary: i.isCompactSummary,
            hiddenByDefault: i.hiddenByDefault,
          })),
          lastMessageUuid: state.lastMessageUuid,
        })
      : payload

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

function loadFromStorage(sessionId: string): { messages: TranscriptItem[]; rawMessages: unknown[]; lastMessageUuid: string | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sessionId)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || data.v !== 1 || !Array.isArray(data.items)) return null
    const items = data.items as Array<{
      id: string
      msg: SdkMessage
      isCompactSummary?: boolean
      hiddenByDefault?: boolean
    }>
    const messages = items.map((i) => ({
      id: i.id,
      msg: i.msg,
      // Re-derive on hydrate.  Older payloads (pre-rename) had a
      // `searchableText` field; we ignore it because the extractor
      // we're using now produces a different (and aligned) view.
      plainText: extractMessagePlainText(i.msg),
      isCompactSummary: i.isCompactSummary ?? false,
      hiddenByDefault: i.hiddenByDefault ?? false,
    })) as TranscriptItem[]
    return {
      messages,
      rawMessages: data.messages ?? [],
      lastMessageUuid: data.lastMessageUuid ?? null,
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
  /** Per-instance subagent filter cache — moved off module scope so
   *  multiple SessionStore instances (multi-panel layouts) don't
   *  thrash a shared single-slot cache against each other. */
  private cachedSubagentsMap: SessionState['activeSubagents'] | null = null
  private cachedRunningSubagents: SessionSnapshot['activeSubagents'] = []

  constructor(sessionId: string) {
    registerStoreForDebug(sessionId, this)
    // Try to restore from localStorage cache first
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
      const seeded: SessionState = {
        ...createInitialSessionState(sessionId),
        items: cached.messages,
        messages: cached.rawMessages as SessionState['messages'],
        lastMessageUuid: cached.lastMessageUuid,
        replayReady: true, // Treat cached data as "replayed"
      }
      this.state = rebuildIndexesFromMessages(seeded, seeded.messages)
      this.snapshot = this.buildSnapshot(this.state)
    } else {
      this.state = createInitialSessionState(sessionId)
      this.snapshot = this.buildSnapshot(this.state)
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
    this.state = next
    this.snapshot = this.buildSnapshot(next)
    this.scheduleFlush()
    this.scheduleSave()
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

  reset(): void {
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dispatch({ type: 'RESET' })
  }

  destroy(): void {
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
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private scheduleFlush(): void {
    if (!this.state.liveTurn?.dirty || this.flushTimer != null) return
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
  }

  /** Per-instance equivalent of the old module-global running-subagents
   *  cache. The Map reference is compared by identity so the filtered
   *  array is only reallocated when activeSubagents actually changes. */
  private getRunningSubagents(map: SessionState['activeSubagents']): SessionSnapshot['activeSubagents'] {
    if (map === this.cachedSubagentsMap) return this.cachedRunningSubagents
    this.cachedSubagentsMap = map
    this.cachedRunningSubagents = Array.from(map.values()).filter((s) => s.status === 'running')
    return this.cachedRunningSubagents
  }

  private buildSnapshot(state: SessionState): SessionSnapshot {
    return {
      replayReady: state.replayReady,
      items: state.items,
      messages: state.messages,
      streamingContent: state.liveTurn?.flushedText ?? null,
      activePhase: state.liveTurn?.phase ?? null,
      tokenRate: state.liveTurn?.tokenRate ?? null,
      contextUsage: state.contextUsage,
      error: state.error,
      queuedAhead: state.queuedAhead,
      permissionDecisions: state.permissionDecisions,
      planStatus: state.planStatus,
      planContent: state.planContent,
      questionAnswers: state.questionAnswers,
      toolStatus: state.toolStatus,
      toolResults: state.toolResults,
      activeSubagents: this.getRunningSubagents(state.activeSubagents),
      subagentIndex: state.activeSubagents,
      lastMessageUuid: state.lastMessageUuid,
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
// `isExcludedByDesign` — true for Plan/Question/Subagent (expected fallback,
// they own their rendering) and false for a generic tool whose result should
// have merged but didn't (a real matching bug). Read the `diagnosis` field.
//
// Paste the output back and we can name the root cause with certainty.

const debugStores = new Map<string, Set<SessionStore>>()

function registerStoreForDebug(sessionId: string, store: SessionStore): void {
  let set = debugStores.get(sessionId)
  if (!set) {
    set = new Set()
    debugStores.set(sessionId, set)
  }
  set.add(store)
}

function unregisterStoreForDebug(sessionId: string, store: SessionStore): void {
  const set = debugStores.get(sessionId)
  if (!set) return
  set.delete(store)
  if (set.size === 0) debugStores.delete(sessionId)
}

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
  diagnosis: string
}

interface ToolStatusDump {
  sessionId: string
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
  all: Record<string, string>
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
    for (const store of stores) {
      const state = store.getState()
      const messages = state.messages
      const counts = { running: 0, success: 0, error: 0 }
      for (const status of state.toolStatus.values()) {
        if (status === 'running') counts.running++
        else if (status === 'success') counts.success++
        else if (status === 'error') counts.error++
      }
      const problems: ToolEntryDump[] = []
      for (const [id, status] of state.toolStatus) {
        // 'success' is the healthy terminal state — skip it.
        if (status === 'success') continue
        let toolName: string | null = null
        let hasResult = false
        let resultIsError: boolean | null = null
        let resultParent: string | null | 'no-result' = 'no-result'
        for (const m of messages) {
          const content = m.message?.content
          if (!Array.isArray(content)) continue
          for (const b of content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_use' && (b.id === id || b.tool_use_id === id)) {
              toolName = typeof b.name === 'string' ? b.name : null
            }
            if (b.type === 'tool_result' && b.tool_use_id === id) {
              hasResult = true
              resultIsError = b.is_error === true
              const parent = (m as Record<string, unknown>).parent_tool_use_id
              resultParent = typeof parent === 'string' ? parent : null
            }
          }
        }
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
      for (const m of messages) {
        const content = m.message?.content
        if (!Array.isArray(content)) continue
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_use' && b.name === ENTER_PLAN_MODE_TOOL_NAME) {
            const eid = typeof b.id === 'string' ? b.id : typeof b.tool_use_id === 'string' ? b.tool_use_id : null
            if (eid) enterPlanIds.add(eid)
          }
        }
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
        const parent = (m as Record<string, unknown>).parent_tool_use_id
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
          const id = b.tool_use_id
          // Consumed → not an orphan. This MUST mirror the render predicate
          // (MessageList.tsx makeResultConsumed): generic inline merge
          // (toolResults), PlanCard (planStatus), QuestionCard
          // (questionAnswers), or the EnterPlanMode marker (enterPlanIds).
          // Subagent ids are in none of these, so they still surface as
          // orphan bubbles by design.
          if (
            state.toolResults.has(id) ||
            state.planStatus.has(id) ||
            state.questionAnswers.has(id) ||
            enterPlanIds.has(id)
          ) {
            continue
          }
          if (seenOrphanIds.has(id)) continue
          seenOrphanIds.add(id)
          // Resolve the originating tool_use name (search the whole log).
          let toolName: string | null = null
          for (const mm of messages) {
            const c = mm.message?.content
            if (!Array.isArray(c)) continue
            for (const bb of c as Array<Record<string, unknown>>) {
              if (bb.type === 'tool_use' && (bb.id === id || bb.tool_use_id === id)) {
                toolName = typeof bb.name === 'string' ? bb.name : null
              }
            }
          }
          const excluded = isExcludedFromMerge(toolName)
          const hasSeededStatus = state.toolStatus.has(id)
          let diagnosis: string
          if (excluded) {
            // Plan / Question results are normally consumed by their card
            // (planStatus / questionAnswers) and skipped above, so reaching
            // here for those is unusual — it means the lifecycle map was
            // pruned away while the result still lingers in the log. Subagent
            // (Agent/Task/Explore) results legitimately surface as bubbles:
            // SubagentCard owns the input card, the result bubble is the
            // worker's only output in the main transcript and is kept by design.
            diagnosis =
              `EXPECTED — "${toolName}" is excluded from the merge map by design; ` +
              'its dedicated renderer (PlanCard / QuestionCard / SubagentCard) is the ' +
              'real card. For Subagent the orphan bubble is the worker output (kept); ' +
              'for Plan/Question the result is normally suppressed once its card consumes it.'
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
            isExcludedByDesign: excluded,
            hasSeededStatus,
            parentToolUseId: typeof parent === 'string' ? parent : null,
            diagnosis,
          })
        }
      }
      const all: Record<string, string> = {}
      for (const [id, status] of state.toolStatus) all[id] = status
      out.push({ sessionId, total: state.toolStatus.size, counts, problems, orphans, all })
    }
  }
  console.log('[toolStatus dump]', out)
  return out
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __crwDumpToolStatus?: () => ToolStatusDump[] }).__crwDumpToolStatus =
    dumpToolStatus
}

