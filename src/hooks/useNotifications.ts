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

import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** Fire a notification iff enabled + permission granted.
   *  Returns true when a notification was actually displayed, false when
   *  the call short-circuited (disabled / permission not granted) — so
   *  callers can track live notifications without duplicating the gates. */
  notify: (payload: NotifyPayload) => boolean
  /** Fire a notification via Service Worker (supports action buttons).
   *  Falls back to plain notify() when SW is unavailable or postMessage
   *  throws. Same boolean contract as `notify`. */
  notifyWithActions: (payload: NotifyWithActionsPayload) => boolean
  /** Programmatically dismiss every live notification carrying `tag`.
   *  Used when a permission/question is resolved so the lingering
   *  `requireInteraction` OS toast goes away instead of sitting in the
   *  notification centre. SW-shown notifications are looked up via
   *  `registration.getNotifications({ tag })` (shared across tabs of the
   *  same origin); plain `new Notification()` fallbacks are closed from a
   *  per-hook tag map. Never throws — unknown tags / already-closed
   *  notifications are no-ops. */
  closeByTag: (tag: string) => Promise<void>
}

export interface UseNotificationsOptions {
  /** Live ref to the ServiceWorkerRegistration, set by App.tsx after
   *  registerSW() resolves. Null when SW is unavailable. */
  swRegRef?: RefObject<ServiceWorkerRegistration | null>
}

