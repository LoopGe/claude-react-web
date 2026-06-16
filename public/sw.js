/* global self, fetch, console */
// Service Worker for claude-react-web desktop notifications.
//
// Responsibilities:
// 1. Receive SHOW_NOTIFICATION messages from the main thread and display
//    OS-level notifications with optional action buttons (Allow / Deny).
// 2. Handle notification clicks — for Allow/Deny actions, call the decide
//    API directly from the SW (no main-thread round-trip needed, so the
//    permission is resolved even if the page isn't focused). For other
//    clicks (body tap, "Open" action), focus the client window.
// 3. Relay NOTIFICATION_ACTION messages back to the main thread so the
//    React UI can sync (close permission dialogs, refresh state).

// ── Inbound: main thread → SW ────────────────────────────────────────

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'SHOW_NOTIFICATION') return

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      tag: data.tag,
      icon: data.icon || '/icon-192.png',
      requireInteraction: data.requireInteraction ?? false,
      silent: data.silent ?? false,
      actions: data.actions || [],
      // Persist metadata so onnotificationclick can read it.
      data: data.data || {},
    }),
  )
})

// ── Notification click ───────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const { sessionId, permissionId, updatedInput } = event.notification.data || {}
  const action = event.action // 'allow' | 'deny' | '' (body click)

  // Allow / Deny: call the decide API directly from the SW.
  // The main thread doesn't need to be involved for the API call itself —
  // the server broadcasts permission-resolved over WS which updates the
  // React UI automatically once the window regains focus.
  if (permissionId && (action === 'allow' || action === 'deny')) {
    event.waitUntil(
      fetch(`/api/sessions/${sessionId}/permissions/${permissionId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          behavior: action,
          // The SDK requires updatedInput on allow paths — echo the
          // original tool input that was captured when the notification
          // was created.
          updatedInput: updatedInput,
          persistForSession: false,
        }),
      }).catch((err) => {
        // Non-fatal: the user can still open the page and decide manually.
        console.warn('[sw] decide API call failed:', err)
      }),
    )
  }

  // Notify the main thread so it can focus the window and sync UI state.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer a visible + focused client, then any visible, then any client.
      const client =
        clients.find(c => c.visibilityState === 'visible' && c.focused) ??
        clients.find(c => c.visibilityState === 'visible') ??
        clients[0]
      if (client) {
        client.postMessage({
          type: 'NOTIFICATION_ACTION',
          sessionId,
          action, // 'allow' | 'deny' | ''
        })
        return client.focus()
      }
      // No existing window — open a new one.
      if (self.clients.openWindow) {
        return self.clients.openWindow('/')
      }
    }),
  )
})
