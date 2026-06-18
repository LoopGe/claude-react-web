import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocalStorage } from './useLocalStorage'
import { PANEL_RATIOS_KEY } from '../constants/storageKeys'

/** Minimum pointer travel (px) before a divider mousedown is treated as a
 *  drag. Mirrors useDragResize.DRAG_THRESHOLD. See Interact C1 in the audit. */
const DRAG_THRESHOLD = 3

export interface PanelColumnResizeOptions {
  openIds: string[]
  panelMinRatio: number
}

/**
 * Per-session column-width ratios for the main grid + divider drag logic.
 *
 * Ratios are keyed by session ID so they travel with their session when
 * panels are evicted and reordered — no more positional misalignment on
 * open/close. Persisted to localStorage under PANEL_RATIOS_KEY.
 */
export function usePanelColumnResize({ openIds, panelMinRatio }: PanelColumnResizeOptions) {
  const [panelRatios, setPanelRatios] = useLocalStorage<Record<string, number>>(PANEL_RATIOS_KEY, {})
  const [draft, setDraft] = useState<Record<string, number> | null>(null)
  const effectiveRatios = draft ?? panelRatios

  /** Construct the grid-template-columns string for the current layout.
   *  Inserts 4px divider tracks between visible panels. Ratios default
   *  to 1 (equal width) for sessions that haven't been manually resized. */
  const gridTemplate = useMemo(() => {
    const n = Math.max(1, openIds.length)
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const r = effectiveRatios[openIds[i]] ?? 1
      parts.push(`${r}fr`)
      if (i < n - 1) parts.push('4px')
    }
    return parts.join(' ')
  }, [openIds, effectiveRatios])

  /** Drag state for the panel-column dividers. `index` is the divider
   *  between columns i and i+1 (so valid values are 0 and 1). */
  const bodyRef = useRef<HTMLDivElement>(null)
  const dividerStart = useRef<{ ratios: Record<string, number>; bodyWidth: number } | null>(null)
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null)
  /** Cleanup fn for the active divider drag — stored so we can remove
   *  window-level mousemove/mouseup listeners on unmount. */
  const dividerDragCleanupRef = useRef<(() => void) | null>(null)

  const onDividerMouseDown = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const body = bodyRef.current
      if (!body) return

      // Threshold-gated drag start (mirrors useDragResize): a mousedown only
      // arms a pending drag; the resize doesn't begin until the pointer moves
      // DRAG_THRESHOLD px. A click that never crosses the threshold cleans up
      // as a no-op, so an accidental jitter on the 4px handle doesn't lock the
      // UI into col-resize + no-select. See Interact C1.
      const startX = e.clientX
      const leftId = openIds[index]
      const rightId = openIds[index + 1]
      let promoted = false

      const promote = () => {
        promoted = true
        dividerStart.current = {
          ratios: { ...effectiveRatios },
          bodyWidth: body.getBoundingClientRect().width,
        }
        setDraggingDivider(index)
        document.body.classList.add('resizing-col')
      }

      // Drag uses the same window-level listeners pattern as sidebar resize,
      // but we need the divider index + accurate pixel→ratio conversion, so
      // the handlers live inline here instead of in the generic useDragResize.
      const onMove = (ev: MouseEvent) => {
        const deltaPx = ev.clientX - startX
        if (!promoted) {
          if (Math.abs(deltaPx) < DRAG_THRESHOLD) return
          promote()
          // Fall through and apply the threshold-crossing delta immediately so
          // the resize doesn't lag behind by the threshold distance.
        }
        const snap = dividerStart.current
        if (!snap) return
        // Convert pixel delta to fractional change of the TOTAL fr-weight sum.
        // Each column's px width = (ratio / sum) * bodyWidth; moving deltaPx
        // means we want ratio[i] to grow by deltaRatio and ratio[i+1] to
        // shrink by the same amount. deltaRatio = deltaPx / (bodyWidth / sum).
        const leftR = snap.ratios[leftId] ?? 1
        const rightR = snap.ratios[rightId] ?? 1
        const sum = (leftR + rightR) || 1
        const pxPerRatio = snap.bodyWidth / sum
        const deltaR = deltaPx / pxPerRatio
        const next = { ...snap.ratios }
        const rawL = leftR + deltaR
        const rawR = rightR - deltaR
        // Enforce minimum ratio on both sides; clamp by stealing back.
        if (rawL < panelMinRatio) {
          next[rightId] = leftR + rightR - panelMinRatio
          next[leftId] = panelMinRatio
        } else if (rawR < panelMinRatio) {
          next[leftId] = leftR + rightR - panelMinRatio
          next[rightId] = panelMinRatio
        } else {
          next[leftId] = rawL
          next[rightId] = rawR
        }
        setDraft(next)
      }
      const onUp = () => {
        if (promoted) {
          setDraggingDivider(null)
          document.body.classList.remove('resizing-col')
        }
        dividerDragCleanupRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      dividerDragCleanupRef.current = onUp
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [effectiveRatios, openIds, panelMinRatio],
  )

  // Commit the draft to localStorage after dragging ends. Same shape as
  // the sidebar commit effect above; lint false-positive suppressed for
  // the same reason.
  useEffect(() => {
    if (draggingDivider != null) return
    if (draft != null) {
      setPanelRatios(draft)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(null)
    }
  }, [draggingDivider, draft, setPanelRatios])

  // Clean up any in-progress divider drag on unmount. Without this,
  // the window-level mousemove/mouseup listeners would leak.
  useEffect(() => () => { dividerDragCleanupRef.current?.() }, [])

  return {
    gridTemplate,
    onDividerMouseDown,
    draggingDivider,
    /** Attach this ref to the scrollable body element that contains the
     *  chat panels. Used for accurate pixel→ratio conversion. */
    bodyRef,
    /** Direct setter — used by the double-click reset handler. */
    setPanelRatios,
    /** Current effective ratios (draft during a drag, persisted otherwise).
     *  Exposed so keyboard resize can read + adjust adjacent columns. */
    effectiveRatios,
  }
}