export function useNotifications(options?: UseNotificationsOptions): UseNotifications {
  const [enabled, setEnabled] = useLocalStorage<boolean>(ENABLED_KEY, false)
  const [permission, setPermission] = useState<NotificationPermission>(() => currentPermission())

  // Live plain (`new Notification()`) instances keyed by tag, so
  // closeByTag() can dismiss them later. Only the fallback path needs
  // this — SW-shown notifications are discovered via
  // registration.getNotifications(), which cannot see plain ones.
  // Untagged notifications are never inserted (nothing to look up by).
  const plainByTagRef = useRef<Map<string, Notification>>(new Map())

  // Monotonic per-tag generation for SW-shown notifications, bumped every
  // time a show is requested under that tag via the SW path. closeByTag()
  // captures the generation before its async `getNotifications` await and
  // aborts the SW closes if it moved — otherwise a notification that
  // reused the tag mid-flight would be dismissed along with the one the
  // caller actually wanted gone. Only the SW path bumps it: a plain
  // fallback show is a different surface and must not poison an in-flight
  // SW close (the plain close uses an identity check instead).
  const tagEpochRef = useRef<Map<string, number>>(new Map())
  const bumpTagEpoch = (tag: string) => {
    tagEpochRef.current.set(tag, (tagEpochRef.current.get(tag) ?? 0) + 1)
  }

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
      // Fire a test notification so the user immediately sees that it works
      // (and can verify OS-level settings like sound / Action Center).
      try {
        new Notification('Notifications enabled', {
          body: 'You will be notified when turns complete and permissions are requested.',
          tag: 'crw-test-notification',
          silent: false,
        })
      } catch { /* constructor failure is non-fatal — the flag is already set */ }
    },
    [enabled, setEnabled],
  )

  const notify = useCallback(
    (payload: NotifyPayload): boolean => {
      if (!enabled) return false
      if (typeof Notification === 'undefined') return false
      if (Notification.permission !== 'granted') return false
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
        // Track tagged instances so closeByTag() can dismiss them later.
        // (No epoch bump here — the plain surface uses an identity check
        // in closeByTag, and bumping would poison an in-flight SW close.)
        if (payload.tag) {
          const tag = payload.tag
          // Same tag reused: close the previous instance before it becomes
          // unreachable. Not all platforms coalesce tag-replaced toasts
          // instantly, and a dropped reference can never be closed later.
          const prev = plainByTagRef.current.get(tag)
          if (prev && prev !== n) {
            try { prev.close() } catch { /* already gone */ }
          }
          plainByTagRef.current.set(tag, n)
          // Evict when the notification dies on its own (user dismiss /
          // auto-hide) so the map doesn't accumulate dead references over
          // a long-lived session.
          n.onclose = () => {
            if (plainByTagRef.current.get(tag) === n) plainByTagRef.current.delete(tag)
          }
        }
        if (payload.onClick) {
          n.onclick = () => {
            window.focus()
            payload.onClick?.()
            n.close()
          }
        }
        return true
      } catch (err) {
        console.warn('[notifications] Notification constructor failed:', err)
        return false
      }
    },
    [enabled],
  )

  const swRegRef = options?.swRegRef

  /** Fetch every SW-shown notification carrying `tag` and close each.
   *  One bad (detached / already-collected) Notification must not skip
   *  closing the rest. No epoch guard — callers that need one wrap this. */
  const fetchAndCloseSwByTag = useCallback(async (tag: string) => {
    try {
      const sw = swRegRef?.current
      if (!sw?.getNotifications) return
      const live = await sw.getNotifications({ tag })
      for (const n of live) {
        try { n.close() } catch { /* keep going */ }
      }
    } catch (err) {
      console.warn('[notifications] getNotifications/close failed:', err)
    }
  }, [swRegRef])

  /** Close every SW-shown notification carrying `tag`, unconditionally.
   *  Used by the SW→plain fallback, which must clear a stale SW toast
   *  even though it is about to show a plain one under the same tag. */
  const closeSwByTag = fetchAndCloseSwByTag

  const notifyWithActions = useCallback(
    (payload: NotifyWithActionsPayload): boolean => {
      if (!enabled) return false
      if (typeof Notification === 'undefined') return false
      if (Notification.permission !== 'granted') return false

      // Prefer Service Worker (supports action buttons).
      // Read .current inside the callback (not in deps) so the ref
      // is always fresh without triggering a useCallback rebuild.
      const sw = swRegRef?.current
      if (sw?.active) {
        try {
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
          if (payload.tag) {
            // The show is requested under this tag — bump the epoch so an
            // in-flight closeByTag won't dismiss this new one.
            bumpTagEpoch(payload.tag)
            // Close a prior plain fallback under the same tag. Different
            // surface, so OS tag-coalescing will NOT replace it — without
            // this both toasts show side by side.
            const prevPlain = plainByTagRef.current.get(payload.tag)
            if (prevPlain) {
              plainByTagRef.current.delete(payload.tag)
              try { prevPlain.close() } catch { /* already gone */ }
            }
          }
          return true
        } catch (err) {
          // SW transitioning to redundant (update cycle) throws
          // InvalidStateError. Fall through to the plain path so the
          // alert is not lost — but first tear down any prior SW toast
          // under this tag (different surface from the plain one we're
          // about to show, so OS tag-coalescing will NOT replace it).
          console.warn('[notifications] SW postMessage failed, falling back:', err)
          if (payload.tag) void closeSwByTag(payload.tag)
        }
      }

      // Fallback: SW unavailable — use plain Notification (no buttons).
      return notify(payload)
    },
    [enabled, notify, swRegRef, closeSwByTag],
  )

  const closeByTag = useCallback(async (tag: string) => {
    const epoch = tagEpochRef.current.get(tag) ?? 0
    // Capture the plain instance up front (sync) so an await below can't
    // race it against a replacement.
    const plainAtStart = plainByTagRef.current.get(tag)
    // SW-shown notifications: shared registration, so this also finds
    // ones displayed by other tabs of the same origin.
    try {
      const sw = swRegRef?.current
      if (sw?.getNotifications) {
        const live = await sw.getNotifications({ tag })
        // A new SW notification reused this tag while we were awaiting —
        // the `live` list now includes it and it belongs to a newer
        // request. Skip the SW closes, but still close the plain instance
        // captured below (a notify() replacement would already have
        // closed it).
        if ((tagEpochRef.current.get(tag) ?? 0) === epoch) {
          for (const n of live) {
            try { n.close() } catch { /* keep going */ }
          }
        }
      }
    } catch (err) {
      console.warn('[notifications] getNotifications/close failed:', err)
    }
    // Plain fallback instance captured at start. Identity check (not
    // epoch) — a replacement would already have closed this one in
    // notify(), so only close if it is still the live entry.
    try {
      if (plainAtStart && plainByTagRef.current.get(tag) === plainAtStart) {
        plainByTagRef.current.delete(tag)
        plainAtStart.close()
      }
    } catch (err) {
      console.warn('[notifications] plain close failed:', err)
    }
  }, [swRegRef])

  return { enabled, permission, toggle, notify, notifyWithActions, closeByTag }
}

function currentPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotificationPermission
}
