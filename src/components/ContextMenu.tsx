// Minimal custom context menu used by SessionList cards.
//
// `position: fixed` at the cursor on `contextmenu`, portalled to <body>. The
// parent owns visibility state (so it knows which session the menu targets);
// this component only handles the rendering, outside-click / Esc dismissal,
// and a small nudge to stay within the viewport. One-open-at-a-time
// enforcement lives in ./context-menu-registry.

import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../utils/transitions'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { claimExclusiveOpen } from './context-menu-registry'
import { markPortaledSurface } from '../theme'

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
  /** The control that opened the menu, when it ALSO toggles it closed.
   *  Passed through to useOutsideMouseDown so a press on the trigger is the
   *  toggle, not an outside press (see that hook's `triggerRef` docs). */
  triggerRef?: React.RefObject<Element | null>
  /** Move DOM focus to the first enabled item on open. Off by default:
   *  right-click menus must leave focus where it is (the composer's IME
   *  composition / selection would break otherwise). On for keyboard-owned
   *  menu buttons (CreateMenuButton). */
  autoFocus?: boolean
  /** What a non-primary outside press does. Default 'ignore' is the
   *  right-click-replacement policy (a `contextmenu` follows). Left-click-owned
   *  surfaces pass 'close' so a right-click doesn't stack a second menu. */
  nonPrimary?: 'close' | 'ignore'
}

export const ContextMenu = memo(function ContextMenu({
  x,
  y,
  items,
  onClose,
  triggerRef,
  autoFocus = false,
  nonPrimary = 'ignore',
}: Props) {
  // Latest onClose for the registry entry (the entry itself is mount-scoped).
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  // Single-open registry: on mount, close every other open menu, then
  // register ours. Layout timing so the buried menu is dismissed before the
  // stacked frame paints. The replace flow (same menu, new anchor) only
  // re-renders — no remount, so this effect does not re-run and the menu
  // never closes itself.
  useLayoutEffect(() => {
    return claimExclusiveOpen(() => onCloseRef.current())
  }, [])

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
    // No accent to carry (nothing in .ctx-menu reads --accent), but the
    // wallpaper fill remap must still reach the hover/active rows.
    markPortaledSurface(el)
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(x, vw - rect.width - 4)
    const ny = Math.min(y, vh - rect.height - 4)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
    // Keyboard-owned menus (autoFocus) land on the first enabled row — the
    // menu is portaled to the end of <body>, so without an explicit move the
    // items sit outside the trigger's tab path. preventScroll so a clamp that
    // still overflows can't drag the document (the menu itself is nudged by
    // setPos above). Right-click menus leave focus alone (IME / selection).
    if (autoFocus) {
      el.querySelector<HTMLButtonElement>('.ctx-menu-item:not(:disabled)')
        ?.focus({ preventScroll: true })
    }
  }, [x, y, autoFocus])

  // Default 'ignore': right-click (button 2) must NOT close a right-click
  // menu — the browser fires `contextmenu` next, which the owning component
  // uses to open a replacement menu, and closing on mousedown would be a
  // visible close→reopen flash. Left-click-owned surfaces pass 'close' so a
  // right-click outside doesn't stack a second menu on top.
  //
  // `mousedown` beats `click` — feels snappier and avoids swallowing a
  // subsequent click on another interactive element (the hook's default).
  useOutsideMouseDown({ ref, onClose, triggerRef, nonPrimary })

  // Esc closes via the shared escape stack, so a context menu above a modal
  // or panel collapses only itself on the first keypress.
  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

  return createPortal(
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
    </motion.div>,
    // Portal to <body>: `pos` above is in VIEWPORT coordinates, and any
    // ancestor carrying filter / transform / backdrop-filter would take over as
    // this element's containing block instead. Canonical statement: the
    // body.has-bg note in layout.css. Pinned by ContextMenu.test.tsx.
    document.body,
  )
})
