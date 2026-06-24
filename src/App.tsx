// Top-level layout: left sidebar (sessions), center pane with up to 3
// Chat panels side-by-side. Session Settings now renders as a per-panel
// overlay (inside ChatPanel) rather than a right drawer — see below.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { api } from './hooks/useApi'
import { isInAppDrag, readDragPayload } from './hooks/useDragPayload'
import { useIsMobile } from './hooks/useIsMobile'
import { useSwipeToClose } from './hooks/useSwipeToClose'
import { useVisualViewportHeight } from './hooks/useVisualViewportHeight'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useComposerSnippets } from './hooks/useComposerSnippets'
import { usePanelColumnResize } from './hooks/usePanelColumnResize'
import { useSidebarResize } from './hooks/useSidebarResize'
import { useSessionNotifications } from './hooks/useSessionNotifications'
import { useSessionUrl } from './hooks/useSessionUrl'
import { registerSW } from './sw-register'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useWsHub, useWsHubStatus } from './hooks/useWsHub'
import type { WsServerFrame } from './ws-types'
import type { MessageSearchHit } from '../shared/search-results'
import type { MessageJumpTarget } from '../shared/message-jump'
import type { NewSessionForm, PermissionMode, SessionInfo, SessionGroup, SidebarSection } from './types'
import { PERMISSION_MODE_CYCLE } from './types'
import { ACCENT_COLORS } from './theme'
import { AppearancePanel } from './components/AppearancePanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { IconSettings, IconBellToggle, IconMenu } from './components/icons/ToolIcons'
import { UpdateBanner } from './components/UpdateBanner'
import { useUpdateInfo } from './hooks/useUpdateInfo'
import { useUiState } from './hooks/useUiState'
import { sessionStoreRegistry } from './session-store/registry'
import { useAppOverlays } from './app/useAppOverlays'
import { useExitPresence, usePresenceValue } from './hooks/useExitPresence'

// Lazy-load heavy modal/overlay components that are only shown on demand.
// This keeps the initial bundle lean — the user pays the download cost
// only when they actually open the palette, settings, or help modal.
//
// SetupPage is also lazy: only first-time / unconfigured users hit it,
// and it pulls in ~1150 lines of UI that returning users never see.
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const InputHistoryPanel = lazy(() => import('./components/InputHistoryPanel').then((m) => ({ default: m.InputHistoryPanel })))
const ResumeSessionDialog = lazy(() => import('./components/session-list/ResumeSessionDialog').then((m) => ({ default: m.ResumeSessionDialog })))
const ShortcutHelp = lazy(() => import('./components/ShortcutHelp').then((m) => ({ default: m.ShortcutHelp })))
const GlobalSettingsModal = lazy(() => import('./components/GlobalSettingsModal').then((m) => ({ default: m.GlobalSettingsModal })))
const SetupPage = lazy(() => import('./components/SetupPage').then((m) => ({ default: m.SetupPage })))
const SnippetsManagerDialog = lazy(() => import('./components/SnippetsManagerDialog').then((m) => ({ default: m.SnippetsManagerDialog })))
const PromptDialog = lazy(() => import('./components/PromptDialog').then((m) => ({ default: m.PromptDialog })))

import {
  SIDEBAR_MIN_KEY,
  SIDEBAR_MAX_KEY,
  SIDEBAR_MIN_DEFAULT,
  SIDEBAR_MAX_DEFAULT,
  PANEL_MIN_RATIO_KEY,
  PANEL_MIN_RATIO_DEFAULT,
  LAST_SEEN_TURN_KEY,
  clampMaxOpen,
} from './constants/storageKeys'
import type { Defaults, ConfigResponse } from './types/config'
import { notificationTooltip } from './utils/notifications'
import { computeUnread, bumpLastSeen, pruneLastSeen } from './utils/unread'
import { randomId } from './utils/uuid'

/** Shallow-compare two SessionInfo objects across every own property.
 *
 * The server broadcasts a `session-update` frame for *every* SDK message in
 * any session (metadata churn: lastTurnAt, pendingPermissionCount, working,
 * messageCount, …). Without this guard, each frame produces a brand-new
 * `sessions` array → `orderedSessions` memo rebuilds → `sidebarSections`
 * rebuilds → the memo'd `<SessionList>` receives a new `sessions` prop and
 * re-renders every `<SessionCard>`. With 3 panels streaming that's 3 full
 * sidebar re-renders per token burst, even when the metadata is byte-for-byte
 * identical to the previous broadcast (the server re-broadcasts the same
 * SessionInfo on many frames).
 *
 * Bailing here (returning the previous array) keeps `sessions` referentially
 * stable so the sidebar memo holds. The post-setSessions side-effects below
 * (lastSeenTurn bump, maybeNotify, dismissPermissionToast) still run on every
 * frame because they read `frame.session` directly, not the state array — so
 * notifications and unread flags are unaffected.
 *
 * Arrays (betas, effortLevels, recap.toolsUsed) are compared by reference.
 * The server constructs a fresh array only when the underlying value changes,
 * so a shared reference means the value is unchanged; when it does change the
 * new reference correctly triggers an update. */
function sessionMetaEqual(a: SessionInfo, b: SessionInfo): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (a[k as keyof SessionInfo] !== b[k as keyof SessionInfo]) return false
  }
  return true
}

