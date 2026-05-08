// Shell-style send history for the chat composer.
//
// Each call to add() pushes a new entry; duplicates of the most recent entry
// are skipped (typing the same prompt twice in a row shouldn't eat a slot).
// Navigation is cursor-style:
//   index === null  → user is editing the live draft
//   index === 0     → most recent sent message
//   index === N-1   → oldest kept entry
//
// prev() steps toward older entries, next() back toward the live draft.
// Persistence is handled via useLocalStorage (per-browser, cross-session).

import { useCallback, useRef, useState } from 'react'
import { useLocalStorage } from './useLocalStorage'

const HISTORY_CAP = 100

export interface InputHistoryApi {
  /** Record a newly sent message. Consecutive duplicates collapse. */
  add: (text: string) => void
  /**
   * Step to an older entry.
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

export function useInputHistory(storageKey: string): InputHistoryApi {
  const [history, setHistory] = useLocalStorage<string[]>(storageKey, [])
  const indexRef = useRef<number | null>(null)
  const draftRef = useRef<string>('')
  // Exposing a trivial counter lets callers force-render on history moves
  // without leaking index state; unused right now but cheap to have.
  const [, tick] = useState(0)

  const add = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setHistory((prev) => {
        if (prev[0] === trimmed) return prev
        const next = [trimmed, ...prev.filter((x) => x !== trimmed)]
        return next.slice(0, HISTORY_CAP)
      })
      // Reset cursor after a successful send.
      indexRef.current = null
      draftRef.current = ''
    },
    [setHistory],
  )

  const prev = useCallback(
    (currentInput: string): string | null => {
      if (history.length === 0) return null
      if (indexRef.current === null) {
        // Entering history — stash the live draft so next() can put it back.
        draftRef.current = currentInput
        indexRef.current = 0
      } else if (indexRef.current < history.length - 1) {
        indexRef.current += 1
      } else {
        return null // already at oldest
      }
      tick((x) => x + 1)
      return history[indexRef.current]
    },
    [history],
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
    return history[indexRef.current]
  }, [history])

  const reset = useCallback(() => {
    indexRef.current = null
    draftRef.current = ''
  }, [])

  const isBrowsing = useCallback(() => indexRef.current !== null, [])

  return { add, prev, next, reset, isBrowsing }
}
