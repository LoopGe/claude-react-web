// Query hook backing the Mod+Shift+H input-history panel.
//
// Reads the full reactive ring from `useHistoryEntries` and splits it into two
// sections — the focused session first ("This session"), then everything else
// ("All sessions" / "Other sessions"), each deduped and filtered by the panel's
// search box. Returns the flat selectable list (session entries first, then
// the rest) for keyboard navigation.
//
// Extracted from InputHistoryPanel so the grouping/dedup/filter logic is
// unit-testable without rendering the component.

import { useMemo } from 'react'
import {
  inputHistoryStore,
  useHistoryEntries,
  type InputHistoryStore,
} from '../state/inputHistoryStore'

export interface InputHistoryPanelSlice {
  /** This session's entries (deduped, filtered), most-recent first. Empty when
   *  no session is focused. */
  sessionItems: string[]
  /** All other sessions' entries (deduped, filtered). */
  otherItems: string[]
  /** Session entries first, then the rest — the selectable list. */
  flat: string[]
  /** Total entries in the store (ignores the search filter — used for the
   *  "No matches" vs "No history yet" empty-state copy). */
  totalCount: number
}

/** Dedup texts preserving first-seen order. */
function dedup(texts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of texts) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export function useInputHistoryPanel(
  currentSessionId: string | null,
  query: string,
  store: InputHistoryStore = inputHistoryStore,
): InputHistoryPanelSlice {
  const entries = useHistoryEntries(store)

  return useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (t: string) => !q || t.toLowerCase().includes(q)

    // With no focused session, there's nothing to promote — show one flat
    // "All sessions" list rather than floating legacy (null-session) entries
    // to the top under no header.
    const sessionTexts =
      currentSessionId == null
        ? []
        : dedup(
            entries.filter((e) => e.sessionId === currentSessionId).map((e) => e.text),
          ).filter(match)
    const otherTexts = dedup(
      entries
        .filter((e) => currentSessionId == null || e.sessionId !== currentSessionId)
        .map((e) => e.text),
    ).filter(match)

    return {
      sessionItems: sessionTexts,
      otherItems: otherTexts,
      flat: [...sessionTexts, ...otherTexts],
      totalCount: entries.length,
    }
  }, [entries, currentSessionId, query])
}
