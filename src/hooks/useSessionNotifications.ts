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
// Both gates use the same THREE-state visibility rule (see `presentation`):
//   - 'skip'    → window focused AND this session is the one on screen.
//                 The user is staring right at it; no interruption at all.
//   - 'toast'   → window focused but the user is looking at a DIFFERENT
//                 session. They're in the page, so an in-app toast is the
//                 right weight — lighter than an OS toast and guaranteed
//                 visible (Windows Action Center can silently drop desktop
//                 notifications from a backgrounded-feeling page). Toasts
//                 do NOT require browser permission and are independent of
//                 the desktop-notification master switch.
//   - 'desktop' → window not focused (minimised / Alt-Tabbed / locked).
//                 A toast wouldn't be seen, so fall back to the OS
//                 notification (still gated by enable + permission).
// `hasFocus()` (rather than visibilityState) catches minimised /
// Alt-Tabbed / locked-screen cases that still report 'visible'.
//
// The hook reads `focusedIdRef`, `sessionsRef`, `handleSelectRef` via
// passed-in RefObjects so its callbacks stay referentially stable
// (the WS-hub effect that calls maybeNotify lists them as deps; if they
// flipped on every render the effect would tear down and rebuild every
// frame).

import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useNotifications, type UseNotifications } from './useNotifications'
import { useToast } from './useToast'
import type { SessionInfo } from '../types'
import type { CliNotification } from '../ws-types.js'

/** How to surface an event, given window focus + which session is on
 *  screen. See the file header for the rationale behind each state. */
type Presentation = 'skip' | 'toast' | 'desktop'
function presentation(windowFocused: boolean, isFocusedSession: boolean): Presentation {
  if (windowFocused && isFocusedSession) return 'skip'
  if (windowFocused) return 'toast'
  return 'desktop'
}

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
  /** Live ref to the ServiceWorkerRegistration. Set by App.tsx after
   *  registerSW() resolves. Null when SW is unavailable. */
  swRegRef?: RefObject<ServiceWorkerRegistration | null>
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
   *  session id, a friendly tool label, and the request kind. Fires a
   *  requireInteraction toast iff the user isn't actively watching that
   *  session. `kind` defaults to 'permission'; 'question' switches the
   *  copy to question wording (AskUserQuestion isn't a permission grant). */
  maybePermissionNotify: (
    sessionId: string,
    toolLabel: string,
    kind?: 'permission' | 'question',
    /** Permission request id — passed through to the SW so it can call
     *  the decide API directly from a notification action button. */
    permissionId?: string,
    /** Original tool input — echoed back as `updatedInput` when the SW
     *  calls the decide API.  The SDK requires it on allow paths. */
    toolInput?: Record<string, unknown>,
  ) => void
  /** Called from the WS `cli-notification` handler (SDK `system/notification`
   *  frames mirrored onto the global channel). Fires a transient toast /
   *  desktop notification iff the user isn't actively watching that session.
   *  Unlike the permission toast it is NOT sticky — these are FYI nudges
   *  ("waiting for your input", idle reminders), not blocking requests, so
   *  the CLI-suggested timeout (or a short default) applies. */
  maybeCliNotify: (sessionId: string, notification: CliNotification) => void
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
  /** Dismiss the sticky permission/question toast for a session (if any).
   *  Called when `pendingPermissionCount` drops to 0 on a session-update. */
  dismissPermissionToast: (sessionId: string) => void
}

