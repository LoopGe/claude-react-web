// In-chat message search bar. Ctrl+F opens, Escape closes. Highlights
// matches and provides prev/next navigation. Wired at the Chat-panel level.

import { useCallback, useEffect, useRef, useState } from 'react'

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
}

export function MessageSearch({ open, onClose, onNavigate, totalResults, onQueryChange, activeIndex }: Props) {
  const [query, setQuery] = useState('')
  const [currentIdx, setCurrentIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevQueryRef = useRef(query)

  // Sync internal currentIdx when parent controls activeIndex.
  // Controlled-component sync; currentIdx intentionally excluded from deps to avoid loops.
  useEffect(() => {
    if (activeIndex != null && activeIndex !== currentIdx) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional controlled-component sync
      setCurrentIdx(activeIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentIdx excluded to avoid infinite loop
  }, [activeIndex])

  // Focus input on open. State is already clean because the parent uses a
  // `key` prop that forces a full remount each time search opens.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
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

  // Navigate results.
  const goPrev = useCallback(() => {
    if (totalResults === 0) return
    const next = (currentIdx - 1 + totalResults) % totalResults
    setCurrentIdx(next)
    onNavigate(next)
  }, [currentIdx, totalResults, onNavigate])

  const goNext = useCallback(() => {
    if (totalResults === 0) return
    const next = (currentIdx + 1) % totalResults
    setCurrentIdx(next)
    onNavigate(next)
  }, [currentIdx, totalResults, onNavigate])

  if (!open) return null

  return (
    <div className="message-search-bar">
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
      <button className="btn message-search-close" onClick={onClose} title="Close (Esc)">
        ✕
      </button>
    </div>
  )
}
