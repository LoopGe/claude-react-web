// Desktop-notification wrapper built on the browser `Notification` API.
//
// Two orthogonal states:
//   - `permission`: what the browser last told us (granted / denied /
//     default / unsupported). We read Notification.permission on load and
//     update it after requestPermission().
//   - `enabled`: a localStorage-backed user preference. Even if the browser
//     has granted permission, we won't notify until the user flips this on.
//     Bell button → enable → (if needed) requestPermission → persist.
//
// `notify()` is a no-op unless both are favourable; callers don't need to
// gate themselves. Two notifications with the same `tag` collapse into
// one entry in the OS tray, so bursty updates don't pile up.

import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { useLocalStorage } from './useLocalStorage'

const ENABLED_KEY = 'claude-react-web:notifications-enabled'

export type NotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface NotifyPayload {
  title: string
  body?: string
  /** Coalesce key — repeated notifications with the same tag replace the
   *  previous one instead of stacking. Usually pass the session id. */
  tag?: string
  /** Suppress the OS notification sound. WARNING: on Windows + recent
   *  Chrome this can also suppress the toast itself — `silent: true`
   *  marks the notification as low-priority and Windows Action Center
   *  may filter it out. Use only for non-actionable status updates
   *  (e.g. "turn complete") where the sound is the main annoyance. */
  silent?: boolean
  /** Keep the toast visible until the user dismisses it instead of
   *  auto-hiding after a few seconds. Use for actionable notifications
   *  (permission requests) so the user has time to notice them. */
  requireInteraction?: boolean
  /** Called if the user clicks the notification. Typical use: focus the
   *  window + navigate to the session that produced the event. */
  onClick?: () => void
}

/** A single action button shown on a Service Worker notification.
 *  Chrome/Edge support up to 2 actions; Firefox ignores them silently. */
export interface NotifyAction {
  action: string
  title: string
}

/** Extended payload for notifications that may carry action buttons.
 *  When a Service Worker is active, actions are forwarded to
 *  `showNotification()`; otherwise the notification falls back to a
 *  plain `new Notification()` (no buttons). */
export interface NotifyWithActionsPayload extends NotifyPayload {
  actions?: NotifyAction[]
  /** Arbitrary data forwarded to the SW's notification.data. The SW
   *  reads it back on `notificationclick` to identify the session and
   *  permission request. */
  data?: Record<string, unknown>
}

export interface UseNotifications {
  enabled: boolean
  permission: NotificationPermission
  /** User-facing: flip the master switch. Requests permission on first
   *  enable. Silently ignored on unsupported browsers. */
  toggle: (next?: boolean) => Promise<void>
  /** Fire a notification iff enabled + permission granted. */
  notify: (payload: NotifyPayload) => void
  /** Fire a notification via Service Worker (supports action buttons).
   *  Falls back to plain notify() when SW is unavailable. */
  notifyWithActions: (payload: NotifyWithActionsPayload) => void
}

export interface UseNotificationsOptions {
  /** Live ref to the ServiceWorkerRegistration, set by App.tsx after
   *  registerSW() resolves. Null when SW is unavailable. */
  swRegRef?: RefObject<ServiceWorkerRegistration | null>
}

export function useNotifications(options?: UseNotificationsOptions): UseNotifications {
  const [enabled, setEnabled] = useLocalStorage<boolean>(ENABLED_KEY, false)
  const [permission, setPermission] = useState<NotificationPermission>(() => currentPermission())

  // On mount, reconcile the localStorage flag with the actual browser
  // permission. If the user enabled notifications last session but the
  // browser permission was revoked in the meantime (e.g. Chrome settings
  // on Windows), flip `enabled` off so the bell UI is accurate and
  // `notify()` short-circuits instead of silently doing nothing.
  // (The lazy initializer above already seeds `permission` from
  // currentPermission(), so we only do the reconciliation step here.)
  useEffect(() => {
    if (enabled && currentPermission() !== 'granted') {
      setEnabled(false)
    }
    // Only on mount — subsequent changes are tracked via the focus listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep permission in sync — the user might flip it from the browser UI
  // while the tab is open. There's no real event, but polling on focus
  // catches most transitions cheaply.
  useEffect(() => {
    const refresh = () => {
      const next = currentPermission()
      setPermission(next)
      // Also reconcile enabled — if permission was revoked while the tab
      // was unfocused, turn off the master switch.
      if (enabled && next !== 'granted') {
        setEnabled(false)
      }
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [enabled, setEnabled])

  const toggle = useCallback(
    async (next?: boolean) => {
      const target = next ?? !enabled
      if (!target) {
        setEnabled(false)
        return
      }
      if (typeof Notification === 'undefined') {
        // No-op on environments that lack the API (old browsers / some
        // webviews). Leave `enabled` false so the UI can show a tooltip.
        setPermission('unsupported')
        return
      }
      if (Notification.permission === 'default') {
        let res: string
        try {
          res = await Notification.requestPermission()
        } catch (err) {
          console.warn('[notifications] requestPermission() failed:', err)
          setEnabled(false)
          return
        }
        // Cross-check: some Windows Chrome configurations resolve the
        // promise with 'granted' while the actual browser/OS permission
        // remains denied (e.g. Chrome site-settings toggled off). Read
        // the canonical Notification.permission to catch this mismatch.
        const actual = Notification.permission as NotificationPermission
        setPermission(actual !== 'default' ? actual : (res as NotificationPermission))
        if (actual !== 'granted') {
          console.warn(
            `[notifications] permission not granted (API returned ${res}, actual: ${actual})`,
          )
          setEnabled(false)
          return
        }
      } else if (Notification.permission === 'denied') {
        setPermission('denied')
        setEnabled(false)
        return
      } else {
        setPermission('granted')
      }
      setEnabled(true)
    },
    [enabled, setEnabled],
  )

  const notify = useCallback(
    (payload: NotifyPayload) => {
      if (!enabled) return
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      try {
        const n = new Notification(payload.title, {
          body: payload.body,
          tag: payload.tag,
          // Default to NOT silent — Windows + recent Chrome silently drop
          // silent notifications from Action Center. Callers can opt in
          // for non-actionable status pings.
          silent: payload.silent ?? false,
          requireInteraction: payload.requireInteraction ?? false,
        })
        if (payload.onClick) {
          n.onclick = () => {
            window.focus()
            payload.onClick?.()
            n.close()
          }
        }
      } catch (err) {
        console.warn('[notifications] Notification constructor failed:', err)
      }
    },
    [enabled],
  )

  const swRegRef = options?.swRegRef
  /* eslint-disable react-hooks/preserve-manual-memoization -- swRegRef is a ref object; .current is read inside the callback at call time, not capture time */
  const notifyWithActions = useCallback(
    (payload: NotifyWithActionsPayload) => {
      if (!enabled) return
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return

      // Prefer Service Worker (supports action buttons).
      // Read .current inside the callback (not in deps) so the ref
      // is always fresh without triggering a useCallback rebuild.
      const sw = swRegRef?.current
      if (sw?.active) {
        sw.active.postMessage({
          type: 'SHOW_NOTIFICATION',
          title: payload.title,
          body: payload.body,
          tag: payload.tag,
          requireInteraction: payload.requireInteraction,
          silent: payload.silent,
          actions: payload.actions,
          data: payload.data,
        })
        return
      }

      // Fallback: SW unavailable — use plain Notification (no buttons).
      notify(payload)
    },
    [enabled, notify, swRegRef],
  )
  /* eslint-enable react-hooks/preserve-manual-memoization */

  return { enabled, permission, toggle, notify, notifyWithActions }
}

function currentPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotificationPermission
}
