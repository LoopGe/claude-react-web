import { useCallback, useEffect, useState } from 'react'
import {
  attachOverlayScrollbar,
  type OverlayScrollbarController,
  type OverlayScrollbarOptions,
} from '../utils/overlay-scrollbar'

/**
 * Attaches a self-built overlay scrollbar to an element.
 *
 * Returns a stable ref-callback. Use it as a React `ref` on a native scroll
 * container, or call it from a virtualizer's scroller-ref callback (e.g.
 * Virtuoso's `scrollerRef` prop) — both are `(el | null) => void`.
 *
 * The attach/destroy lifecycle is driven by element identity, so it tolerates
 * late-populated refs (Virtuoso hands its internal scroller over after mount).
 */
export function useOverlayScrollbar(
  opts: OverlayScrollbarOptions = {},
): (el: HTMLElement | null) => void {
  const { orientation, autoHide, autoHideDelay, minThumbSize } = opts
  const [el, setEl] = useState<HTMLElement | null>(null)

  const refCallback = useCallback((node: HTMLElement | null) => {
    setEl(node)
  }, [])

  useEffect(() => {
    if (!el) return
    const controller: OverlayScrollbarController = attachOverlayScrollbar(el, {
      orientation,
      autoHide,
      autoHideDelay,
      minThumbSize,
    })
    return () => controller.destroy()
  }, [el, orientation, autoHide, autoHideDelay, minThumbSize])

  return refCallback
}
