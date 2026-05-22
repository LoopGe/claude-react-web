import { createInitialSessionState, type SessionAction, type SessionSnapshot, type SessionState, type TranscriptItem } from './types'
import { reduceSessionState } from './reducer'

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
    const payload = JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      messages: state.messages,
      items: state.items.map((i) => ({
        id: i.id,
        searchableText: i.searchableText,
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
          searchableText: i.searchableText,
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
      msg: unknown
      searchableText?: string | null
      isCompactSummary?: boolean
      hiddenByDefault?: boolean
    }>
    const messages = items.map((i) => ({
      id: i.id,
      msg: i.msg,
      searchableText: i.searchableText ?? null,
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
    // Try to restore from localStorage cache first
    const cached = loadFromStorage(sessionId)
    if (cached && cached.messages.length > 0) {
      this.state = {
        ...createInitialSessionState(sessionId),
        items: cached.messages,
        messages: cached.rawMessages as SessionState['messages'],
        lastMessageUuid: cached.lastMessageUuid,
        replayReady: true, // Treat cached data as "replayed"
      }
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
      activeSubagents: this.getRunningSubagents(state.activeSubagents),
      subagentIndex: state.activeSubagents,
      lastMessageUuid: state.lastMessageUuid,
    }
  }
}

