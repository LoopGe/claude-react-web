// Minimal custom context menu used by SessionList cards.
//
// Positioned absolutely at the cursor on `contextmenu`. The parent owns
// visibility state (so it knows which session the menu targets); this
// component only handles the rendering, outside-click / Esc dismissal,
// and a small nudge to stay within the viewport.

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../utils/transitions'
import { useEscapeStack } from '../hooks/useEscapeStack'

export interface ContextMenuItem {
  /** Shown in the menu. Falsy = render a separator instead. */
  label?: string
  /** Optional leading glyph / icon. A string renders as a glyph; an
   *  element (e.g. an SVG icon component) renders inline. */
  icon?: React.ReactNode
  /** Inline style applied to the icon span (e.g. per-item colour). */
  iconStyle?: CSSProperties
  onClick?: () => void
  /** Render in a "danger" style (red) — e.g. Delete. */
  danger?: boolean
  /** Disabled rows are visible but don't fire. */
  disabled?: boolean
}

interface Props {
  /** Client-coordinate (event.clientX/Y) anchor point. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export const ContextMenu = memo(function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Measured position after layout — nudged inward if the menu would
  // otherwise overflow the viewport.
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y })
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition.
  const { popover } = usePopoverMotion()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(x, vw - rect.width - 4)
    const ny = Math.min(y, vh - rect.height - 4)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [x, y])

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      // Only dismiss on left-click. Right-click (button 2) should NOT
      // close the menu — the browser fires `contextmenu` next, which
      // the owning component uses to open a replacement menu. Closing
      // on mousedown would cause a visible close→reopen flash.
      if (e.button !== 0) return
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // `mousedown` beats `click` — feels snappier and avoids swallowing
    // a subsequent click on another interactive element.
    window.addEventListener('mousedown', onDocMouseDown)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [onClose])

  // Esc closes via the shared escape stack, so a context menu above a modal
  // or panel collapses only itself on the first keypress.
  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

  return (
    <motion.div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      // Pop in/out from the anchor (top-left origin set on .ctx-menu in CSS)
      // — mirrors the old ctx-menu-in/ctx-menu-out keyframes: scale 0.98 +
      // small vertical nudge. pointerEvents:'none' on exit replaces the old
      // [data-state="closing"]{pointer-events:none} rule so the fading menu
      // can't be clicked. Exit only fires under AnimatePresence (ChatPanel);
      // other callers mount/unmount instantly with just the entrance.
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      // Stop mousedown so the outside-click listener above (which is on
      // window) doesn't fire when the user clicks the menu itself.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {(() => {
        // Collapse consecutive separators and trim leading/trailing ones.
        // Callers build the item list from conditional spreads, so a separator
        // can end up adjacent to another (or at an edge) when the items
        // between them are absent — e.g. a panel menu whose Side Chat /
        // Settings / Close-panel rows are all gated off. Dropping those here
        // keeps every caller's separator placement simple without each one
        // having to track its neighbours.
        const visible: ContextMenuItem[] = []
        for (const item of items) {
          const isSep = !item.label
          if (isSep) {
            const last = visible[visible.length - 1]
            // Skip leading separators and consecutive separators.
            if (visible.length === 0 || !last.label) continue
          }
          visible.push(item)
        }
        // Trim a trailing separator.
        if (visible.length > 0 && !visible[visible.length - 1].label) visible.pop()
        return visible.map((item, i) => {
          if (!item.label) return <div key={`sep-${i}`} className="ctx-menu-sep" role="separator" />
          return (
            <button
              key={`${i}-${item.label}`}
              className={`ctx-menu-item ${item.danger ? 'danger' : ''}`}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return
                item.onClick?.()
                onClose()
              }}
            >
              {item.icon && <span className="ctx-menu-icon" style={item.iconStyle} aria-hidden>{item.icon}</span>}
              <span className="ctx-menu-label">{item.label}</span>
            </button>
          )
        })
      })()}
    </motion.div>
  )
})
