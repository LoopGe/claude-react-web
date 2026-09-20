// Windows custom-titlebar app menu (☰).
//
// On Windows the native menu bar is gone (frame: false + no Menu.setApplicationMenu).
// This dropdown is the replacement for File / Edit / View / Window — same
// role the macOS native menu plays, rendered into the drag strip.
//
// Reuses the project's ctx-menu popover conventions (portal, viewport clamp,
// outside-press dismiss with trigger exemption, capture-phase Escape).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconMenu } from './icons/ToolIcons'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { markPortaledSurface } from '../theme'
import { formatCombo } from '../utils/format-combo'
import type { DesktopEditAction, DesktopViewAction, DesktopWindowAction } from '../../shared/desktop-bridge'

interface Props {
  onNewSession: () => void
  onOpenSettings: () => void
}

type Row =
  | {
      kind: 'item'
      id: string
      label: string
      accelerator?: string
      danger?: boolean
      /** Edit rows must not steal focus from the input they act on. */
      keepFocus?: boolean
      run: () => void
    }
  | { kind: 'sep'; id: string }

function desktopBridge() {
  return typeof window !== 'undefined' ? window.__CRW_DESKTOP__ : undefined
}

function windowAction(action: DesktopWindowAction): void {
  desktopBridge()?.windowAction?.(action)
}

function editAction(action: DesktopEditAction): void {
  desktopBridge()?.editAction?.(action)
}

function viewAction(action: DesktopViewAction): void {
  desktopBridge()?.viewAction?.(action)
}

