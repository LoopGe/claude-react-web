// Minimal custom context menu used by SessionList cards.
//
// `position: fixed` at the cursor on `contextmenu`, portalled to <body>. The
// parent owns visibility state (so it knows which session the menu targets);
// this component only handles the rendering, outside-click / Esc dismissal,
// and a small nudge to stay within the viewport. One-open-at-a-time
// enforcement lives in ../hooks/floating-surface-registry.

import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion, useIsPresent } from 'motion/react'
import { usePopoverMotion } from '../utils/transitions'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useFloatingSurface, FloatingSurfaceProvider } from '../hooks/useFloatingSurface'
import type { FloatingDismissReason } from '../hooks/floating-surface-registry'
import { markPortaledSurface } from '../theme'

/** Trailing disclosure glyph for submenu parent rows. */
function SubmenuArrow() {
  return <span className="ctx-menu-arrow" aria-hidden>▸</span>
}

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
  /**
   * Nested flyout rows. Renders the row as a submenu parent (▸ disclosure);
   * the flyout opens on hover or click INSIDE this menu's portal container —
   * a nested portal would register a second floating surface and the
   * one-open-at-a-time registry would close the parent menu on open. Only
   * one submenu is open at a time; Escape unwinds it before the menu.
   */
  children?: ContextMenuItem[]
}

