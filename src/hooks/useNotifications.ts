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
import { useLocalStorage } from './useLocalStorage'

const ENABLED_KEY = 'claude-react-web:notifications-enabled'

export type NotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface NotifyPayload {
  title: string
  body?: string
  /** Coalesce key — repeated notifications with the same tag replace the
   *  previous one instead of stacking. Usually pass the session id. */
  tag?: string
  /** Called if the user clicks the notification. Typical use: focus the
   *  window + navigate to the session that produced the event. */
  onClick?: () => void
}

export interface UseNotifications {
  enabled: boolean
  permission: NotificationPermission
  /** User-facing: flip the master switch. Requests permission on first
   *  enable. Silently ignored on unsupported browsers. */
  toggle: (next?: boolean) => Promise<void>
  /** Fire a notification iff enabled + permission granted. */
  notify: (payload: NotifyPayload) => void
}

export function useNotifications(): UseNotifications {
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
          // Replace the tag-matching notification silently — without this,
          // the browser re-plays the system sound for every update which
          // is obnoxious when a session fires multiple results in a row.
          silent: true,
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

  return { enabled, permission, toggle, notify }
}

function currentPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotificationPermission
}
