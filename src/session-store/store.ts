import { createInitialSessionState, type SessionAction, type SessionSnapshot, type SessionState, type TranscriptItem } from './types'
import { rebuildIndexesFromMessages, reduceSessionState } from './reducer'
import { extractMessagePlainText } from '../search'
import type { SdkMessage } from '../types'

type Listener = () => void

const STORAGE_PREFIX = 'claude-web-session:'
const STORAGE_MAX_BYTES = 4 * 1024 * 1024 // 4MB per session (localStorage limit ~5MB)
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

/** Evict oldest localStorage entries when we have too many cached sessions.
 *  Throttled to run at most once per minute to avoid repeated JSON.parse
 *  overhead on every persistToStorage call. */
let _lastPruneAt = 0
function pruneStorageCache(): void {
  const now = Date.now()
  if (now - _lastPruneAt < 60_000) return
  _lastPruneAt = now
  try {
    const entries: Array<{ key: string; ts: number }> = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const data = JSON.parse(raw) as { savedAt?: number }
        // Use the savedAt timestamp written by persistToStorage.
        // Fall back to 0 for entries written by older versions.
        entries.push({ key, ts: typeof data.savedAt === 'number' ? data.savedAt : 0 })
      } catch {
        entries.push({ key, ts: 0 })
      }
    }
    // Sort oldest first — evict the least-recently-saved entries.
    entries.sort((a, b) => a.ts - b.ts)
    while (entries.length > MAX_CACHED_SESSIONS) {
      const oldest = entries.shift()!
      localStorage.removeItem(oldest.key)
    }
  } catch { /* ignore */ }
}

/** Persist a session's transcript to localStorage so it survives store
 *  destruction (idle pruning) and page reloads. Only stores the essential
 *  data needed to render the conversation — liveTurn, permissions, and
 *  other ephemeral state are excluded. */
function persistToStorage(sessionId: string, state: SessionState): void {
  try {
    // plainText is derived from msg via extractMessagePlainText —
    // we never persist it.  loadFromStorage re-derives on hydrate
    // so format upgrades to the extractor land automatically.
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
    if (payload.length > STORAGE_MAX_BYTES) {
      // Trim oldest items to fit — keep last 200 messages max
      const trimmed = JSON.stringify({
        v: 1,
        messages: state.messages.slice(-200),
        items: state.items.slice(-200).map((i) => ({
          id: i.id,
          msg: i.msg,
          isCompactSummary: i.isCompactSummary,
          hiddenByDefault: i.hiddenByDefault,
        })),
        lastMessageUuid: state.lastMessageUuid,
      })
      localStorage.setItem(STORAGE_PREFIX + sessionId, trimmed)
    } else {
      localStorage.setItem(STORAGE_PREFIX + sessionId, payload)
    }
    pruneStorageCache()
  } catch {
    // localStorage quota exceeded or unavailable — silently skip
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
    }, 33)
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

interface ToolStatusDump {
  sessionId: string
  total: number
  /** Quick counts so the headline failure mode is visible at a glance. */
  counts: { running: number; success: number; error: number }
  /** Every non-success tool entry, with per-id result analysis. The
   *  previous version only analyzed 'running' entries — useless once the
   *  turn-end sweep has flipped lingering 'running' tools to 'error'. */
  problems: ToolEntryDump[]
  all: Record<string, string>
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
      const all: Record<string, string> = {}
      for (const [id, status] of state.toolStatus) all[id] = status
      out.push({ sessionId, total: state.toolStatus.size, counts, problems, all })
    }
  }
  console.log('[toolStatus dump]', out)
  return out
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __crwDumpToolStatus?: () => ToolStatusDump[] }).__crwDumpToolStatus =
    dumpToolStatus
}

