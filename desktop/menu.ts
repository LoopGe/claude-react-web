// Native application menu.
//
// The web build has no menu bar; the desktop host provides the standard
// macOS/Windows menu so familiar shortcuts (reload, devtools, quit, copy/paste,
// zoom) work without the app implementing them. Everything here is standard
// Electron roles except two app-specific items that drive the renderer.

import { Menu, shell, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { DESKTOP_MENU_CHANNEL, type DesktopMenuCommand } from '../shared/desktop-bridge.js'

/** Send a menu command to the focused renderer over the shared menu channel.
 *  The preload's `onMenu` subscription dispatches by command. */
function sendToFocused(win: BrowserWindow | null, command: DesktopMenuCommand): void {
  win?.webContents.send(DESKTOP_MENU_CHANNEL, command)
}

export function buildAppMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin'

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
    : []

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          // Resolve the window at CLICK time, not build time: a window that
          // was replaced (close + reopen via `activate`) must not receive the
          // command on its dead webContents.
          click: () => sendToFocused(getWindow(), 'crw:menu-new-session'),
        },
        { type: 'separator' },
        // A tool app should not keep a headless host alive after the window
        // closes; keep the standard close on every platform.
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Project Home',
          click: () => { void shell.openExternal('https://github.com/LoopGe/claude-react-web') },
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

/** Install the application menu. Called once after the first window exists. */
export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(buildAppMenu(getWindow))
}
