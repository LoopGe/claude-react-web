// Shared shell for a row-anchored detail popover: `position: fixed`, portaled
// to <body>, measured after layout and nudged back inside the viewport, Esc via
// the shared escape stack, outside-mousedown via the shared hook (with the open
// row as triggerRef so its own toggle click closes cleanly instead of
// close→reopen flicker). Re-measuring while open comes from useAnchorPosition.
//
// Follows the ContextMenu pattern for the portal (an ancestor carrying
// filter/transform/backdrop-filter would otherwise become the containing block
// — see ContextMenu.tsx's canonical note). CSS owns the shape via the caller's
// `className`; this component owns the portal, dismissal and motion only.
//
// Consumers: TodoDetailPopover (TaskList rows), MonitorDetailPopover
// (MonitorBar rows), and ProjectPopover (the ChatPanel project chip). Hover-
// driven surfaces use HoverPopover instead.

import { memo, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../utils/transitions'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useAnchorPosition, type AnchorRect } from '../hooks/useAnchorPosition'
import { markPortaledSurface } from '../theme'

export type { AnchorRect } from '../hooks/useAnchorPosition'

export type AnchoredPopoverPlacement = 'above' | 'below'

interface Props {
  /** Shape class owned by the consumer's CSS (e.g. `todo-detail-pop`). */
  className: string
  ariaLabel: string
  /** Optional rect captured at open time — fallback anchor; the live anchor
   *  is re-read from triggerRef on every measure pass. */
  anchor?: AnchorRect
  /** The open row element — the useOutsideMouseDown trigger exemption, and
   *  the live anchor source while the popover stays open. */
  triggerRef: RefObject<HTMLElement | null>
  /** Preferred direction; insufficient space still flips to the other side. */
  placement?: AnchoredPopoverPlacement
  onClose: () => void
  children: ReactNode
}

export const AnchoredPopover = memo(function AnchoredPopover({
  className,
  ariaLabel,
  anchor,
  triggerRef,
  placement = 'above',
  onClose,
  children,
}: Props) {
  const { popover } = usePopoverMotion()
  const { ref, x, y, hidden, remeasure } = useAnchorPosition(triggerRef, {
    side: placement === 'below' ? 'bottom' : 'top',
    align: 'start',
    fallbackRect: anchor ?? null,
  })

  // Stamp the portalled surface with its owning panel (the portal breaks DOM
  // ancestry, so the `[data-portaled]` compensations need the marker).
  useLayoutEffect(() => {
    if (ref.current !== null) markPortaledSurface(ref.current)
  }, [ref])

  useOutsideMouseDown({ ref, onClose, triggerRef })

  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

  return createPortal(
    <motion.div
      ref={ref}
      className={className}
      style={{
        left: x ?? undefined,
        top: y ?? undefined,
        visibility: hidden || x === null || y === null ? 'hidden' : undefined,
      }}
      role="dialog"
      aria-label={ariaLabel}
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      // The entrance scale transform skews the first measured height (~2%
      // short) and no layout event follows it — re-measure once it settles.
      onAnimationComplete={() => remeasure()}
      // The outside-click listener is on window; a press inside the popover
      // must not dismiss it (same stopPropagation as ContextMenu).
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>,
    document.body,
  )
})