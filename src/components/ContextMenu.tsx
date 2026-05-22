// Minimal custom context menu used by SessionList cards.
//
// Positioned absolutely at the cursor on `contextmenu`. The parent owns
// visibility state (so it knows which session the menu targets); this
// component only handles the rendering, outside-click / Esc dismissal,
// and a small nudge to stay within the viewport.

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

export interface ContextMenuItem {
  /** Shown in the menu. Falsy = render a separator instead. */
  label?: string
  /** Optional leading glyph / icon character. */
  icon?: string
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
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // `mousedown` beats `click` — feels snappier and avoids swallowing
    // a subsequent click on another interactive element.
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      // Stop mousedown so the outside-click listener above (which is on
      // window) doesn't fire when the user clicks the menu itself.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
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
      })}
    </div>
  )
})
