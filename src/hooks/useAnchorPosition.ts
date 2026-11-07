// Shared positioner for portalled anchored surfaces.
//
// Owns the measure → flip → clamp → re-measure loop that AnchoredPopover
// previously kept to itself. It returns viewport coordinates; the consumer
// renders its own `position: fixed` element with them. Keeping this out of the
// components is what lets HoverPopover and the existing click popovers share
// one geometry implementation.
//
// Design notes:
//   - `offsetWidth`/`offsetHeight`, not `getBoundingClientRect`, for the
//     popover: the latter includes Motion's in-flight enter transform, so a
//     re-measure mid-settle would move the surface.
//   - Device-pixel snapping avoids re-rasterizing SVG/1px borders between
//     frames.
//   - The trigger rect is read live on every pass; `fallbackRect` is for the
//     anchor-only callers (AnchoredPopover's legacy `anchor` prop).
//   - A missing or 0×0 trigger means the row is detached or display:none (a
//     keep-alive panel, a virtualized row). Hide instead of clamping to the
//     viewport's bottom-left.
//   - The capture-phase scroll listener is required: an inner transcript
//     scroller's scroll events do not bubble to window.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  width: number
  height: number
}

export type AnchorSide = 'top' | 'bottom' | 'left' | 'right'
export type AnchorAlign = 'start' | 'center' | 'end'

export interface AnchorPositionOptions {
  side: AnchorSide
  align: AnchorAlign
  /** Space between the trigger and the surface. Default 6. */
  gap?: number
  /** Minimum distance from every viewport edge. Default 8. */
  margin?: number
  /** Used when the trigger is absent. The live trigger wins when it measures
   *  non-zero. */
  fallbackRect?: AnchorRect | null
  /** Clamp after a below→above flip. AnchoredPopover's legacy geometry
   *  deliberately does not (pinned by its offscreen test); new surfaces want
   *  the clamp. Default false. */
  clampAfterFlip?: boolean
  /** False while the surface is not mounted. HoverPopover portals only on
   *  open, and a dense list can mount hundreds of closed hints; skipping the
   *  listener/observer setup then keeps scroll cost at zero for them.
   *  Default true. */
  active?: boolean
}

export interface AnchorPositionResult {
  /** Attach to the portalled surface element. */
  ref: RefObject<HTMLDivElement | null>
  /** Viewport coordinates; null until the first successful measure. */
  x: number | null
  y: number | null
  /** True while there is no usable anchor or measured position. */
  hidden: boolean
  /** The live trigger rect, for consumers that draw an arrow or need the
   *  raw geometry. Null when only a fallback rect was available. */
  anchorRect: DOMRect | null
  /** Re-run the measurement (e.g. after Motion's entrance transform settles). */
  remeasure: () => void
}

interface NormalizedRect {
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

function normalizeRect(rect: AnchorRect): NormalizedRect {
  return {
    top: rect.top,
    bottom: rect.top + rect.height,
    left: rect.left,
    right: rect.left + rect.width,
    width: rect.width,
    height: rect.height,
  }
}

function crossAxis(
  rect: NormalizedRect,
  size: number,
  align: AnchorAlign,
  axis: 'horizontal' | 'vertical',
): number {
  const start = axis === 'horizontal' ? rect.left : rect.top
  const extent = axis === 'horizontal' ? rect.width : rect.height
  if (align === 'start') return start
  if (align === 'end') return start + extent - size
  return start + extent / 2 - size / 2
}

/** Keep the previous rect object when nothing moved: the capture-phase scroll
 *  listener runs per frame, and consumers that depend on `anchorRect` must not
 *  re-render (or re-run their own layout effect) for an unchanged anchor. */
function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

/**
 * Position a portalled surface against a live trigger.
 * @param triggerRef - element the surface anchors to
 * @param options - side, cross-axis alignment, gap, margin, fallback rect
 * @returns the surface ref, viewport coordinates, hidden flag and a remeasure
 */
export function useAnchorPosition(
  triggerRef: RefObject<HTMLElement | null>,
  { side, align, gap = 6, margin = 8, fallbackRect = null, clampAfterFlip = false, active = true }: AnchorPositionOptions,
): AnchorPositionResult {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [hidden, setHidden] = useState(true)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  // Motion's onAnimationComplete fires outside the layout effect's closure.
  const measureRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    if (!active) return
    // Define the measurer even when the surface has not mounted yet:
    // HoverPopover portals only while open, and calls remeasure() after that
    // mount. The mount-time pass here is a no-op; the caller's is not.
    const measure = () => {
      const el = ref.current
      if (!el) return
      const triggerEl = triggerRef.current
      const live = triggerEl?.getBoundingClientRect() ?? null
      // A live trigger that measures 0×0 is display:none or detached (a
      // keep-alive panel, a virtualized row): hide. Do NOT fall back to the
      // captured anchor here — that is what pinned the old geometry to the
      // viewport's bottom-left.
      if (triggerEl !== null && live !== null && live.width === 0 && live.height === 0) {
        setHidden(true)
        setAnchorRect(null)
        return
      }
      if (live === null && fallbackRect === null) {
        setHidden(true)
        setAnchorRect(null)
        return
      }
      const rect = normalizeRect(live ?? fallbackRect!)
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      const dpr = window.devicePixelRatio || 1
      const snap = (v: number) => Math.round(v * dpr) / dpr
      const clamp = (v: number, min: number, max: number) => Math.min(Math.max(min, v), max)

      let x: number
      let y: number
      switch (side) {
        case 'top':
          y = rect.top - h - gap
          if (y < margin) y = rect.bottom + gap
          if (y + h > vh - margin) y = Math.max(margin, vh - h - margin)
          x = crossAxis(rect, w, align, 'horizontal')
          break
        case 'bottom':
          y = rect.bottom + gap
          if (y + h > vh - margin) {
            y = rect.top - h - gap
            // AnchoredPopover's legacy below→above flip only floors at the
            // margin; keep that geometry unless the caller opts into the clamp.
            y = clampAfterFlip ? clamp(y, margin, vh - h - margin) : Math.max(margin, y)
          }
          x = crossAxis(rect, w, align, 'horizontal')
          break
        case 'left':
          x = rect.left - w - gap
          if (x < margin) x = rect.right + gap
          y = crossAxis(rect, h, align, 'vertical')
          break
        case 'right':
          x = rect.right + gap
          if (x + w > vw - margin) x = rect.left - w - gap
          y = crossAxis(rect, h, align, 'vertical')
          break
      }
      x = clamp(x, margin, vw - w - margin)
      if (side === 'left' || side === 'right') y = clamp(y, margin, vh - h - margin)

      setAnchorRect(prev => (sameRect(prev, live) ? prev : live))
      setHidden(false)
      setPos(prev => (prev !== null && prev.x === snap(x) && prev.y === snap(y) ? prev : { x: snap(x), y: snap(y) }))
    }

    measureRef.current = measure
    measure()
    window.addEventListener('resize', measure)
    // capture: inner scrollers do not bubble their scroll events to window.
    window.addEventListener('scroll', measure, true)
    const surface = ref.current
    const ro = surface !== null ? new ResizeObserver(measure) : null
    if (ro !== null && surface !== null) ro.observe(surface)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      ro?.disconnect()
    }
  }, [active, triggerRef, side, align, gap, margin, fallbackRect, clampAfterFlip])

  const remeasure = useCallback(() => measureRef.current(), [])

  return { ref, x: pos?.x ?? null, y: pos?.y ?? null, hidden, anchorRect, remeasure }
}