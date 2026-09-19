// Service Worker registration.
//
// Called once from App.tsx on mount. Returns the ServiceWorkerRegistration
// once the SW is active, or null if the browser doesn't support SWs or
// registration fails.
//
// The SW file lives at /sw.js (copied from public/ by Vite at build time).
// Scope defaults to '/' which covers the entire app.

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null
  }
  // The desktop host serves the client from a custom `crw://` scheme, which
  // does not support service workers ("The URL protocol of the current origin
  // ('crw://app') is not supported"). Skip registration there — desktop
  // notifications use Electron's native Notification, not the SW.
  if (window.__CRW_DESKTOP__) {
    return null
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    // Wait for the SW to be activated — showNotification requires an
    // active worker.controller or ready promise.
    await navigator.serviceWorker.ready
    return reg
  } catch (err) {
    console.warn('[sw] registration failed:', err)
    return null
  }
}
