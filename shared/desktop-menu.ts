// One menu description, two renderers.
//
// macOS/Linux turn this into a native Menu template (desktop/menu.ts).
// Windows renders it as the ☰ dropdown in the custom titlebar
// (src/components/DesktopAppMenu.tsx). Keeping a single source means the
// two cannot drift — add an item here and both hosts pick it up.
//
// Actions are host-agnostic tags; each renderer maps them to its own
// mechanism (Electron role / webContents method / renderer callback).

import type {
  DesktopEditAction,
  DesktopMenuCommand,
  DesktopViewAction,
  DesktopWindowAction,
} from './desktop-bridge.js'

/** Platforms a menu entry can appear on. */
export type DesktopMenuPlatform = 'macos' | 'windows' | 'linux'

export type DesktopMenuAction =
  /** Electron built-in role (mac/linux native menu). */
  | { kind: 'role'; role: string }
  /** Send a command to the focused renderer. */
  | { kind: 'command'; command: DesktopMenuCommand }
  /** Edit-menu action (Windows ☰ → webContents; mac uses the role). */
  | { kind: 'edit'; action: DesktopEditAction }
  /** View-menu action (Windows ☰ → webContents; mac uses the role). */
  | { kind: 'view'; action: DesktopViewAction }
  /** Window-control action (Windows ☰). */
  | { kind: 'window'; action: DesktopWindowAction }
  /** Open an external URL. */
  | { kind: 'href'; href: string }

export interface DesktopMenuItem {
  type?: 'item'
  id: string
  label: string
  /** Canonical combo for display, e.g. `mod+n`, `f11`. */
  accelerator?: string
  /** Electron accelerator string for the native menu (mac/linux). */
  electronAccelerator?: string
  action?: DesktopMenuAction
  /** Only render on these platforms. Omitted = all. */
  platforms?: DesktopMenuPlatform[]
  /** Never render on these platforms. */
  excludePlatforms?: DesktopMenuPlatform[]
  /** Windows ☰: restore pre-menu focus before running (edit actions). */
  keepFocus?: boolean
  /** Windows ☰: danger styling. */
  danger?: boolean
}

export interface DesktopMenuSeparator {
  type: 'separator'
  id: string
  platforms?: DesktopMenuPlatform[]
  excludePlatforms?: DesktopMenuPlatform[]
}

export type DesktopMenuEntry = DesktopMenuItem | DesktopMenuSeparator

export interface DesktopMenuGroup {
  id: string
  label: string
  /**
   * `app` — the macOS application menu (under the app name). Not shown as a
   * top-level row on Windows ☰ (its items are folded into File/Help there).
   * `window` — gets the Window role treatment on mac.
   * `help` — Electron help role on mac.
   */
  role?: 'app' | 'window' | 'help'
  entries: DesktopMenuEntry[]
  platforms?: DesktopMenuPlatform[]
  excludePlatforms?: DesktopMenuPlatform[]
}

function visibleOn(entry: { platforms?: DesktopMenuPlatform[]; excludePlatforms?: DesktopMenuPlatform[] }, p: DesktopMenuPlatform): boolean {
  if (entry.platforms && !entry.platforms.includes(p)) return false
  if (entry.excludePlatforms?.includes(p)) return false
  return true
}

export function desktopMenuVisible(
  entry: { platforms?: DesktopMenuPlatform[]; excludePlatforms?: DesktopMenuPlatform[] },
  platform: DesktopMenuPlatform,
): boolean {
  return visibleOn(entry, platform)
}

