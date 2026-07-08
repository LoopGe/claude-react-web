// Input history browser — searchable list of previously sent messages.
//
// Triggered via Mod+Shift+H (App routes the open state to the focused panel).
// Mirrors CommandPalette's UX: a search input at the top and a scrollable list
// below, navigable with arrow keys, confirmed with Enter, dismissed with
// Escape or a backdrop click.
//
// Rendered as an in-panel overlay (PanelOverlay) — column-scoped to the chat
// panel whose session is focused, not a full-app modal. The selected entry is
// injected into THAT panel's composer via onSelect (Chat wires it to
// setInput + history.reset()).
//
// The data is the shell-style send history owned by `inputHistoryStore` (a
// single localStorage key spanning all sessions). This panel splits it into
// two sections — the currently-focused session first ("This session"), then
// everything else ("All sessions" / "Other sessions"), including legacy
// unattributed entries.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useInputHistoryPanel } from '../hooks/useInputHistoryPanel'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { PanelOverlay } from './PanelOverlay'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (text: string) => void
  /** Session whose history sorts to the top; null shows only the global list. */
  currentSessionId: string | null
}

export function InputHistoryPanel({ open, onClose, onSelect, currentSessionId }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)

  const { sessionItems, otherItems, flat, totalCount } = useInputHistoryPanel(
    currentSessionId,
    query,
  )

  // Defensive clamp for display: a cross-tab store update could shrink `flat`
  // below the cursor. Query changes reset to 0 in onChange, and Enter checks
  // `entry != null`, so this only affects which row is highlighted.
  const safeIndex = flat.length === 0 ? 0 : Math.min(selectedIndex, flat.length - 1)

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

  // Auto-focus the input on mount / open. Runs in commit, before PanelOverlay's
  // trap effect — but we opt out of the trap (trapFocus=false) so the input
  // keeps focus and Tab is contained by refocusing it.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keep selected item in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-entry-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // Guard empty list: Math.min(i + 1, -1) would set selectedIndex to -1,
      // which safeIndex masks while flat stays empty but would surface as
      // "no highlight, Enter no-op" if a cross-tab store update later made
      // flat non-empty without resetting the cursor.
      if (flat.length === 0) return
      setSelectedIndex((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && flat.length > 0) {
      e.preventDefault()
      const entry = flat[safeIndex]
      if (entry != null) {
        onSelect(entry)
        onClose()
      }
    } else if (e.key === 'Tab') {
      // Contain Tab inside the panel by keeping the search input focused —
      // palettes don't wrap onto result buttons (you type to filter, arrow to
      // select, Enter to confirm).
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
      className={`palette-item${flatIndex === safeIndex ? ' selected' : ''}`}
      role="option"
      aria-selected={flatIndex === safeIndex}
      onMouseEnter={() => setSelectedIndex(flatIndex)}
      onClick={() => { onSelect(entry); onClose() }}
    >
      <span className="palette-item-label">{entry}</span>
    </button>
  )

  return (
    <PanelOverlay
      open={open}
      onClose={onClose}
      ariaLabel="Input history"
      trapFocus={false}
      panelClassName="input-history-card"
      onKeyDown={handleKeyDown}
    >
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
        aria-activedescendant={flat[safeIndex] != null ? `history-item-${safeIndex}` : undefined}
      />
      <div className="palette-list" ref={listRefMerged} id="history-list" role="listbox">
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
    </PanelOverlay>
  )
}

export default InputHistoryPanel
