// In-chat message search bar. Ctrl+F opens, Escape closes. Highlights
// matches and provides prev/next navigation. Wired at the Chat-panel level.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconX } from './icons/ToolIcons'
import { useExitPresence } from '../hooks/useExitPresence'

interface Props {
  open: boolean
  onClose: () => void
  /** Called when the user navigates to a result. Receives the 0-based
   *  match index so the parent can scroll MessageList to it. */
  onNavigate: (index: number) => void
  totalResults: number
  onQueryChange: (query: string) => void
  /** Externally controlled active index (0-based). When the parent
   *  resets this (e.g. because the query changed), the internal
   *  counter syncs to it. */
  activeIndex?: number
  /** Seed text for the search input, captured from the user's current
   *  selection when the bar opens. Used only as the initial state — the
   *  parent forces a remount via `key` each time search opens, so this
   *  is read once at mount. */
  initialQuery?: string
}

export function MessageSearch({ open, onClose, onNavigate, totalResults, onQueryChange, activeIndex, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [currentIdx, setCurrentIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevQueryRef = useRef(query)
  const { shouldRender, isExiting } = useExitPresence(open)

  // Sync internal currentIdx when parent controls activeIndex.
  // Controlled-component sync; currentIdx intentionally excluded from deps to avoid loops.
  useEffect(() => {
    if (activeIndex != null && activeIndex !== currentIdx) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional controlled-component sync
      setCurrentIdx(activeIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentIdx excluded to avoid infinite loop
  }, [activeIndex])

  // Focus input on open. Query state is reset by remounting this component
  // with a new key per open cycle; keeping the outer search bar present lets
  // its close animation finish.
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      // Select the seeded text so the user can immediately type over it.
      el.select()
    })
  }, [open])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Push query changes up. Only reset currentIdx when the query actually
  // changes (not on parent re-renders that change onQueryChange).
  useEffect(() => {
    if (prevQueryRef.current !== query) {
      prevQueryRef.current = query
      setCurrentIdx(0)
    }
    onQueryChange(query)
  }, [query, onQueryChange])

  // Keep refs so functional state updaters always see the latest values
  // without being blocked by a stale closure.
  const totalResultsRef = useRef(totalResults)
  const onNavigateRef = useRef(onNavigate)
  // Sync refs after commit so they're always current without triggering
  // re-renders (the react-hooks/refs rule forbids writing during render).
  useLayoutEffect(() => {
    totalResultsRef.current = totalResults
    onNavigateRef.current = onNavigate
  })
  // Flag set by goPrev/goNext so the effect below knows this was a
  // user-initiated navigation (not a programmatic sync via activeIndex).
  const userNavigatingRef = useRef(false)

  // Call onNavigate after React commits a user-initiated index change.
  // Separated from the state updater to keep it pure.
  useEffect(() => {
    if (userNavigatingRef.current) {
      userNavigatingRef.current = false
      onNavigateRef.current(currentIdx)
    }
  }, [currentIdx])

  // Navigate results. Uses functional updater for setCurrentIdx so rapid
  // clicks within a single render frame each advance by one.
  const goPrev = useCallback(() => {
    const total = totalResultsRef.current
    if (total === 0) return
    userNavigatingRef.current = true
    setCurrentIdx((prev) => (prev - 1 + total) % total)
  }, [])

  const goNext = useCallback(() => {
    const total = totalResultsRef.current
    if (total === 0) return
    userNavigatingRef.current = true
    setCurrentIdx((prev) => (prev + 1) % total)
  }, [])

  if (!shouldRender) return null

  return (
    <div className="message-search-bar" data-state={isExiting ? 'closing' : 'open'}>
      <input
        ref={inputRef}
        className="message-search-input"
        type="text"
        placeholder="Search messages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) { goPrev() } else { goNext() }
          }
        }}
      />
      <span className="message-search-count">
        {totalResults > 0 ? `${currentIdx + 1}/${totalResults}` : query ? '0 results' : ''}
      </span>
      <button
        className="btn message-search-nav"
        onClick={goPrev}
        disabled={totalResults === 0}
        title="Previous result (Shift+Enter)"
      >
        ↑
      </button>
      <button
        className="btn message-search-nav"
        onClick={goNext}
        disabled={totalResults === 0}
        title="Next result (Enter)"
      >
        ↓
      </button>
      <button className="btn message-search-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
        <IconX size={12} />
      </button>
    </div>
  )
}
