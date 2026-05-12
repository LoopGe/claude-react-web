import { useEffect, useState } from 'react'
import { useDragResize } from './useDragResize'
import { useLocalStorage } from './useLocalStorage'
import { SIDEBAR_WIDTH_KEY } from '../constants/storageKeys'

export interface SidebarResizeOptions {
  minPx: number
  maxPx: number
}

/**
 * Sidebar width state + drag-resize logic.
 *
 * Persists the committed width to localStorage under SIDEBAR_WIDTH_KEY.
 * During a drag the live width is held in a transient draft so the
 * component re-renders on every mousemove without touching storage;
 * the draft is flushed to localStorage on mouseup.
 */
export function useSidebarResize({ minPx, maxPx }: SidebarResizeOptions) {
  const [sidebarWidth, setSidebarWidth] = useLocalStorage<number>(SIDEBAR_WIDTH_KEY, 280)
  /** Live-editable width during a resize drag — we update this on every
   *  mousemove but only flush to localStorage on mouseup. */
  const [draft, setDraft] = useState<number | null>(null)

  const resize = useDragResize((delta) => {
    const w = Math.max(minPx, Math.min(maxPx, sidebarWidth + delta))
    setDraft(w)
  })

  // When the drag ends, commit the draft to localStorage. The synchronous
  // setState inside this effect is intentional: the draft is transient,
  // and once the gesture is over we want the persisted value to catch up
  // and the draft to clear exactly once. The lint rule can't see that.
  useEffect(() => {
    if (resize.dragging) return
    if (draft != null) {
      setSidebarWidth(draft)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(null)
    }
  }, [resize.dragging, draft, setSidebarWidth])

  return {
    sidebarWidth: draft ?? sidebarWidth,
    sidebarResize: resize,
    /** Direct setter — used by the double-click reset handler. */
    setSidebarWidth,
  }
}