export function App() {
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  // False until the first sessions-snapshot frame arrives over WS. Drives a
  // sidebar skeleton so "No sessions yet" doesn't flash before the list loads.
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  /** Becomes true the moment the first sessions-snapshot frame is observed.
   *  Used inside the WS listener (which closes over state once on mount) to
   *  branch on "this is the first snapshot" without re-registering the
   *  listener every time `sessionsLoaded` flips. */
  const firstSnapshotSeenRef = useRef(false)
  /** Sessions queued for deletion but still within the Undo grace window.
   *  Hidden from the sidebar optimistically; the real delete fires when the
   *  timer lapses (or is cancelled by Undo). */
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(new Set())
  /** Ordered list of open session ids (oldest first). Length <= maxOpen. */
  const [openIds, setOpenIds] = useState<string[]>([])
  /** Side Chat drawer state. Only one Side Chat can be open at a time.
   *  Stores the full SessionInfo from the POST response so the drawer
   *  can mount immediately without waiting for the WS session-created
   *  frame to update the sessions array. `collapsed` tracks whether
   *  the drawer is hidden (session stays alive). `initialMessageCount`
   *  snapshots messageCount at collapse time for unread badge tracking. */
  const [sideChat, setSideChat] = useState<{
    parentId: string
    session: SessionInfo
    collapsed: boolean
    initialMessageCount: number
  } | null>(null)
  const sideChatRef = useRef(sideChat)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref sync; async close/create callbacks read this ref so they don't capture a stale `sideChat` (useEffect would lag by one render)
  sideChatRef.current = sideChat
  /** Panels currently playing their exit animation. Each entry holds a
   *  snapshot of the SessionInfo at the moment the panel was removed so
   *  the closing ChatPanel can finish rendering + fading out. */
  const [closingPanels, setClosingPanels] = useState<{ id: string; session: SessionInfo; rect: DOMRect }[]>([])
  const prevOpenIdsRef = useRef<string[]>([])
  /** Which of the open panels is currently focused (controls settings
   *  panel target + clears unread when selected). */
  const [focusedId, setFocusedId] = useState<string | null>(null)
  /** Mobile drawer (sidebar) open state. Desktop ignores this — the sidebar
   *  is always a static grid column there. */
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** Per-session "last turn seen by the user" timestamp. A session is
   *  unread when `lastTurnAt > lastSeenTurn[id]` AND it isn't the
   *  currently-focused panel in a focused window. Opening, focusing, or
   *  receiving a turn while focused+visible bumps the seen timestamp.
   *  Persisted so a reload doesn't flag every previously-answered
   *  session as unread. */
  const [lastSeenTurn, setLastSeenTurn] = useLocalStorage<Record<string, number>>(
    LAST_SEEN_TURN_KEY,
    {},
  )
  const [defaults, setDefaults] = useState<Defaults>({})
  const [serverModels, setServerModels] = useState<string[]>([])
  const {
    settingsOpenFor,
    setSettingsOpenFor,
    settingsTabRequest,
    gitPanelOpenFor,
    setGitPanelOpenFor,
    helpOpen,
    setHelpOpen,
    helpCommands,
    handleCloseSettings,
    handleOpenSettings,
    handleCloseGitPanel,
    handleOpenGitPanel,
    openSettingsTab,
    showHelpWithCommands,
    toggleShortcutHelp,
  } = useAppOverlays()
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false)
  const newSessionDialogOpenRef = useRef(newSessionDialogOpen)
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
  const resumeDialogOpenRef = useRef(resumeDialogOpen)
  // When set, the resume picker was opened from a panel's `/resume` local
  // command: the chosen session should REPLACE this panel's slot rather than
  // open in a new panel. Null = the global (Mod+Shift+O) resume flow.
  const [resumeTargetPanelId, setResumeTargetPanelId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false)
  const [messageJumpTarget, setMessageJumpTarget] = useState<MessageJumpTarget | null>(null)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  // Operational errors and one-shot notifications go through the global
  // toast hub (mounted in main.tsx). Use `toast.error(...)` for anything
  // a user can dismiss/scan; persistent connection state (Reconnecting...)
  // is rendered separately as an inline banner — it's a status, not a
  // notification.
  const toast = useToast()
  // Theme + accent (global + per-session). Lives in its own hook so
  // App.tsx isn't on the hook for the OS-theme subscription, accent
  // CSS-var sync, and the React-19-unmount-race write-through pattern.
  const {
    theme,
    setMode,
    skin,
    setSkin,
    accentColor,
    setAccentColor,
    sessionColors,
    sessionAccentMap,
    handleSessionColorChange,
  } = useTheme()
  /** Ids currently being resumed — briefly disables the item so a double-
   *  click doesn't fire two POSTs. */
  const [resuming, setResuming] = useState<Set<string>>(new Set())
  const resumingRef = useRef(resuming)
  /** User-chosen ordering for the sidebar. Items here always sort before
   *  anything not listed; unknown ids (e.g. sessions created after the
   *  order was saved) fall through to the default lastActivityAt sort. */
  const {
    groups,
    setGroups,
    sidebarOrder,
    setSidebarOrder,
    collapsedGroups,
    setCollapsedGroups,
  } = useUiState()

  // Composer snippets — a SINGLE global instance shared by every panel
  // (previously each Chat panel owned its own copy). Backed by the server
  // (/api/snippets — disk) so they survive reloads and never disagree
  // between panels. The manager + save dialogs render once at this level.
  const snippets = useComposerSnippets()
  const [showSnippetsManager, setShowSnippetsManager] = useState(false)
  /** Set when the user picks "Save current input as snippet…  in a panel's
   *  composer. Holds the textarea snapshot so later edits don't mutate the
   *  captured content before the label is confirmed. */
  const [pendingSnippetSave, setPendingSnippetSave] = useState<{ content: string } | null>(null)
  const resumeDialogPresence = useExitPresence(resumeDialogOpen)
  const globalSettingsPresence = useExitPresence(globalSettingsOpen)
  const snippetSavePresence = usePresenceValue(pendingSnippetSave)
  const snippetsManagerPresence = useExitPresence(showSnippetsManager)
  const helpPresence = useExitPresence(helpOpen)
  const snippetsRefresh = snippets.refresh
  const openSnippetsManager = useCallback(() => {
    // Pull the latest from the server each time the manager opens so a
    // stale tab re-syncs (matches the "refetch on open" sync model).
    void snippetsRefresh()
    setShowSnippetsManager(true)
  }, [snippetsRefresh])
  const saveCurrentAsSnippet = useCallback((content: string) => {
    setPendingSnippetSave({ content })
  }, [])
  /** Max number of chat panels open at once, and max sessions per group.
   *  Shared setting because the main grid and groups should agree on
   *  capacity. Server-driven via /api/config — config.json. */
  const [serverMaxOpen, setServerMaxOpen] = useState<number>(3)
  // True at/below the mobile breakpoint (<=768px). Drives single-panel mode
  // and the drawer sidebar.
  const isMobile = useIsMobile()
  // Swipe the drawer left to dismiss it — only active as a mobile drawer.
  const drawerSwipe = useSwipeToClose({
    onClose: () => setDrawerOpen(false),
    enabled: isMobile && drawerOpen,
  })
  // Track the visible viewport height on mobile so the on-screen keyboard
  // can't push the composer off-screen (writes the --app-vh CSS var).
  useVisualViewportHeight(isMobile)
  // `maxGroupSize` is the per-group capacity (persisted to localStorage via
  // group membership) and must NOT be squeezed by the viewport, or narrow
  // screens would permanently evict group members. `maxOpen` is the number
  // of panels shown at once — forced to 1 on mobile for single-panel mode.
  const maxGroupSize = clampMaxOpen(serverMaxOpen)
  const maxOpen = isMobile ? 1 : maxGroupSize

  // Configurable layout constraints — persisted in localStorage so
  // power users can tune sidebar limits and panel minimum ratio.
  const [sidebarMinPxRaw] = useLocalStorage<number>(SIDEBAR_MIN_KEY, SIDEBAR_MIN_DEFAULT)
  const [sidebarMaxPxRaw] = useLocalStorage<number>(SIDEBAR_MAX_KEY, SIDEBAR_MAX_DEFAULT)
  const sidebarMinPx = Math.max(100, Math.min(400, Math.round(sidebarMinPxRaw)))
  const sidebarMaxPx = Math.max(sidebarMinPx + 100, Math.min(1200, Math.round(sidebarMaxPxRaw)))
  const [panelMinRatioRaw] = useLocalStorage<number>(PANEL_MIN_RATIO_KEY, PANEL_MIN_RATIO_DEFAULT)
  const panelMinRatio = Math.max(0.05, Math.min(0.4, panelMinRatioRaw))

  // Groups are optional — sessions without a group appear in the
  // "Ungrouped" sidebar section. No default group is auto-created.

  const { sidebarWidth: effectiveSidebarWidth, sidebarResize, setSidebarWidth } = useSidebarResize({ minPx: sidebarMinPx, maxPx: sidebarMaxPx })

  const { gridTemplate, onDividerMouseDown, draggingDivider, bodyRef, setPanelRatios, effectiveRatios } = usePanelColumnResize({ openIds, panelMinRatio })

  // Keyboard resize for the sidebar separator. ArrowLeft shrinks, ArrowRight
  // grows, by a 24px step clamped to [sidebarMinPx, sidebarMaxPx]. Mirrors the
  // mouse drag so keyboard-only users can rebalance the workspace (Interact C2).
  const KEYBOARD_RESIZE_STEP = 24
  const onSidebarResizerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let delta = 0
      if (e.key === 'ArrowLeft') delta = -KEYBOARD_RESIZE_STEP
      else if (e.key === 'ArrowRight') delta = KEYBOARD_RESIZE_STEP
      else return
      e.preventDefault()
      const next = Math.max(sidebarMinPx, Math.min(sidebarMaxPx, effectiveSidebarWidth + delta))
      setSidebarWidth(next)
    },
    [effectiveSidebarWidth, setSidebarWidth, sidebarMinPx, sidebarMaxPx],
  )

  // Keyboard resize for an inter-panel divider. ArrowLeft/Right shift 0.05 of
  // ratio between the two adjacent panels (clamped to panelMinRatio). `index`
  // is the divider between columns index and index+1.
  const onPanelDividerKeyDown = useCallback(
    (index: number) => (e: React.KeyboardEvent) => {
      let delta = 0
      if (e.key === 'ArrowLeft') delta = -0.05
      else if (e.key === 'ArrowRight') delta = 0.05
      else return
      e.preventDefault()
      const leftId = openIds[index]
      const rightId = openIds[index + 1]
      if (!leftId || !rightId) return
      const leftR = effectiveRatios[leftId] ?? 1
      const rightR = effectiveRatios[rightId] ?? 1
      const rawL = leftR + delta
      const rawR = rightR - delta
      const next = { ...effectiveRatios }
      if (rawL < panelMinRatio) {
        next[rightId] = leftR + rightR - panelMinRatio
        next[leftId] = panelMinRatio
      } else if (rawR < panelMinRatio) {
        next[leftId] = leftR + rightR - panelMinRatio
        next[rightId] = panelMinRatio
      } else {
        next[leftId] = rawL
        next[rightId] = rawR
      }
      setPanelRatios(next)
    },
    [openIds, effectiveRatios, setPanelRatios, panelMinRatio],
  )

  // Update checker — gated on isConfigured so we don't probe before
  // the setup wizard finishes (the npm registry shouldn't see traffic
  // from a server that can't yet talk to Claude either way). Shared
  // between the top-of-page banner and the About tab in
  // GlobalSettingsModal so "Check now" propagates instantly.
  const updateInfo = useUpdateInfo(isConfigured === true)

  useEffect(() => {
    void api
      .get<ConfigResponse>('/config')
      .then((r) => {
        setIsConfigured(r.configured !== false)
        if (r.configured === false) return
        setDefaults(r.defaults)
        if (r.models?.length) setServerModels(r.models)
        if (r.maxOpenPanels != null) setServerMaxOpen(r.maxOpenPanels)
      })
      .catch(() => setIsConfigured(true))
  }, [])

  // Desktop notifications: refs declared first, then the hook wires
  // the working-flag edge detector + permission gate. See
  // useSessionNotifications for the visibility gate, the seed semantics,
  // and why the maybe* callbacks read the refs (not reactive deps).
  const openIdsRef = useRef(openIds)
  const focusedIdRef = useRef(focusedId)
  const sessionsRef = useRef(sessions)
  const maxOpenRef = useRef(maxOpen)
  const groupsRef = useRef(groups)
  const activeGroupIdRef = useRef<string | null>(null)
  const paletteOpenRef = useRef(paletteOpen)
  const helpOpenRef = useRef(helpOpen)
  const historyPanelOpenRef = useRef(historyPanelOpen)
  const settingsOpenForRef = useRef(settingsOpenFor)
  const gitPanelOpenForRef = useRef(gitPanelOpenFor)
  const handleSelectRef = useRef<(id: string) => void>(() => {})
  const jumpNonceRef = useRef(0)
  // Per-session interrupt callbacks registered by <Chat> components.
  // The ESC shortcut in the keyboard handler uses this to trigger the
  // same code-path as the Composer's interrupt button.
  const interruptFnsRef = useRef<Map<string, () => void>>(new Map())
  const registerInterrupt = useCallback((sessionId: string, fn: () => void) => {
    interruptFnsRef.current.set(sessionId, fn)
  }, [])
  // Per-session recap-refresh callbacks registered by <Chat> components.
  // Enables the Alt+R shortcut to trigger a recap fetch for the focused session.
  const recapFnsRef = useRef<Map<string, () => void>>(new Map())
  const registerRecap = useCallback((sessionId: string, fn: () => void) => {
    recapFnsRef.current.set(sessionId, fn)
  }, [])
  // Per-session input-injection callbacks registered by <Chat> components.
  // The Mod+Shift+H input-history panel uses this to drop a selected past
  // message into the focused session's composer.
  const injectInputFnsRef = useRef<Map<string, (text: string) => void>>(new Map())
  const registerInjectInput = useCallback((sessionId: string, fn: (text: string) => void) => {
    injectInputFnsRef.current.set(sessionId, fn)
  }, [])
  // Keep refs in sync with the latest state values. Assigned directly
  // in the render body (before return) so callbacks that capture these
  // refs always read the current values — no useEffect needed.
  /* eslint-disable react-hooks/refs -- intentional render-time ref sync; the alternative (useEffect) would lag by one render and break stale-closure callbacks downstream */
  openIdsRef.current = openIds
  focusedIdRef.current = focusedId
  sessionsRef.current = sessions
  groupsRef.current = groups
  resumingRef.current = resuming
  maxOpenRef.current = maxOpen
  paletteOpenRef.current = paletteOpen
  helpOpenRef.current = helpOpen
  historyPanelOpenRef.current = historyPanelOpen
  settingsOpenForRef.current = settingsOpenFor
  gitPanelOpenForRef.current = gitPanelOpenFor
  newSessionDialogOpenRef.current = newSessionDialogOpen
  resumeDialogOpenRef.current = resumeDialogOpen
  /* eslint-enable react-hooks/refs */

  // When the panel capacity shrinks (e.g. desktop — mobile resize/rotation
  // drops maxOpen to 1), `openSession`'s eviction only gates NEW opens — it
  // never retroactively trims already-open panels. Without this, narrowing
  // the viewport would leave 3 panels crammed into one column. Trim down to
  // `maxOpen`, preserving the focused panel (or the most recent one).
  useEffect(() => {
    setOpenIds((prev) => {
      if (prev.length <= maxOpen) return prev
      // Keep the most recent `maxOpen` panels, but always retain the focused
      // one even if it's older than the cutoff.
      const focused = focusedIdRef.current
      const kept = prev.slice(prev.length - maxOpen)
      if (focused && prev.includes(focused) && !kept.includes(focused)) {
        kept[0] = focused
      }
      if (focused && !kept.includes(focused)) setFocusedId(kept[kept.length - 1])
      return kept
    })
    // Only react to capacity changes; openIds churn is handled by openSession.
    // (setOpenIds / setFocusedId / focusedIdRef are all stable.)
  }, [maxOpen])

  // Service Worker registration — enables action buttons on OS-level
  // desktop notifications (Allow / Deny for permission requests).
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null)
  useEffect(() => {
    registerSW().then((reg) => { swRegRef.current = reg })
  }, [])

  // Listen for SW notification action callbacks. When the user clicks
  // Allow/Deny on an OS notification, the SW calls the decide API
  // directly and then posts back so the UI can focus the session.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'NOTIFICATION_ACTION' && e.data.sessionId) {
        handleSelectRef.current?.(e.data.sessionId)
      }
    }
    navigator.serviceWorker?.addEventListener('message', handler)
    return () => navigator.serviceWorker?.removeEventListener('message', handler)
  }, [])

  // Notification coordinator: working-flag edge detector + permission
  // gate, both gated on `document.hasFocus() && focusedId === sessionId`.
  // The hook owns notifyRef + prevWorkingRef internally; App keeps only
  // the bell-button-facing `notifications` slice and the three
  // session-event callbacks the WS hub effect calls into.
  const { notifications, maybeNotify, maybePermissionNotify, seedWorkingState, pruneSession, dismissPermissionToast } =
    useSessionNotifications({ focusedIdRef, sessionsRef, handleSelectRef, swRegRef })

  // Single push-based subscription to the server's session list. All
  // events now ride on the shared WebSocket hub — one connection per
  // tab, fanned out by kind. This replaces the previous SSE channel
  // and incidentally eliminates the per-panel HTTP/1.1 connection
  // exhaustion we used to hit with three concurrent chats.
  const hub = useWsHub()

  // Hub-status banner: shown when the WebSocket is reconnecting. This is
  // a persistent status (it stays up as long as we're disconnected) so
  // it's rendered as an inline banner, NOT a toast — toasts auto-dismiss
  // and "we're still offline" is exactly the message the user needs to
  // keep seeing. Status comes from its own context (useWsHubStatus) so
  // hub identity stays stable across status flips.
  const hubStatus = useWsHubStatus()
  const reconnectingBanner = hubStatus === 'reconnecting' ? 'Reconnecting to server...' : null

  useEffect(() => {
    const off = hub.addListener((frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'sessions-snapshot': {
          // Capture `isFirstSnapshot` BEFORE we flip `sessionsLoaded`. The
          // first snapshot on tab-mount is the only authoritative "these are
          // every session that exists on the server" signal we'll get —
          // subsequent snapshots fire on reconnect mid-stream and may race
          // a session-created we haven't received yet. We use this single
          // gate to prune ghost ids from groups (sessions deleted in another
          // tab while this tab was offline never broadcast session-removed
          // to us). Pruning on later snapshots would risk dropping a still-
          // live member during a reconnect race.
          const isFirstSnapshot = !firstSnapshotSeenRef.current
          firstSnapshotSeenRef.current = true
          setSessions(frame.sessions)
          setSessionsLoaded(true)
          // Reconcile open/focused against whatever the server reports.
          const ids = new Set(frame.sessions.map((s) => s.id))
          setOpenIds((prev) => {
            const next = prev.filter((id) => ids.has(id))
            return next.length === prev.length ? prev : next
          })
          setFocusedId((prev) => (prev && ids.has(prev) ? prev : null))
          // Prune lastSeenTurn entries whose sessions are gone — keeps
          // the persisted map from growing unbounded across restarts.
          setLastSeenTurn((prev) => pruneLastSeen(prev, ids))
          // Clean up orphaned Side Chat sessions. A Side Chat is abandoned when
          //   (a) its parent is gone from the snapshot — left behind by a
          //       crashed tab or a closed parent;     OR
          //   (b) the parent is present but the side chat has zero live
          //       subscribers AND is not the one this tab currently owns.
          //       This catches: page refresh while a drawer was open
          //       (sideChat state is in-memory only), and tabs that had a
          //       side chat open and then closed cleanly without the DELETE
          //       firing (e.g. tab close before animation completed).
          // The `subscribers === 0` gate prevents a second tab from killing
          // another tab's *active* side chat — when tab A still has the
          // drawer (or a collapsed-but-mounted ChatPanel) subscribed, the
          // server reports subscribers >= 1 in the snapshot and tab B
          // leaves it alone. Server-side idle GC eventually reaps anything
          // still abandoned beyond idleMs.
          const ownSideId = sideChatRef.current?.session.id ?? null
          for (const s of frame.sessions) {
            if (!s.parentId) continue
            if (s.id === ownSideId) continue
            const parentMissing = !ids.has(s.parentId)
            const abandoned = parentMissing || s.subscribers === 0
            if (!abandoned) continue
            void api.delete(`/sessions/${s.id}`).catch(() => {})
            sessionStoreRegistry.delete(s.id)
          }
          // NOTE: sidebarOrder is deliberately NOT pruned here. A single
          // snapshot is not an authoritative "these are the only sessions
          // that exist" list — a transient/incomplete snapshot (server
          // restart mid-persist, reconnect race, a session still inside the
          // persistence debounce window) would otherwise permanently strip
          // a still-live session from order and never re-add it. Pruning
          // sidebarOrder happens on the authoritative real-time
          // `session-removed` frame instead. Residual ids here are
          // harmless: sidebarSections / handleActivateGroup / activeGroupId
          // all filter sessionIds against the live `sessions` set, so an id
          // for a session that no longer exists never renders or opens.
          //
          // The first snapshot is special: it's the only one we can safely
          // treat as "complete". Reconnect snapshots may race a not-yet-
          // received session-created. We prune group.sessionIds on first
          // snapshot only — this clears ghosts left behind by another tab's
          // delete while we were offline, without risking eviction during a
          // mid-stream reconnect.
          if (isFirstSnapshot) {
            setGroups((prev) => {
              let changed = false
              const next = prev.map((g) => {
                const filtered = g.sessionIds.filter((id) => ids.has(id))
                if (filtered.length === g.sessionIds.length) return g
                changed = true
                return { ...g, sessionIds: filtered }
              })
              return changed ? next : prev
            })
          }
          break
        }
        case 'session-update': {
          setSessions((prev) => {
            const i = prev.findIndex((s) => s.id === frame.session.id)
            // An update for an id we don't know about is almost certainly
            // a race: a `created` event is on its way too. Ignore it and
            // let `created` do the insert — handling it here would create
            // two rows if `created` also arrives (it always does).
            if (i < 0) return prev
            // The server broadcasts a session-update for EVERY SDK message
            // in any session (metadata churn: lastTurnAt, working,
            // pendingPermissionCount, …). Most re-broadcasts carry
            // identical metadata. Replacing the array here unconditionally
            // would give `orderedSessions` a new identity → the entire
            // sidebar re-renders on every message in every open session
            // (3 panels streaming = 3 sidebar re-renders per token burst).
            // Bail when nothing the sidebar reads actually changed. The
            // side-effects below (lastSeenTurn bump, maybeNotify,
            // dismissPermissionToast) are driven by frame.session directly,
            // not by the state array, so they still run.
            if (sessionMetaEqual(prev[i], frame.session)) return prev
            const next = prev.slice()
            next[i] = frame.session
            return next
          })
          // If the update belongs to the currently-focused session AND
          // the window is focused, the user is actively watching it —           // bump lastSeenTurn so a new turn doesn't render as unread
          // after the panel is closed, or in a non-focused open-panel
          // sibling. Mirrors maybeNotify's visibility gate so the two
          // behaviours stay consistent.
          if (
            frame.session.lastTurnAt &&
            focusedIdRef.current === frame.session.id &&
            typeof document !== 'undefined' &&
            document.hasFocus()
          ) {
            setLastSeenTurn((prev) =>
              bumpLastSeen(prev, frame.session.id, frame.session.lastTurnAt),
            )
          }
          // Falling-edge trigger for desktop notifications — see maybeNotify.
          maybeNotify(frame.session)
          // Auto-dismiss sticky permission/question toasts once all pending
          // permissions for this session have been resolved.
          if (frame.session.pendingPermissionCount === 0) {
            dismissPermissionToast(frame.session.id)
          }
          // Keep the side chat's SessionInfo in sync so the collapsed badge
          // reflects live working/messageCount changes.
          setSideChat((prev) => {
            if (!prev || prev.session.id !== frame.session.id) return prev
            return { ...prev, session: frame.session }
          })
          break
        }
        case 'session-created': {
          setSessions((prev) => {
            const i = prev.findIndex((s) => s.id === frame.session.id)
            if (i >= 0) {
              const next = prev.slice()
              next[i] = frame.session
              return next
            }
            return [frame.session, ...prev]
          })
          // Seed the edge-detector so a session that spawns already
          // working doesn't fire a notification on its first true→ false
          // transition when the user is still watching it.
          seedWorkingState(frame.session.id, frame.session.working)
          break
        }
        case 'session-removed': {
          setSessions((prev) => prev.filter((s) => s.id !== frame.id))
          setOpenIds((prev) => prev.filter((id) => id !== frame.id))
          setFocusedId((prev) => (prev === frame.id ? null : prev))
          // Drop the session's lastSeenTurn entry — no reason to keep
          // it around once the server has deleted the session.
          setLastSeenTurn((prev) => {
            if (!(frame.id in prev)) return prev
            const next = { ...prev }
            delete next[frame.id]
            return next
          })
          // Drop the notification edge-detector entry too. Long-lived
          // tabs that watch many short sessions over hours otherwise
          // grow that Map without bound.
          pruneSession(frame.id)
          // Prune the deleted id from persisted sidebar order and group
          // membership. This is the authoritative real-time delete signal
          // (also fires for cross-tab deletes), so it's safe to remove here
          // Unlike the snapshot handler, which could fire on an
          // incomplete session list and drop still-live members.
          setSidebarOrder((prev) =>
            prev.includes(frame.id) ? prev.filter((id) => id !== frame.id) : prev,
          )
          setGroups((prev) => {
            let changed = false
            const next = prev.map((g) => {
              if (!g.sessionIds.includes(frame.id)) return g
              changed = true
              return { ...g, sessionIds: g.sessionIds.filter((sid) => sid !== frame.id) }
            })
            return changed ? next : prev
          })
          // Clean up side chat if its parent was removed, or if the
          // side chat session itself was removed.
          if (
            sideChatRef.current &&
            (sideChatRef.current.parentId === frame.id ||
              sideChatRef.current.session.id === frame.id)
          ) {
            const sideId = sideChatRef.current.session.id
            setSideChat(null)
            void api.delete(`/sessions/${sideId}`).catch(() => {})
            sessionStoreRegistry.delete(sideId)
          }
          break
        }
        case 'session-recap-update': {
          // Per-session recap transition. The same data also rides on
          // session-update (RecapManager broadcasts both), but this
          // dedicated frame is smaller and arrives in the same turn the
          // recap state actually changed — useful for the specific
          // recap UI that gates on session.recap.status. Patch just the
          // recap field so unrelated SessionInfo references stay
          // referentially stable.
          setSessions((prev) => {
            const i = prev.findIndex((s) => s.id === frame.sessionId)
            if (i < 0) return prev
            const cur = prev[i]
            // No-op when recap is referentially identical (guards the
            // "session-update arrived first with the same recap"
            // case — both frames re-render but the second is wasted).
            if (cur.recap === frame.recap) return prev
            const next = prev.slice()
            next[i] = { ...cur, recap: frame.recap }
            return next
          })
          break
        }
        case 'global-permission-request': {
          // Questions get dedicated wording in the notification ("is asking a
          // question" rather than "needs permission" / "Approve or deny").
          const r = frame.request
          const label =
            r.kind === 'question'
              ? 'a question'
              : (('displayName' in r && r.displayName) ||
                  ('toolName' in r && r.toolName) ||
                  'a tool')
          const toolInput = r.kind === 'permission' ? r.input as Record<string, unknown> : undefined
          maybePermissionNotify(frame.sessionId, label as string, r.kind, r.id, toolInput)
          break
        }
        default:
          // Other frame kinds (per-session replay/message/etc.) are
          // consumed by useChatStream listeners. App-level code only
          // cares about the global slice above.
          break
      }
    })
    return off
  }, [hub, maybeNotify, maybePermissionNotify, seedWorkingState, pruneSession, dismissPermissionToast, setLastSeenTurn, setSidebarOrder, setGroups])

  // Hub status — reconnecting banner is derived inline (single ternary
  // above) — no effect needed.

  // When the window regains focus, bump the currently-focused session's
  // lastSeenTurn to its latest lastTurnAt. Without this, a turn that
  // completed while the user was alt-tabbed away stays marked unread
  // even though the user is now staring right at it. Pairs with the
  // session-update hook that bumps seen while focused+visible.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFocus = () => {
      const fid = focusedIdRef.current
      if (!fid) return
      const s = sessionsRef.current.find((x) => x.id === fid)
      setLastSeenTurn((prev) => bumpLastSeen(prev, fid, s?.lastTurnAt))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [setLastSeenTurn])

  /** Push a session id onto the open list. Rules:
   *  - Already open — just focus it, no reshuffle.
   *  - Not open but >= maxOpen already — evict the oldest non-focused id.
   *  - Append to the end and focus it.
   *  Also bumps the session's lastSeenTurn so opening clears unread. */
  const openSession = useCallback(
    (id: string, lastTurnAt: number | undefined) => {
      setOpenIds((prev) => {
        if (prev.includes(id)) return prev
        if (prev.length < maxOpenRef.current) return [...prev, id]
        // Pick an eviction candidate: the oldest non-focused session.
        const curFocusedId = focusedIdRef.current
        const focusIdx = curFocusedId ? prev.indexOf(curFocusedId) : -1
        const evictIdx = prev.findIndex((_, i) => i !== focusIdx)
        const next = prev.slice()
        next.splice(evictIdx === -1 ? 0 : evictIdx, 1)
        next.push(id)
        return next
      })
      setFocusedId(id)
      setLastSeenTurn((prev) => ({ ...prev, [id]: lastTurnAt ?? Date.now() }))
    },
    [setLastSeenTurn],
  )

  const closeSession = useCallback(
    (id: string) => {
      // If the closed panel hosts a Side Chat, clean up the ephemeral session.
      // The drawer's animation-driven close path also DELETEs, but we may
      // never reach it here (the drawer unmounts as soon as its parent panel
      // closes, skipping the animation). Fire-and-forget guarantees cleanup.
      if (sideChatRef.current?.parentId === id) {
        const sideId = sideChatRef.current.session.id
        setSideChat(null)
        void api.delete(`/sessions/${sideId}`).catch(() => {})
        sessionStoreRegistry.delete(sideId)
      }
      // Both state updates are derived from the fresh openIds snapshot
      // inside a single updater, avoiding the fragile cross-updater
      // side-effect pattern. The setFocusedId call is issued from
      // inside setOpenIds's updater so `next` is guaranteed to be the
      // post-filter result regardless of batching order.
      setOpenIds((prev) => {
        const next = prev.filter((x) => x !== id)
        // Schedule the focusedId update inside this updater where
        // `next` is in scope — safe because React runs functional
        // updaters synchronously within a single batch.
        setFocusedId((f) => (f === id ? (next[next.length - 1] ?? null) : f))
        return next
      })
    },
    [],
  )

  /** Move a session into a group (or out of all groups when groupId is
   *  empty). Capacity is enforced by the callers (the sidebar drag-over
   *  rejects drops onto a full group, the context menu hides full groups
   *  from "Move to group"), so we don't expect to land here against a
   *  full target. Treat that as a no-op + warning rather than silently
   *  evicting somebody — silent eviction lost work in the previous
   *  implementation when a stale view triggered the path. */
  const handleAddToGroup = useCallback(
    (sessionId: string, groupId: string) => {
      // Compute the next groups synchronously from the ref so the openIds
      // sync below can read the result without waiting for setGroups's
      // async updater (setGroups wraps a setState whose updater runs on
      // React's schedule, not inline — a `let nextGroups` assigned inside
      // that updater would still be empty when we reach the sync code).
      const prevGroups = groupsRef.current
      let nextGroups: SessionGroup[]
      if (!groupId) {
        nextGroups = prevGroups.map((g) => ({
          ...g,
          sessionIds: g.sessionIds.filter((id) => id !== sessionId),
        }))
      } else {
        const target = prevGroups.find((g) => g.id === groupId)
        if (!target) return
        if (target.sessionIds.includes(sessionId)) return
        if (target.sessionIds.length >= maxGroupSize) {
          toast.error(
            `Group "${target.name}" is full (${maxGroupSize} sessions). Remove one first.`,
          )
          return
        }
        nextGroups = prevGroups.map((g) => {
          const without = { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }
          if (g.id !== groupId) return without
          return { ...without, sessionIds: [...without.sessionIds, sessionId] }
        })
      }
      setGroups(() => nextGroups)
      // Sync the open panel set when the active group's membership changes:
      // if the main view is currently showing exactly this group's sessions,
      // add the newly-joined session (or drop the one that just left) so the
      // view follows the group without requiring a manual re-activate.
      const active = activeGroupIdRef.current
      if (!active) return
      const updated = nextGroups.find((g) => g.id === active)
      if (!updated) return
      const prevOpen = openIdsRef.current
      const isGroupView = prevOpen.length > 0 && prevOpen.every((id) => updated.sessionIds.includes(id))
      if (!isGroupView) return
      const desired = updated.sessionIds.slice(0, maxOpenRef.current)
      const ordered = prevOpen.filter((id) => desired.includes(id))
      for (const id of desired) if (!ordered.includes(id)) ordered.push(id)
      const final = ordered.filter((id) => desired.includes(id)).slice(0, maxOpenRef.current)
      if (final.length === prevOpen.length && final.every((id, i) => id === prevOpen[i])) return
      setOpenIds(final)
    },
    [setGroups, maxGroupSize, toast, setOpenIds],
  )

  /** The group whose sessions are currently open in the main grid.
   *  null when openIds is empty or no group fully owns the open set. */
  const activeGroupId = useMemo(() => {
    if (openIds.length === 0) return null
    return groups.find((g) => openIds.every((id) => g.sessionIds.includes(id)))?.id ?? null
  }, [openIds, groups])
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref sync (same pattern as openIdsRef etc.)
  activeGroupIdRef.current = activeGroupId

  const handleCreate = useCallback(
    async (form: NewSessionForm) => {
      // `accent` and `groupId` are frontend-only fields — don't forward them to the SDK.
      const { accent, groupId, ...rest } = form
      try {
        const res = await api.post<{ session: SessionInfo }>('/sessions', rest)
        // Don't mutate `sessions` here — the server emits a `created`
        // event on /sessions/events that inserts the row. If we prepend
        // locally too we race with the SSE, end up with two rows, and
        // later state updates (e.g. a subsequent pump error) only hit
        // one of them — leaving an "err" phantom alongside the real card.

        // Assign to group (optional — ungrouped sessions are allowed).
        if (groupId) handleAddToGroup(res.session.id, groupId)

        // When viewing a group, only open the new session in the grid
        // if it belongs to that group. Otherwise leave it in the sidebar
        // so it doesn't intrude on the group view.
        const effectiveGroupId = groupId || null
        if (activeGroupId && effectiveGroupId !== activeGroupId) {
          setLastSeenTurn((prev) => ({ ...prev, [res.session.id]: res.session.lastTurnAt ?? Date.now() }))
        } else if (activeGroupId && effectiveGroupId === activeGroupId) {
          // Same group — append to existing group grid (matches handleSelect
          // behaviour for same-group sessions).
          openSession(res.session.id, res.session.lastTurnAt)
        } else {
          // Ungrouped session, no group view — replace grid with single panel.
          setFocusedId(res.session.id)
          setOpenIds([res.session.id])
          setLastSeenTurn((prev) => ({ ...prev, [res.session.id]: res.session.lastTurnAt ?? Date.now() }))
        }
        if (accent) {
          // Save the chosen accent under the new id. The hook's handler
          // does the localStorage-then-setState dance that survives a
          // dialog unmount in the same tick.
          handleSessionColorChange(res.session.id, accent)
        }
      } catch (e) {
        toast.error(`Couldn't create session: ${(e as Error).message}`)
      }
    },
    [handleSessionColorChange, handleAddToGroup, activeGroupId, openSession, setLastSeenTurn, toast],
  )

  const handleFork = useCallback(
    async (id: string) => {
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/fork`, {})
        // Open the forked session right away so the user can see the
        // divergence point. The global `created` event from the server
        // will add the row to the sidebar.
        openSession(res.session.id, res.session.lastTurnAt)
        // Inherit group from source session.
        const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
        if (sourceGroup) handleAddToGroup(res.session.id, sourceGroup.id)
      } catch (e) {
        toast.error(`Couldn't fork session: ${(e as Error).message}`)
      }
    },
    [openSession, groups, handleAddToGroup, toast],
  )

  /** Close the Side Chat drawer and delete the ephemeral session.
   *  Accepts an optional sessionId to target a specific session (used by
   *  the drawer's unmount cleanup). Falls back to the current sideChat ref. */
  const handleCloseSideChat = useCallback(async (sessionId?: string) => {
    const id = sessionId ?? sideChatRef.current?.session.id
    if (!id) return
    // Only clear sideChat state if it still points to this session.
    if (sideChatRef.current?.session.id === id) setSideChat(null)
    try { await api.delete(`/sessions/${id}`) } catch { /* */ }
    sessionStoreRegistry.delete(id)
  }, [])

  /** Toggle the Side Chat drawer between expanded and collapsed.
   *  Collapse hides the drawer but keeps the session alive on the server.
   *  Expand clears the unread badge. */
  const handleToggleCollapseSideChat = useCallback(() => {
    setSideChat((prev) => {
      if (!prev) return null
      if (prev.collapsed) {
        // Expanding: clear unread by resetting initialMessageCount
        return { ...prev, collapsed: false, initialMessageCount: 0 }
      }
      // Collapsing: snapshot the current messageCount for unread tracking
      return { ...prev, collapsed: true, initialMessageCount: prev.session.messageCount }
    })
  }, [])

  /** Create a Side Chat — ephemeral fork rendered as a drawer overlay. */
  const sideChatCreating = useRef(false)
  const handleSideChat = useCallback(
    async (id: string) => {
      if (sideChatCreating.current) return
      sideChatCreating.current = true
      try {
        // Close any existing Side Chat before creating a new one.
        // Set sideChat(null) FIRST so the old drawer's unmount cleanup
        // sees sideChatRef.current === null and skips the delete (we
        // handle it ourselves below).
        if (sideChatRef.current) {
          const oldId = sideChatRef.current.session.id
          setSideChat(null)
          try { await api.delete(`/sessions/${oldId}`) } catch { /* */ }
          sessionStoreRegistry.delete(oldId)
        }
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/side-chat`, {})
        setSideChat({ parentId: id, session: res.session, collapsed: false, initialMessageCount: 0 })
      } catch (e) {
        toast.error(`Couldn't create Side Chat: ${(e as Error).message}`)
      } finally {
        sideChatCreating.current = false
      }
    },
    [toast],
  )

  /** Create a brand-new empty session that reuses the source session's
   *  basic config (cwd, model, permissionMode) without carrying over any
   *  conversation history. Think "fork the settings, not the transcript". */
  const handleNewLikeThis = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      // Inherit the source's group only. If the source is ungrouped, the
      // copy stays ungrouped too — never silently drop it into some other
      // group that happens to have room.
      const form: NewSessionForm = {
        cwd: source.cwd,
        model: source.model,
        permissionMode: source.permissionMode,
        title: source.title ? `${source.title} (copy)` : undefined,
        // Carry forward the beta flags so a 1M-context session stays 1M
        // when copie?. Without this, "new like this" silently downgrades
        // the window.
        betas: source.betas,
        groupId: sourceGroup?.id,
      }
      await handleCreate(form)
    },
    [sessions, groups, handleCreate],
  )

  /** The irreversible part: actually hit the server (which kills the Query
   *  subprocess and erases persistence) and clean up local references.
   *  Used directly by Restart (create-then-delete) where an Undo toast
   *  would be nonsensical, and by the delayed path below once the undo
   *  window lapses. */
  const performDelete = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await api.delete(`/sessions/${id}`)
        closeSession(id)
        // Purge the session's transcript cache from localStorage. Without
        // this, deleted sessions leave orphan `claude-web-session:*` keys
        // that accumulate forever and eat the ~5MB quota — eventually
        // starving small but critical keys (session-groups, sidebar-order)
        // whose writes then fail. Going through the registry destroys the
        // in-memory store first so the idle sweep can't re-persist it.
        sessionStoreRegistry.delete(id)
        // Clean up per-session accent so it doesn't linger in storage.
        // Passing `undefined` deletes the entry through the same
        // localStorage-merge path the colour-menu uses.
        handleSessionColorChange(id, undefined)
        // Remove deleted session from any group it belongs to so the
        // group's session count stays accurate.
        setGroups((prev) =>
          prev.map((g) =>
            g.sessionIds.includes(id)
              ? { ...g, sessionIds: g.sessionIds.filter((sid) => sid !== id) }
              : g,
          ),
        )
        // Server pushes a `removed` event on the global SSE, which
        // re-prunes session state — no need to GET /sessions here.
        return true
      } catch (e) {
        toast.error(`Couldn't delete session: ${(e as Error).message}`)
        return false
      }
    },
    [closeSession, setGroups, handleSessionColorChange, toast],
  )

  /** Pending delete timers keyed by session id. The server delete is
   *  irreversible (kills the subprocess + erases persistence), so "undo"
   *  can only work as a Gmail-style grace period: hide the session from
   *  the sidebar immediately, fire the real delete after a delay, and let
   *  the user cancel the timer within the window. */
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingDeleteHideTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  /** Cancel a queued delete (Undo). Restores the card by clearing the
   *  optimistic-hide id. */
  const cancelPendingDelete = useCallback((id: string) => {
    const timer = pendingDeleteTimers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      pendingDeleteTimers.current.delete(id)
    }
    const hideTimer = pendingDeleteHideTimers.current.get(id)
    if (hideTimer) {
      clearTimeout(hideTimer)
      pendingDeleteHideTimers.current.delete(id)
    }
    setDeletingSessionIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setPendingDeleteIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const handleDelete = useCallback(
    (id: string) => {
      // Already queued? Ignore the repeat click.
      if (pendingDeleteTimers.current.has(id)) return
      const session = sessions.find((s) => s.id === id)
      const label = session?.title ?? id.slice(0, 8)
      // Play a short local exit animation first, then hide the card for
      // the Undo grace window. The irreversible API call is still deferre?.
      setDeletingSessionIds((prev) => new Set(prev).add(id))
      const EXIT_ANIMATION_MS = 260
      const UNDO_MS = 8000
      const hideTimer = setTimeout(() => {
        pendingDeleteHideTimers.current.delete(id)
        setPendingDeleteIds((prev) => new Set(prev).add(id))
        setDeletingSessionIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, EXIT_ANIMATION_MS)
      pendingDeleteHideTimers.current.set(id, hideTimer)
      const timer = setTimeout(() => {
        clearTimeout(hideTimer)
        pendingDeleteHideTimers.current.delete(id)
        pendingDeleteTimers.current.delete(id)
        void performDelete(id).then((deleted) => {
          if (deleted) return
          setPendingDeleteIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          setDeletingSessionIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        })
      }, UNDO_MS)
      pendingDeleteTimers.current.set(id, timer)
      toast.info(`Deleted "${label}"`, {
        actionLabel: 'Undo',
        durationMs: UNDO_MS,
        onClick: () => cancelPendingDelete(id),
      })
    },
    [sessions, performDelete, cancelPendingDelete, toast],
  )

  // Clear any queued delete timers on unmount so a pending timer can't fire
  // after the component is gone. Note this ABANDONS the queued delete (the
  // session survives) rather than committing it — a page close cancels the
  // pending intent, which is the safe default for an irreversible action.
  useEffect(() => {
    const timers = pendingDeleteTimers.current
    const hideTimers = pendingDeleteHideTimers.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      for (const t of hideTimers.values()) clearTimeout(t)
      timers.clear()
      hideTimers.clear()
    }
  }, [])

  /** Create a fresh session with the same config, then delete the old one.
   *  Create-first ensures the old session is preserved if creation fails. */
  const handleRestart = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      const wasOpen = openIds.includes(id)

      try {
        // Create the replacement session directly (no groupId) to avoid
        // handleAddToGroup's overflow eviction kicking a sibling out of
        // the group while the old session still occupies its slot.
        const res = await api.post<{ session: SessionInfo }>('/sessions', {
          cwd: source.cwd,
          model: source.model,
          permissionMode: source.permissionMode,
          // Preserve beta flags (notably `context-1m-...`) so restart
          // doesn't silently drop the window from 1M back to 200k.
          betas: source.betas,
          title: source.title,
        })
        const newId = res.session.id

        // Swap the panel slot so the new session takes the old one's
        // position without triggering openSession's eviction logic.
        if (wasOpen) {
          setOpenIds((prev) => {
            const idx = prev.indexOf(id)
            if (idx === -1) return prev
            const next = prev.slice()
            next[idx] = newId
            return next
          })
          setFocusedId((prev) => (prev === id ? newId : prev))
        }
        setLastSeenTurn((prev) => ({ ...prev, [newId]: res.session.lastTurnAt ?? Date.now() }))

        // Delete the old session.  The WS `session-removed` handler
        // automatically removes the old id from the group's sessionIds.
        await performDelete(id)

        // Insert the new session into the group at the old session's
        // position.  Must happen AFTER performDelete, because the WS
        // handler runs setGroups to remove the old id — doing it before
        // would be overwritten by the stale-closure-based WS update.
        if (sourceGroup) {
          const oldIdx = sourceGroup.sessionIds.indexOf(id)
          setGroups((prev) =>
            prev.map((g) => {
              if (g.id !== sourceGroup.id) return g
              // If the WS handler already removed `id`, insert at the
              // recorded position; otherwise replace in-place.
              const curIdx = g.sessionIds.indexOf(id)
              if (curIdx !== -1) {
                const next = g.sessionIds.slice()
                next[curIdx] = newId
                return { ...g, sessionIds: next }
              }
              // Already removed by WS handler — splice in at old position.
              const next = g.sessionIds.slice()
              next.splice(Math.min(oldIdx, next.length), 0, newId)
              return { ...g, sessionIds: next }
            }),
          )
        }
      } catch (e) {
        toast.error(`Couldn't restart session: ${(e as Error).message}`)
      }
    },
    [sessions, groups, openIds, performDelete, toast],
  )

  /** Activate a group: replace main-area panels with the group's sessions. */
  const handleActivateGroup = useCallback(
    (groupId: string) => {
      const group = groups.find((g) => g.id === groupId)
      if (!group) return
      const sessionSet = new Set(sessions.map((s) => s.id))
      const valid = group.sessionIds.filter((id) => sessionSet.has(id)).slice(0, maxOpen)
      if (valid.length === 0) return
      setOpenIds(valid)
      setFocusedId(valid[0])
      setLastSeenTurn((prev) => {
        const next = { ...prev }
        const now = Date.now()
        for (const id of valid) next[id] = now
        return next
      })
      // Resume dormant sessions in the backgroun?.
      for (const id of valid) {
        const s = sessions.find((x) => x.id === id)
        if (s && !s.running && !s.terminated) {
          void api.post(`/sessions/${id}/resume`, {}).catch(() => {})
        }
      }
    },
    [groups, sessions, maxOpen, setLastSeenTurn],
  )

  /** Resume a dormant session. Handles the resuming-set bookkeeping,
   *  the API call, and error display. `afterSuccess` runs after the
   *  sessions state is updated with the fresh session. */
  const resumeSession = useCallback(
    async (id: string, afterSuccess: (res: { session: SessionInfo }) => void) => {
      setResuming((prev) => new Set(prev).add(id))
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/resume`, {})
        setSessions((prev) => prev.map((p) => (p.id === id ? res.session : p)))
        afterSuccess(res)
      } catch (e) {
        const msg = (e as Error).message
        // The 410 "transcript file is missing" path also flips the
        // session to terminated server-side and broadcasts a session-
        // update; the panel's bottom-of-composer "session ended"
        // banner already explains that, so a global toast would just
        // duplicate the message. Silently swallow this one variant.
        if (!/transcript file is missing/i.test(msg)) {
          // Add an "Open" action so the user can jump to the session
          // even though the resume failed (the panel still mounts as
          // a dormant card, useful for retry / delete).
          toast.error(`Couldn't resume session: ${msg}`, {
            actionLabel: 'Open',
            onClick: () => { void handleSelectRef.current(id) },
          })
        }
      } finally {
        setResuming((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [toast],
  )

  /** Select a session. Dormant (not running, not terminated) sessions are
   *  resumed first — the server spins up a fresh Query with
   *  `options.resume`, then the SSE replay fills in the transcript.
   *  If the session belongs to a different group than the one currently
   *  active, the entire view switches to that group first.  Ungrouped
   *  sessions open in single-panel mode (replace the current panels). */
  const handleSelect = useCallback(
    async (id: string) => {
      const s = sessionsRef.current.find((x) => x.id === id)
      if (!s) {
        openSession(id, undefined)
        return
      }

      const sessionGroup = groups.find((g) => g.sessionIds.includes(id))

      // Ungrouped session — single-panel mode (replace all open panels).
      if (!sessionGroup) {
        setLastSeenTurn((prev) => ({ ...prev, [id]: s.lastTurnAt ?? Date.now() }))
        if (!s.running && !s.terminated && !resumingRef.current.has(id)) {
          await resumeSession(id, () => {
            setOpenIds([id])
            setFocusedId(id)
          })
        } else {
          setOpenIds([id])
          setFocusedId(id)
        }
        return
      }

      // Group switching: clicking a session in another group activates
      // that group, replacing all open panels with its sessions.
      if (sessionGroup.id !== activeGroupId) {
        handleActivateGroup(sessionGroup.id)
        setLastSeenTurn((prev) => ({ ...prev, [id]: s.lastTurnAt ?? Date.now() }))
        // Resume FIRST, then focus — same rationale as ungrouped path.
        if (!s.running && !s.terminated && !resumingRef.current.has(id)) {
          await resumeSession(id, () => { setFocusedId(id) })
        } else {
          setFocusedId(id)
        }
        return
      }

      // Same group — original behaviour.
      if (s.running || s.terminated) {
        openSession(id, s.lastTurnAt)
        return
      }
      if (resumingRef.current.has(id)) return
      await resumeSession(id, (res) => { openSession(id, res.session.lastTurnAt) })
    },
    [resumeSession, openSession, groups, activeGroupId, handleActivateGroup, setLastSeenTurn],
  )
  // Keep a stable ref so notification onClick handlers can call the
  // full handleSelect logic (group switch, dormant resume, unread clear)
  // without the useCallback depending on handleSelect directly.
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref sync, same rationale as the block above
  handleSelectRef.current = handleSelect

  const handleSelectMessage = useCallback(
    (hit: MessageSearchHit, query: string) => {
      const target: MessageJumpTarget = {
        nonce: ++jumpNonceRef.current,
        sessionId: hit.sessionId,
        query,
        messageUuid: hit.messageUuid,
        messageIndex: hit.messageIndex,
        matchOrdinal: hit.matchOrdinal,
      }
      setMessageJumpTarget(target)
      void handleSelect(hit.sessionId)
    },
    [handleSelect],
  )
  // Sidebar selection wrapper: on mobile, also close the drawer after picking
  // a session. Memoised so SessionList's `renderCard` useCallback (which lists
  // onSelect as a dependency) keeps a stable identity — an inline arrow here
  // would invalidate it on every App render and re-render the whole list.
  // `isMobile` only flips at the breakpoint, so on desktop this stays stable.
  const handleSelectFromSidebar = useCallback(
    (id: string) => {
      void handleSelect(id)
      if (isMobile) setDrawerOpen(false)
    },
    [handleSelect, isMobile],
  )

  /** When focus changes to an open panel, bump its seen-turn so the unread
   *  dot disappears. Focusing an already-read panel is a no-op. Uses
   *  `sessionsRef.current` so the callback's identity stays stable across
   *  every `session-update` WS frame — otherwise each <ChatPanel>'s
   *  `onFocus` prop churns and defeats memoisation. */
  const focusPanel = useCallback(
    (id: string) => {
      setFocusedId(id)
      const s = sessionsRef.current.find((x) => x.id === id)
      setLastSeenTurn((prev) => bumpLastSeen(prev, id, s?.lastTurnAt))
    },
    [setLastSeenTurn],
  )

  // Deep linking: sync URL hash ↔ open panels. Ref-backed callbacks so
  // the hook's effects never re-run on identity churn.
  const openSessionFromUrlRef = useRef((id: string) => { handleSelectRef.current(id) })
  const focusPanelFromUrlRef = useRef((id: string) => { focusPanel(id) })
  /* eslint-disable react-hooks/refs -- intentional render-time ref read; useSessionUrl stores the value in its own ref on mount */
  useSessionUrl({
    sessionsLoaded,
    openIds,
    focusedId,
    maxOpen,
    onOpenSession: openSessionFromUrlRef.current,
    onFocusPanel: focusPanelFromUrlRef.current,
  })
  /* eslint-enable react-hooks/refs */

  /** Derive unread flags from the session list + lastSeenTurn. A session
   *  is unread when `s.lastTurnAt > lastSeenTurn[id]` — regardless of
   *  whether the session is open. The session-update WS handler bumps
   *  `lastSeenTurn[focusedId]` whenever a new turn arrives on the focused
   *  panel in a focused window, so "user is actively watching" naturally
   *  clears the flag. Non-focused open panels (a 2-up/3-up layout) do
   *  show unread, which matches user expectations from chat apps. */
  const unread = useMemo(
    () => computeUnread(sessions, lastSeenTurn),
    [sessions, lastSeenTurn],
  )

  // Update the window title when unread count changes.
  useEffect(() => {
    const count = Object.values(unread).filter(Boolean).length
    document.title = count > 0 ? `(${count}) claude-react-web` : 'claude-react-web'
  }, [unread])

  /** Open sessions, rendered in the order they were opene?. Filter by
   *  what the server currently reports so a deleted-on-server session
   *  disappears on the next poll. */
  const openSessions = useMemo(
    () => openIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s),
    [openIds, sessions],
  )

  const updateSession = useCallback((s: SessionInfo) => {
    setSessions((prev) => prev.map((p) => (p.id === s.id ? s : p)))
  }, [])

  // ── Panel exit animation + entering DOM class ───────────────────────
  // Entering IDs are already computed during render (enteringSetRef).
  // This effect applies the `.entering` class to the real DOM and
  // detects exited panels for the closing-ghost overlay.
  const prevExitIdsRef = useRef<string[]>([])
  useLayoutEffect(() => {
    const bodyEl = bodyRef.current

    // Apply .entering class to newly-entering panels.
    for (const id of enteringSetRef.current) {
      const el = bodyEl?.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
      if (el) el.classList.add('entering')
    }

    // Exiting: panels in prev but not in next. Capture their DOM rects
    // BEFORE React removes them so we can overlay the closing ghost at
    // the exact same position. Uses a separate ref from the entering
    // detection because prevOpenIdsRef is updated during render.
    const prevIds = prevExitIdsRef.current
    const nextSet = new Set(openIds)
    prevExitIdsRef.current = openIds
    const gone = prevIds
      .filter((id) => !nextSet.has(id))
      .map((id) => ({ id }))
    if (gone.length === 0) return
    const snapshots = gone
      .map(({ id }) => {
        const session = sessionsRef.current.find((s) => s.id === id)
        if (!session || !bodyEl) return null
        const panelEl = bodyEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
        if (!panelEl) return null
        const panelR = panelEl.getBoundingClientRect()
        const bodyR = bodyEl.getBoundingClientRect()
        return {
          id,
          session,
          rect: new DOMRect(panelR.left - bodyR.left, panelR.top - bodyR.top, panelR.width, panelR.height),
        }
      })
      .filter(Boolean) as { id: string; session: SessionInfo; rect: DOMRect }[]
    if (snapshots.length === 0) return
    setClosingPanels((prev) => [...prev, ...snapshots])
  }, [openIds])

  // ── Panel swap animation ─────────────────────────────────────────────
  // animatePanels is called AFTER a state update (swapPanels / handleReorderInGroup).
  // It captures old positions of the given panel IDs, waits for the
  // browser to paint the new grid layout, then FLIP-animates them all
  // simultaneously — A slides to B's spot and vice versa.
  const animatePanels = useCallback((...ids: string[]) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const bodyEl = bodyRef.current
    if (!bodyEl) return
    const bodyR = bodyEl.getBoundingClientRect()
    const snapshots: { el: HTMLElement; x: number; y: number }[] = []
    for (const id of ids) {
      const el = bodyEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      snapshots.push({ el, x: r.left - bodyR.left, y: r.top - bodyR.top })
    }
    if (snapshots.length === 0) return
    // Wait for the grid to repaint with the new order, then animate.
    requestAnimationFrame(() => {
      const opts: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }
      const bodyR2 = bodyEl.getBoundingClientRect()
      for (const { el, x, y } of snapshots) {
        const r = el.getBoundingClientRect()
        const dx = x - (r.left - bodyR2.left)
        const dy = y - (r.top - bodyR2.top)
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0,0)' }],
          opts,
        )
      }
    })
  }, [])

  const endPanelExit = useCallback((id: string) => {
    setClosingPanels((prev) => prev.filter((p) => p.id !== id))
  }, [])

  // Fallback for reduced-motion: onAnimationEnd never fires when CSS
  // sets animation:none, so closing-panel ghosts would leak forever.
  // Detect the preference and immediately clear any closing panels.
  useEffect(() => {
    if (closingPanels.length === 0) return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (mql.matches) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- when the user prefers reduced motion, onAnimationEnd never fires (CSS sets animation:none), so closing-panel ghosts would leak forever; clearing them here is the documented escape hatch for that media-query case, not a cascading-render anti-pattern.
      setClosingPanels([])
    }
  }, [closingPanels.length])

  // ── Entering-panel detection (render phase) ──────────────────────────
  // We diff openIds during render (not in an effect) so the `.entering`
  // flag is available in the same render that first mounts the panel.
  // The useLayoutEffect below applies the class to the real DOM for the
  // first frame (before the browser paints). A state nudge in
  // handlePanelAnimEnd then forces a re-render so React's virtual DOM
  // reconciles and removes the class via its normal className commit.
  const enteringSetRef = useRef<Set<string>>(new Set())
  /* eslint-disable react-hooks/refs -- intentional: render-phase diff for entering-panel detection */
  if (prevOpenIdsRef.current !== openIds) {
    const prevSet = new Set(prevOpenIdsRef.current)
    for (const id of openIds) {
      if (!prevSet.has(id)) enteringSetRef.current.add(id)
    }
    prevOpenIdsRef.current = openIds
  }
  /* eslint-enable react-hooks/refs */
  // State nudge: incremented by handlePanelAnimEnd to force a re-render
  // after the animation completes, so React reconciles className.
  const [, setAnimEpoch] = useState(0)
  const handlePanelAnimEnd = useCallback((id: string) => {
    enteringSetRef.current.delete(id)
    setAnimEpoch((n) => n + 1)
  }, [])

  // Global keyboard shortcuts.
  //
  // Choices here err on the side of "won't be hijacked by the browser":
  //   - Ctrl/Cmd+1/2/3 is usable because we preventDefault before the
  //     browser's own tab-switch binding fires (it works in both Chrome
  //     and Firefox for number keys specifically).
  //   - Alt+W / Alt+N are used instead of Ctrl+W / Ctrl+N: those two
  //     are hard-bound in many browsers as "close tab" / "open window"
  //     and preventDefault() can't reach them.
  //   - Esc closes whatever overlay is open, highest-priority last (so
  //     the dialog covers the drawer, etc.).
  const shortcuts = useMemo(
    () => [
        {
          combo: 'mod+1',
          handler: () => {
            if (openIdsRef.current[0]) setFocusedId(openIdsRef.current[0])
          },
          description: 'Focus slot 1',
        },
        {
          combo: 'mod+2',
          handler: () => {
            if (openIdsRef.current[1]) setFocusedId(openIdsRef.current[1])
          },
          description: 'Focus slot 2',
        },
        {
          combo: 'mod+3',
          handler: () => {
            if (openIdsRef.current[2]) setFocusedId(openIdsRef.current[2])
          },
          description: 'Focus slot 3',
        },
        {
          combo: 'alt+w',
          handler: () => {
            if (focusedIdRef.current) closeSession(focusedIdRef.current)
          },
          description: 'Close focused panel',
        },
        {
          combo: 'alt+n',
          handler: () => setNewSessionDialogOpen(true),
          description: 'New session',
        },
        {
          // NOT mod+shift+r: that's the browser hard-reload combo on
          // Windows/Linux, and the dispatcher preventDefault()s every
          // bound combo — which would silently kill hard-reload. mod+shift+o
          // ("Open" a past session) has no browser default.
          combo: 'mod+shift+o',
          handler: () => setResumeDialogOpen(true),
          description: 'Resume session...',
        },
        {
          combo: 'mod+k',
          handler: () => setPaletteOpen((v) => !v),
          description: 'Command palette',
        },
        {
          combo: 'mod+shift+h',
          handler: () => setHistoryPanelOpen((v) => !v),
          allowInInput: true,
          description: 'Browse input history',
        },
        {
          combo: 'mod+x',
          handler: () => toggleShortcutHelp(helpOpenRef.current),
          allowInInput: true,
          description: 'Keyboard shortcuts',
        },
        {
          combo: 'shift+tab',
          handler: () => {
            const fid = focusedIdRef.current
            if (!fid) return
            const s = sessionsRef.current.find((x) => x.id === fid)
            if (!s) return
            const cur = (s.permissionMode ?? 'default') as PermissionMode
            const idx = PERMISSION_MODE_CYCLE.indexOf(cur)
            const next = idx >= 0 ? PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length] : 'default'
            void api.post(`/sessions/${fid}/permission-mode`, { mode: next })
          },
          description: 'Cycle permission mode',
        },
        {
          combo: 'alt+r',
          handler: () => {
            if (focusedIdRef.current) recapFnsRef.current.get(focusedIdRef.current)?.()
          },
          allowInInput: true,
          description: 'Refresh session recap',
        },
        {
          combo: 'escape',
          handler: () => {
            // Escape ownership is two-tier:
            //   1. Focus-trapped dialogs (PermissionDialog, QuestionDialog) and
            //      nested overlays (DirectoryPicker) handle Escape LOCALLY and
            //      stop propagation xthey need custom semantics (deny / skip /
            //      dismiss-just-this-layer) and must NOT fall through to the
            //      "interrupt session" branch below.
            //   2. Every other non-trapping overlay routes through this single
            //      ordered chain so there's one place that defines precedence.
            // Priority: CommandPalette > ShortcutHelp > NewSessionDialog > per-panel Git overlay > Settings overlay > Interrupt.
            // Git is checked before Settings because it's the more recently
            // introduced overlay and tends to be what the user wants to
            // close when they press Esc with both possible.
            if (paletteOpenRef.current) setPaletteOpen(false)
            else if (historyPanelOpenRef.current) setHistoryPanelOpen(false)
            else if (helpOpenRef.current) setHelpOpen(false)
            else if (resumeDialogOpenRef.current) { setResumeDialogOpen(false); setResumeTargetPanelId(null) }
            else if (newSessionDialogOpenRef.current) setNewSessionDialogOpen(false)
            else if (gitPanelOpenForRef.current) setGitPanelOpenFor(null)
            else if (settingsOpenForRef.current) setSettingsOpenFor(null)
            else if (focusedIdRef.current) {
              const focused = sessionsRef.current.find((s) => s.id === focusedIdRef.current)
              if (focused?.working) {
                // Use the registered interrupt callback (set by <Chat>).
                // The result message's "interrupted" (?) label is derived
                // from the SDK `terminal_reason`, not from this call-path.
                const fn = interruptFnsRef.current.get(focusedIdRef.current)
                if (fn) {
                  void fn()
                } else {
                  // Fallback: Chat hasn't registered yet (e.g. still
                  // mounting). Direct POST still interrupts the turn.
                  void api.post(`/sessions/${focusedIdRef.current}/interrupt`)
                }
              }
            }
          },
          allowInInput: true, // Esc inside textarea should still close modals / interrupt
          description: 'Close overlay / Interrupt',
        },
      ],
      [closeSession, setGitPanelOpenFor, setHelpOpen, setSettingsOpenFor, toggleShortcutHelp],
    )
  useKeyboardShortcuts(shortcuts)

  /** Final sidebar order: sidebarOrder[] wins for ids it contains; anything
   *  not listed falls back to the server's lastActivityAt sort. Ids in the
   *  saved order but no longer present on the server are droppe?. */
  const orderedSessions = useMemo(() => {
    // Side Chat sessions are ephemeral — they only exist in panels, never
    // in the sidebar.  Sessions in the Undo grace window are also hidden.
    let visible = sessions.filter((s) => !s.parentId)
    if (pendingDeleteIds.size) {
      visible = visible.filter((s) => !pendingDeleteIds.has(s.id))
    }
    const byId = new Map(visible.map((s) => [s.id, s]))
    const ordered: SessionInfo[] = []
    const seen = new Set<string>()
    for (const id of sidebarOrder) {
      const s = byId.get(id)
      if (s) {
        ordered.push(s)
        seen.add(id)
      }
    }
    for (const s of visible) if (!seen.has(s.id)) ordered.push(s)
    return ordered
  }, [sessions, sidebarOrder, pendingDeleteIds])

  /** Grouped sidebar view: groups -> ungrouped. Sessions not in any group
   *  appear in the "Ungrouped" section at the bottom. */
  const sidebarSections = useMemo((): SidebarSection[] => {
    const byId = new Map(orderedSessions.map((s) => [s.id, s]))

    // 1. Group sections.
    const sections: SidebarSection[] = []
    const groupedIds = new Set<string>()
    for (const g of groups) {
      const groupSessions: SessionInfo[] = []
      for (const id of g.sessionIds) {
        const s = byId.get(id)
        if (s) {
          groupSessions.push(s)
          groupedIds.add(id)
        }
      }
      sections.push({ kind: 'group', group: g, sessions: groupSessions })
    }

    // 2. Ungrouped sessions (not in any group).
    const ungrouped: SessionInfo[] = []
    for (const s of orderedSessions) {
      if (!groupedIds.has(s.id)) ungrouped.push(s)
    }
    if (ungrouped.length > 0) {
      sections.push({ kind: 'ungrouped', sessions: ungrouped })
    }

    return sections
  }, [orderedSessions, groups])

  /** Reorder callback wired to the sidebar's DnD. Moves `draggedId` so it
   *  lands either before or after `targetId`. Dropping on itself is a
   *  no-op. The resulting order is saved so the page survives reloads. */
  const handleReorderSidebar = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after') => {
      if (draggedId === targetId) return
      const currentIds = orderedSessions.map((s) => s.id)
      const without = currentIds.filter((id) => id !== draggedId)
      const targetIdx = without.indexOf(targetId)
      if (targetIdx < 0) return
      const insertAt = position === 'before' ? targetIdx : targetIdx + 1
      without.splice(insertAt, 0, draggedId)
      setSidebarOrder(() => without)
      // If the dragged session was in a group, remove it from that group's
      // membership — dropping onto an ungrouped (or different-group) target
      // moves it OUT of its current group. Without this the session stays in
      // the old group's sessionIds and the grouped view keeps rendering it
      // there, so the drop appears to "bounce back" (couldn't drag it out).
      // Compute next groups synchronously from the ref (setGroups's updater
      // runs on React's schedule, so a `let nextGroups` assigned inside it
      // would still be empty here — see handleAddToGroup).
      const prevGroups = groupsRef.current
      const owner = prevGroups.find((g) => g.sessionIds.includes(draggedId))
      if (owner) {
        const nextGroups = prevGroups.map((g) =>
          g.id === owner.id
            ? { ...g, sessionIds: g.sessionIds.filter((id) => id !== draggedId) }
            : g,
        )
        setGroups(() => nextGroups)
        // If the dragged session just left the active group, drop it from the
        // open panel set so the view follows (mirrors handleAddToGroup).
        const active = activeGroupIdRef.current
        if (active) {
          const updated = nextGroups.find((g) => g.id === active)
          if (updated && !updated.sessionIds.includes(draggedId)) {
            const prevOpen = openIdsRef.current
            const isGroupView = prevOpen.length > 0 && prevOpen.every((id) => updated.sessionIds.includes(id))
            if (isGroupView) {
              const next = prevOpen.filter((id) => id !== draggedId)
              if (next.length !== prevOpen.length) setOpenIds(next)
            }
          }
        }
      }
    },
    [orderedSessions, setSidebarOrder, setGroups, setOpenIds],
  )

  // --- Session group management ----------------------------------------------

  /** Validate a group name. Returns a user-facing error message on failure
   *  or null on success. Empty / whitespace-only is rejected, names are
   *  capped at 40 chars (sidebar pill layout breaks past that), and
   *  case-insensitive duplicates are blocked because the only way to tell
   *  them apart in the pill row is to count them. `ignoreId` skips one
   *  group when checking duplicates so rename-to-same-name is a no-op,
   *  not an error. */
  const validateGroupName = useCallback(
    (raw: string, ignoreId?: string): { ok: true; name: string } | { ok: false; error: string } => {
      const name = raw.trim()
      if (!name) return { ok: false, error: 'Group name cannot be empty.' }
      if (name.length > 40) return { ok: false, error: 'Group name is too long (max 40 chars).' }
      const lower = name.toLowerCase()
      const dup = groups.some((g) => g.id !== ignoreId && g.name.trim().toLowerCase() === lower)
      if (dup) return { ok: false, error: `A group named "${name}" already exists.` }
      return { ok: true, name }
    },
    [groups],
  )

  const handleCreateGroup = useCallback(
    (name: string) => {
      const res = validateGroupName(name)
      if (!res.ok) {
        toast.error(res.error)
        return ''
      }
      const id = randomId()
      setGroups((prev) => [...prev, { id, name: res.name, sessionIds: [] }])
      return id
    },
    [setGroups, validateGroupName, toast],
  )

  /** Delete a group. Orphaned sessions automatically become ungrouped
   *  (they'll appear in the sidebar's "Ungrouped" section). Offers an
   *  Undo affordance so an accidental click on the destructive menu item
   *  is recoverable for ~6s. */
  const handleDeleteGroup = useCallback(
    (groupId: string) => {
      type DeletedSnapshot = { group: typeof groups[number]; collapsed: boolean }
      // Capture the to-be-deleted group's state before mutating. We don't
      // close over `groups` here (it would re-render-bind every dependency
      // change) — read via functional setter to get the freshest value.
      const snapshotRef: { current: DeletedSnapshot | null } = { current: null }
      setGroups((prev) => {
        const g = prev.find((x) => x.id === groupId)
        if (!g) return prev
        snapshotRef.current = { group: g, collapsed: !!collapsedGroups[groupId] }
        return prev.filter((x) => x.id !== groupId)
      })
      setCollapsedGroups((prev) => {
        if (!(groupId in prev)) return prev
        const next = { ...prev }
        delete next[groupId]
        return next
      })
      const restored = snapshotRef.current
      if (restored) {
        toast.success(`Deleted group "${restored.group.name}"`, {
          actionLabel: 'Undo',
          durationMs: 6000,
          onClick: () => {
            setGroups((prev) => {
              if (prev.some((g) => g.id === restored.group.id)) return prev
              return [...prev, restored.group]
            })
            if (restored.collapsed) {
              setCollapsedGroups((prev) => ({ ...prev, [restored.group.id]: true }))
            }
          },
        })
      }
    },
    [setGroups, setCollapsedGroups, collapsedGroups, toast],
  )

  const handleRenameGroup = useCallback(
    (groupId: string, name: string) => {
      const res = validateGroupName(name, groupId)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: res.name } : g)))
    },
    [setGroups, validateGroupName, toast],
  )

  /** Drag-drop handler for a card landing on a card inside a group.
   *  The dragged session's position within `sessionIds` is set relative
   *  to the target. With exclusive membership, the session is only in
   *  one group, so this only reorders within that group. Panel order
   *  (`openIds`) is synced to match when overlapping sessions exist. */
  const handleReorderInGroup = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after', groupId: string) => {
      if (draggedId === targetId) return
      // Compute the new order inside the functional updater so we read
      // the freshest state without closing over `groups`.
      let newIds: string[] = []
      setGroups((prev) => {
        const group = prev.find((g) => g.id === groupId)
        if (!group) return prev
        const without = group.sessionIds.filter((id) => id !== draggedId)
        const targetIdx = without.indexOf(targetId)
        const insertAt = targetIdx < 0 ? without.length : position === 'before' ? targetIdx : targetIdx + 1
        without.splice(insertAt, 0, draggedId)
        newIds = without
        // If the dragged session belonged to a DIFFERENT group, remove it
        // from that group — a cross-group drop must transfer membership,
        // not duplicate it. (Same-group drops are a no-op filter here.)
        return prev.map((g) => {
          if (g.id === groupId) return { ...g, sessionIds: without }
          if (g.sessionIds.includes(draggedId)) {
            return { ...g, sessionIds: g.sessionIds.filter((id) => id !== draggedId) }
          }
          return g
        })
      })
      if (newIds.length === 0) return

      // Sync open panel order: re-order the group sessions that are
      // currently open while preserving non-group sessions in place.
      setOpenIds((prev) => {
        const groupSet = new Set(newIds)
        const openGroup = prev.filter((id) => groupSet.has(id))
        if (openGroup.length < 2) return prev
        const reordered = newIds.filter((id) => groupSet.has(id) && prev.includes(id))
        if (openGroup.join() === reordered.join()) return prev
        let ri = 0
        return prev.map((id) => (groupSet.has(id) ? reordered[ri++] : id))
      })
      // Animate all open group panels to their new grid positions.
      const openGroup = openIdsRef.current.filter((id) => newIds.includes(id))
      if (openGroup.length >= 2) animatePanels(...openGroup)
    },
    [setGroups, setOpenIds, animatePanels],
  )

  const toggleGroupCollapse = useCallback(
    (groupId: string) => {
      setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
    },
    [setCollapsedGroups],
  )

  /** Move a panel to the target panel's position (splice-move, same
   *  semantics as sidebar reordering). If both panels belong to the same
   *  group, the group's `sessionIds` order is synced to match. */
  const swapPanels = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    // Splice-move: remove draggedId, insert at targetId's index.
    setOpenIds((prev) => {
      const without = prev.filter((id) => id !== draggedId)
      const idx = without.indexOf(targetId)
      if (idx < 0) return prev
      without.splice(idx, 0, draggedId)
      return without
    })
    // Sync group order (same splice-move semantics).
    setGroups((prev) => {
      const groupId = prev.find(
        (g) => g.sessionIds.includes(draggedId) && g.sessionIds.includes(targetId),
      )?.id
      if (!groupId) return prev
      return prev.map((g) => {
        if (g.id !== groupId) return g
        const ids = g.sessionIds.filter((id) => id !== draggedId)
        const idx = ids.indexOf(targetId)
        if (idx < 0) return g
        ids.splice(idx, 0, draggedId)
        return { ...g, sessionIds: ids }
      })
    })
    setFocusedId(draggedId)
    animatePanels(draggedId, targetId)
  }, [setGroups, animatePanels])

  /** Drop a sidebar card onto a specific slot in the main grid. If the
   *  slot is occupied by another session, that session is evicted (panel
   *  closes, session stays alive) and the new one takes its place.
   *  When both sessions are already open, uses splice-move (consistent
   *  with swapPanels) and syncs the shared group's order. */
  const openAtSlot = useCallback(
    (id: string, targetId: string, lastTurnAt: number | undefined) => {
      setOpenIds((prev) => {
        // Already open — splice-move to the target slot (same semantics
        // as swapPanels). Also sync group order below.
        if (prev.includes(id)) {
          const without = prev.filter((x) => x !== id)
          const idx = without.indexOf(targetId)
          if (idx < 0) return prev
          without.splice(idx, 0, id)
          return without
        }
        // Not open yet: replace whatever's in the target slot.
        const j = prev.indexOf(targetId)
        if (j < 0) return prev
        const next = prev.slice()
        next[j] = id
        return next
      })
      // Sync group order when both sessions share a group (same pattern
      // as swapPanels).
      setGroups((prev) => {
        const groupId = prev.find(
          (g) => g.sessionIds.includes(id) && g.sessionIds.includes(targetId),
        )?.id
        if (!groupId) return prev
        return prev.map((g) => {
          if (g.id !== groupId) return g
          const ids = g.sessionIds.filter((sid) => sid !== id)
          const idx = ids.indexOf(targetId)
          if (idx < 0) return g
          ids.splice(idx, 0, id)
          return { ...g, sessionIds: ids }
        })
      })
      setFocusedId(id)
      setLastSeenTurn((prev) => ({ ...prev, [id]: lastTurnAt ?? Date.now() }))
    },
    [setLastSeenTurn, setGroups],
  )

  const handleAcceptSidebarDrop = useCallback(async (sidebarId: string, targetSlotId: string) => {
    const existing = sessionsRef.current.find((x) => x.id === sidebarId)
    let live = existing
    if (existing && !existing.running && !existing.terminated) {
      try {
        const res = await api.post<{ session: SessionInfo }>(
          `/sessions/${sidebarId}/resume`,
          {},
        )
        live = res.session
        updateSession(res.session)
      } catch (err) {
        const msg = (err as Error).message
        // Same rationale as `resumeSession`: transcript-missing already
        // surfaces in the panel via the terminated banner.
        if (!/transcript file is missing/i.test(msg)) {
          toast.error(`Couldn't resume session: ${msg}`, {
            actionLabel: 'Open',
            onClick: () => { void handleSelectRef.current(sidebarId) },
          })
        }
        return
      }
    }
    openAtSlot(sidebarId, targetSlotId, live?.lastTurnAt)
  }, [updateSession, openAtSlot, toast])

  // Resume a picked session INTO a specific panel slot (the `/resume` local
  // command flow). Mirrors handleAcceptSidebarDrop's dormant handling, but
  // also covers unknown CLI-created sessions (not in `sessions`): those fall
  // through to resumeSession, which adopts them server-side before swapping.
  const resumeIntoPanel = useCallback(
    (pickedId: string, targetPanelId: string) => {
      const known = sessionsRef.current.find((s) => s.id === pickedId)
      if (known?.running) {
        openAtSlot(pickedId, targetPanelId, known.lastTurnAt)
      } else {
        void resumeSession(pickedId, (res) => openAtSlot(pickedId, targetPanelId, res.session.lastTurnAt))
      }
    },
    [resumeSession, openAtSlot],
  )

  // Opened from a panel's `/resume`: remember which slot to replace, then pop
  // the picker. onResume (below) branches on resumeTargetPanelI?.
  const requestResumeForPanel = useCallback((panelSessionId: string) => {
    setResumeTargetPanelId(panelSessionId)
    setResumeDialogOpen(true)
  }, [])

  const refreshConfigResponse = useCallback(async () => {
    const r = await api.get<ConfigResponse>('/config')
    setDefaults(r.defaults)
    if (r.models?.length) setServerModels(r.models)
    if (r.maxOpenPanels != null) setServerMaxOpen(r.maxOpenPanels)
  }, [])

  const handleConfigured = useCallback(
    async ({ openNewSession }: { openNewSession: boolean }) => {
      // Best-effort refresh — populates defaults.cwd / serverModels so
      // the auto-opened NewSessionDialog isn't blank. We DELIBERATELY
      // swallow refresh errors and flip isConfigured anyway, because:
      //
      //   1. /config/setup already succeeded (otherwise SetupPage would
      //      have caught its own POST failure and never called us).
      //      Trapping the user on SetupPage makes the next retry click
      //      re-POST /config/setup, overwriting the just-written file.
      //
      //   2. Empty defaults are recoverable — the user picks cwd / model
      //      manually in NewSessionDialog. A "stuck on setup forever"
      //      page is not.
      //
      // SetupPage's finalize catch therefore only fires for /config/setup
      // failures, which are legitimate retries.
      try {
        await refreshConfigResponse()
      } catch (err) {
        console.error('Post-setup /config refresh failed:', err)
      }
      setIsConfigured(true)
      if (openNewSession) setNewSessionDialogOpen(true)
    },
    [refreshConfigResponse],
  )

  const handleGlobalSettingsSaved = useCallback(() => {
    // Surface refresh failures so saved global settings don't silently
    // leave the App with stale `defaults` / `serverModels`. The modal
    // closes on its own success path; we can't bubble back into it, so
    // we log. Better than `void`-discarding the rejection — at least the
    // failure is visible in the console.
    refreshConfigResponse().catch((err) => {
      console.error('Post-save /config refresh failed:', err)
    })
    // Also re-probe the registry: the user may have just edited the
    // updateCheckRegistry field in the About tab, and the cached
    // snapshot would still reflect the previous URL (or `disabled`)
    // until the cache TTL expires. A force refresh here makes "save"
    // feel responsive — the banner / About tab reflect the new URL
    // before the modal is fully close?.
    updateInfo.refresh()
  }, [refreshConfigResponse, updateInfo])

  // Memoize the settings tab request so ChatPanel's React.memo doesn't
  // see a new object reference on every render.
  const stableSettingsTabRequest = useMemo(
    () => settingsTabRequest ? { tab: settingsTabRequest.tab, nonce: settingsTabRequest.nonce } : null,
    [settingsTabRequest?.tab, settingsTabRequest?.nonce],
  )

  if (isConfigured === null) {
    return (
      <div className="app-loading">
        <div className="app-loading-card" role="status" aria-live="polite">
          <span className="brand-dot app-loading-dot" aria-hidden />
          <div className="app-loading-copy">
            <p className="app-loading-title">Claude Web</p>
            <p className="app-loading-subtitle">Loading workspace...</p>
          </div>
          <div className="app-loading-spinner" aria-hidden />
        </div>
      </div>
    )
  }
  if (!isConfigured) {
    return (
      <Suspense
        fallback={
          <div className="app-loading">
            <div className="app-loading-card" role="status" aria-live="polite">
              <span className="brand-dot app-loading-dot" aria-hidden />
              <div className="app-loading-copy">
                <p className="app-loading-title">Claude Web</p>
                <p className="app-loading-subtitle">Preparing setup...</p>
              </div>
              <div className="app-loading-spinner" aria-hidden />
            </div>
          </div>
        }
      >
        <SetupPage onConfigured={handleConfigured} />
      </Suspense>
    )
  }

  return (
    <ErrorBoundary>
    <div
      className={`app${isMobile && drawerOpen ? ' drawer-open' : ''}`}
      style={{ ['--sidebar-width' as string]: `${effectiveSidebarWidth}px` }}
    >
      {/* Skip link for keyboard users — first focusable element on the
          page. Hidden visually until it receives focus, at which point
          it slides into view. Sends focus to the chat panels region so
          a Tab-only user doesn't have to walk through the entire
          sidebar to reach the conversation. */}
      <a className="skip-link" href="#main">Skip to chat</a>
      <aside className="sidebar" aria-label="Sessions" {...drawerSwipe}>
        <div className="brand">
          <span className="brand-dot" /> claude-react-web
        </div>
        <SessionList
          sessions={orderedSessions}
          sessionsLoaded={sessionsLoaded}
          openIds={openIds}
          focusedId={focusedId}
          defaults={defaults}
          serverModels={serverModels}
          resumingIds={resuming}
          unread={unread}
          deletingIds={deletingSessionIds}
          sessionColors={sessionColors}
          onSessionColorChange={handleSessionColorChange}
          onSelect={handleSelectFromSidebar}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onClosePanel={closeSession}
          onFork={handleFork}
          onNewLikeThis={handleNewLikeThis}
          onRestart={handleRestart}
          onReorder={handleReorderSidebar}
          onDropIntoGroup={handleAddToGroup}
          onReorderInGroup={handleReorderInGroup}
          newSessionDialogOpen={newSessionDialogOpen}
          onNewSessionDialogChange={setNewSessionDialogOpen}
          groups={groups}
          sidebarSections={sidebarSections}
          collapsedGroups={collapsedGroups}
          onActivateGroup={handleActivateGroup}
          onCreateGroup={handleCreateGroup}
          onDeleteGroup={handleDeleteGroup}
          onRenameGroup={handleRenameGroup}
          onAddToGroup={handleAddToGroup}
          onToggleGroupCollapse={toggleGroupCollapse}
          activeGroupId={activeGroupId}
          maxOpen={maxOpen}
        />
        <div
          className={`sidebar-resizer ${sidebarResize.dragging ? 'dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={sidebarResize.startDrag}
          onKeyDown={onSidebarResizerKeyDown}
          // Double-click resets to default.
          onDoubleClick={() => setSidebarWidth(280)}
          title="Drag to resize · double-click to reset"
          tabIndex={0}
        />
      </aside>

      {/* Mobile drawer backdrop. Only rendered when the drawer is open on a
          narrow viewport; clicking it closes the drawer. Hidden entirely on
          desktop (the sidebar is a static grid column there). */}
      {isMobile && drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      {/* tabIndex={-1} makes the landmark a programmatic focus target so
          activating the skip-link (`href="#main"`) actually moves focus
          here. Without it, the browser scrolls into view but focus stays
          at the link, and the next Tab walks back through the sidebar ?           defeating the whole point of the skip-link. */}
      <main className="main" id="main" tabIndex={-1} aria-label="Chat panels">
        {/* Visually-hidden page heading so the landmark has a top-level
            <h1> for screen-reader orientation. Without it the first heading
            a SR user meets inside <main> is a per-panel header or the
            empty-state <h2> — there's no "you are in the chat area" h1.
            The aria-label on <main> names the region; this names the page. */}
        <h1 className="sr-only">Chat</h1>
        <header className="main-header">
          {/* Hamburger toggles the drawer sidebar. Rendered only on mobile;
              CSS pushes it to the left edge (margin-right: auto) so the rest
              of the toolbar stays flush-right. */}
          {isMobile && (
            <button
              className="btn btn-icon drawer-toggle"
              onClick={() => setDrawerOpen((v) => !v)}
              aria-label="Open sessions"
              aria-expanded={drawerOpen}
            >
              <IconMenu size={18} />
            </button>
          )}
          {/* The header used to echo the focused session's title / model /
              mode / cwd, but with up to three panels open that information
              is already visible inside each ChatPanel header ? duplicating
              it at the top was both redundant and subtly wrong (it looked
              like "the active session" when all three are active). Now the
              row holds only the app-level toolbar. */}
          {/* role="group" rather than "toolbar": ARIA's toolbar pattern
              expects arrow-key roving between items, which we don't
              implement (Tab walks the cluster like ordinary buttons).
              Group preserves the labelled-region semantics so a screen
              reader still announces "App actions" without making a
              keyboard promise we don't keep. */}
          <div className="main-toolbar" role="group" aria-label="App actions">
            <button
              className={`btn btn-icon ${notifications.enabled ? 'active' : ''}`}
              onClick={() => void notifications.toggle()}
              title={notificationTooltip(notifications.permission, notifications.enabled)}
              disabled={notifications.permission === 'unsupported'}
              aria-label="Toggle desktop notifications"
            >
              <IconBellToggle
                size={16}
                className={`notification-icon ${notifications.enabled ? 'enabled' : 'disabled'}`}
              />
            </button>
            <AppearancePanel
              skin={skin}
              mode={theme}
              accentColor={accentColor}
              onSkin={setSkin}
              onMode={setMode}
              onAccent={(v) => setAccentColor(v ?? ACCENT_COLORS[0].accent)}
              className="btn btn-icon"
            />
            <button
              className="btn btn-icon"
              onClick={() => setGlobalSettingsOpen(true)}
              title="Global Settings"
              aria-label="Global Settings"
            >
              <IconSettings size={16} />
            </button>
          </div>
        </header>

        {/* Reconnecting banner — kept inline (not toast) because it's a
            persistent status, not a one-shot notification. Auto-dismiss
            would defeat the purpose. The element stays permanently
            mounted as a live region so screen readers observe the
            transition; collapses to an sr-only 1×1 when not active. */}
        <div
          className={`error-bar${reconnectingBanner ? '' : ' error-bar-empty'}`}
          role="status"
          aria-live="polite"
        >
          {reconnectingBanner ?? ''}
        </div>

        <UpdateBanner
          info={updateInfo.info}
          updating={updateInfo.updating}
          onUpdate={updateInfo.update}
        />

        <div
          ref={bodyRef}
          className="main-body"
          data-panel-count={openSessions.length || 1}
          style={{ gridTemplateColumns: gridTemplate }}
          onDragOver={(e) => {
            if (!isInAppDrag(e)) return
            e.preventDefault()
          }}
          onDrop={(e) => {
            const payload = readDragPayload(e)
            if (!payload || payload.kind !== 'sidebar-card') return
            e.preventDefault()
            void handleSelect(payload.id)
          }}
        >
          {openSessions.length === 0 ? (
            <div className="empty-state app-empty-state">
              <p className="app-empty-state-eyebrow">Workspace ready</p>
              <h2>{sessions.length > 0 ? 'No session open' : 'Start a new session'}</h2>
              <p>
                {sessions.length > 0
                  ? 'Pick a session from the sidebar, resume one from history, or start fresh.'
                  : `Start a conversation with Claude in this workspace. You can keep up to ${maxOpen} session${maxOpen === 1 ? '' : 's'} open at once.`}
              </p>
              <div className="app-empty-state-actions">
                <button
                  className="btn btn-primary empty-state-cta"
                  onClick={() => setNewSessionDialogOpen(true)}
                >
                  New session
                </button>
                <button className="btn empty-state-cta" onClick={() => setPaletteOpen(true)}>
                  Command palette
                </button>
              </div>
              <p className="empty-state-hint">
                Tip: press <kbd>Ctrl</kbd>+<kbd>K</kbd> anytime to jump to actions.
              </p>
            </div>
          ) : (
            // Flatten panels + dividers into a single children list. The grid
            // template we built alternates fr / 4px tracks, so this order has
            // to match or the columns will de-sync.
            // eslint-disable-next-line react-hooks/refs -- intentional: entering flag read during render
            openSessions.flatMap((s, i) => {
              const entering = enteringSetRef.current.has(s.id)
              const node = (
                // Per-panel ErrorBoundary: if one panel's render throws
                // (e.g. a malformed assistant message), the other open
                // panels and the sidebar keep working. children identity
                // changes on prop updates, so a recovered render auto-clears.
                <ErrorBoundary key={s.id}>
                  <ChatPanel
                    session={s}
                    focused={s.id === focusedId}
                    hasUnread={!!unread[s.id]}
                    slot={i + 1}
                    entering={entering}
                    onAnimEnd={entering ? handlePanelAnimEnd : undefined}
                    accentStyle={sessionAccentMap.get(s.id)}
                    onFocus={focusPanel}
                    onClose={closeSession}
                    onSessionUpdate={updateSession}
                    settingsOpen={settingsOpenFor === s.id}
                    messageJumpTarget={messageJumpTarget?.sessionId === s.id ? messageJumpTarget : null}
                    onOpenSettings={handleOpenSettings}
                    onCloseSettings={handleCloseSettings}
                    gitPanelOpen={gitPanelOpenFor === s.id}
                    onOpenGitPanel={handleOpenGitPanel}
                    onCloseGitPanel={handleCloseGitPanel}
                    onSwap={swapPanels}
                    onRegisterInterrupt={registerInterrupt}
                    onRegisterRecap={registerRecap}
                    onRegisterInjectInput={registerInjectInput}
                    onAcceptSidebarDrop={handleAcceptSidebarDrop}
                    onRequestResumeForPanel={requestResumeForPanel}
                    onOpenSettingsTab={openSettingsTab}
                    onShowHelp={showHelpWithCommands}
                    sideChatSession={sideChat?.parentId === s.id ? sideChat.session : undefined}
                    sideChatCollapsed={sideChat?.parentId === s.id ? sideChat.collapsed : undefined}
                    sideChatUnread={
                      sideChat?.parentId === s.id && sideChat.collapsed
                        ? Math.max(0, sideChat.session.messageCount - sideChat.initialMessageCount)
                        : 0
                    }
                    onToggleCollapseSideChat={
                      sideChat?.parentId === s.id ? handleToggleCollapseSideChat : undefined
                    }
                    onCloseSideChat={sideChat?.parentId === s.id ? handleCloseSideChat : undefined}
                    onSideChat={handleSideChat}
                    settingsTabRequest={
                      settingsTabRequest?.sessionId === s.id
                        ? stableSettingsTabRequest
                        : null
                    }
                    isResuming={resuming.has(s.id)}
                    snippets={snippets}
                    onOpenSnippetsManager={openSnippetsManager}
                    onSaveCurrentAsSnippet={saveCurrentAsSnippet}
                  />
                </ErrorBoundary>
              )
              if (i === openSessions.length - 1) return [node]
              return [
                node,
                <div
                  key={`divider-${i}`}
                  className={`panel-divider ${draggingDivider === i ? 'dragging' : ''}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize panel"
                  onMouseDown={onDividerMouseDown(i)}
                  onKeyDown={onPanelDividerKeyDown(i)}
                  onDoubleClick={() => setPanelRatios(Object.fromEntries(openIds.map((id) => [id, 1])))}
                  title="Drag to resize · double-click to reset"
                  tabIndex={0}
                />,
              ]
            }).concat(
              // Closing panels: lightweight ghost that fades out at the
              // panel's last known position. onAnimationEnd removes it.
              closingPanels.map((cp) => (
                <div
                  key={`closing-${cp.id}`}
                  className="chat-panel-slot exiting"
                  style={{ top: cp.rect.y, left: cp.rect.x, width: cp.rect.width, height: cp.rect.height }}
                  onAnimationEnd={() => endPanelExit(cp.id)}
                >
                  <section
                    className="chat-panel"
                    style={sessionAccentMap.get(cp.id)}
                  >
                    <div className="chat-panel-header">
                      <span className="chat-panel-title">
                        {cp.session.title ?? cp.session.id.slice(0, 8)}
                      </span>
                    </div>
                  </section>
                </div>
              ))
            )
          )}
        </div>
      </main>

      <Suspense fallback={null}>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          shortcuts={shortcuts}
          sessions={sessions}
          onSelectMessage={handleSelectMessage}
          onSelectSession={(id) => {
            if (openIds.includes(id)) {
              setFocusedId(id)
            } else {
              const s = sessions.find((s) => s.id === id)
              openSession(id, s?.lastTurnAt)
            }
            setPaletteOpen(false)
          }}
        />
      </Suspense>

      <Suspense fallback={null}>
        <InputHistoryPanel
          open={historyPanelOpen}
          onClose={() => setHistoryPanelOpen(false)}
          currentSessionId={focusedId}
          onSelect={(text) => {
            const fid = focusedIdRef.current
            if (fid) injectInputFnsRef.current.get(fid)?.(text)
          }}
        />
      </Suspense>

      {resumeDialogPresence.shouldRender && (
        <Suspense fallback={null}>
          <ResumeSessionDialog
            open={resumeDialogOpen}
            defaultCwd={defaults.cwd}
            onResume={(id) => {
              setResumeDialogOpen(false)
              // Panel-scope `/resume`: replace that panel's slot with the
              // picked session instead of opening a new panel.
              if (resumeTargetPanelId) {
                const target = resumeTargetPanelId
                setResumeTargetPanelId(null)
                resumeIntoPanel(id, target)
                return
              }
              if (openIds.includes(id)) {
                setFocusedId(id)
                return
              }
              const known = sessions.find((s) => s.id === id)
              if (known && !known.running && !known.terminated) {
                // Tracked dormant session — reuse the sidebar resume flow.
                void handleSelect(id)
              } else if (known?.running) {
                openSession(id, known.lastTurnAt)
              } else {
                // Unknown (CLI-created) or not-yet-tracked session: resume
                // directly. The server adopts it into the store, then we
                // open the panel. resumeSession surfaces any error toast.
                void resumeSession(id, (res) => openSession(id, res.session.lastTurnAt))
              }
            }}
            onCancel={() => { setResumeDialogOpen(false); setResumeTargetPanelId(null) }}
          />
        </Suspense>
      )}

      {helpPresence.shouldRender && (
        <Suspense fallback={null}>
          <ShortcutHelp
            open={helpOpen}
            onClose={() => setHelpOpen(false)}
            shortcuts={shortcuts}
            commands={helpCommands}
          />
        </Suspense>
      )}

      {globalSettingsPresence.shouldRender && (
        <Suspense fallback={null}>
          <GlobalSettingsModal
            open={globalSettingsOpen}
            onClose={() => setGlobalSettingsOpen(false)}
            onSaved={handleGlobalSettingsSaved}
            updateInfo={updateInfo.info}
            updateRefreshing={updateInfo.refreshing}
            updateError={updateInfo.error}
            onRefreshUpdate={updateInfo.refresh}
            updating={updateInfo.updating}
            onUpdate={updateInfo.update}
          />
        </Suspense>
      )}

      {/* Composer snippet dialogs — rendered ONCE at app level (a single
          global instance shared by every panel). Use .perm-overlay which
          covers the viewport and centers the card. */}
      {(() => {
        const snippetSave = snippetSavePresence.value
        if (!snippetSave) return null
        return (
          <Suspense fallback={null}>
            <PromptDialog
              open={pendingSnippetSave != null}
              title="Save snippet"
              message={
                <>
                  <p>Pick a label for this snippet. The current composer text will be saved as its content.</p>
                  <pre className="snippet-save-preview">{snippetSave.content}</pre>
                </>
              }
              defaultValue=""
              confirmLabel="Save"
              placeholder="Snippet label"
              onConfirm={(label) => {
                snippets.add(label, snippetSave.content)
                setPendingSnippetSave(null)
              }}
              onCancel={() => setPendingSnippetSave(null)}
            />
          </Suspense>
        )
      })()}

      {snippetsManagerPresence.shouldRender && (
        <Suspense fallback={null}>
          <SnippetsManagerDialog
            open={showSnippetsManager}
            api={snippets}
            onClose={() => setShowSnippetsManager(false)}
          />
        </Suspense>
      )}
    </div>
    </ErrorBoundary>
  )
}
