// Shared types for the open-path routes (reveal a project directory in the
// server machine's file manager / terminal, or open a local HTML file in its
// default browser). Used by both the server route and the client UI.

// Shared types for the open-path routes (reveal a project directory in the
// server machine's file manager / terminal / a brand editor, or open a local
// HTML file in its default browser). Used by both the server route and the
// client UI.

export const OPEN_PATH_TARGETS = [
  'finder',
  'terminal',
  // Brand-app targets (the "Open in …" editor/terminal entries). Availability
  // on the server machine is probed by GET /open-path/apps — a target that is
  // not installed must never be offered (launching it would 500).
  'vscode',
  'cursor',
  'zed',
  'iterm2',
  'windowsterminal',
  // HTML-file-in-system-browser target (HTML previews). FILE semantics —
  // every other target takes a directory.
  'browser',
] as const

/** Brand targets the /apps availability probe covers (everything except the
 *  two OS-generic entries, which always exist on their platforms, and the
 *  browser entry, which has no install probe — the OS default browser always
 *  exists). */
export const OPEN_PATH_APP_TARGETS = ['vscode', 'cursor', 'zed', 'iterm2', 'windowsterminal'] as const

/** Menu/button labels for the brand targets, keyed by target id — the single
 *  source shared by the project popover buttons and the session context-menu
 *  open-in group so the two surfaces cannot drift. */
export const OPEN_PATH_APP_LABELS: Readonly<Record<(typeof OPEN_PATH_APP_TARGETS)[number], string>> = {
  vscode: 'Open in VS Code',
  cursor: 'Open in Cursor',
  zed: 'Open in Zed',
  iterm2: 'Open in iTerm2',
  windowsterminal: 'Open in Windows Terminal',
}
export type OpenPathTarget = (typeof OPEN_PATH_TARGETS)[number]

export function isOpenPathTarget(v: unknown): v is OpenPathTarget {
  return typeof v === 'string' && (OPEN_PATH_TARGETS as readonly string[]).includes(v)
}

export function isHtmlFilePath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** Answer of `GET /open-path/capability`. `local` is computed per request
 *  from the peer socket address, so the same server reports true for a
 *  localhost browser tab and false for a LAN client. */
export interface OpenPathCapability {
  local: boolean
}

/** Answer of `GET /open-path/apps`: the brand targets installed on the
 *  SERVER machine (platform facts, not per-request — the loopback gate for
 *  whether a client may USE them lives on the capability route and POST). */
export interface OpenPathAppsPayload {
  apps: OpenPathTarget[]
}
