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

/** The bridge the desktop preload exposes. Presence == running in Electron. */
function desktopBridge(): unknown {
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
}

/** Resolve the capability set for the current host. */
export function getHostCapabilities(): HostCapabilities {
  const desktop = isDesktopHost()
  return {
    lanSharing: !desktop,
    serviceWorker: !desktop,
    npxSelfUpdate: !desktop,
    nativeNotifications: desktop,
    nativeMenu: desktop,
    fileDrop: true,
  }
}
