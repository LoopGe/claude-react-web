// Windows custom-titlebar app menu (☰).
//
// Renders shared/desktop-menu.ts — the SAME data that generates the macOS
// native menu — so the two hosts cannot drift. On Windows the native menu
// bar is gone (titleBarStyle:'hidden' + no Menu.setApplicationMenu); this
// dropdown is the File/Edit/View/Window replacement.
//
// Reuses the project's ctx-menu popover conventions (portal, viewport clamp,
// outside-press dismiss with trigger exemption, capture-phase Escape) plus
// a minimal arrow-key menu model that role="menu" promises to AT.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconMenu } from './icons/ToolIcons'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { markPortaledSurface } from '../theme'
import { formatCombo } from '../utils/format-combo'
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuAction,
  type DesktopMenuItem,
} from '../../shared/desktop-menu'
import type { DesktopEditAction, DesktopViewAction, DesktopWindowAction } from '../../shared/desktop-bridge'

interface Props {
  /** Renderer callbacks for command-tagged items (session.new, settings…). */
  onCommand: (command: string) => void
}

function desktopBridge() {
  return typeof window !== 'undefined' ? window.__CRW_DESKTOP__ : undefined
}

function runHostAction(action: DesktopMenuAction): void {
  const bridge = desktopBridge()
  switch (action.kind) {
    case 'edit':
      bridge?.editAction?.(action.action as DesktopEditAction)
      return
    case 'view':
      bridge?.viewAction?.(action.action as DesktopViewAction)
      return
    case 'window':
      bridge?.windowAction?.(action.action as DesktopWindowAction)
      return
    case 'href':
      // Host opens it — a renderer window.open would spawn a raw BrowserWindow.
      if (desktopBridge()?.openExternal) desktopBridge()!.openExternal!(action.href)
      else void window.open(action.href, '_blank', 'noopener,noreferrer')
      return
    case 'command':
      // Handled by the caller via onCommand.
      return
    case 'role':
      // Roles are mac/linux native-menu only; nothing to do in the ☰.
      return
  }
}

export function DesktopAppMenu({ onCommand }: Props) {
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
    bridge.requestMaximizeState?.()
    return off
  }, [])

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAnchor({ x: rect.left, y: rect.bottom + 4 })
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

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

  useOutsideMouseDown({ ref: menuRef, onClose: close, triggerRef, active: open })
  useEscapeStack({ active: open, onEscape: close, getContainer: () => menuRef.current })

  // Flatten the shared data for the Windows ☰. The mac-only `app` group is
  // skipped (its Settings/Quit live under File here). Window-group labels
  // flip Maximize↔Restore from the live maximize mirror.
  const rows: Array<
    | { kind: 'item'; item: DesktopMenuItem; label: string }
    | { kind: 'sep'; id: string }
  > = []
  for (const group of DESKTOP_MENU) {
    if (!desktopMenuVisible(group, 'windows')) continue
    if (group.role === 'app') continue
    for (const entry of group.entries) {
      if (!desktopMenuVisible(entry, 'windows')) continue
      if (entry.type === 'separator') {
        rows.push({ kind: 'sep', id: entry.id })
        continue
      }
      // Skip pure Electron roles that have no Windows ☰ equivalent wired.
      if (entry.action?.kind === 'role') continue
      let label = entry.label
      if (entry.id === 'maximize-win') label = maximized ? 'Restore' : 'Maximize'
      rows.push({ kind: 'item', item: entry, label })
    }
  }

  const runItem = (item: DesktopMenuItem) => {
    if (item.keepFocus && lastFocusedRef.current?.isConnected) {
      lastFocusedRef.current.focus({ preventScroll: true })
    }
    close()
    if (item.action?.kind === 'command') onCommand(item.action.command)
    else if (item.action) runHostAction(item.action)
  }

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
                  key={row.item.id}
                  type="button"
                  className={`ctx-menu-item${row.item.danger ? ' danger' : ''}`}
                  role="menuitem"
                  onMouseDown={row.item.keepFocus ? (e) => e.preventDefault() : undefined}
                  onClick={() => runItem(row.item)}
                >
                  <span className="ctx-menu-label">{row.label}</span>
                  {row.item.accelerator && (
                    <span className="titlebar-app-menu-accel" aria-hidden>
                      {formatCombo(row.item.accelerator)}
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