/** Map the Electron process platform to a DesktopMenuPlatform. */
export function menuPlatformOf(platform: NodeJS.Platform | string): DesktopMenuPlatform {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

export const DESKTOP_MENU: DesktopMenuGroup[] = [
  {
    id: 'app',
    label: 'claude-react-web',
    role: 'app',
    platforms: ['macos'],
    entries: [
      { id: 'about', label: 'About', action: { kind: 'role', role: 'about' } },
      { type: 'separator', id: 'app-sep-1' },
      { id: 'settings', label: 'Settings…', electronAccelerator: 'Cmd+,', action: { kind: 'command', command: 'crw:menu-open-settings' } },
      { type: 'separator', id: 'app-sep-2' },
      { id: 'services', label: 'Services', action: { kind: 'role', role: 'services' } },
      { type: 'separator', id: 'app-sep-3' },
      { id: 'hide', label: 'Hide', action: { kind: 'role', role: 'hide' } },
      { id: 'hide-others', label: 'Hide Others', action: { kind: 'role', role: 'hideOthers' } },
      { id: 'unhide', label: 'Show All', action: { kind: 'role', role: 'unhide' } },
      { type: 'separator', id: 'app-sep-4' },
      { id: 'quit', label: 'Quit', electronAccelerator: 'Cmd+Q', action: { kind: 'role', role: 'quit' } },
    ],
  },
  {
    id: 'file',
    label: 'File',
    entries: [
      {
        id: 'new-session',
        label: 'New Session',
        accelerator: 'mod+n',
        electronAccelerator: 'CmdOrCtrl+N',
        action: { kind: 'command', command: 'crw:menu-new-session' },
      },
      {
        id: 'settings',
        label: 'Settings…',
        accelerator: 'mod+,',
        electronAccelerator: 'CmdOrCtrl+,',
        // macOS puts Settings in the app menu; Windows ☰ shows it under File.
        excludePlatforms: ['macos'],
        action: { kind: 'command', command: 'crw:menu-open-settings' },
      },
      { type: 'separator', id: 'file-sep-1' },
      {
        id: 'close',
        label: 'Close Window',
        electronAccelerator: 'CmdOrCtrl+W',
        // mac uses the Close role; Windows ☰ uses Window → Close instead
        // (a single-window app does not need both Quit and Close).
        platforms: ['macos'],
        action: { kind: 'role', role: 'close' },
      },
      {
        id: 'quit-linux',
        label: 'Quit',
        electronAccelerator: 'CmdOrCtrl+Q',
        // Linux has no app-name menu; Quit must live under File. Windows ☰
        // uses Window → Close (single-window app).
        platforms: ['linux'],
        danger: true,
        action: { kind: 'role', role: 'quit' },
      },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    entries: [
      // On mac/linux these are native roles; on Windows ☰ they forward to
      // webContents and must keepFocus so the composer keeps the caret.
      { id: 'undo', label: 'Undo', accelerator: 'mod+z', electronAccelerator: 'CmdOrCtrl+Z', keepFocus: true, action: { kind: 'edit', action: 'undo' } },
      // No electronAccelerator on Redo: the Electron 'redo' role already
      // carries the platform default (Cmd+Shift+Z on macOS, Ctrl+Y on Win).
      // Forcing CmdOrCtrl+Y would override the mac convention.
      { id: 'redo', label: 'Redo', accelerator: 'mod+y', keepFocus: true, action: { kind: 'edit', action: 'redo' } },
      { type: 'separator', id: 'edit-sep-1' },
      { id: 'cut', label: 'Cut', accelerator: 'mod+x', electronAccelerator: 'CmdOrCtrl+X', keepFocus: true, action: { kind: 'edit', action: 'cut' } },
      { id: 'copy', label: 'Copy', accelerator: 'mod+c', electronAccelerator: 'CmdOrCtrl+C', keepFocus: true, action: { kind: 'edit', action: 'copy' } },
      { id: 'paste', label: 'Paste', accelerator: 'mod+v', electronAccelerator: 'CmdOrCtrl+V', keepFocus: true, action: { kind: 'edit', action: 'paste' } },
      { type: 'separator', id: 'edit-sep-2' },
      { id: 'select-all', label: 'Select All', accelerator: 'mod+a', electronAccelerator: 'CmdOrCtrl+A', keepFocus: true, action: { kind: 'edit', action: 'selectAll' } },
    ],
  },
  {
    id: 'view',
    label: 'View',
    entries: [
      { id: 'reload', label: 'Reload', accelerator: 'mod+r', electronAccelerator: 'CmdOrCtrl+R', action: { kind: 'view', action: 'reload' } },
      { id: 'force-reload', label: 'Force Reload', platforms: ['macos', 'linux'], action: { kind: 'role', role: 'forceReload' } },
      { id: 'devtools', label: 'Toggle Developer Tools', accelerator: 'mod+shift+i', electronAccelerator: 'CmdOrCtrl+Shift+I', action: { kind: 'view', action: 'toggle-devtools' } },
      { type: 'separator', id: 'view-sep-1' },
      { id: 'zoom-reset', label: 'Actual Size', accelerator: 'mod+0', electronAccelerator: 'CmdOrCtrl+0', action: { kind: 'view', action: 'zoom-reset' } },
      { id: 'zoom-in', label: 'Zoom In', accelerator: 'mod+=', electronAccelerator: 'CmdOrCtrl+=', action: { kind: 'view', action: 'zoom-in' } },
      { id: 'zoom-out', label: 'Zoom Out', accelerator: 'mod+-', electronAccelerator: 'CmdOrCtrl+-', action: { kind: 'view', action: 'zoom-out' } },
      { type: 'separator', id: 'view-sep-2' },
      { id: 'fullscreen', label: 'Toggle Full Screen', accelerator: 'f11', electronAccelerator: 'F11', action: { kind: 'view', action: 'toggle-fullscreen' } },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    role: 'window',
    entries: [
      { id: 'minimize', label: 'Minimize', electronAccelerator: 'CmdOrCtrl+M', action: { kind: 'role', role: 'minimize' } },
      { id: 'zoom', label: 'Zoom', platforms: ['macos', 'linux'], action: { kind: 'role', role: 'zoom' } },
      // Windows ☰ uses the window-action bridge (label flips with maximize).
      { id: 'minimize-win', label: 'Minimize', platforms: ['windows'], action: { kind: 'window', action: 'minimize' } },
      { id: 'maximize-win', label: 'Maximize', platforms: ['windows'], action: { kind: 'window', action: 'toggle-maximize' } },
      { id: 'close-win', label: 'Close', platforms: ['windows'], danger: true, action: { kind: 'window', action: 'close' } },
      { type: 'separator', id: 'win-sep-1', platforms: ['macos'] },
      { id: 'front', label: 'Bring All to Front', platforms: ['macos'], action: { kind: 'role', role: 'front' } },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    role: 'help',
    entries: [
      {
        id: 'project-home',
        label: 'Project Home',
        // Native menu: shell.openExternal directly (no renderer round-trip).
        // Windows ☰: DesktopAppMenu maps href → preload openExternal.
        action: { kind: 'href', href: 'https://github.com/LoopGe/claude-react-web' },
      },
    ],
  },
]
