// Input history browser — searchable list of previously sent messages.
//
// Triggered globally via Mod+Shift+H. Mirrors CommandPalette's UX: a search
// input at the top and a scrollable list below, navigable with arrow keys,
// confirmed with Enter, dismissed with Escape or a backdrop click.
//
// The data is the shell-style send history persisted by useInputHistory under
// INPUT_HISTORY_KEY (a single localStorage key spanning all sessions). Entries
// carry the session they were sent from; this panel splits them into two
// sections — the currently-focused session first ("This session"), then
// everything else ("All sessions"), including legacy unattributed entries.
// Selecting an entry calls onSelect(text), which the App routes into the
// focused panel's composer.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { INPUT_HISTORY_KEY } from './Chat'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { normalizeEntries } from '../hooks/useInputHistory'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (text: string) => void
  /** Session whose history sorts to the top; null shows only the global list. */
  currentSessionId: string | null
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

export function InputHistoryPanel({ open, onClose, onSelect, currentSessionId }: Props) {
  const [rawHistory] = useLocalStorage<unknown[]>(INPUT_HISTORY_KEY, [])
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Split into current-session vs. everything-else, each deduped & filtered.
  const { sessionItems, otherItems, flat } = useMemo(() => {
    const entries = normalizeEntries(rawHistory)
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
      // Flat selectable list: session entries first, then the rest. Keyboard
      // navigation indexes into this; section headers are not selectable.
      flat: [...sessionTexts, ...otherTexts],
    }
  }, [rawHistory, currentSessionId, query])

  const totalCount = useMemo(() => normalizeEntries(rawHistory).length, [rawHistory])

  // Reset state when opening, synchronously before first paint so the user
  // never sees stale content from a previous invocation.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open */
  useLayoutEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-focus the input on mount / open.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keep selected item in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-entry-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Capture-phase Escape so it fires even if a child is focused.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && flat.length > 0) {
      e.preventDefault()
      const entry = flat[selectedIndex]
      if (entry != null) onSelect(entry)
      onClose()
    } else if (e.key === 'Tab') {
      // Focus trap: keep Tab inside the panel.
      e.preventDefault()
      inputRef.current?.focus()
    }
  }

  // Render one selectable entry button. `flatIndex` is its position in `flat`.
  const renderItem = (entry: string, flatIndex: number) => (
    <button
      key={`${flatIndex}:${entry}`}
      id={`history-item-${flatIndex}`}
      data-entry-index={flatIndex}
      className={`palette-item${flatIndex === selectedIndex ? ' selected' : ''}`}
      role="option"
      aria-selected={flatIndex === selectedIndex}
      onMouseEnter={() => setSelectedIndex(flatIndex)}
      onClick={() => { onSelect(entry); onClose() }}
    >
      <span className="palette-item-label">{entry}</span>
    </button>
  )

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Input history" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Search input history…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          aria-label="Search input history"
          aria-autocomplete="list"
          aria-controls="history-list"
          aria-activedescendant={flat[selectedIndex] != null ? `history-item-${selectedIndex}` : undefined}
        />
        <div className="palette-list" ref={listRef} id="history-list" role="listbox">
          {flat.length === 0 && (
            <div className="palette-empty">{totalCount === 0 ? 'No history yet' : 'No matches'}</div>
          )}
          {sessionItems.length > 0 && currentSessionId != null && (
            <div className="palette-section-label">This session</div>
          )}
          {sessionItems.map((entry, i) => renderItem(entry, i))}
          {otherItems.length > 0 && (
            <div className="palette-section-label">
              {currentSessionId != null ? 'Other sessions' : 'All sessions'}
            </div>
          )}
          {otherItems.map((entry, i) => renderItem(entry, sessionItems.length + i))}
        </div>
      </div>
    </div>
  )
}

export default InputHistoryPanel
