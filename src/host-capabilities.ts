// Host capabilities — which surfaces are meaningful in the current host.
//
// The same client bundle runs in two hosts:
//   - web:     served over HTTP by server/cli.ts; LAN sharing, PWA install and
//              service-worker notifications are real.
//   - desktop: served from Electron's `crw://` scheme; there is no LAN URL to
//              share, no service worker, and the update channel is the app
//              bundle rather than `npx`.
//
// One place decides, so feature checks are not scattered `if (isElectron)`
// branches. Desktop-ness is detected by the preload-injected bridge.

import type { DesktopPlatform } from '../shared/desktop-bridge'

/** The bridge the desktop preload exposes. Presence == running in Electron. */
function desktopBridge(): { platform?: DesktopPlatform } | undefined {
  return typeof window !== 'undefined' ? window.__CRW_DESKTOP__ : undefined
}

/** True when the client is running inside the Electron desktop host. */
export function isDesktopHost(): boolean {
  return desktopBridge() != null
}

export interface HostCapabilities {
  /** "Open on phone" / LAN QR sharing. Web only — a desktop build has no
   *  reachable HTTP origin. */
  lanSharing: boolean
  /** PWA install prompt + service worker. Not available under `crw://`. */
  serviceWorker: boolean
  /** The in-app updater installs via `npx <pkg>@latest`. On desktop the app
   *  bundle is updated by the Electron updater instead. */
  npxSelfUpdate: boolean
  /** Native (OS-level) notifications. The desktop host owns this; the web
   *  host uses the Notification API / service worker. */
  nativeNotifications: boolean
  /** A native application menu / tray is present (desktop). */
  nativeMenu: boolean
  /** Files can be dropped from the OS. Both hosts support drag-drop; kept
   *  explicit so a future sandboxed webview can opt out. */
  fileDrop: boolean
  /** The window uses a renderer-drawn titlebar (drag strip + ☰ on Windows).
   *  True only for desktop win32/darwin — Linux keeps the native frame. */
  customTitlebar: boolean
  /** Host OS when running in Electron; null on the web. */
  desktopPlatform: DesktopPlatform | null
}

/** Resolve the capability set for the current host. */
export function getHostCapabilities(): HostCapabilities {
  const desktop = isDesktopHost()
  const platform = desktopBridge()?.platform ?? null
  return {
    lanSharing: !desktop,
    serviceWorker: !desktop,
    npxSelfUpdate: !desktop,
    nativeNotifications: desktop,
    // Windows clears the native menu (custom titlebar + ☰). macOS and Linux
    // keep it — Linux has no custom chrome and would lose every role otherwise.
    // A bridge without `platform` (test fake / old preload) reports no menu.
    nativeMenu: desktop && platform != null && platform !== 'win32',
    fileDrop: true,
    customTitlebar: desktop && (platform === 'win32' || platform === 'darwin'),
    desktopPlatform: platform,
  }
}
