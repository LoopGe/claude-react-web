import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clamp } from '../utils/clamp'

/**
 * Shared selection controller for every arrow-navigable list picker — command
 * palette, resume-session dialog, input-history panel, model picker, searchable
 * pickers (project/field) and the subagent swarm popover.
 *
 * It owns the one invariant those lists kept re-breaking: POINTER HOVER MUST
 * NEVER SCROLL THE LIST. Hovering a row that is even partially clipped by the
 * list's edge used to run the keyboard "keep the highlight visible"
 * `scrollIntoView`, which moved the list out from under a stationary pointer —
 * the browser then re-targeted hover onto the row that slid beneath it, whose
 * mouseenter scrolled again, so the list crawled by itself as the mouse
 * travelled. A hovered row is already under the pointer; only keyboard and
 * programmatic selection changes may scroll.
 *
 * Callers therefore declare the intent on every selection update: `hover`
 * opts out of scrolling, `move` (arrow keys) and `reset` (row 0 on open / query
 * change / close) opt in. The effect reads the flag whenever the active index
 * changes — or when a reset forces it, since an unchanged index would not.
 *
 * Clamping rules stay here so each list cannot drift: the exposed `activeIndex`
 * is the raw selection clamped to `[0, count-1]` (`emptyIndex` while the list
 * is empty), and `move` clamps at the ends unless `wrap` is set.
 */
export interface UseListSelectionOptions {
  /** Number of selectable rows currently rendered. */
  count: number
  /**
   * Resolve the DOM element for an (already clamped) active index. Callers
   * pass an inline closure over their list ref; the hook keeps the latest one
   * so the scroll effect can depend on `activeIndex` alone.
   */
  getRow: (index: number) => HTMLElement | null | undefined
  /**
   * The `activeIndex` exposed while `count === 0`. Default 0 (most lists keep
   * row 0 highlighted); menus that must report "nothing selected" pass -1.
   */
  emptyIndex?: number
  /** Arrow movement wraps past the ends (listbox menus) instead of clamping. */
  wrap?: boolean
}

export interface ListSelection {
  /** The clamped index to render as selected and to activate (Enter/click). */
  activeIndex: number
  /** Pointer hover: move the highlight, never scroll. */
  hover: (index: number) => void
  /** Keyboard step: move the highlight by `delta` and scroll it into view. */
  move: (delta: number) => void
  /** Programmatic reset to row 0 (open / query change / close): scrolls. */
  reset: () => void
}

export function useListSelection({
  count,
  getRow,
  emptyIndex = 0,
  wrap = false,
}: UseListSelectionOptions): ListSelection {
  const [rawIndex, setRawIndex] = useState(0)
  // Declared by every selection update right before setState and read by the
  // scroll effect. See the header comment: hover must never scroll.
  const scrollOnSelectRef = useRef(true)
  // `reset()` must scroll row 0 even when the raw index is already 0 (a fresh
  // scope should show the top of the list, and setState bails out on an
  // unchanged index). The counter forces the effect to run.
  const [scrollTick, setScrollTick] = useState(0)

  // `getRow` is an inline closure in every caller. Keep the latest one in a
  // ref (updated right before the passive scroll effect runs) so the effect
  // depends on `activeIndex`, not on a re-created closure.
  const getRowRef = useRef(getRow)
  useLayoutEffect(() => {
    getRowRef.current = getRow
  }, [getRow])

  const hover = useCallback((index: number) => {
    scrollOnSelectRef.current = false
    setRawIndex(index)
  }, [])

  const move = useCallback(
    (delta: number) => {
      // Guard the empty list: without it a clamped step lands on -1 (nothing
      // highlighted, Enter a no-op).
      if (count === 0) return
      scrollOnSelectRef.current = true
      setRawIndex((i) => {
        const current = clamp(i, 0, count - 1)
        // Normalize the modulo for |delta| > count: JS `%` keeps the sign, so
        // `(0 - 4 + 3) % 3` is -1, not 2.
        if (wrap) return ((current + delta) % count + count) % count
        return clamp(current + delta, 0, count - 1)
      })
    },
    [count, wrap],
  )

  const reset = useCallback(() => {
    scrollOnSelectRef.current = true
    setRawIndex(0)
    setScrollTick((t) => t + 1)
  }, [])

  const activeIndex = count === 0 ? emptyIndex : clamp(rawIndex, 0, count - 1)

  useEffect(() => {
    if (!scrollOnSelectRef.current) return
    getRowRef.current(activeIndex)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, scrollTick])

  return { activeIndex, hover, move, reset }
}