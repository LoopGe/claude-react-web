// Input history browser — searchable list of previously sent messages.
//
// Triggered globally via Mod+Shift+H. Mirrors CommandPalette's UX: a search
// input at the top and a scrollable list below, navigable with arrow keys,
// confirmed with Enter, dismissed with Escape or a backdrop click.
//
// The data is the shell-style send history persisted by useInputHistory under
// INPUT_HISTORY_KEY (a single localStorage key shared across all sessions), so
// we read the raw array directly via useLocalStorage. Selecting an entry calls
// onSelect(text), which the App routes into the focused panel's composer.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { INPUT_HISTORY_KEY } from './Chat'
import { useLocalStorage } from '../hooks/useLocalStorage'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (text: string) => void
}

export function InputHistoryPanel({ open, onClose, onSelect }: Props) {
  const [history] = useLocalStorage<string[]>(INPUT_HISTORY_KEY, [])
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query) return history
    const q = query.toLowerCase()
    return history.filter((entry) => entry.toLowerCase().includes(q))
  }, [history, query])

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
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
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
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      const entry = filtered[selectedIndex]
      if (entry != null) onSelect(entry)
      onClose()
    } else if (e.key === 'Tab') {
      // Focus trap: keep Tab inside the panel.
      e.preventDefault()
      inputRef.current?.focus()
    }
  }

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
          aria-activedescendant={filtered[selectedIndex] ? `history-item-${selectedIndex}` : undefined}
        />
        <div className="palette-list" ref={listRef} id="history-list" role="listbox">
          {filtered.length === 0 && (
            <div className="palette-empty">{history.length === 0 ? 'No history yet' : 'No matches'}</div>
          )}
          {filtered.map((entry, i) => (
            <button
              key={`${i}:${entry}`}
              id={`history-item-${i}`}
              className={`palette-item${i === selectedIndex ? ' selected' : ''}`}
              role="option"
              aria-selected={i === selectedIndex}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => { onSelect(entry); onClose() }}
            >
              <span className="palette-item-label">{entry}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default InputHistoryPanel
