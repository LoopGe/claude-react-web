// Shell-style send history for the chat composer.
//
// Each call to add() pushes a new entry; duplicates of the most recent entry
// (within the same session) are skipped (typing the same prompt twice in a row
// shouldn't eat a slot). Navigation is cursor-style:
//   index === null  → user is editing the live draft
//   index === 0     → most recent sent message
//   index === N-1   → oldest kept entry
//
// prev() steps toward older entries, next() back toward the live draft.
//
// History is partitioned by session: each entry carries the `sessionId` it was
// sent from. composer navigation (prev/next) only walks entries belonging to
// the current session, so Mod+↑/↓ in one panel never surfaces another panel's
// prompts. The full ring is still persisted under a single localStorage key so
// the Mod+Shift+H panel can show everything; entries from before this feature
// (plain strings) migrate to `sessionId: null` ("unattributed").
//
// Persistence is handled via useLocalStorage (per-browser).

import { useCallback, useMemo, useRef, useState } from 'react'
import { useLocalStorage } from './useLocalStorage'

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
 *  Mod+Shift+H history panel, which reads the same key directly. */
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

export interface InputHistoryApi {
  /** Record a newly sent message. Consecutive same-session duplicates collapse. */
  add: (text: string) => void
  /**
   * Step to an older entry (within the current session).
   *  - `currentInput` is what the textarea shows right now; captured on
   *    first step so we can restore it with next() from beyond index 0.
   *  - returns the string to put in the textarea, or `null` if there is
   *    nothing older to show.
   */
  prev: (currentInput: string) => string | null
  /** Step toward the live draft. Returns the string to restore. */
  next: () => string | null
  /** Forget that we're in history navigation (on user edit). */
  reset: () => void
  /** Whether the user is currently browsing history (vs. editing draft). */
  isBrowsing: () => boolean
}

export function useInputHistory(
  storageKey: string,
  sessionId: string | null = null,
): InputHistoryApi {
  const [rawHistory, setHistory] = useLocalStorage<unknown[]>(storageKey, [])
  const indexRef = useRef<number | null>(null)
  const draftRef = useRef<string>('')
  // Exposing a trivial counter lets callers force-render on history moves
  // without leaking index state; unused right now but cheap to have.
  const [, tick] = useState(0)

  // Normalize once per change, then derive the current-session slice that
  // composer navigation walks. The full ring still lives in `rawHistory`.
  const sessionEntries = useMemo(() => {
    const entries = normalizeEntries(rawHistory)
    return entries.filter((e) => e.sessionId === sessionId).map((e) => e.text)
  }, [rawHistory, sessionId])

  const add = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setHistory((prev) => {
        const entries = normalizeEntries(prev)
        // Collapse only against this session's most-recent entry.
        const lastForSession = entries.find((e) => e.sessionId === sessionId)
        if (lastForSession?.text === trimmed) return prev
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
        return capped.slice(0, HISTORY_CAP)
      })
      // Reset cursor after a successful send.
      indexRef.current = null
      draftRef.current = ''
    },
    [setHistory, sessionId],
  )

  const prev = useCallback(
    (currentInput: string): string | null => {
      if (sessionEntries.length === 0) return null
      if (indexRef.current === null) {
        // Entering history — stash the live draft so next() can put it back.
        draftRef.current = currentInput
        indexRef.current = 0
      } else if (indexRef.current < sessionEntries.length - 1) {
        indexRef.current += 1
      } else {
        return null // already at oldest
      }
      tick((x) => x + 1)
      return sessionEntries[indexRef.current]
    },
    [sessionEntries],
  )

  const next = useCallback((): string | null => {
    if (indexRef.current === null) return null
    if (indexRef.current === 0) {
      // Stepped back past the newest entry → restore the draft.
      indexRef.current = null
      const draft = draftRef.current
      draftRef.current = ''
      tick((x) => x + 1)
      return draft
    }
    indexRef.current -= 1
    tick((x) => x + 1)
    return sessionEntries[indexRef.current]
  }, [sessionEntries])

  const reset = useCallback(() => {
    indexRef.current = null
    draftRef.current = ''
  }, [])

  const isBrowsing = useCallback(() => indexRef.current !== null, [])

  return { add, prev, next, reset, isBrowsing }
}
