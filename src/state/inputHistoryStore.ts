// Single source of truth for the shell-style send history.
//
// The input history is a bounded ring of every prompt the user has sent,
// partitioned by the session it was sent from. It has two distinct consumers
// with different needs:
//   - the composer's ↑/↓ navigation (per-session slice, optional mode filter,
//     cursor state)
//   - the Mod+Shift+H history panel (the full ring, search-filtered, with the
//     focused session promoted to the top)
//
// Both used to reach into the same localStorage key via their own
// `useLocalStorage` instances. That worked (useLocalStorage cross-syncs
// same-tab instances) but left no single owner of the write path — caps,
// dedup, and move-to-front logic lived inside the composer's hook, and the
// panel re-parsed the raw value independently. This module is the owner: one
// external store, one writer, `useSyncExternalStore` for reactive reads.
//
// `createInputHistoryStore(key)` is a factory so tests can spin up an isolated
// store under a throwaway key. The app uses the default singleton
// `inputHistoryStore`, bound to INPUT_HISTORY_KEY.

import { useSyncExternalStore } from 'react'

// localStorage key. The single source; no caller reads this key directly anymore.
export const INPUT_HISTORY_KEY = 'claude-react-web:input-history'

// Global cap across all sessions, then a tighter per-session cap so one busy
// session can't crowd the others out of the shared ring.
const HISTORY_CAP = 100
const SESSION_HISTORY_CAP = 20

export interface HistoryEntry {
  text: string
  /** Session the entry was sent from; null for legacy/unattributed entries. */
  sessionId: string | null
}

/** Coerce a raw persisted value (which may be the legacy `string[]` shape or
 *  the current `HistoryEntry[]` shape) into normalized entries. Legacy plain
 *  strings become `{ text, sessionId: null }`. Exported for reuse by the
 *  Mod+Shift+H history panel and tests. */
export function normalizeEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ text: item, sessionId: null })
    } else if (
      item != null &&
      typeof item === 'object' &&
      typeof (item as HistoryEntry).text === 'string'
    ) {
      const e = item as HistoryEntry
      out.push({ text: e.text, sessionId: e.sessionId ?? null })
    }
  }
  return out
}

export interface InputHistoryStore {
  /** Record a newly sent message. Consecutive same-session duplicates collapse;
   *  same-session identical earlier entry moves to front. Enforces per-session
   *  (20) and global (100) caps. No-op for empty/whitespace input. */
  add: (text: string, sessionId: string | null) => void
  /** The full ring (most-recent first). Referentially stable between writes. */
  getAll: () => HistoryEntry[]
  /** Texts belonging to one session, most-recent first. */
  getSession: (sessionId: string | null) => string[]
  /** Subscribe to ring changes (for useSyncExternalStore). */
  subscribe: (fn: () => void) => () => void
  /** Snapshot for useSyncExternalStore — same reference as getAll() until the
   *  next write/storage event. */
  getSnapshot: () => HistoryEntry[]
  /** Drop the in-memory cache and re-read from localStorage on next access.
   *  Tests use this after mutating localStorage directly. */
  reset: () => void
  /** Wipe all entries from memory and localStorage. */
  clear: () => void
}

export function createInputHistoryStore(key: string): InputHistoryStore {
  // Cache holds the parsed ring. Null = stale → re-read on next access. The
  // cache is what makes getSnapshot referentially stable across renders when
  // nothing changed (a hard requirement of useSyncExternalStore).
  let cache: HistoryEntry[] | null = null
  const listeners = new Set<() => void>()

  function read(): HistoryEntry[] {
    if (cache) return cache
    let raw: unknown = null
    if (typeof window !== 'undefined') {
      try {
        const stored = window.localStorage.getItem(key)
        raw = stored == null ? null : JSON.parse(stored)
      } catch {
        // Corrupt JSON — treat as empty rather than crash every render.
        raw = null
      }
    }
    cache = normalizeEntries(raw)
    return cache
  }

  function persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(cache))
    } catch (err) {
      // Quota exhausted / private mode. In-memory state still updates and
      // notifies, but won't survive reload. Warn — never swallow silently.
      const quota =
        err instanceof DOMException &&
        (err.code === 22 ||
          err.code === 1014 ||
          err.name === 'QuotaExceededError' ||
          err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      console.warn(
        `[inputHistoryStore] failed to persist "${key}"` +
          (quota ? ' — localStorage quota is full; this key was NOT saved' : '') +
          ':',
        err,
      )
    }
  }

  function emit(): void {
    for (const fn of [...listeners]) fn()
  }

  function commit(next: HistoryEntry[]): void {
    cache = next
    persist()
    emit()
  }

  // Cross-tab sync. Storage events do NOT fire in the writing tab (the in-tab
  // emit() above covers that), so this only reacts to other tabs/windows.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== key || e.newValue == null) return
      cache = null // invalidate; read() re-parses on next access
      emit()
    })
  }

  return {
    add(text, sessionId) {
      const trimmed = text.trim()
      if (!trimmed) return
      const entries = read()
      // Collapse only against this session's most-recent entry.
      const lastForSession = entries.find((e) => e.sessionId === sessionId)
      if (lastForSession?.text === trimmed) return
      // Drop an earlier identical entry from the same session (move-to-front),
      // leaving other sessions' identical prompts untouched.
      const filtered = entries.filter(
        (e) => !(e.sessionId === sessionId && e.text === trimmed),
      )
      const merged: HistoryEntry[] = [{ text: trimmed, sessionId }, ...filtered]
      // Per-session cap: keep only this session's 20 most recent entries
      // (they appear front-to-back in recency order), passing every other
      // session's entries through untouched.
      let kept = 0
      const capped = merged.filter((e) => {
        if (e.sessionId !== sessionId) return true
        kept += 1
        return kept <= SESSION_HISTORY_CAP
      })
      // Then the global cap across all sessions.
      commit(capped.slice(0, HISTORY_CAP))
    },
    getAll() {
      return read()
    },
    getSession(sessionId) {
      return read()
        .filter((e) => e.sessionId === sessionId)
        .map((e) => e.text)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getSnapshot() {
      return read()
    },
    reset() {
      cache = null
      emit()
    },
    clear() {
      commit([])
    },
  }
}

/** The app-wide singleton. Components consume it via the hooks below; tests
 *  build their own with `createInputHistoryStore('throwaway-key')`. */
export const inputHistoryStore = createInputHistoryStore(INPUT_HISTORY_KEY)

/** Reactive read of the full ring. Re-renders on any write or cross-tab
 *  storage event. Returns a referentially-stable array between changes. */
export function useHistoryEntries(store: InputHistoryStore = inputHistoryStore): HistoryEntry[] {
  // store.subscribe / store.getSnapshot are stable method references on the
  // store object (created once at factory time), so they can be passed
  // directly without re-subscribing each render.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
