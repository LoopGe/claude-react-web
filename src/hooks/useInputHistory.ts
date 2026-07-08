// Shell-style send history for the chat composer — facade over the
// `inputHistoryStore` data layer + `useHistoryCursor` navigation cursor.
//
// This hook preserves the original `{ add, prev, next, reset, isBrowsing }`
// API the composer consumes, so the call site (`Chat.tsx`) keeps the same
// surface. The internals are re-architected:
//   - persistence (dedup, per-session/global caps, move-to-front, legacy
//     migration) lives in `src/state/inputHistoryStore.ts` — the single writer
//   - browse cursor state lives in `useHistoryCursor`
//   - this facade just wires `add` → store + cursor reset
//
// `store` is injectable for tests; production uses the app-wide singleton.

import { useCallback } from 'react'
import { inputHistoryStore, type InputHistoryStore } from '../state/inputHistoryStore'
import { useHistoryCursor } from './useHistoryCursor'

export interface InputHistoryApi {
  /** Record a newly sent message. Consecutive same-session duplicates collapse. */
  add: (text: string) => void
  /** Step to an older entry (within the current session). Returns the string
   *  to put in the textarea, or `null` if there is nothing older to show. */
  prev: (currentInput: string) => string | null
  /** Step toward the live draft. Returns the string to restore. */
  next: () => string | null
  /** Forget that we're in history navigation (on user edit). */
  reset: () => void
  /** Whether the user is currently browsing history (vs. editing draft). */
  isBrowsing: () => boolean
}

export function useInputHistory(
  sessionId: string | null = null,
  /** Optional predicate to narrow the navigable entries. The full ring is
   *  still stored (add() writes everything); this only filters what prev/next
   *  walk. Used by `!` bash mode to isolate shell history from chat history:
   *  pass `(s) => s.startsWith('!')` in bash mode, `(s) => !s.startsWith('!')`
   *  otherwise. The filter is read fresh on each prev/next call so a mode
   *  switch mid-browsing picks up the new slice without a stale closure. */
  filter: ((entry: string) => boolean) | null = null,
  store: InputHistoryStore = inputHistoryStore,
): InputHistoryApi {
  const { prev, next, reset, isBrowsing } = useHistoryCursor(sessionId, filter, store)

  const add = useCallback(
    (text: string) => {
      store.add(text, sessionId)
      // Reset cursor after a successful send.
      reset()
    },
    [store, sessionId, reset],
  )

  return { add, prev, next, reset, isBrowsing }
}