export function DesktopAppMenu({ onNewSession, onOpenSettings }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Element focused before the menu opened — edit rows restore it so
   *  wc.paste()/undo() hit the composer, not a menu button. */
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge?.onMaximizeChange) return
    const off = bridge.onMaximizeChange((v) => setMaximized(v))
    // Seed from the host — the window may already be maximized before this
    // component mounted, and the event-only mirror would never fire.
    bridge.requestMaximizeState?.()
    return off
  }, [])

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    lastFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAnchor({ x: rect.left, y: rect.bottom + 4 })
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  // Measure then nudge inward so the menu never clips off-screen.
  useLayoutEffect(() => {
    if (!open) return
    const el = menuRef.current
    if (!el) return
    markPortaledSurface(el)
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    setPos({
      x: Math.min(Math.max(margin, anchor.x), vw - rect.width - margin),
      y: Math.min(Math.max(margin, anchor.y), vh - rect.height - margin),
    })
  }, [open, anchor.x, anchor.y])

  // Trigger is exempt — it toggles, so its own mousedown must not unmount
  // the menu before the click lands (mirrors AppearancePanel).
  useOutsideMouseDown({ ref: menuRef, onClose: close, triggerRef, active: open })
  useEscapeStack({ active: open, onEscape: close, getContainer: () => menuRef.current })

  const rows: Row[] = [
    { kind: 'item', id: 'new', label: 'New Session', accelerator: 'mod+n', run: onNewSession },
    { kind: 'item', id: 'settings', label: 'Settings', accelerator: 'mod+,', run: onOpenSettings },
    { kind: 'sep', id: 'sep-file' },
    // keepFocus: Electron's wc.undo()/paste() target the focused element.
    // A plain mousedown would focus this <button> and the edit command would
    // hit a non-editable node — preventDefault keeps focus in the composer.
    { kind: 'item', id: 'undo', label: 'Undo', accelerator: 'mod+z', keepFocus: true, run: () => editAction('undo') },
    { kind: 'item', id: 'redo', label: 'Redo', accelerator: 'mod+y', keepFocus: true, run: () => editAction('redo') },
    { kind: 'sep', id: 'sep-edit-1' },
    { kind: 'item', id: 'cut', label: 'Cut', accelerator: 'mod+x', keepFocus: true, run: () => editAction('cut') },
    { kind: 'item', id: 'copy', label: 'Copy', accelerator: 'mod+c', keepFocus: true, run: () => editAction('copy') },
    { kind: 'item', id: 'paste', label: 'Paste', accelerator: 'mod+v', keepFocus: true, run: () => editAction('paste') },
    {
      kind: 'item',
      id: 'selectAll',
      label: 'Select All',
      accelerator: 'mod+a',
      keepFocus: true,
      run: () => editAction('selectAll'),
    },
    { kind: 'sep', id: 'sep-view' },
    { kind: 'item', id: 'reload', label: 'Reload', accelerator: 'mod+r', run: () => viewAction('reload') },
    {
      kind: 'item',
      id: 'devtools',
      label: 'Toggle Developer Tools',
      accelerator: 'mod+shift+i',
      run: () => viewAction('toggle-devtools'),
    },
    { kind: 'item', id: 'zoom-in', label: 'Zoom In', accelerator: 'mod+=', run: () => viewAction('zoom-in') },
    { kind: 'item', id: 'zoom-out', label: 'Zoom Out', accelerator: 'mod+-', run: () => viewAction('zoom-out') },
    { kind: 'item', id: 'zoom-reset', label: 'Reset Zoom', accelerator: 'mod+0', run: () => viewAction('zoom-reset') },
    {
      kind: 'item',
      id: 'fullscreen',
      label: 'Toggle Full Screen',
      accelerator: 'f11',
      run: () => viewAction('toggle-fullscreen'),
    },
    { kind: 'sep', id: 'sep-win' },
    { kind: 'item', id: 'min', label: 'Minimize', run: () => windowAction('minimize') },
    {
      kind: 'item',
      id: 'max',
      label: maximized ? 'Restore' : 'Maximize',
      run: () => windowAction('toggle-maximize'),
    },
    { kind: 'item', id: 'close', label: 'Close', danger: true, run: () => windowAction('close') },
  ]

  const runRow = (row: Row) => {
    if (row.kind !== 'item') return
    // Restore the pre-menu focus BEFORE the action: the open effect moves
    // focus into the menu for arrow-key nav, and Electron's edit commands
    // target document.activeElement. Without this, Paste hits a <button>.
    if (row.keepFocus && lastFocusedRef.current?.isConnected) {
      lastFocusedRef.current.focus({ preventScroll: true })
    }
    close()
    row.run()
  }

  // Minimal menu keyboard model: ArrowDown/Up move between items, Home/End
  // jump, Enter/Space activate (native button behaviour). role="menu" promises
  // this to AT — without it we'd be lying about the widget type.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  // Focus the first item when the menu opens so arrow keys work immediately.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus()
    }, 0)
    return () => window.clearTimeout(id)
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-icon titlebar-app-menu-trigger"
        aria-label="App menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Menu"
        onClick={() => (open ? close() : openMenu())}
      >
        <IconMenu size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="ctx-menu titlebar-app-menu"
            style={{ left: pos.x, top: pos.y }}
            role="menu"
            aria-label="App menu"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
          >
            {rows.map((row) =>
              row.kind === 'sep' ? (
                <div key={row.id} className="ctx-menu-sep" role="separator" />
              ) : (
                <button
                  key={row.id}
                  type="button"
                  className={`ctx-menu-item${row.danger ? ' danger' : ''}`}
                  role="menuitem"
                  // keepFocus rows must not steal the caret from the input
                  // they act on — preventDefault on mousedown leaves focus
                  // where it was so wc.paste()/undo() hit the textarea.
                  onMouseDown={row.keepFocus ? (e) => e.preventDefault() : undefined}
                  onClick={() => runRow(row)}
                >
                  <span className="ctx-menu-label">{row.label}</span>
                  {row.accelerator && (
                    <span className="titlebar-app-menu-accel" aria-hidden>
                      {formatCombo(row.accelerator)}
                    </span>
                  )}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
