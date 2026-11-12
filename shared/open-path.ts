// Shared types for the open-path routes (reveal a project directory in the
// server machine's file manager / terminal, or open a local HTML file in its
// default browser). Used by both the server route and the client UI.

export const OPEN_PATH_TARGETS = ['finder', 'terminal', 'browser'] as const
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
