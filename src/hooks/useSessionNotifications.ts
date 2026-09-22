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

/** OS-notification tag for a session's permission/question toast.
 *  Single owner of the `:perm` tag format — the show sites and the close
 *  sites must agree, and a hand-copied literal at each is how they
 *  silently drift. (Turn-complete and CLI tags are different formats and
 *  are built at their own call sites.) */
function permTag(sessionId: string): string {
  return `${sessionId}:perm`
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
  const closeByTagRef = useRef(notifications.closeByTag)
  useEffect(() => {
    notifyRef.current = notifications.notify
    notifyWithActionsRef.current = notifications.notifyWithActions
    closeByTagRef.current = notifications.closeByTag
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

  /** Live permission/question surfaces per session. One entry per
   *  session, whatever mix of surfaces is up: `toastId` when a sticky
   *  in-app toast is showing (toast presentation), `osShown` when a
   *  desktop OS notification was actually displayed (desktop
   *  presentation, gated on notify()'s boolean so a no-op call —
   *  notifications disabled / permission revoked — does not arm the
   *  close path). Collapsed into one map so there is a single entry to
   *  delete and no cross-map invariant to keep in sync. */
  const permLiveRef = useRef<Map<string, { toastId?: string; osShown?: boolean }>>(new Map())

  /** Tear down whatever permission/question surface this session has up
   *  (sticky in-app toast and/or OS notification) and clear its live
   *  record. Single owner of the teardown sequence so the toast branch,
   *  the desktop branch, and dismissPermissionToast can't drift apart on
   *  which half they clean. */
  const tearDownPermSurface = useCallback((sessionId: string) => {
    const live = permLiveRef.current.get(sessionId)
    if (!live) return
    permLiveRef.current.delete(sessionId)
    if (live.toastId) toastRef.current.dismiss(live.toastId)
    if (live.osShown) void closeByTagRef.current?.(permTag(sessionId))
  }, [])

  const maybePermissionNotify = useCallback(
    (sessionId: string, toolLabel: string, kind: 'permission' | 'question' = 'permission', permissionId?: string, toolInput?: Record<string, unknown>) => {
      // Use hasFocus() rather than visibilityState: the tab can be "visible"
      // (foreground tab) while the browser window itself is minimized, behind
      // another app (Alt-Tab), or the screen is locked. In all those cases
      // hasFocus() correctly returns false, so we still fire the notification.
      const windowFocused = typeof document !== 'undefined' && document.hasFocus()
      const isFocused = focusedIdRef.current === sessionId
      const mode = presentation(windowFocused, isFocused)

      // Tear down STALE surfaces before deciding what to show. Two rules:
      //   1. The OTHER surface's leftover is always stale (its Allow/Deny
      //      buttons target a superseded permissionId) and nothing we show
      //      next will replace it — cross-surface, so OS tag-coalescing
      //      does not apply. Always tear it down.
      //   2. The SAME surface's leftover is replaced by tag-coalescing (OS)
      //      or by the explicit dismiss below (toast). Do NOT also call
      //      closeByTag for it: that is an async close racing an immediate
      //      same-tag re-show, and closeByTag's epoch guard would (correctly)
      //      refuse to close anything — leaving the stale toast in place on
      //      platforms where coalescing is not instant.
      const prior = permLiveRef.current.get(sessionId)
      if (mode !== 'toast' && prior?.toastId) toastRef.current.dismiss(prior.toastId)
      if (mode !== 'desktop' && prior?.osShown) void closeByTagRef.current?.(permTag(sessionId))
      // Clear the record — the branches below write a fresh entry (or none).
      if (prior) permLiveRef.current.delete(sessionId)

      if (mode === 'skip') {
        // User is staring right at the session — the in-app permission card
        // is the surface. Leftovers are stale (rule 1 above already tore
        // down the other surface; same-surface leftovers can't exist here
        // because skip means we never showed one this turn).
        return
      }

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

        // Structured toast: the headline is the title, the actionable
        // detail the muted body. (Toast title omits the ⚠/❓ emoji the
        // desktop fallback keeps — the in-app kind icon already signals it.)
        const toastTitle = isQuestion
          ? `${title} is asking a question`
          : `${title} needs permission`
        const toastId = toastRef.current.info(isQuestion ? 'Open to answer' : `Approve or deny: ${toolLabel}`, {
          title: toastTitle,
          durationMs: 0,
          actionLabel: isQuestion ? 'Answer' : 'Open',
          onClick: () => handleSelectRef.current?.(sessionId),
        })
        permLiveRef.current.set(sessionId, { toastId })
        return
      }

      // mode === 'desktop' — window not focused, fall back to the OS toast.
      // Permission requests with an id get Allow/Deny action buttons via
      // the Service Worker; questions and legacy requests without an id
      // fall back to a plain notification that opens the page on click.
      // Only record osShown when notify reported a show was requested —
      // the master switch may be off or the browser permission revoked,
      // and arming the close path then would be a wasted IPC. (For the SW
      // path "requested" is the strongest signal available without an ack.)
      const shown = !isQuestion && permissionId
        ? notifyWithActionsRef.current({
            title: headline,
            body: `Approve or deny: ${toolLabel}`,
            tag: permTag(sessionId),
            requireInteraction: true,
            actions: [
              { action: 'allow', title: '✓ Allow' },
              { action: 'deny', title: '✗ Deny' },
            ],
            data: { sessionId, permissionId, kind: 'permission', updatedInput: toolInput },
            onClick: () => { handleSelectRef.current?.(sessionId) },
          })
        : notifyRef.current({
            title: headline,
            body: isQuestion ? 'Open to answer' : `Approve or deny: ${toolLabel}`,
            tag: permTag(sessionId),
            requireInteraction: true,
            onClick: () => { handleSelectRef.current?.(sessionId) },
          })
      if (shown) {
        // Fresh entry — the cross-surface teardown above already cleared
        // whatever was live, so only the OS surface is up now.
        permLiveRef.current.set(sessionId, { osShown: true })
      }
      // When !shown nothing is live; the teardown above already deleted
      // the old entry, so there is deliberately nothing to write.
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
        toastRef.current.info(n.text, {
          title,
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
          toastRef.current.error(s.error, { title, onClick })
        } else {
          toastRef.current.info('Turn complete', { title, onClick })
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

  const dismissPermissionToast = useCallback((sessionId: string) => {
    // Tears down both halves (sticky toast + OS notification) when a
    // permission/question surface is live. The `if (!live) return` inside
    // tearDownPermSurface is what keeps the count-0 `session-update` hot
    // path cheap: sessions with no perm activity pay only a Map lookup,
    // never a getNotifications IPC.
    //
    // Known limitation (deliberate tradeoff): after a tab reload the
    // in-memory live record is gone, so an SW notification shown before
    // the reload is not programmatically closed here. It still dismisses
    // on click (the SW closes it in notificationclick) or on a manual
    // close; closing it unconditionally would reintroduce the hot-path
    // IPC on every idle session-update.
    tearDownPermSurface(sessionId)
  }, [tearDownPermSurface])

  const pruneSession = useCallback((sessionId: string) => {
    prevWorkingRef.current.delete(sessionId)
    // A deleted session must not leave a lingering sticky toast or
    // `requireInteraction` OS toast behind.
    tearDownPermSurface(sessionId)
  }, [tearDownPermSurface])

  return { notifications, maybeNotify, maybePermissionNotify, maybeCliNotify, seedWorkingState, pruneSession, dismissPermissionToast }
}