interface Props {
  /** Client-coordinate (event.clientX/Y) anchor point. */
  x: number
  y: number
  /** Place the menu below the anchor (default) or above it using the measured
   *  menu height. Composer-anchored menus use 'above'. */
  placement?: 'above' | 'below'
  items: ContextMenuItem[]
  onClose: (reason?: FloatingDismissReason) => void
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
  placement = 'below',
  items,
  onClose,
  triggerRef,
  autoFocus = false,
  nonPrimary = 'ignore',
}: Props) {
  const isPresent = useIsPresent()
  const ref = useRef<HTMLDivElement>(null)
  // Measured position after layout — nudged inward if the menu would
  // otherwise overflow the viewport.
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y })
  // --- Submenu state ---------------------------------------------------------
  // One flyout at a time, keyed by the index into the COLLAPSED visible list
  // (the same array the rows render from). The ref mirrors the state because
  // the Escape path (onEscape below) and the row handlers must agree
  // synchronously — the state alone lags one commit behind hover switches.
  const [openSub, setOpenSub] = useState<number | null>(null)
  const openSubRef = useRef<number | null>(null)
  const [subPos, setSubPos] = useState<{ top: number; side: 'left' | 'right' }>({ top: 0, side: 'right' })
  const subRef = useRef<HTMLDivElement>(null)
  const setSubOpen = (index: number | null): void => {
    openSubRef.current = index
    setOpenSub(index)
  }
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition.
  const { popover } = usePopoverMotion()
  // Labels and separator rows determine the measured menu dimensions. Track
  // their content rather than only items.length so above-placement stays
  // anchored when a same-length update adds/removes rows or changes wrapping.
  const itemsLayoutKey = items.map((item) => item.label ?? '').join('\0')
  const { surfaceId } = useFloatingSurface({
    kind: 'menu',
    active: true,
    phase: isPresent ? 'open' : 'exiting',
    contextMenu: true,
    getContainer: () => ref.current,
    getTrigger: () => triggerRef?.current ?? null,
    onDismiss: onClose,
    // Escape unwinds an open flyout first (the menu stays); the registry
    // reads this callback through a ref, so the closure below is always live.
    onEscape: () => {
      if (openSubRef.current !== null) setSubOpen(null)
      else onClose()
    },
  })

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
    const anchorY = placement === 'above' ? y - rect.height : y
    const ny = Math.min(anchorY, vh - rect.height - 4)
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
  }, [x, y, placement, itemsLayoutKey, autoFocus])

  // Flyout placement, measured after the submenu mounts: vertically aligned
  // to the parent row (clamped to the viewport), opening to the menu's right
  // and flipping to its left when that would overflow. Coordinates are
  // relative to the menu container — the submenu is an absolutely-positioned
  // child of the fixed-position portal, so the container IS its origin.
  useLayoutEffect(() => {
    if (openSub === null) return
    const container = ref.current
    const sub = subRef.current
    // The parent row is found by its open-marker attribute, not a ref: the
    // rows render from the same pass that sets openSub, and the
    // react-compiler lint rightly rejects ref access during render.
    const row = container?.querySelector<HTMLButtonElement>('.ctx-menu-parent[data-submenu-open="true"]')
    if (!row || !container || !sub) return
    const menuRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const subRect = sub.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = rowRect.top - menuRect.top
    if (menuRect.top + top + subRect.height > vh - 4) {
      top = Math.max(0, vh - 4 - subRect.height - menuRect.top)
    }
    const fitsRight = menuRect.left + menuRect.width + subRect.width <= vw - 4
    setSubPos({ top, side: fitsRight ? 'right' : 'left' })
  }, [openSub])

  // Default 'ignore': right-click (button 2) must NOT close a right-click
  // menu — the browser fires `contextmenu` next, which the owning component
  // uses to open a replacement menu, and closing on mousedown would be a
  // visible close→reopen flash. Left-click-owned surfaces pass 'close' so a
  // right-click outside doesn't stack a second menu on top.
  //
  // `mousedown` beats `click` — feels snappier and avoids swallowing a
  // subsequent click on another interactive element (the hook's default).
  useOutsideMouseDown({ ref, onClose, triggerRef, surfaceId, nonPrimary })

  // Collapse consecutive separators and trim leading/trailing ones. Callers
  // build the item list from conditional spreads, so a separator can end up
  // adjacent to another (or at an edge) when the items between them are
  // absent — dropping those here keeps every caller's separator placement
  // simple without each one having to track its neighbours. `openSub` indexes
  // THIS array (rows and the flyout both render from it).
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
  if (visible.length > 0 && !visible[visible.length - 1].label) visible.pop()

  return (
    <FloatingSurfaceProvider surfaceId={surfaceId}>
      {createPortal(
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
        return visible.map((item, i) => {
          if (!item.label) return <div key={`sep-${i}`} className="ctx-menu-sep" role="separator" />
          if (item.children && item.children.length > 0) {
            return (
              <button
                key={`${i}-${item.label}`}
                className="ctx-menu-item ctx-menu-parent"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub === i}
                data-submenu-open={openSub === i || undefined}
                disabled={item.disabled}
                onMouseEnter={() => setSubOpen(i)}
                onClick={() => {
                  if (item.disabled) return
                  setSubOpen(openSub === i ? null : i)
                }}
              >
                {item.icon && <span className="ctx-menu-icon" style={item.iconStyle} aria-hidden>{item.icon}</span>}
                <span className="ctx-menu-label">{item.label}</span>
                <SubmenuArrow />
              </button>
            )
          }
          return (
            <button
              key={`${i}-${item.label}`}
              className={`ctx-menu-item ${item.danger ? 'danger' : ''}`}
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={() => setSubOpen(null)}
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
      {(() => {
        const parent = openSub !== null ? visible[openSub] : null
        if (parent === null || !parent.children || parent.children.length === 0) return null
        return (
          <div
            ref={subRef}
            className="ctx-menu ctx-submenu"
            role="menu"
            aria-label={parent.label}
            style={{ top: subPos.top, ...(subPos.side === 'right' ? { left: '100%' } : { right: '100%' }) }}
          >
            {parent.children.map((child, ci) =>
              child.label ? (
                <button
                  key={`${ci}-${child.label}`}
                  className={`ctx-menu-item ${child.danger ? 'danger' : ''}`}
                  role="menuitem"
                  disabled={child.disabled}
                  onClick={() => {
                    if (child.disabled) return
                    child.onClick?.()
                    onClose()
                  }}
                >
                  {child.icon && <span className="ctx-menu-icon" style={child.iconStyle} aria-hidden>{child.icon}</span>}
                  <span className="ctx-menu-label">{child.label}</span>
                </button>
              ) : (
                <div key={`sub-sep-${ci}`} className="ctx-menu-sep" role="separator" />
              ),
            )}
          </div>
        )
      })()}
        </motion.div>,
        // Portal to <body>: `pos` above is in VIEWPORT coordinates, and any
        // ancestor carrying filter / transform / backdrop-filter would take over as
        // this element's containing block instead. Canonical statement: the
        // body.has-bg note in layout.css. Pinned by ContextMenu.test.tsx.
        document.body,
      )}
    </FloatingSurfaceProvider>
  )
})
