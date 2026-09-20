// Window-control IPC for the custom titlebar.
//
// On Windows the frame is hidden (`frame: false` + `titleBarOverlay`); the
// renderer draws its own drag strip and a ☰ menu, and drives minimize /
// maximize / close through these channels. Edit- and view-menu actions also
// land here so the Windows dropdown can forward them to the focused
// webContents without a native menu bar.

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import {
  DESKTOP_EDIT_ACTION_CHANNEL,
  DESKTOP_GET_MAXIMIZE_CHANNEL,
  DESKTOP_MAXIMIZE_CHANNEL,
  DESKTOP_TITLEBAR_THEME_CHANNEL,
  DESKTOP_VIEW_ACTION_CHANNEL,
  DESKTOP_WINDOW_ACTION_CHANNEL,
  type DesktopEditAction,
  type DesktopViewAction,
  type DesktopWindowAction,
  type TitlebarThemePayload,
} from '../shared/desktop-bridge.js'
import { createLogger } from '../server/log.js'

const log = createLogger('desktop')

function targetWindow(evt: IpcMainEvent): BrowserWindow | null {
  // Prefer the window that sent the frame; fall back to focused / first.
  const fromEvent = BrowserWindow.fromWebContents(evt.sender)
  if (fromEvent && !fromEvent.isDestroyed()) return fromEvent
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

function applyWindowAction(win: BrowserWindow, action: DesktopWindowAction): void {
  switch (action) {
    case 'minimize':
      win.minimize()
      return
    case 'maximize':
      win.maximize()
      return
    case 'unmaximize':
      win.unmaximize()
      return
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return
    case 'close':
      win.close()
      return
  }
}

function applyEditAction(evt: IpcMainEvent, action: DesktopEditAction): void {
  const wc = evt.sender
  switch (action) {
    case 'undo':
      wc.undo()
      return
    case 'redo':
      wc.redo()
      return
    case 'cut':
      wc.cut()
      return
    case 'copy':
      wc.copy()
      return
    case 'paste':
      wc.paste()
      return
    case 'selectAll':
      wc.selectAll()
      return
  }
}

function applyViewAction(win: BrowserWindow, action: DesktopViewAction): void {
  const wc = win.webContents
  switch (action) {
    case 'reload':
      wc.reload()
      return
    case 'force-reload':
      wc.reloadIgnoringCache()
      return
    case 'toggle-devtools':
      wc.toggleDevTools()
      return
    case 'zoom-in':
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 10))
      return
    case 'zoom-out':
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3))
      return
    case 'zoom-reset':
      wc.setZoomLevel(0)
      return
    case 'toggle-fullscreen':
      win.setFullScreen(!win.isFullScreen())
      return
  }
}

function isTitlebarTheme(value: unknown): value is TitlebarThemePayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.color === 'string' && typeof v.symbolColor === 'string' && typeof v.height === 'number'
}

/**
 * Register window-control IPC. Safe to call once after app ready.
 * Also mirrors maximize/unmaximize onto each window's webContents so the
 * renderer can update its ☰ Window menu labels.
 */
export function wireWindowControls(): void {
  ipcMain.on(DESKTOP_WINDOW_ACTION_CHANNEL, (evt, action: DesktopWindowAction) => {
    const win = targetWindow(evt)
    if (!win) return
    applyWindowAction(win, action)
  })

  ipcMain.on(DESKTOP_EDIT_ACTION_CHANNEL, (evt, action: DesktopEditAction) => {
    applyEditAction(evt, action)
  })

  ipcMain.on(DESKTOP_VIEW_ACTION_CHANNEL, (evt, action: DesktopViewAction) => {
    const win = targetWindow(evt)
    if (!win) return
    applyViewAction(win, action)
  })

  ipcMain.on(DESKTOP_TITLEBAR_THEME_CHANNEL, (evt, payload: unknown) => {
    if (!isTitlebarTheme(payload)) {
      log.warn('ignoring malformed titlebar theme payload')
      return
    }
    const win = targetWindow(evt)
    if (!win) return
    // titleBarOverlay is a no-op on platforms without it (mac/linux).
    win.setTitleBarOverlay({
      color: payload.color,
      symbolColor: payload.symbolColor,
      height: payload.height,
    })
  })

  // Initial maximize snapshot: the ☰ Window menu must not seed a stale
  // "Maximize" label when the window is already maximized at subscribe time.
  ipcMain.on(DESKTOP_GET_MAXIMIZE_CHANNEL, (evt) => {
    const win = targetWindow(evt)
    if (!win) return
    evt.sender.send(DESKTOP_MAXIMIZE_CHANNEL, win.isMaximized())
  })
}

/** Attach maximize-state mirroring to a newly created window. */
export function attachMaximizeMirror(win: BrowserWindow): void {
  const send = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(DESKTOP_MAXIMIZE_CHANNEL, win.isMaximized())
  }
  win.on('maximize', send)
  win.on('unmaximize', send)
  win.on('enter-full-screen', send)
  win.on('leave-full-screen', send)
}