export function useSessionNotifications({
  focusedIdRef,
  sessionsRef,
  handleSelectRef,
  swRegRef,
}: UseSessionNotificationsArgs): UseSessionNotificationsResult {
  const notifications = useNotifications({ swRegRef })
  // Mirror notifications.notify into a ref so the maybe* callbacks
  // stay referentially stable. If they depended on `notifications.notify`
  // directly they'd rebuild every time the hook's internal state
  // (enabled / permission) flipped, which would tear down and rebuild
  // the WS-hub listener effect that lists them as deps.
  const notifyRef = useRef(notifications.notify)
  const notifyWithActionsRef = useRef(notifications.notifyWithActions)
  useEffect(() => {
    notifyRef.current = notifications.notify
    notifyWithActionsRef.current = notifications.notifyWithActions
  })

  // Same ref-mirror trick for the toast hub. `useToast()` is already
  // referentially stable (memoised), but mirroring keeps the pattern
  // uniform and decouples the maybe* callbacks from it entirely.
  const toast = useToast()
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  })

  /** Last-seen working flag per session. We notify when this flips from
   *  true to false (= a turn just completed). */
  const prevWorkingRef = useRef<Map<string, boolean>>(new Map())

  /** Sticky toast IDs keyed by session. Used to auto-dismiss permission/
   *  question toasts once the pending count drops to 0. */
  const permToastIdsRef = useRef<Map<string, string>>(new Map())

  const maybePermissionNotify = useCallback(
    (sessionId: string, toolLabel: string, kind: 'permission' | 'question' = 'permission', permissionId?: string, toolInput?: Record<string, unknown>) => {
      // Use hasFocus() rather than visibilityState: the tab can be "visible"
      // (foreground tab) while the browser window itself is minimized, behind
      // another app (Alt-Tab), or the screen is locked. In all those cases
      // hasFocus() correctly returns false, so we still fire the notification.
      const windowFocused = typeof document !== 'undefined' && document.hasFocus()
      const isFocused = focusedIdRef.current === sessionId
      const mode = presentation(windowFocused, isFocused)
      if (mode === 'skip') return

      // Look up a friendly title — fall back to id prefix when we haven't
      // seen the session in the list yet (unlikely but possible during
      // startup races).
      const sessionsNow = sessionsRef.current ?? []
      const session = sessionsNow.find((s) => s.id === sessionId)
      const title = session?.title ?? sessionId.slice(0, 8)

      // AskUserQuestion is surfaced through this same blocking-request path,
      // but it isn't a permission grant — it's a question awaiting an answer.
      // Word it accordingly so the toast/desktop notification doesn't say
      // "needs permission" / "Approve or deny" for what is really a question.
      const isQuestion = kind === 'question'
      const headline = isQuestion
        ? `❓ ${title} is asking a question`
        : `⚠ ${title} needs permission`

      if (mode === 'toast') {
        // User is in the page, just on another session. A sticky toast
        // (durationMs:0) stays until they act — both permission requests
        // and questions block the turn until answered. Independent of the
        // desktop-notification master switch / browser permission.
        // Dismiss any existing sticky toast for this session before creating
        // a new one. Without this, the old toast ID is silently overwritten
        // in permToastIdsRef and can never be dismissed.
        const existingId = permToastIdsRef.current.get(sessionId)
        if (existingId) toastRef.current.dismiss(existingId)

        const toastId = toastRef.current.info(headline, {
          durationMs: 0,
          actionLabel: isQuestion ? 'Answer' : 'Open',
          onClick: () => handleSelectRef.current?.(sessionId),
        })
        permToastIdsRef.current.set(sessionId, toastId)
        return
      }

      // mode === 'desktop' — window not focused, fall back to the OS toast.
      // Permission requests with an id get Allow/Deny action buttons via
      // the Service Worker; questions and legacy requests without an id
      // fall back to a plain notification that opens the page on click.
      if (!isQuestion && permissionId) {
        notifyWithActionsRef.current({
          title: headline,
          body: `Approve or deny: ${toolLabel}`,
          tag: `${sessionId}:perm`,
          requireInteraction: true,
          actions: [
            { action: 'allow', title: '✓ Allow' },
            { action: 'deny', title: '✗ Deny' },
          ],
          data: { sessionId, permissionId, kind: 'permission', updatedInput: toolInput },
          onClick: () => { handleSelectRef.current?.(sessionId) },
        })
      } else {
        notifyRef.current({
          title: headline,
          body: isQuestion ? 'Open to answer' : `Approve or deny: ${toolLabel}`,
          tag: `${sessionId}:perm`,
          requireInteraction: true,
          onClick: () => { handleSelectRef.current?.(sessionId) },
        })
      }
    },
    [focusedIdRef, sessionsRef, handleSelectRef],
  )

  const maybeCliNotify = useCallback(
    (sessionId: string, n: CliNotification) => {
      const windowFocused = typeof document !== 'undefined' && document.hasFocus()
      const isFocused = focusedIdRef.current === sessionId
      const mode = presentation(windowFocused, isFocused)
      if (mode === 'skip') return

      const sessionsNow = sessionsRef.current ?? []
      const session = sessionsNow.find((s) => s.id === sessionId)
      const title = session?.title ?? sessionId.slice(0, 8)

      // The CLI suggests an on-screen duration; clamp to something sane.
      // 8s default matches the informational toasts elsewhere in the app.
      const durationMs = n.timeoutMs != null ? Math.min(Math.max(n.timeoutMs, 2000), 30_000) : 8000
      // low/medium nudges are status updates, not action requests — quiet
      // on the desktop path (silent) per the same tradeoff maybeNotify makes
      // for "turn complete".
      const quiet = n.priority === 'low' || n.priority === 'medium'

      if (mode === 'toast') {
        toastRef.current.info(`🔔 ${title} · ${n.text}`, {
          durationMs,
          onClick: () => { handleSelectRef.current?.(sessionId) },
        })
        return
      }

      notifyRef.current({
        title: `🔔 ${title}`,
        body: n.text,
        // Dedup key: same key → the OS replaces the prior toast instead of
        // stacking repeats ("still waiting for input" every minute).
        tag: `${sessionId}:cli${n.key ? `:${n.key}` : ''}`,
        silent: quiet,
        onClick: () => { handleSelectRef.current?.(sessionId) },
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
      const mode = presentation(windowFocused, isFocused)
      if (mode === 'skip') return // user is watching it — no need

      const title = s.title ?? s.id.slice(0, 8)

      if (mode === 'toast') {
        // User is in the page, just on another session — an in-app toast is
        // the right weight. Click jumps to the session (same handler as the
        // desktop notification below).
        const onClick = () => handleSelectRef.current?.(s.id)
        if (s.error) {
          toastRef.current.error(`✗ ${title} · ${s.error}`, { onClick })
        } else {
          toastRef.current.info(`✓ ${title} · Turn complete`, { onClick })
        }
        return
      }

      // mode === 'desktop' — window not focused, fall back to the OS toast.
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
    permToastIdsRef.current.delete(sessionId)
  }, [])

  const dismissPermissionToast = useCallback((sessionId: string) => {
    const toastId = permToastIdsRef.current.get(sessionId)
    if (toastId) {
      permToastIdsRef.current.delete(sessionId)
      toastRef.current.dismiss(toastId)
    }
  }, [])

  return { notifications, maybeNotify, maybePermissionNotify, maybeCliNotify, seedWorkingState, pruneSession, dismissPermissionToast }
}
