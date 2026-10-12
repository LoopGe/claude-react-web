// Shell-style history navigation cursor for the chat composer.
//
// Pure UI state: the browse index + stashed live draft. Consumes the reactive
// session slice from `useHistoryEntries` (so it re-derives whenever the store
// changes) and walks it with prev()/next().
//
//   index === null  → user is editing the live draft
//   index === 0     → most recent sent message
//   index === N-1   → oldest kept entry
//
// prev() steps toward older entries, next() back toward the live draft.
//
// `filter` narrows the navigable slice (used by `!` bash mode to isolate shell
// history from chat history) without affecting what the store keeps. The
// filter is captured in a useMemo so a mode switch mid-browsing re-derives the
// slice; the cursor is reset to null on slice identity change so a stale index
// into the old slice can't overrun the new one.
//
// Persistence + dedup/caps live in `inputHistoryStore`; this hook holds no
// storage of its own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  inputHistoryStore,
  useHistoryEntries,
  type InputHistoryStore,
} from '../state/inputHistoryStore'

export interface HistoryRecall {
  /** The text to put in the composer. */
  text: string
  /** The entry's image-record id (key into the `inputHistoryImages` IDB side
   *  store) when this recall IS a history entry; null for a text-only /
   *  legacy entry. */
  id: string | null
  /** True when this recall is the stashed live draft being restored
   *  (next() past index 0) — the caller restores the images it stashed on
   *  entering browse rather than loading an entry's from IDB. A text-only
   *  ENTRY is isDraft:false with id:null, so the two cases never collide. */
  isDraft: boolean
}

export interface HistoryCursor {
  /**
   * Step to an older entry.
   *  - `currentInput` is what the textarea shows right now; captured on
   *    first step so we can restore it with next() from beyond index 0.
   *  - returns the recall (`text` + image-record `id`), or `null` if there
   *    is nothing older to show.
   */
  prev: (currentInput: string) => HistoryRecall | null
  /** Step toward the live draft. The draft restore carries `id: null`. */
  next: () => HistoryRecall | null
  /** Forget that we're in history navigation (on user edit / after send). */
  reset: () => void
  /** Whether the user is currently browsing history (vs. editing draft). */
  isBrowsing: () => boolean
}

export function useHistoryCursor(
  sessionId: string | null = null,
  filter: ((entry: string) => boolean) | null = null,
  store: InputHistoryStore = inputHistoryStore,
): HistoryCursor {
  const all = useHistoryEntries(store)

  // Derive the current-session slice (full entries — recall carries the entry
  // id for image loading), then narrow by the optional text filter.
  const entries = useMemo(() => {
    const sessionEntries = all.filter((e) => e.sessionId === sessionId)
    return filter ? sessionEntries.filter((e) => filter(e.text)) : sessionEntries
  }, [all, sessionId, filter])

  const indexRef = useRef<number | null>(null)
  const draftRef = useRef<string>('')
  // Trivial counter lets callers force-render on history moves without leaking
  // index state.
  const [, tick] = useState(0)

  // Reset the browse cursor whenever the navigable slice CONTENT changes
  // (filter flip or new history). Deps on a content key (not the array
  // identity) so a cross-panel store write that churns `entries` identity
  // without changing THIS session's slice content doesn't null the cursor
  // and lose the stashed draft.
  const entriesKey = entries.map((e) => e.text).join('')
  useEffect(() => {
    indexRef.current = null
  }, [entriesKey])

  const prev = useCallback(
    (currentInput: string): HistoryRecall | null => {
      if (entries.length === 0) return null
      if (indexRef.current === null) {
        // Entering history — stash the live draft so next() can put it back.
        draftRef.current = currentInput
        indexRef.current = 0
      } else if (indexRef.current < entries.length - 1) {
        indexRef.current += 1
      } else {
        return null // already at oldest
      }
      tick((x) => x + 1)
      const e = entries[indexRef.current]
      return { text: e.text, id: e.id ?? null, isDraft: false }
    },
    [entries],
  )

  const next = useCallback((): HistoryRecall | null => {
    if (indexRef.current === null) return null
    if (indexRef.current === 0) {
      // Stepped back past the newest entry → restore the draft (id null —
      // the caller restores whatever it stashed for the draft).
      indexRef.current = null
      const draft = draftRef.current
      draftRef.current = ''
      tick((x) => x + 1)
      return { text: draft, id: null, isDraft: true }
    }
    indexRef.current -= 1
    tick((x) => x + 1)
    const e = entries[indexRef.current]
    return { text: e.text, id: e.id ?? null, isDraft: false }
  }, [entries])

  const reset = useCallback(() => {
    indexRef.current = null
    draftRef.current = ''
  }, [])

  const isBrowsing = useCallback(() => indexRef.current !== null, [])

  return { prev, next, reset, isBrowsing }
}
