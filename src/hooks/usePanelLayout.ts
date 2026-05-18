// Panel layout management: which sessions are open, which is focused,
// panel resize, and swap/eviction logic.

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePanelColumnResize } from './usePanelColumnResize'

export interface UsePanelLayoutOpts {
  maxOpen: number
  panelMinRatio: number
}

export interface UsePanelLayoutResult {
  openIds: string[]
  setOpenIds: React.Dispatch<React.SetStateAction<string[]>>
  focusedId: string | null
  setFocusedId: React.Dispatch<React.SetStateAction<string | null>>
  /** Stable refs that track the current state for use in callbacks
   *  with stable identity (avoids stale closure issues). */
  focusedIdRef: React.MutableRefObject<string | null>
  openIdsRef: React.MutableRefObject<string[]>
  maxOpenRef: React.MutableRefObject<number>
  openSession: (id: string, lastTurnAt: number | undefined) => void
  closeSession: (id: string) => void
  swapPanels: (draggedId: string, targetId: string) => void
  // Panel resize
  gridTemplate: string
  onDividerMouseDown: (index: number) => (e: React.MouseEvent) => void
  draggingDivider: number | null
  bodyRef: React.RefObject<HTMLDivElement | null>
  setPanelRatios: (ratios: Record<string, number>) => void
}

export function usePanelLayout({ maxOpen, panelMinRatio }: UsePanelLayoutOpts): UsePanelLayoutResult {
  const [openIds, setOpenIds] = useState<string[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const maxOpenRef = useRef(maxOpen)
  // Track the latest maxOpen via ref so the openSession callback (called
  // on user input, after commit) reads fresh data without forcing a
  // re-create of the callback on every config tick.
  useEffect(() => {
    maxOpenRef.current = maxOpen
  })
  const focusedIdRef = useRef<string | null>(null)
  const openIdsRef = useRef<string[]>([])

  // Keep refs current for use inside callbacks.
  const _setFocusedId = useCallback((v: string | null | ((prev: string | null) => string | null)) => {
    setFocusedId((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      focusedIdRef.current = next
      return next
    })
  }, [])

  const _setOpenIds = useCallback((updater: React.SetStateAction<string[]>) => {
    setOpenIds((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      openIdsRef.current = next
      return next
    })
  }, [])

  /** Open a session in the panel layout. Handles eviction when at max capacity.
   *  Note: does NOT call `setLastSeenTurn` — the caller must handle that
   *  separately (it's a UI concern, not a layout concern). */
  const openSession = useCallback(
    (id: string, _lastTurnAt: number | undefined) => {
      setOpenIds((prev) => {
        if (prev.includes(id)) return prev
        if (prev.length < maxOpenRef.current) return [...prev, id]
        // Evict the oldest non-focused session.
        const curFocusedId = focusedIdRef.current
        const focusIdx = curFocusedId ? prev.indexOf(curFocusedId) : -1
        const evictIdx = prev.findIndex((_, i) => i !== focusIdx)
        const next = prev.slice()
        next.splice(evictIdx === -1 ? 0 : evictIdx, 1)
        next.push(id)
        openIdsRef.current = next
        return next
      })
      _setFocusedId(id)
    },
    [_setFocusedId],
  )

  const closeSession = useCallback(
    (id: string) => {
      setOpenIds((prev) => {
        const next = prev.filter((x) => x !== id)
        openIdsRef.current = next
        // Schedule the focusedId update inside this updater where
        // `next` is in scope — safe because React runs functional
        // updaters synchronously within a single batch.
        _setFocusedId((f) => (f === id ? (next[next.length - 1] ?? null) : f))
        return next
      })
    },
    [_setFocusedId],
  )

  const swapPanels = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    setOpenIds((prev) => {
      const i = prev.indexOf(draggedId)
      const j = prev.indexOf(targetId)
      if (i < 0 || j < 0) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      openIdsRef.current = next
      return next
    })
    _setFocusedId(draggedId)
  }, [_setFocusedId])

  const { gridTemplate, onDividerMouseDown, draggingDivider, bodyRef, setPanelRatios } = usePanelColumnResize({ openIds, panelMinRatio })

  return {
    openIds,
    setOpenIds: _setOpenIds as typeof setOpenIds,
    focusedId,
    setFocusedId: _setFocusedId as typeof setFocusedId,
    focusedIdRef,
    openIdsRef,
    maxOpenRef,
    openSession,
    closeSession,
    swapPanels,
    gridTemplate,
    onDividerMouseDown,
    draggingDivider,
    bodyRef,
    setPanelRatios,
  }
}
