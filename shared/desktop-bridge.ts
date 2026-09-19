// Shared contract for the Electron preload <-> renderer bridge.
//
// Lives in `shared/` (imported by both the browser bundle and the desktop
// preload bundle) so the channel names and command strings cannot drift
// between the two sides.

/** IPC channel the native menu uses to dispatch a command to the renderer. */
export const DESKTOP_MENU_CHANNEL = 'crw:menu'

/** Commands the native application menu can dispatch. */
export type DesktopMenuCommand = 'crw:menu-new-session'
