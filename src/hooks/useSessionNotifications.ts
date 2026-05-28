// Session-aware desktop notification coordinator.
//
// Wraps `useNotifications` with the App-level orchestration layer:
//
//   1. Edge-detect when a session's `working` flag flips true→false and
//      fire a "turn complete" toast. Seeded by `seedWorkingState` when a
//      session-created frame lands so a session that spawns already
//      working doesn't fire on its first transition while the user is
//      still watching it.
//
//   2. Fire a "needs permission" toast (with requireInteraction) when a
//      cross-session `global-permission-request` lands for a session the
//      user isn't actively watching. Tagged `:perm` so it doesn't
//      collide with the same session's turn-complete toast.
//
// Both gates use the same visibility rule — `document.hasFocus() &&
// focusedId === sessionId` means the user is staring right at it, no
// desktop interruption needed. `hasFocus()` (rather than visibilityState)
// catches minimised / Alt-Tabbed / locked-screen cases that still report
// 'visible'.
//
// The hook reads `focusedIdRef`, `sessionsRef`, `handleSelectRef` via
// passed-in RefObjects so its callbacks stay referentially stable
// (the WS-hub effect that calls maybeNotify lists them as deps; if they
// flipped on every render the effect would tear down and rebuild every
// frame).

import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useNotifications, type UseNotifications } from './useNotifications'
import type { SessionInfo } from '../types'

export interface UseSessionNotificationsArgs {
  /** Currently-focused session id (or null). Read at notify time to
   *  decide whether the user is watching the session that produced the
   *  event. */
  focusedIdRef: RefObject<string | null>
  /** Latest sessions array. Used to look up a friendly title for the
   *  toast — falls back to id-prefix when the session hasn't appeared in
   *  the list yet (startup race). */
  sessionsRef: RefObject<SessionInfo[]>
  /** App-level select handler — invoked from the toast click. The full
   *  sidebar-card navigation logic (group switching, dormant resume,
   *  unread-dot clearing) lives there. */
  handleSelectRef: RefObject<(id: string) => void>
}

export interface UseSessionNotificationsResult {
  /** The underlying notifications hook — exposed so the bell button in
   *  the header can render its enable/disable / permission state. */
  notifications: UseNotifications
  /** Called from the WS `session-update` handler with the latest
   *  snapshot. Fires a toast iff working flipped true→false AND the
   *  user isn't actively watching that session. */
  maybeNotify: (s: SessionInfo) => void
  /** Called from the WS `global-permission-request` handler with the
   *  session id and a friendly tool label. Fires a requireInteraction
   *  toast iff the user isn't actively watching that session. */
  maybePermissionNotify: (sessionId: string, toolLabel: string) => void
  /** Seed the edge-detector when a `session-created` frame lands.
   *  Without this, a session that spawns already working would fire a
   *  notification on its first true→false transition — even when the
   *  user is still staring at the panel they just opened. */
  seedWorkingState: (sessionId: string, working: boolean) => void
  /** Drop the edge-detector entry when a session is removed. Long-lived
   *  tabs that watch many short sessions over hours otherwise grow this
   *  Map without bound — and a same-id reuse after deletion would carry
   *  stale "was working" state across the gap. */
  pruneSession: (sessionId: string) => void
}

export function useSessionNotifications({
  focusedIdRef,
  sessionsRef,
  handleSelectRef,
}: UseSessionNotificationsArgs): UseSessionNotificationsResult {
  const notifications = useNotifications()
  // Mirror notifications.notify into a ref so the maybe* callbacks
  // stay referentially stable. If they depended on `notifications.notify`
  // directly they'd rebuild every time the hook's internal state
  // (enabled / permission) flipped, which would tear down and rebuild
  // the WS-hub listener effect that lists them as deps.
  const notifyRef = useRef(notifications.notify)
  useEffect(() => {
    notifyRef.current = notifications.notify
  })

  /** Last-seen working flag per session. We notify when this flips from
   *  true to false (= a turn just completed). */
  const prevWorkingRef = useRef<Map<string, boolean>>(new Map())

  const maybePermissionNotify = useCallback(
    (sessionId: string, toolLabel: string) => {
      // Use hasFocus() rather than visibilityState: the tab can be "visible"
      // (foreground tab) while the browser window itself is minimized, behind
      // another app (Alt-Tab), or the screen is locked. In all those cases
      // hasFocus() correctly returns false, so we still fire the notification.
      const windowFocused = typeof document !== 'undefined' && document.hasFocus()
      const isFocused = focusedIdRef.current === sessionId
      if (windowFocused && isFocused) return

      // Look up a friendly title — fall back to id prefix when we haven't
      // seen the session in the list yet (unlikely but possible during
      // startup races).
      const sessionsNow = sessionsRef.current ?? []
      const session = sessionsNow.find((s) => s.id === sessionId)
      const title = session?.title ?? sessionId.slice(0, 8)

      notifyRef.current({
        title: `⚠ ${title} needs permission`,
        body: `Approve or deny: ${toolLabel}`,
        tag: `${sessionId}:perm`,
        // Permission notifications are actionable — the user must respond
        // for the turn to continue. Keep the toast visible until they
        // dismiss it, and DON'T mark it silent (Windows Action Center
        // suppresses silent toasts from this kind of "background" page).
        requireInteraction: true,
        onClick: () => {
          handleSelectRef.current?.(sessionId)
        },
      })
    },
    [focusedIdRef, sessionsRef, handleSelectRef],
  )

  const maybeNotify = useCallback(
    (s: SessionInfo) => {
      const prev = prevWorkingRef.current.get(s.id) ?? false
      prevWorkingRef.current.set(s.id, s.working)
      if (!(prev && !s.working)) return // only trigger on the falling edge

      const windowFocused = typeof document !== 'undefined' && document.hasFocus()
      const isFocused = focusedIdRef.current === s.id
      if (windowFocused && isFocused) return // user is watching it — no need

      const title = s.title ?? s.id.slice(0, 8)
      notifyRef.current({
        title: `✓ ${title}`,
        body: s.error ? `Errored: ${s.error}` : 'Turn complete',
        tag: s.id,
        // Status update — quiet to avoid sound spam when several
        // sessions complete back-to-back. Accepts the Windows-Action-
        // -Center-silent-suppression tradeoff because the user can
        // see completion state in the sidebar anyway.
        silent: true,
        onClick: () => {
          // Delegate to the full sidebar-card navigation logic so notification
          // clicks get the same behaviour: group switching, dormant resume,
          // and unread-dot clearing.
          handleSelectRef.current?.(s.id)
        },
      })
    },
    [focusedIdRef, handleSelectRef],
  )

  const seedWorkingState = useCallback((sessionId: string, working: boolean) => {
    prevWorkingRef.current.set(sessionId, working)
  }, [])

  const pruneSession = useCallback((sessionId: string) => {
    prevWorkingRef.current.delete(sessionId)
  }, [])

  return { notifications, maybeNotify, maybePermissionNotify, seedWorkingState, pruneSession }
}
