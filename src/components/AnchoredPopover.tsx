// Shared shell for a row-anchored detail popover: `position: fixed`, portaled
// to <body>, measured after layout and nudged back inside the viewport, Esc via
// the shared escape stack, outside-mousedown via the shared hook (with the open
// row as triggerRef so its own toggle click closes cleanly instead of
// close→reopen flicker). Keeps re-measuring while open — the anchor row can
// scroll, churn, or be hidden under a fixed popover.
//
// Follows the ContextMenu pattern for the portal (an ancestor carrying
// filter/transform/backdrop-filter would otherwise become the containing block
// — see ContextMenu.tsx's canonical note). CSS owns the shape via the caller's
// `className`; this component owns coordinates and dismissal only.
//
// Consumers: TodoDetailPopover (TaskList rows) and MonitorDetailPopover
// (MonitorBar rows). The two cards' rows deliberately share this shell so a
// click means the same thing in both.

import { memo, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../utils/transitions'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { markPortaledSurface } from '../theme'

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  width: number
  height: number
}

interface Props {
  /** Shape class owned by the consumer's CSS (e.g. `todo-detail-pop`). */
  className: string
  ariaLabel: string
  /** The clicked row's rect at open time — fallback anchor; the live anchor
   *  is re-read from triggerRef on every measure pass. */
  anchor: AnchorRect
  /** The open row element — the useOutsideMouseDown trigger exemption, and
   *  the live anchor source while the popover stays open. */
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
}

export const AnchoredPopover = memo(function AnchoredPopover({
  className,
  ariaLabel,
  anchor,
  triggerRef,
  onClose,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [anchorHidden, setAnchorHidden] = useState(false)
  const { popover } = usePopoverMotion()

  // measure() is also called from motion's onAnimationComplete (below), which
  // fires outside the layout effect's closure — route it through a ref.
  const measureRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    markPortaledSurface(el)
    // Measure-and-place, re-run while open: the row can move under a fixed
    // popover (transcript scroll, list churn when rows land/expire, window
    // resize) and the popover's own height changes when its content does.
    // Re-reading the live trigger rect + re-clamping keeps it glued instead of
    // frozen at the open-time coordinates.
    const measure = () => {
      const r = triggerRef.current?.getBoundingClientRect() ?? anchor
      // A zero-size trigger means the row is display:none (its panel went
      // into the keep-alive cache) or detached — there is nothing to anchor
      // to, so hide instead of clamping to viewport bottom-left. (A visible
      // row never measures 0×0.)
      const detached = r.width === 0 && r.height === 0
      setAnchorHidden(detached)
      if (detached) return
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Horizontal: align to the row's left edge, clamped inside the viewport.
      const x = Math.min(Math.max(8, r.left), vw - rect.width - 8)
      // Vertical: above the row; flip below when there's no headroom; last
      // resort clamp against the top edge (bottom-overlay card ⇒ rare).
      let y = r.top - rect.height - 6
      if (y < 8) y = r.bottom + 6
      if (y + rect.height > vh - 8) y = Math.max(8, vh - rect.height - 8)
      // Same coordinates → keep the previous object: the capture-phase scroll
      // listener fires per frame during transcript autoscroll, and a fresh
      // object per event would re-render the popover every frame.
      setPos((prev) => (prev !== null && prev.x === x && prev.y === y ? prev : { x, y }))
    }
    measureRef.current = measure
    measure()
    window.addEventListener('resize', measure)
    // capture: the transcript scroller is an inner element — its scroll
    // events don't bubble, but capture-phase window sees them all.
    window.addEventListener('scroll', measure, true)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      ro.disconnect()
    }
  }, [anchor, triggerRef])

  useOutsideMouseDown({ ref, onClose, triggerRef })

  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

  const hidden = pos === null || anchorHidden
  return createPortal(
    <motion.div
      ref={ref}
      className={className}
      style={{ left: pos?.x, top: pos?.y, visibility: hidden ? 'hidden' : undefined }}
      role="dialog"
      aria-label={ariaLabel}
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      // The entrance scale transform skews the first measured height (~2%
      // short) and no layout event follows it — re-measure once it settles.
      onAnimationComplete={() => measureRef.current()}
      // The outside-click listener is on window; a press inside the popover
      // must not dismiss it (same stopPropagation as ContextMenu).
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>,
    document.body,
  )
})
