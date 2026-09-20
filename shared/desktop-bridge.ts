// Shared contract for the Electron preload <-> renderer bridge.
//
// Lives in `shared/` (imported by both the browser bundle and the desktop
// preload bundle) so the channel names and command strings cannot drift
// between the two sides.

/** IPC channel the native menu uses to dispatch a command to the renderer. */
export const DESKTOP_MENU_CHANNEL = 'crw:menu'

/** Commands the native application menu can dispatch. */
export type DesktopMenuCommand = 'crw:menu-new-session'

/** Host OS as reported by the preload (`process.platform`). */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

/** Renderer → main: chrome window controls for the custom titlebar. */
export type DesktopWindowAction = 'minimize' | 'maximize' | 'unmaximize' | 'toggle-maximize' | 'close'

/** Renderer → main: edit-menu actions (Windows ☰ dropdown). */
export type DesktopEditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

/** Renderer → main: keep the Windows caption overlay in sync with the app theme. */
export interface TitlebarThemePayload {
  /** Overlay background (CSS color). Use transparent so the app chrome shows through. */
  color: string
  /** Caption button glyph color. Must contrast with the chrome behind the overlay. */
  symbolColor: string
  /** Overlay height in px — must match the custom titlebar row. */
  height: number
}

export const DESKTOP_WINDOW_ACTION_CHANNEL = 'crw:window-action'
export const DESKTOP_EDIT_ACTION_CHANNEL = 'crw:edit-action'
export const DESKTOP_TITLEBAR_THEME_CHANNEL = 'crw:titlebar-theme'
/** main → renderer: maximize state changed (for ☰ Window menu labels). */
export const DESKTOP_MAXIMIZE_CHANNEL = 'crw:maximize-changed'
/** Renderer → main: ask for the current maximize state (initial snapshot). */
export const DESKTOP_GET_MAXIMIZE_CHANNEL = 'crw:get-maximize'

/** Renderer → main: view-menu actions (reload / devtools / zoom). */
export type DesktopViewAction =
  | 'reload'
  | 'force-reload'
  | 'toggle-devtools'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-fullscreen'
export const DESKTOP_VIEW_ACTION_CHANNEL = 'crw:view-action'

/** Shared titlebar strip height in CSS px. MUST stay in sync with
 *  `--titlebar-height` in src/styles/tokens.css and `--app-header-height`
 *  (the brand/main-header rows the drag strip is made of) — the Windows
 *  caption overlay, the drag strip, and those rows all key off it. */
export const TITLEBAR_HEIGHT_PX = 43
