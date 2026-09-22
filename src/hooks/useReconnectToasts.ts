// Global reconnect toasts — the toast-hub replacement for the App-level
// "Reconnecting to server..." banner.
//
// Design (bounded change, 2026-09-22): connection status is a persistent
// state, but the product decision is to unify every notice onto the toast
// hub. Toast already supports sticky (`durationMs: 0`), so the banner is
// replaced by:
//
//   enter 'reconnecting'     → sticky info toast
//   reach 'online'           → dismiss sticky + success toast
//   anything else            → leave the sticky up (still offline)
//
// The leave arm keys on 'online' ONLY. A `reconnecting → connecting →
// online` retry sequence must not close the episode early: 'connecting'
// is still offline, so the sticky stays and "Reconnected" waits for the
// socket to actually come back.
//
// Two toast-hub realities are handled explicitly:
//
//   - Manual ✕ / action click calls `onDismiss`. Respect it: never re-push
//     this episode. Our own programmatic dismiss ALSO fires onDismiss —
//     a suppress flag keeps that from looking like a user opt-out.
//   - Capacity eviction (MAX_TOASTS = 3) never touches `durationMs: 0`
//     toasts (see ToastProvider). The sticky is not in that competition,
//     so there is no re-push path to maintain and a burst of offline
//     error toasts cannot erase the indicator (nor can recovery eat an
//     error).
//
// Mount via a bridge component (ReconnectToasts) that also owns the
// always-mounted sr-only live region — ToastHost inserts toast nodes with
// their text already present, which some SR/browser combos do not
// announce (see layout.css `.error-bar-empty`).

import { useEffect, useRef } from 'react'
import { useWsHubStatus } from './useWsHub'
import { useToast } from './useToast'

export const RECONNECT_TOAST_MESSAGE = 'Reconnecting to server...'
export const RECONNECTED_TOAST_MESSAGE = 'Reconnected'

export function useReconnectToasts(): void {
  const hubStatus = useWsHubStatus()
  const { show, dismiss } = useToast()

  const toastIdRef = useRef<string | null>(null)
  /** User hit ✕ / clicked the toast away. Distinct from capacity eviction
   *  (which cannot hit this toast). */
  const userDismissedRef = useRef(false)
  /** A disconnect episode is open. Gates "Reconnected" to one per episode
   *  and survives sticky loss to a user ✕. */
  const episodeActiveRef = useRef(false)
  /** Set around our own dismiss(id) so its onDismiss doesn't look like a
   *  user opt-out. (ToastProvider calls onDismiss synchronously today;
   *  a `reason` on dismiss/onDismiss would delete this flag.) */
  const suppressUserDismissRef = useRef(false)

  useEffect(() => {
    const handleDismissed = () => {
      if (!suppressUserDismissRef.current) {
        userDismissedRef.current = true
      }
      toastIdRef.current = null
    }

    const pushSticky = () => {
      toastIdRef.current = show('info', RECONNECT_TOAST_MESSAGE, {
        durationMs: 0,
        onDismiss: handleDismissed,
      })
    }

    const closeSticky = () => {
      const id = toastIdRef.current
      toastIdRef.current = null
      if (!id) return
      suppressUserDismissRef.current = true
      dismiss(id)
      suppressUserDismissRef.current = false
    }

    // LEAVE — only when the socket is actually back. A 'connecting' retry
    // hop keeps the episode (and the sticky) open.
    if (hubStatus === 'online' && episodeActiveRef.current) {
      episodeActiveRef.current = false
      userDismissedRef.current = false
      closeSticky()
      // Announce recovery even if the user had ✕'d the sticky.
      show('success', RECONNECTED_TOAST_MESSAGE)
      return
    }

    // ENTER — mount-during-reconnect included (prev is implicit in
    // episodeActiveRef).
    if (hubStatus === 'reconnecting' && !episodeActiveRef.current) {
      episodeActiveRef.current = true
      userDismissedRef.current = false
      pushSticky()
    }
  }, [hubStatus, show, dismiss])

  // Unmount while offline must not orphan a durationMs:0 sticky (Fast
  // Refresh of App, error-boundary remount, …). The next mount re-arms.
  useEffect(() => {
    return () => {
      const id = toastIdRef.current
      if (!id) return
      suppressUserDismissRef.current = true
      dismiss(id)
      suppressUserDismissRef.current = false
    }
  }, [dismiss])
}
