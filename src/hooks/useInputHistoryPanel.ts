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
  type HistoryEntry,
  type InputHistoryStore,
} from '../state/inputHistoryStore'

/** One selectable history entry: the text plus the image-record id of the
 *  NEWEST ring entry carrying that text (null when text-only / legacy) —
 *  the id is what recall loads images from. */
export interface HistoryPanelEntry {
  text: string
  id: string | null
}

export interface InputHistoryPanelSlice {
  /** This session's entries (deduped, filtered), most-recent first. Empty when
   *  no session is focused. */
  sessionItems: HistoryPanelEntry[]
  /** All other sessions' entries (deduped, filtered). */
  otherItems: HistoryPanelEntry[]
  /** Session entries first, then the rest — the selectable list. */
  flat: HistoryPanelEntry[]
  /** Total entries in the store (ignores the search filter — used for the
   *  "No matches" vs "No history yet" empty-state copy). */
  totalCount: number
}

/** Dedup entries by text preserving first-seen (most-recent) order; each
 *  survivor keeps the newest entry's image-record id. */
function dedupEntries(entries: HistoryEntry[]): HistoryPanelEntry[] {
  const seen = new Set<string>()
  const out: HistoryPanelEntry[] = []
  for (const e of entries) {
    if (seen.has(e.text)) continue
    seen.add(e.text)
    out.push({ text: e.text, id: e.id ?? null })
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
    const filterText = (items: HistoryPanelEntry[]) => items.filter((e) => match(e.text))

    // With no focused session, there's nothing to promote — show one flat
    // "All sessions" list rather than floating legacy (null-session) entries
    // to the top under no header.
    const sessionEntries =
      currentSessionId == null
        ? []
        : dedupEntries(entries.filter((e) => e.sessionId === currentSessionId))
    const otherEntries = dedupEntries(
      entries.filter((e) => currentSessionId == null || e.sessionId !== currentSessionId),
    )
    const sessionItems = filterText(sessionEntries)
    const otherItems = filterText(otherEntries)

    return {
      sessionItems,
      otherItems,
      flat: [...sessionItems, ...otherItems],
      totalCount: entries.length,
    }
  }, [entries, currentSessionId, query])
}
