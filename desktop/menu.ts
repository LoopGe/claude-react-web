// Native application menu — macOS and Linux.
//
// The template is GENERATED from shared/desktop-menu.ts so the mac menu and
// the Windows ☰ dropdown cannot drift. Windows clears the application menu
// (custom titlebar + renderer ☰); installing one there would fight the
// frameless chrome (Alt would pop a menu row that steals the drag strip).

import { Menu, shell, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { DESKTOP_MENU_CHANNEL, type DesktopMenuCommand } from '../shared/desktop-bridge.js'
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  menuPlatformOf,
  type DesktopMenuAction,
  type DesktopMenuEntry,
  type DesktopMenuGroup,
  type DesktopMenuPlatform,
} from '../shared/desktop-menu.js'

/** Send a menu command to the focused renderer over the shared menu channel.
 *  The preload's `onMenu` subscription dispatches by command. */
function sendToFocused(win: BrowserWindow | null, command: DesktopMenuCommand): void {
  win?.webContents.send(DESKTOP_MENU_CHANNEL, command)
}

/** Bridge edit actions → Electron roles for the native menu. */
const EDIT_ROLE: Record<string, string> = {
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll',
}

/** Bridge view actions → Electron roles for the native menu. */
const VIEW_ROLE: Record<string, string> = {
  reload: 'reload',
  'force-reload': 'forceReload',
  'toggle-devtools': 'toggleDevTools',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  'zoom-reset': 'resetZoom',
  'toggle-fullscreen': 'togglefullscreen',
}

function resolveRole(action: DesktopMenuAction | undefined): string | null {
  if (!action) return null
  if (action.kind === 'role') return action.role
  if (action.kind === 'edit') return EDIT_ROLE[action.action] ?? null
  if (action.kind === 'view') return VIEW_ROLE[action.action] ?? null
  if (action.kind === 'window') {
    if (action.action === 'minimize') return 'minimize'
    if (action.action === 'close') return 'close'
    return null
  }
  return null
}

function buildEntry(
  entry: DesktopMenuEntry,
  platform: DesktopMenuPlatform,
  getWindow: () => BrowserWindow | null,
): MenuItemConstructorOptions | null {
  if (!desktopMenuVisible(entry, platform)) return null
  if (entry.type === 'separator') return { type: 'separator' }

  const role = resolveRole(entry.action)
  if (role) {
    return {
      label: entry.label,
      role: role as MenuItemConstructorOptions['role'],
      accelerator: entry.electronAccelerator,
    }
  }

  const item: MenuItemConstructorOptions = {
    label: entry.label,
    accelerator: entry.electronAccelerator,
  }

  if (entry.action?.kind === 'command') {
    const command = entry.action.command
    // Resolve the window at CLICK time, not build time: a window that was
    // replaced (close + reopen via `activate`) must not receive the command
    // on its dead webContents.
    item.click = () => sendToFocused(getWindow(), command)
  } else if (entry.action?.kind === 'href') {
    const href = entry.action.href
    item.click = () => {
      void shell.openExternal(href)
    }
  } else if (entry.action?.kind === 'window' && entry.action.action === 'toggle-maximize') {
    item.click = () => {
      const win = getWindow()
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  }

  return item
}

function buildGroup(
  group: DesktopMenuGroup,
  platform: DesktopMenuPlatform,
  getWindow: () => BrowserWindow | null,
): MenuItemConstructorOptions | null {
  if (!desktopMenuVisible(group, platform)) return null

  const items = group.entries
    .map((e) => buildEntry(e, platform, getWindow))
    .filter((x): x is MenuItemConstructorOptions => x !== null)

  if (group.role === 'help') {
    return { role: 'help', label: group.label, submenu: items }
  }
  if (group.role === 'window') {
    return { role: 'windowMenu', label: group.label, submenu: items }
  }
  if (group.role === 'app') {
    // Always the real productName — the shared data's label is a placeholder
    // for the Windows ☰ flatten (which skips this group entirely).
    return { label: app.name, submenu: items }
  }
  return { label: group.label, submenu: items }
}

export function buildAppMenu(getWindow: () => BrowserWindow | null): Menu {
  const platform = menuPlatformOf(process.platform)
  const template = DESKTOP_MENU.map((g) => buildGroup(g, platform, getWindow)).filter(
    (x): x is MenuItemConstructorOptions => x !== null,
  )
  return Menu.buildFromTemplate(template)
}

/** Install the application menu. Called once after the first window exists.
 *  Windows clears it (custom titlebar + ☰); macOS and Linux keep the full
 *  native template — Linux has no custom chrome and would otherwise lose
 *  every role accelerator with no replacement. */
export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(buildAppMenu(getWindow))
}
