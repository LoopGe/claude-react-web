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

import { useLayoutEffect, useRef, useState } from 'react'
import { useInputHistoryPanel, type HistoryPanelEntry } from '../hooks/useInputHistoryPanel'
import { useListSelection } from '../hooks/useListSelection'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { PanelOverlay } from './PanelOverlay'

interface Props {
  open: boolean
  onClose: () => void
  /** A selected entry: text for the composer, id to load its images from
   *  (null = text-only entry — recall clears the composer's images). */
  onSelect: (entry: HistoryPanelEntry) => void
  /** Session whose history sorts to the top; null shows only the global list. */
  currentSessionId: string | null
}

export function InputHistoryPanel({ open, onClose, onSelect, currentSessionId }: Props) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)

  const { sessionItems, otherItems, flat, totalCount } = useInputHistoryPanel(
    currentSessionId,
    query,
  )

  // Hover only moves the highlight; arrow keys and the open/query resets also
  // scroll the selected entry into view (see useListSelection). The displayed
  // index is clamped inside the hook, so a cross-tab store update that shrinks
  // `flat` below the cursor can never render "nothing selected".
  const { activeIndex, hover, reset, handleKeyDown } = useListSelection({
    count: flat.length,
    getRow: (i) => listRef.current?.querySelector<HTMLElement>(`[data-entry-index="${i}"]`),
    onActivate: (i) => {
      const entry = flat[i]
      if (entry != null) {
        onSelect(entry)
        onClose()
      }
    },
    tabFocusRef: inputRef,
  })

  // Reset state when opening, synchronously before first paint so the user
  // never sees stale content from a previous invocation.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open */
  useLayoutEffect(() => {
    if (open) {
      setQuery('')
      reset()
    }
  }, [open, reset])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-focus the input on mount / open. Runs in commit, before PanelOverlay's
  // trap effect — but we opt out of the trap (trapFocus=false) so the input
  // keeps focus and Tab is contained by refocusing it.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Render one selectable entry button. `flatIndex` is its position in `flat`.
  const renderItem = (entry: HistoryPanelEntry, flatIndex: number) => (
    <button
      key={`${flatIndex}:${entry.text}`}
      id={`history-item-${flatIndex}`}
      data-entry-index={flatIndex}
      className={`palette-item${flatIndex === activeIndex ? ' selected' : ''}`}
      role="option"
      aria-selected={flatIndex === activeIndex}
      onMouseEnter={() => hover(flatIndex)}
      onClick={() => { onSelect(entry); onClose() }}
    >
      <span className="palette-item-label truncate">{entry.text || '(image)'}</span>
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
        onChange={(e) => { setQuery(e.target.value); reset() }}
        aria-label="Search input history"
        aria-autocomplete="list"
        aria-controls="history-list"
        aria-activedescendant={flat[activeIndex] != null ? `history-item-${activeIndex}` : undefined}
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
