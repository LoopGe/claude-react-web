// Top-level layout: left sidebar (sessions), center pane with up to 3
// Chat panels side-by-side. Session Settings now renders as a per-panel
// overlay (inside ChatPanel) rather than a right drawer — see below.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { PanelSlot } from './components/PanelSlot'
import { api } from './hooks/useApi'
import { isInAppDrag, readDragPayload } from './hooks/useDragPayload'
import { useIsMobile } from './hooks/useIsMobile'
import { useSwipeToClose } from './hooks/useSwipeToClose'
import { useVisualViewportHeight } from './hooks/useVisualViewportHeight'
import { useKeyboardShortcuts, type Shortcut } from './hooks/useKeyboardShortcuts'
import { useHeldModifiers } from './hooks/useHeldModifiers'
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
import { usePluginRegistry } from './app-plugins/usePluginRegistry'
import { usePluginCommands } from './app-plugins/usePluginCommands'
import { PluginWidgetSlot } from './app-plugins/PluginWidgetSlot'
import { buildWhenContext, whenHolds } from './app-plugins/when'
import type { PaletteItem } from './components/CommandPalette'
import type { WsServerFrame } from './ws-types'
import type { MessageSearchHit } from '../shared/search-results'
import type { MessageJumpTarget } from '../shared/message-jump'
import { firstPartyOverridesForCreate } from '../shared/session-info'
import type { NewSessionForm, PermissionMode, SessionInfo, SessionGroup, SidebarSection } from './types'
import { PERMISSION_MODE_CYCLE } from './types'
import { ACCENT_COLORS } from './theme'
import { AppearancePanel } from './components/AppearancePanel'
import { ProfileSwitcher } from './components/ProfileSwitcher'
import { ErrorBoundary } from './components/ErrorBoundary'
import { IconSettings, IconBellToggle, IconMenu, IconSidebar, IconFolderSearch } from './components/icons/ToolIcons'
import { UpdateBanner } from './components/UpdateBanner'
import { useUpdateInfo } from './hooks/useUpdateInfo'
import { useUiState } from './hooks/useUiState'
import { sessionStoreRegistry } from './session-store/registry'
import { useAppOverlays } from './app/useAppOverlays'
import { useExitPresence } from './hooks/useExitPresence'
import { AnimatePresence } from 'motion/react'
import { createCallbackRegistry, type CallbackRegistry } from './utils/callbackRegistry'
import { shouldAutoResumeOnSelect } from './utils/select-resume'

// How long the evicted session X fades out (WAAPI, opacity only) before the
// atomic X→Y swap commits. The replacement Y then fades in over X's empty
// slot, so the two fades together read as one in-place replacement. See
// swapSession.
const SWAP_EXIT_MS = 160

// Lazy-load heavy modal/overlay components that are only shown on demand.
// This keeps the initial bundle lean — the user pays the download cost
// only when they actually open the palette, settings, or help modal.
//
// SetupPage is also lazy: only first-time / unconfigured users hit it,
// and it pulls in ~1150 lines of UI that returning users never see.
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const ResumeSessionDialog = lazy(() => import('./components/session-list/ResumeSessionDialog').then((m) => ({ default: m.ResumeSessionDialog })))
const ShortcutHelp = lazy(() => import('./components/ShortcutHelp').then((m) => ({ default: m.ShortcutHelp })))
const GlobalSettingsModal = lazy(() => import('./components/GlobalSettingsModal').then((m) => ({ default: m.GlobalSettingsModal })))
const SetupPage = lazy(() => import('./components/SetupPage').then((m) => ({ default: m.SetupPage })))
const SnippetsManagerDialog = lazy(() => import('./components/SnippetsManagerDialog').then((m) => ({ default: m.SnippetsManagerDialog })))
const PromptDialog = lazy(() => import('./components/PromptDialog').then((m) => ({ default: m.PromptDialog })))
const UploadsManagerDialog = lazy(() => import('./components/UploadsManagerDialog').then((m) => ({ default: m.UploadsManagerDialog })))
const StructuredPanel = lazy(() => import('./components/StructuredPanel').then((m) => ({ default: m.StructuredPanel })))

import {
  SIDEBAR_COLLAPSED_KEY,
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
import { setMaxUploadBytes } from './hooks/config-store'
import { closeGroupPanelsState } from './utils/group-panels'
import { inheritGroupId, inheritSidebarOrderId, joinGroupOfSource } from './utils/session-slot'
import { buildNewLikeThisForm } from './utils/new-like-this'
import { notificationTooltip } from './utils/notifications'
import { computeUnread, bumpLastSeen, pruneLastSeen } from './utils/unread'
import { randomId } from './utils/uuid'
import { escapeAction } from './utils/escape-action'
import { prepareGroupFlip } from './utils/flip'

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
  /** Replacement sessions announced by the server before their source-group
   * membership has been applied locally. They must not flash under Ungrouped
   * while the independent UI-state store catches up. */
  const [pendingGroupInheritance, setPendingGroupInheritance] = useState<Map<string, { sourceId: string; evicting: boolean; replaces?: boolean }>>(new Map())
  // False until the first sessions-snapshot frame arrives over WS. Drives a
  // sidebar skeleton so "No sessions yet" doesn't flash before the list loads.
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  /** Becomes true the moment the first sessions-snapshot frame is observed.
   *  Used inside the WS listener (which closes over state once on mount) to
   *  branch on "this is the first snapshot" without re-registering the
   *  listener every time `sessionsLoaded` flips. */
  const firstSnapshotSeenRef = useRef(false)
  /** Ids playing the local delete-exit animation while the server DELETE is
   *  in flight. The session is removed from the list once the delete lands. */
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(new Set())
  /** Synchronous re-entrancy gate for handleDelete (deletingSessionIds is
   *  state, so it can't gate the same-tick double-fire). Mirrors
   *  deletingSessionIds; entries are removed when the delete settles. */
  const deletingIdsRef = useRef<Set<string>>(new Set())
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
  /** External composer-focus signals for the three main-grid slots. The
   *  mod+1/2/3 shortcuts bump slot i's counter so the target panel's
   *  <Composer> refocuses after switching (Composer refocuses whenever its
   *  `focusSignal` prop changes). Monotonic counters — only the value
   *  *changing* matters, never the value itself. */
  const [panelFocusSignals, setPanelFocusSignals] = useState<[number, number, number]>([0, 0, 0])
  /** Held key-hint modifiers. Ctrl/Cmd lights up the slot pills (mod+1/2/3),
   *  Alt reveals the group-pill number badges (alt+1..9). Re-renders only on
   *  actual modifier press/release. */
  const heldModifiers = useHeldModifiers()
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
  /** Global UI-pref defaults (server-backed, config.json). Sessions without
   *  an explicit per-session override inherit these. Refreshed live whenever
   *  the global settings modal saves (handleGlobalSettingsSaved →
   *  refreshConfigResponse). `firstPartyTools` is the structured global
   *  default map (GET /config folds the legacy `appToolsGit` boolean into
   *  it at load, so the map is always authoritative). Defaults to undefined
   *  so the first-party UI falls back to live tool status until the first
   *  /config fetch lands. */
  const [globalPrefs, setGlobalPrefs] = useState<{
    showPinnedUserMessage: boolean
    autoRecap: boolean
    firstPartyTools?: Record<string, { enabled: boolean }>
  }>({ showPinnedUserMessage: true, autoRecap: true })
  const {
    settingsOpenFor,
    settingsTabRequest,
    gitPanelOpenFor,
    tasksPanelOpenFor,
    handleCloseTasksPanel,
    handleOpenTasksPanel,
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
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
  const [structuredOpen, setStructuredOpen] = useState(false)
  // The last interrupt fired for a session, keyed by session id. Esc is
  // context-sensitive by turn state (working → interrupt, idle → resume
  // picker), so an impatient double-press while a turn runs would otherwise
  // land "interrupt + immediately open resume picker" — the timestamp
  // suppresses the trailing press (escapeAction's window). Keyed per
  // session so interrupting in one panel never suppresses an idle Esc in
  // another. Written by the Escape handler AND by Chat's interrupt path
  // (onInterruptFired) so the Composer button's interrupt arms the same
  // suppression window.
  const lastInterruptRef = useRef<{ sessionId: string; at: number } | null>(null)
  // When set, the resume picker was opened from a panel's `/resume` local
  // command: the chosen session should REPLACE this panel's slot rather than
  // open in a new panel. Null = the global (Mod+Shift+O) resume flow.
  const [resumeTargetPanelId, setResumeTargetPanelId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false)
  const [messageJumpTarget, setMessageJumpTarget] = useState<MessageJumpTarget | null>(null)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [uploadsDialogOpen, setUploadsDialogOpen] = useState(false)
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
    loading: uiStateLoading,
  } = useUiState()

  // Composer snippets — a SINGLE global instance shared by every panel
  // (previously each Chat panel owned its own copy). Backed by the server
  // (/api/snippets → disk) so they survive reloads and never disagree
  // between panels. The manager + save dialogs render once at this level.
  const snippets = useComposerSnippets()
  const [showSnippetsManager, setShowSnippetsManager] = useState(false)
  /** Set when the user picks "Save current input as snippet…  in a panel's
   *  composer. Holds the textarea snapshot so later edits don't mutate the
   *  captured content before the label is confirmed. */
  const [pendingSnippetSave, setPendingSnippetSave] = useState<{ content: string } | null>(null)
  // The App-root modal only renders for the global / empty-state flow
  // (resumeTargetPanelId === null). When a panel is targeted the picker
  // renders inside that panel's <Chat> as a column-scoped overlay instead,
  // so the global modal's presence is gated off here.
  const resumeDialogPresence = useExitPresence(resumeDialogOpen && resumeTargetPanelId === null)
  const globalSettingsPresence = useExitPresence(globalSettingsOpen)
  const uploadsDialogPresence = useExitPresence(uploadsDialogOpen)
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
   *  capacity. Server-driven via /api/config → config.json. */
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

  /** Desktop sidebar hide/show. Persisted so a reload restores the state;
   *  expanding keeps the drag-resized width (see --sidebar-width below). */
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(SIDEBAR_COLLAPSED_KEY, false)

  // Groups are optional — sessions without a group appear in the
  // "Ungrouped" sidebar section. No default group is auto-created.

  const { sidebarWidth: effectiveSidebarWidth, sidebarResize, setSidebarWidth } = useSidebarResize({ minPx: sidebarMinPx, maxPx: sidebarMaxPx })

  // Resolved open ids — `openIds` filtered to ids that actually resolve to a
  // SessionInfo. The grid template + divider handlers must be built from THIS
  // set (what's actually rendered), not the raw `openIds`: an unknown id could
  // otherwise sit in `openIds` without a matching session and de-sync the grid
  // tracks from the rendered children (the single empty-state child would land
  // in the first of several columns, shifting it left).
  const resolvedOpenIds = useMemo(
    () => openIds.filter((id) => sessions.some((s) => s.id === id)),
    [openIds, sessions],
  )

  const { gridTemplate, onDividerMouseDown, draggingDivider, bodyRef, setPanelRatios, effectiveRatios } = usePanelColumnResize({ openIds: resolvedOpenIds, panelMinRatio })

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
      const leftId = resolvedOpenIds[index]
      const rightId = resolvedOpenIds[index + 1]
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
    [resolvedOpenIds, effectiveRatios, setPanelRatios, panelMinRatio],
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
        if (r.maxUploadBytes != null) setMaxUploadBytes(r.maxUploadBytes)
        setGlobalPrefs({
          showPinnedUserMessage: r.showPinnedUserMessage ?? true,
          autoRecap: r.autoRecap ?? true,
          firstPartyTools: r.firstPartyTools,
        })
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
  const resumeTargetPanelIdRef = useRef(resumeTargetPanelId)
  const maxOpenRef = useRef(maxOpen)
  const maxGroupSizeRef = useRef(maxGroupSize)
  const groupsRef = useRef(groups)
  const activeGroupIdRef = useRef<string | null>(null)
  /** Forward ref to animatePanels (declared much later). closeSession /
   *  handleAddToGroup / handleReorderSidebar all need to FLIP-animate the
   *  surviving panels when openIds shrinks or grows, but animatePanels
   *  lives next to its sibling panel-grid machinery hundreds of lines
   *  down. Bridging through a ref keeps the related code grouped without
   *  causing TDZ violations. */
  const animatePanelsRef = useRef<((...ids: string[]) => void) | null>(null)
  const helpOpenRef = useRef(helpOpen)
  const handleSelectRef = useRef<(id: string, opts?: { auto?: boolean }) => void>(() => {})
  const handleDeleteRef = useRef<(id: string) => void>(() => {})
  const jumpNonceRef = useRef(0)
  /** Ids mid-/clear. While a clear is in flight, the server broadcasts
   *  `session-removed` for X (it drops X from the store so X leaves the
   *  sidebar, transcript kept for resume). That `removed` frame can land
   *  BEFORE the /clear POST response that drives the X→Y panel swap — and
   *  the default `session-removed` handler closes the panel slot / evicts X
   *  from its group, which would pre-empt the swap. So while an id is in
   *  this set, the `session-removed` handler skips everything except
   *  dropping X from the sidebar list; `handleClear`'s swap owns the slot. */
  const clearingIdsRef = useRef<Set<string>>(new Set())
  // State mirror of clearingIdsRef so the cleared panel can re-render to show
  // the clearing blur (view-only — does NOT gate the data swap). The WS guard
  // reads the ref; the UI reads the state. Same state+ref-mirror pattern as
  // openIds/openIdsRef.
  const [clearingIds, setClearingIds] = useState<Set<string>>(new Set())
  // Set by the guarded `session-removed` handler when the server has confirmed
  // X's removal during a /clear. Read by handleClear's catch to distinguish
  // "server processed the clear but the POST response was lost" (X is dead →
  // evict the stale slot) from "server never acted" (X is live → keep it).
  const clearingServerRemovedRef = useRef<Set<string>>(new Set())
  // In-flight /clear count per id (same-tab double-/clear). The `finally`
  // releases the guard + blur only when the count hits 0 — so a short-circuited
  // second call (server declined because the first is still in flight) doesn't
  // tear down state the first call still owns, AND a single-call short-circuit
  // (stuck server `clearing` flag / cross-tab) still cleans up instead of
  // leaving the panel blurred forever.
  const clearingInFlightRef = useRef<Map<string, number>>(new Map())
  // ids just swapped in by `swapSession` (X→Y). Read+cleared by the
  // exit-detection layout effect to suppress the closing-ghost ONLY for true
  // swaps — not for maxOpen eviction / single-panel switch / slot drag-replace,
  // which are also length-preserving 1-for-1 openIds changes but genuine
  // closes that should play the ghost.
  const justSwappedInRef = useRef<Set<string>>(new Set())
  // Forward-declared ref for `teardownRemovedSession` (declared later, after
  // its deps). The WS `session-removed` handler (in an effect above) calls it
  // via this ref to avoid a use-before-declaration; synced at render time
  // where the callback is defined. Same pattern as `animatePanelsRef`.
  const teardownRemovedSessionRef = useRef<((id: string) => void) | null>(null)
  // Per-session interrupt callbacks registered by <Chat> components.
  // The ESC shortcut in the keyboard handler uses this to trigger the
  // same code-path as the Composer's interrupt button.
  //
  // Each registry returns a stale-guarded unregister so a <Chat> unmount
  // (panel close / session switch / delete) drops its entry. The previous
  // `useRef<Map>` only ever `.set()` and never `.delete()`, so closed
  // sessions leaked their callback closures — and the component scope each
  // captured — for the lifetime of the tab.
  const interruptFnsRef = useRef<CallbackRegistry<() => void>>(createCallbackRegistry())
  const registerInterrupt = useCallback((sessionId: string, fn: () => void) => {
    return interruptFnsRef.current.register(sessionId, fn)
  }, [])
  // Per-session recap-refresh callbacks registered by <Chat> components.
  // Enables the Alt+R shortcut to trigger a recap fetch for the focused session.
  const recapFnsRef = useRef<CallbackRegistry<() => void>>(createCallbackRegistry())
  const registerRecap = useCallback((sessionId: string, fn: () => void) => {
    return recapFnsRef.current.register(sessionId, fn)
  }, [])
  // Per-session background-tasks callbacks registered by <Chat> components.
  // Enables the Alt+B shortcut to background in-flight tasks for the focused
  // session.
  const backgroundFnsRef = useRef<CallbackRegistry<() => void>>(createCallbackRegistry())
  const registerBackground = useCallback((sessionId: string, fn: () => void) => {
    return backgroundFnsRef.current.register(sessionId, fn)
  }, [])
  // Per-session "turn active" getters registered by <Chat> components.
  // The escape handler consults this alongside session.working: right
  // after a send, the server snapshot hasn't flipped working=true yet
  // (~1 frame + network), and an Esc in that gap should interrupt the
  // just-started turn, not open the resume picker. Chat owns the
  // optimistic signal (pendingTurnSince — the same bridge that keeps the
  // WorkingBubble mounted across the gap).
  const turnActiveFnsRef = useRef<CallbackRegistry<() => boolean>>(createCallbackRegistry())
  const registerTurnActive = useCallback((sessionId: string, fn: () => boolean) => {
    return turnActiveFnsRef.current.register(sessionId, fn)
  }, [])
  // Stamp the post-interrupt suppression window (see lastInterruptRef).
  // Called by the Escape handler's interrupt path and by <Chat>'s own
  // interrupt funnel (the Composer button) via onInterruptFired, so every
  // interrupt — not just the keyboard one — arms the window.
  const handleInterruptFired = useCallback((sessionId: string) => {
    lastInterruptRef.current = { sessionId, at: Date.now() }
  }, [])
  // Per-session input-injection callbacks registered by <Chat> components.
  // Keep refs in sync with the latest state values. Assigned directly
  // in the render body (before return) so callbacks that capture these
  // refs always read the current values — no useEffect needed.
  /* eslint-disable react-hooks/refs -- intentional render-time ref sync; the alternative (useEffect) would lag by one render and break stale-closure callbacks downstream */
  openIdsRef.current = openIds
  focusedIdRef.current = focusedId
  sessionsRef.current = sessions
  resumeTargetPanelIdRef.current = resumeTargetPanelId
  groupsRef.current = groups
  resumingRef.current = resuming
  maxOpenRef.current = maxOpen
  maxGroupSizeRef.current = maxGroupSize
  helpOpenRef.current = helpOpen

  // Close the in-panel history overlay when its host panel goes away (no
  // focused panel can render it). Without this, closing the focused panel
  // while the overlay is open would leave historyPanelOpen=true — invisible
  // (no panel mounts it) — and then pop over the next panel that gets focused.
  /* eslint-disable react-hooks/set-state-in-effect -- mirrors the focus-driven
     close pattern; only fires when focusedId transitions to null */
  useEffect(() => {
    if (focusedId == null) setHistoryPanelOpen(false)
  }, [focusedId])
  /* eslint-enable react-hooks/set-state-in-effect */
  /* eslint-enable react-hooks/refs */

  // DEBUG: expose a runtime group-state dump on window for console use.
  // Mounted once (empty deps); the function reads live refs at call time, so
  // it always reflects current state with zero ongoing cost — no subscriptions,
  // no polling, no extra renders. Gated on `import.meta.env.DEV` so vite
  // tree-shakes it out of the production bundle — available in `npm run dev`,
  // absent from the shipped `npx` binary. Call `window.__dumpGroupState()`
  // from DevTools.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    type Dump = () => unknown
    const dump: Dump = () => {
      const groups = groupsRef.current
      const openIds = openIdsRef.current
      const active = activeGroupIdRef.current
      const sessions = sessionsRef.current
      const title = (id: string) => sessions.find((s) => s.id === id)?.title ?? '(untitled)'
      console.log('%c=== GROUP STATE (runtime) ===', 'font-weight:bold;color:#6cf')
      for (const g of groups) {
        console.group(`[${g.name}]  ${g.sessionIds.length} members  id=${g.id}`)
        g.sessionIds.forEach((id, i) => console.log(`${i}: ${id}  ->  ${title(id)}`))
        console.groupEnd()
      }
      const activeGroup = groups.find((g) => g.id === active)
      console.log(
        `activeGroupId: ${active ?? '(null)'}${activeGroup ? ` (${activeGroup.name})` : ''}`,
      )
      console.log(
        'openIds:',
        openIds.map((id) => `${id} -> ${title(id)}`),
      )
      const raw = {
        groups,
        openIds,
        activeGroupId: active,
        sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
      }
      console.log('raw ->', raw)
      return raw
    }
    const w = window as unknown as { __dumpGroupState?: Dump }
    w.__dumpGroupState = dump
    return () => {
      delete w.__dumpGroupState
    }
  }, [])

  // When the panel capacity shrinks (e.g. desktop → mobile resize/rotation
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
  const { notifications, maybeNotify, maybePermissionNotify, maybeCliNotify, seedWorkingState, pruneSession, dismissPermissionToast } =
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
          setPendingGroupInheritance((prev) => {
            const liveIds = new Set(frame.sessions.map((s) => s.id))
            const next = new Map(prev)
            for (const [newId, pending] of next) {
              // A reconnect snapshot is authoritative for the live session
              // set. If either side of the inheritance is gone, no later
              // session-removed frame can resolve this marker.
              if (!liveIds.has(newId) || !liveIds.has(pending.sourceId)) next.delete(newId)
            }
            return next.size === prev.size ? prev : next
          })
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
          // the window is focused, the user is actively watching it —
          // bump lastSeenTurn so a new turn doesn't render as unread
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
          // A (re-)created session is not mid-delete-animation. Clear any
          // stale deletingSessionIds entry left by a prior delete of the same
          // id (e.g. a session deleted via /resume-replace, then re-resumed
          // from the picker). The updater is a no-op when the id isn't
          // present, so no state read is needed (keeps this WS handler free
          // of stale closures).
          const sid = frame.session.id
          setDeletingSessionIds((prev) => (prev.has(sid) ? new Set([...prev].filter((x) => x !== sid)) : prev))
          // Seed the edge-detector so a session that spawns already
          // working doesn't fire a notification on its first true→ false
          // transition when the user is still watching it.
          seedWorkingState(frame.session.id, frame.session.working)
          // `/clear`, restart, and fork all spawn a fresh session Y that
          // should land in an existing session X's group. The server tags
          // this frame with `joinGroupOf` = X. Append Y to X's group NOW,
          // in the same batch as `setSessions` above, so neither X nor Y
          // flashes under "Ungrouped" before the POST response runs.
          //
          // APPEND (not replace) is deliberate: X is still in `sessions`
          // until the POST-driven `swapSession` (clear/restart, same tab) or
          // `session-removed(X)` (cross-tab) evicts it. Replacing X→Y here
          // would evict X from its group while X is still in `sessions`,
          // flashing X under "Ungrouped". Appending keeps X grouped until
          // it's actually gone, so no flash. `swapSession`/`handleAddToGroup`
          // are idempotent over an already-appended Y (dedup).
          //
          // sidebarOrder is intentionally NOT touched here: swapSession
          // (clear/restart) replaces X→Y in order; for fork, Y is appended to
          // the order by orderedSessions' unknown-id fallback. Touching it
          // here would risk the same evict-X-while-present flash on order.
          const joinGroupOf = frame.joinGroupOf
          if (joinGroupOf && joinGroupOf !== sid) {
            // Keep the relationship even when groups are still hydrating. The
            // pending marker prevents Y from rendering as Ungrouped until the
            // source group becomes available (or the source is confirmed to be
            // ungrouped).
            setPendingGroupInheritance((prev) => {
              const next = new Map(prev)
              next.set(sid, {
                sourceId: joinGroupOf,
                evicting: frame.evictingSource === true,
                replaces: frame.replacesSource === true,
              })
              return next
            })
            // For /clear + restart (`evictingSource` true): X is being evicted by
            // the POST-driven swapSession (same tab) or session-removed
            // (cross-tab), and that path places Y EXACTLY in X's slot. We
            // deliberately do NOT append Y to the group here: appending would
            // flash Y at the group tail for the 80-140ms before the POST swap —
            // shoving the following cards down and then back, and reading as a
            // "Y first appears in the wrong place" teleport. The pending marker
            // above keeps Y hidden (not rendered as Ungrouped, not rendered at
            // the tail) until swapSession/teardown places it.
            //
            // For crash-recovery fork (`replacesSource` true): X is dead, Y is
            // its continuation. REPLACE X with Y in the group and sidebar order
            // so Y lands in X's exact slot — even when the group is full (X
            // leaves, so the group never exceeds maxGroupSize). X stays in the
            // sidebar as a dead artifact (ungrouped).
            //
            // For user fork (`evictingSource`/`replacesSource` absent) X stays,
            // so append now so the forked session lands in its source's group
            // immediately; the maxGroupSize cap stands and handleAddToGroup can
            // toast on overflow.
            if (frame.evictingSource === true) {
              // /clear + restart: swapSession/teardown places Y — nothing to do here.
            } else if (frame.replacesSource === true) {
              setGroups((prev) => inheritGroupId(prev, joinGroupOf, sid))
              setSidebarOrder((prev) => inheritSidebarOrderId(prev, joinGroupOf, sid))
            } else {
              setGroups((prev) =>
                joinGroupOfSource(prev, joinGroupOf, sid, {
                  evicting: false,
                  maxGroupSize: maxGroupSizeRef.current,
                }),
              )
            }
          }
          break
        }
        case 'session-removed': {
          // /clear broadcasts `removed` for X (server drops X from the store
          // so the transcript is detached; kept for resume). The `removed`
          // frame can land before handleClear's atomic X→Y swap (driven by
          // the POST response). While X is mid-clear, skip ALL teardown —
          // INCLUDING the `setSessions` removal — so X stays fully alive in
          // sessions/openIds/groups until handleClear's `swapSession` replaces
          // it atomically. This keeps the sidebar (group row) and panel grid
          // stable across the WS-vs-POST race (no shrink, no compaction).
          // Record that the server confirmed X's removal so handleClear's
          // error path can tell a dead X (server processed, response lost)
          // from a live one (server never acted).
          if (clearingIdsRef.current.has(frame.id)) {
            clearingServerRemovedRef.current.add(frame.id)
            break
          }
          // Full teardown (shared with handleClear's error path).
          teardownRemovedSessionRef.current?.(frame.id)
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
        case 'cli-notification': {
          // CLI notification frames (SDK system/notification mirrored onto
          // the global channel): "waiting for your input", idle nudges, …
          // Routed through the same presentation-gated trigger as permission
          // requests — toast when the user is elsewhere in the page, OS
          // notification when the window is unfocused, nothing when they're
          // watching the session.
          maybeCliNotify(frame.sessionId, frame.notification)
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
  }, [hub, maybeNotify, maybePermissionNotify, maybeCliNotify, seedWorkingState, pruneSession, dismissPermissionToast, setLastSeenTurn, setSidebarOrder, setGroups])

  // Hub status → reconnecting banner is derived inline (single ternary
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
   *  - Already open → just focus it, no reshuffle.
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

  /** Tear down the Side Chat hosted on `parentId` (if any): drop the drawer
   *  state, DELETE the ephemeral session, purge its transcript cache. Mirrors
   *  the block that used to live inline in `closeSession`; extracted so
   *  `handleClear`'s swap path can reuse it (it doesn't go through
   *  closeSession, and the guarded `session-removed(X)` skips the side-chat
   *  teardown at App.tsx:814-823 — so without this, /clear on a panel hosting
   *  a side chat leaked the ephemeral session). */
  const cleanupSideChat = useCallback((parentId: string) => {
    if (sideChatRef.current?.parentId === parentId) {
      const sideId = sideChatRef.current.session.id
      setSideChat(null)
      void api.delete(`/sessions/${sideId}`).catch(() => {})
      sessionStoreRegistry.delete(sideId)
    }
  }, [])

  /** Atomic local X→Y session swap. In one batched state update, replaces
   *  `oldId` with `newId`/`newSession` everywhere a session id is tracked:
   *  sessions (remove old, upsert new at old's position), openIds, focusedId,
   *  groups (sessionIds), sidebarOrder, lastSeenTurn. Used by /clear, restart
   *  and discard. Driven by the POST response (which carries Y), so `sessions`
   *  carries Y the instant openIds adopts it — no gap for the WS
   *  session-created/session-removed frames to race. Those frames are
   *  idempotent confirmations. Also marks newId in `justSwappedInRef` so the
   *  exit-detection effect suppresses the closing-ghost for the swap (true
   *  swaps only — evictions/replaces still animate). openIds and groups swap
   *  together, so activeGroupId stays consistent (no null-flicker).
   *
   * Before the commit, X fades out in place (WAAPI, opacity only) so the
   * eviction reads as a smooth in-place replacement: every surviving card's
   * position is unchanged (Y takes X's exact slot), so there is deliberately
   * no FLIP/slide — only X dims out and Y dims in over the same slot. The
   * fade is skipped for reduced-motion and when X's card isn't currently
   * rendered. Callers should `await` this so the clearing guard stays armed
   * through the fade. */
  const swapSession = useCallback(
    async (oldId: string, newId: string, newSession: SessionInfo) => {
      if (oldId === newId) return
      // Fade X out in place before the atomic swap unmounts it — otherwise X
      // pops out in the same frame Y appears, which reads as "remove then add".
      // Opacity only: no translateY (Y inherits X's slot, so there's no motion
      // for a slide to add — a positional nudge would read as jitter).
      const xEl = document.querySelector<HTMLElement>(`[data-session-card-id="${oldId}"]`)
      if (xEl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        try {
          const anim = xEl.animate(
            [
              { opacity: 1 },
              { opacity: 0 },
            ],
            { duration: SWAP_EXIT_MS, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
          )
          await anim.finished
        } catch {
          /* element removed mid-fade (e.g. cross-tab) — proceed with the swap */
        }
      }
      // Mark the swap so the exit-detection effect suppresses X's closing-ghost
      // (true swap → Y fades in via .entering). Callers pass an OPEN panel's id
      // (oldId ∈ openIds), so the swap always changes openIds and exit-detection
      // runs to consume this marker — no stale-entry risk.
      justSwappedInRef.current.add(newId)
      // Commit the swap synchronously so Y's card is in the DOM before we look
      // it up for the fade-in below. In async contexts (this POST continuation)
      // React 19's scheduler would otherwise defer the commit to a
      // MessageChannel macrotask, leaving Y's card unmounted here.
      flushSync(() => {
        setPendingGroupInheritance((prev) => {
          if (!prev.has(newId)) return prev
          const next = new Map(prev)
          next.delete(newId)
          return next
        })
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === oldId)
          const withoutOld = idx === -1 ? prev : prev.filter((s) => s.id !== oldId)
          const existing = withoutOld.findIndex((s) => s.id === newId)
          if (existing >= 0) {
            // session-created(Y) already landed — refresh in place.
            const next = withoutOld.slice()
            next[existing] = newSession
            return next
          }
          // Insert Y at X's old position so it inherits X's sidebar slot.
          const next = withoutOld.slice()
          next.splice(idx === -1 ? withoutOld.length : idx, 0, newSession)
          return next
        })
        setOpenIds((prev) => prev.map((id) => (id === oldId ? newId : id)))
        setFocusedId((prev) => (prev === oldId ? newId : prev))
        setGroups((prev) => inheritGroupId(prev, oldId, newId))
        setSidebarOrder((prev) => inheritSidebarOrderId(prev, oldId, newId))
        setLastSeenTurn((prev) => {
          const next = { ...prev }
          delete next[oldId]
          next[newId] = newSession.lastTurnAt ?? Date.now()
          return next
        })
      })
      // Fade the replacement in over X's now-empty slot — the in-place half of
      // the X-out/Y-in swap. batch1 no longer appends Y for evicting clears
      // (it stays pending/hidden), so Y mounts here for the first time;
      // `fill: 'backwards'` applies the transparent start keyframe in the same
      // frame the card mounts (before the browser paints), so there's no
      // opacity-1 flash.
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const yEl = document.querySelector<HTMLElement>(`[data-session-card-id="${newId}"]`)
        if (yEl) {
          try {
            yEl.animate(
              [{ opacity: 0 }, { opacity: 1 }],
              { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
            )
          } catch {
            /* element removed (e.g. cross-tab) — skip */
          }
        }
      }
    },
    [setGroups, setLastSeenTurn, setSidebarOrder],
  )

  /** Full teardown for a session that's been removed server-side: drop it from
   *  sessions/openIds/focusedId/lastSeenTurn/sidebarOrder/groups, prune the
   *  notification edge-detector + callback registries, clear pending-delete
   *  state, and clean up a hosted side chat. Shared by the `session-removed`
   *  WS handler (cross-tab + local deletes) and `handleClear`'s error path
   *  (server processed the clear but the POST response was lost — X is dead
   *  and must be fully evicted, not just dropped from the panel). */
  const teardownRemovedSession = useCallback(
    (id: string) => {
      // A cross-tab clear can deliver session-removed(X) after the created(Y)
      // frame but before this tab has applied Y's inherited group. Preserve the
      // replacement in X's group before removing X; otherwise clearing the
      // pending marker below would make Y flash under Ungrouped.
      const pendingReplacements = [...pendingGroupInheritance].filter(([, pending]) => pending.sourceId === id)
      if (pendingReplacements.length > 0) {
        setGroups((prev) => {
          let next = prev
          for (const [newId, pending] of pendingReplacements) {
            next = joinGroupOfSource(next, id, newId, {
              evicting: pending.evicting,
              maxGroupSize: maxGroupSizeRef.current,
            })
          }
          return next
        })
      }
      setPendingGroupInheritance((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [newId, pending] of next) {
          if (newId === id || pending.sourceId === id) {
            next.delete(newId)
            changed = true
          }
        }
        return changed ? next : prev
      })
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setOpenIds((prev) => prev.filter((x) => x !== id))
      setFocusedId((prev) => (prev === id ? null : prev))
      setLastSeenTurn((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      pruneSession(id)
      setDeletingSessionIds((prev) => (prev.has(id) ? new Set([...prev].filter((x) => x !== id)) : prev))
      interruptFnsRef.current.delete(id)
      recapFnsRef.current.delete(id)
      backgroundFnsRef.current.delete(id)
      turnActiveFnsRef.current.delete(id)
      setSidebarOrder((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
      setGroups((prev) => {
        let changed = false
        const next = prev.map((g) => {
          if (!g.sessionIds.includes(id)) return g
          changed = true
          return { ...g, sessionIds: g.sessionIds.filter((sid) => sid !== id) }
        })
        return changed ? next : prev
      })
      // Side chat: parent removed (cleanupSideChat) OR the side-chat session
      // itself was removed (inline — cleanupSideChat only covers the parent).
      cleanupSideChat(id)
      if (sideChatRef.current?.session.id === id) {
        const sideId = sideChatRef.current.session.id
        setSideChat(null)
        void api.delete(`/sessions/${sideId}`).catch(() => {})
        sessionStoreRegistry.delete(sideId)
      }
    },
    [cleanupSideChat, pendingGroupInheritance, pruneSession, setGroups, setLastSeenTurn, setSidebarOrder],
  )
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref sync (same pattern as animatePanelsRef): the WS session-removed handler (in an effect above) calls teardownRemovedSession via this ref.
  teardownRemovedSessionRef.current = teardownRemovedSession

  const closeSession = useCallback(
    (id: string) => {
      // If the closed panel hosts a Side Chat, clean up the ephemeral session.
      // The drawer's animation-driven close path also DELETEs, but we may
      // never reach it here (the drawer unmounts as soon as its parent panel
      // closes, skipping the animation). Fire-and-forget guarantees cleanup.
      cleanupSideChat(id)
      // A group is a synced workspace, so closing a group member's panel
      // removes it from the group (it drops to the sidebar's "Ungrouped"
      // section) rather than merely hiding it — keeping open panels in
      // sync with membership. Ungrouped sessions just close. performDelete
      // removes from the group separately too, so this is redundant-but-
      // harmless there.
      const owner = groupsRef.current.find((g) => g.sessionIds.includes(id))
      if (owner) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === owner.id ? { ...g, sessionIds: g.sessionIds.filter((sid) => sid !== id) } : g,
          ),
        )
      }
      // Both state updates are derived from the fresh openIds snapshot
      // inside a single updater, avoiding the fragile cross-updater
      // side-effect pattern. The setFocusedId call is issued from
      // inside setOpenIds's updater so `next` is guaranteed to be the
      // post-filter result regardless of batching order.
      // Capture surviving panel positions before openIds shrinks so the
      // FLIP can smoothly grow them into the closed panel's space — the
      // closingPanels ghost handles the exiting panel's fade-out, but
      // without this the survivors snap to their new wider grid track.
      const prevOpen = openIdsRef.current
      const survivors = prevOpen.filter((x) => x !== id)
      if (survivors.length > 0 && survivors.length !== prevOpen.length) {
        animatePanelsRef.current?.(...survivors)
      }
      setOpenIds((prev) => {
        const next = prev.filter((x) => x !== id)
        // Schedule the focusedId update inside this updater where
        // `next` is in scope — safe because React runs functional
        // updaters synchronously within a single batch.
        setFocusedId((f) => (f === id ? (next[next.length - 1] ?? null) : f))
        return next
      })
    },
    [cleanupSideChat, setGroups],
  )

  /** Deactivate a group: close every open panel that belongs to it WITHOUT
   *  touching group membership (the group and its members stay, so the
   *  sidebar header can re-activate it later). This is intentionally a
   *  separate path from `closeSession`, whose synced close==ungroup
   *  semantics would empty the group. The pure transition lives in
   *  `closeGroupPanelsState` so it is unit-testable without mounting App. */
  const closeGroupPanels = useCallback(
    (groupId: string) => {
      const group = groupsRef.current.find((g) => g.id === groupId)
      if (!group) return
      const prevOpen = openIdsRef.current
      const { openIds: nextOpen, focusedId: nextFocused } = closeGroupPanelsState({
        openIds: prevOpen,
        groupSessionIds: group.sessionIds,
        focusedId: focusedIdRef.current,
      })
      // FLIP any surviving (non-group) panels into the freed space, mirroring
      // closeSession. When the group was the whole open set this is a no-op.
      if (nextOpen.length !== prevOpen.length) {
        animatePanelsRef.current?.(...nextOpen)
      }
      setOpenIds(() => nextOpen)
      setFocusedId(() => nextFocused)
    },
    [],
  )

  /** Stable per-group "close all panels" handlers. Passing an inline arrow
   *  `() => closeGroupPanels(owningGroup.id)` in the panel render loop would
   *  mint a fresh function identity on every App render (every WS frame) and
   *  bust memo(ChatPanel) for every grouped panel. This map hands out a stable
   *  identity per group, rebuilding only when the group set itself changes. */
  const closeGroupPanelsHandlers = useMemo(() => {
    const map = new Map<string, () => void>()
    /* eslint-disable react-hooks/refs -- closeGroupPanels only reads refs when
       INVOKED (on click), not here during render; the arrow is a deferred
       closure, not a call, which the rule can't see through. */
    for (const g of groups) map.set(g.id, () => closeGroupPanels(g.id))
    /* eslint-enable react-hooks/refs */
    return map
    // closeGroupPanels is stable ([] deps); rebuild only when the group set
    // changes, not on every render.
  }, [groups, closeGroupPanels])

  /** When an already-open UNGROUPED session (pure-ungrouped view,
   *  activeGroupId=null) joins a group via drag or "Move to group", activate
   *  that group's view — mirror handleSelect (click a group member → sync the
   *  whole group into the grid; focus stays on the dragged session). Gates:
   *  - `prevOpen.includes(sessionId)`: only sessions ALREADY open, so
   *    create/fork (add-then-open) aren't affected — their new id hasn't
   *    reached openIdsRef yet when this runs synchronously.
   *  - no open panel is in any group: only activate from a PURE-ungrouped
   *    view. In a mixed view (some open panel already belongs to a group)
   *    activating would evict that grouped panel, which is surprising.
   *  Returns true when it activated. */
  const activateGroupViewIfOpenUngrouped = useCallback(
    (sessionId: string, groupNewIds: string[], prevGroups: SessionGroup[]): boolean => {
      if (activeGroupIdRef.current !== null) return false
      const prevOpen = openIdsRef.current
      if (!prevOpen.includes(sessionId)) return false
      const inAnyGroup = (id: string) => prevGroups.some((g) => g.sessionIds.includes(id))
      if (prevOpen.some((id) => inAnyGroup(id))) return false
      const live = new Set(sessionsRef.current.map((s) => s.id))
      const groupIds = groupNewIds.filter((id) => live.has(id))
      // Mobile/single-panel cap: if the group can't all fit, keep just the
      // dragged session rather than arbitrarily picking siblings.
      const desired = groupIds.length <= maxOpenRef.current ? groupIds : [sessionId]
      if (desired.length === prevOpen.length && desired.every((id, i) => id === prevOpen[i])) {
        return false
      }
      const survivors = prevOpen.filter((id) => desired.includes(id))
      if (survivors.length > 0) animatePanelsRef.current?.(...survivors)
      setOpenIds(desired)
      return true
    },
    [setOpenIds],
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
      if (!active) {
        // No active group view. If the added session is already open and was
        // ungrouped (e.g. focus is on a single ungrouped panel and the user
        // dragged / moved it into a group), activate that group's view. No-op
        // for create/fork — see activateGroupViewIfOpenUngrouped.
        if (groupId) {
          const target = nextGroups.find((g) => g.id === groupId)
          if (target) activateGroupViewIfOpenUngrouped(sessionId, target.sessionIds, prevGroups)
        }
        return
      }
      const updated = nextGroups.find((g) => g.id === active)
      if (!updated) return
      const prevOpen = openIdsRef.current
      // isGroupView must be checked against the PRE-change group (prevGroups),
      // because prevOpen reflects what's open NOW — for a drag-OUT, prevOpen
      // still contains the session being removed, so checking against the
      // post-change `updated` would always fail and silently skip the sync.
      const prevActiveGroup = prevGroups.find((g) => g.id === active)
      const isGroupView =
        prevActiveGroup != null &&
        prevOpen.length > 0 &&
        prevOpen.every((id) => prevActiveGroup.sessionIds.includes(id))
      if (!isGroupView) return
      const desired = updated.sessionIds.slice(0, maxOpenRef.current)
      const ordered = prevOpen.filter((id) => desired.includes(id))
      for (const id of desired) if (!ordered.includes(id)) ordered.push(id)
      const final = ordered.filter((id) => desired.includes(id)).slice(0, maxOpenRef.current)
      if (final.length === prevOpen.length && final.every((id, i) => id === prevOpen[i])) return
      // FLIP-animate the surviving panels' position+width so they don't
      // teleport to their new grid-template-columns ratio when one panel
      // is added or removed (e.g. dragging a session into / out of the
      // active group). Capture must run before setOpenIds since
      // animatePanels reads current DOM positions synchronously and
      // schedules a rAF that fires after React commits the new layout.
      // Closing panels keep their own ghost-overlay exit animation
      // (`closingPanels`) and entering panels keep their `entering`
      // fade-in — this only smooths the survivors.
      const survivors = prevOpen.filter((id) => final.includes(id))
      if (survivors.length > 0) animatePanelsRef.current?.(...survivors)
      setOpenIds(final)
    },
    [setGroups, maxGroupSize, toast, setOpenIds, activateGroupViewIfOpenUngrouped],
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
        // Add Y to `sessions` locally so openSessions resolves it the instant
        // openIds adopts it below, even if the session-created WS frame lags.
        // The session-created handler refreshes it in place (idempotent — the
        // `some` guard prevents a duplicate if that frame already landed).
        setSessions((prev) => (prev.some((s) => s.id === res.session.id) ? prev : [res.session, ...prev]))

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
        // Add Y to `sessions` locally so openSessions resolves it the instant
        // openIds adopts it below, even if the session-created WS frame lags
        // (session-created refreshes it in place — idempotent).
        setSessions((prev) => (prev.some((s) => s.id === res.session.id) ? prev : [res.session, ...prev]))
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

  /** Crash-recovery fork: fork a terminated session from its last completed
   *  turn (the composer choice-banner button). Distinct from handleFork:
   *  - forkFromLastSafe:true resolves the newest completed turn as the branch
   *    point, dropping a poisonous trailing crash turn.
   *  - replacesSource:true broadcasts the created frame with replacesSource so
   *    the client REPLACES the dead source's sidebar slot (Y lands in X's
   *    slot, X drops to Ungrouped) instead of the append-that-keeps-X of a
   *    manual fork.
   *  No handleAddToGroup here — the replacesSource frame drives group
   *  placement client-side. */
  const handleCrashFork = useCallback(
    async (id: string) => {
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/fork`, {
          forkFromLastSafe: true,
          replacesSource: true,
        })
        // Add Y to `sessions` locally so openSession resolves it the instant
        // openIds adopts it below, even if the session-created WS frame lags
        // (session-created refreshes it in place — idempotent).
        setSessions((prev) => (prev.some((s) => s.id === res.session.id) ? prev : [res.session, ...prev]))
        openSession(res.session.id, res.session.lastTurnAt)
      } catch (e) {
        toast.error(`Couldn't fork session: ${(e as Error).message}`)
      }
    },
    [openSession, toast],
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
      // Form building (context copy, first-party overrides, group inherit +
      // full-group drop) lives in buildNewLikeThisForm — see there.
      await handleCreate(buildNewLikeThisForm(source, sourceGroup, maxGroupSize))
    },
    [sessions, groups, handleCreate, maxGroupSize],
  )

  /** The irreversible part: actually hit the server (which kills the Query
   *  subprocess and erases persistence) and clean up local references.
   *  Used directly by Restart (create-then-delete) and by handleDelete once
   *  the user confirms the delete dialog. */
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

  /** Delete the session immediately. User-facing deletes confirm first via a
   *  ConfirmDialog at the call site (sidebar card / context menu / panel
   *  menu); resume-replace calls this directly without a confirm by design.
   *  There's no Undo grace window. A short local exit animation plays while
   *  the server DELETE is in flight; the card is removed once the
   *  `session-removed` broadcast lands. */
  const handleDelete = useCallback(
    (id: string) => {
      // Re-entrancy guard: a delete for this id is already in flight (e.g. a
      // fast double-click on a confirm button before the dialog unmounts).
      // Without this, the second call would race a second DELETE → 404 toast.
      if (deletingIdsRef.current.has(id)) return
      deletingIdsRef.current.add(id)
      setDeletingSessionIds((prev) => new Set(prev).add(id))
      void performDelete(id).then((deleted) => {
        // Clear the gate either way — a failed delete must be retryable.
        deletingIdsRef.current.delete(id)
        if (deleted) return
        // Delete failed — restore the card by dropping the exit-animation flag.
        setDeletingSessionIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      })
    },
    [performDelete],
  )
  // Stable ref so resumeIntoPanel can call the latest handleDelete without
  // itself depending on it — keeps resumeIntoPanel's identity stable. Same
  // pattern as handleSelectRef.
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref sync
  handleDeleteRef.current = handleDelete

  /** Create a fresh session with the same config, then delete the old one.
   *  Create-first ensures the old session is preserved if creation fails. */
  const handleRestart = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      let swapped = false
      // Guard the WS session-removed(X) teardown while the swap's exit fade is
      // in flight: without it, a cross-tab delete during the fade would tear X
      // down before swapSession slots Y, dropping the group position. Same
      // pattern as handleClear / handleDiscard.
      clearingIdsRef.current.add(id)
      try {
        // Create the replacement session (no groupId — swapSession moves the
        // group slot X→Y atomically, avoiding handleAddToGroup's overflow
        // eviction kicking a sibling out while the old session still occupies
        // its slot). `joinGroupOf: id` makes the server's `session-created(Y)`
        // broadcast carry `joinGroupOf: X`, so every tab appends Y to X's
        // group the instant Y appears — no "Ungrouped" flash before this POST
        // resolves and swapSession runs (swapSession then evicts X).
        const res = await api.post<{ session: SessionInfo }>('/sessions', {
          cwd: source.cwd,
          model: source.model,
          permissionMode: source.permissionMode,
          // Preserve beta flags (notably `context-1m-...`) so restart
          // doesn't silently drop the window from 1M back to 200k.
          betas: source.betas,
          // Preserve per-first-party-server overrides so a restarted session
          // keeps its tool set (create-time prefs honor them on FIRST spawn).
          firstPartyTools: firstPartyOverridesForCreate(source),
          title: source.title,
          joinGroupOf: id,
          // X is being evicted by this restart (swapSession replaces X→Y), so
          // the server tags the created(Y) broadcast with evictingSource. The
          // client uses that flag to keep Y pending (NOT appended) until
          // swapSession places it in X's exact slot — no group-tail flash.
          evictingSource: true,
        })
        // Atomic X→Y swap (sessions/openIds/focusedId/groups/sidebarOrder/
        // lastSeenTurn). Y mounts fresh and plays .entering. swapSession also
        // inserts Y into `sessions`, so openSessions resolves it with no gap.
        // Awaited so the exit fade completes (and X stays guarded) before the
        // delete below broadcasts session-removed(X).
        await swapSession(id, res.session.id, res.session)
        swapped = true
        // Delete the old session server-side. performDelete→closeSession cleans
        // up side-chat/registry/accent; its openIds/groups/sessions filters are
        // no-ops (swapSession already moved X→Y), and the WS session-removed(X)
        // teardown is likewise a no-op for the swapped state.
        await performDelete(id)
      } catch (e) {
        if (swapped) {
          // performDelete failed (e.g. network) AFTER swapSession already
          // removed X locally. X is still alive server-side — re-add it to the
          // sidebar so it isn't orphaned/invisible until a page reload. (If X
          // was cross-tab-deleted during the POST await, this re-adds a dead
          // session; clicking it 404s — reload recovers. The network-failure
          // case dominates, so re-adding is net-positive.)
          setSessions((prev) => (prev.some((s) => s.id === id) ? prev : [source, ...prev]))
        }
        // Clear any evicting replacement marker for X that swapSession never
        // consumed (POST failed after the session-created(Y) broadcast) — with
        // batch1 no longer appending Y, a stuck pending would hide Y forever.
        setPendingGroupInheritance((prev) => {
          let changed = false
          const next = new Map(prev)
          for (const [newId, pending] of next) {
            if (pending.evicting && pending.sourceId === id) {
              next.delete(newId)
              changed = true
            }
          }
          return changed ? next : prev
        })
        toast.error(`Couldn't restart session: ${(e as Error).message}`)
      } finally {
        clearingIdsRef.current.delete(id)
        clearingServerRemovedRef.current.delete(id)
      }
    },
    [sessions, performDelete, toast, swapSession],
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
      // Resume dormant sessions in the background — but NOT ones the user
      // deliberately slept (slept:true). Those stay dormant until an explicit
      // click / drop / Resume-button wakes them. Terminated sessions are never
      // auto-resumed here either: a recoverable (canRetryResume) one opens to
      // the composer's Resume / Fork-from-last-completed choice banner.
      for (const id of valid) {
        const s = sessions.find((x) => x.id === id)
        // !s.slept: a deliberately-slept session isn't woken behind the
        // user's back. !s.terminated: a crashed session must not silently
        // re-run the poison turn — the user chooses via the banner.
        if (s && !s.running && !s.slept && !s.terminated && !resumingRef.current.has(id)) {
          const pm = sessionsRef.current.find((s) => s.id === resumeTargetPanelIdRef.current)?.permissionMode
          void api.post(`/sessions/${id}/resume`, {
            permissionMode: pm,
          }).catch(() => {})
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
        const pm = sessionsRef.current.find((s) => s.id === resumeTargetPanelIdRef.current)?.permissionMode
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/resume`, {
          permissionMode: pm,
        })
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

  /** Put a live, idle session into dormant state (release the SDK subprocess
   *  + subscribers) without deleting it. Reversible via resumeSession / click.
   *  The button is only rendered for idle sessions, so a 409 ("working") is
   *  unexpected — handled as a revert + info toast. Optimistically flips the
   *  session to dormant so the UI transitions immediately; the server's
   *  subsequent session-update broadcast reconciles (idempotent). */
  const sleepSession = useCallback(
    async (id: string) => {
      const prev = sessionsRef.current.find((s) => s.id === id)
      setSessions((cur) => cur.map((s) => (s.id === id
        ? {
          ...s,
          running: false,
          phase: 'dormant',
          working: false,
          workingSince: undefined,
          pendingPermissionCount: 0,
          // Mark deliberately-slept so auto/background resume paths (group
          // sibling resume, programmatic group open) skip this session —
          // only an explicit click/drop/Resume-button should wake it.
          slept: true,
        }
        : s)))
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/sleep`, {})
        setSessions((cur) => cur.map((s) => (s.id === id ? res.session : s)))
      } catch (e) {
        // Revert to the pre-sleep state.
        if (prev) setSessions((cur) => cur.map((s) => (s.id === id ? prev : s)))
        const msg = (e as Error).message
        if (/working/i.test(msg)) toast.info('等当前回合结束再休眠')
        else toast.error(`Couldn't sleep session: ${msg}`)
      }
    },
    [toast],
  )

  /** Select a session. Dormant (not running, not terminated) sessions are
   *  resumed first — the server spins up a fresh Query with
   *  `options.resume`, then the SSE replay fills in the transcript.
   *
   *  A group is a synced workspace: clicking any member opens the WHOLE
   *  group (up to maxOpen panels) and focuses the clicked one, so the open
   *  panel set always mirrors group membership. Ungrouped sessions open in
   *  single-panel mode (replace the current panels). On mobile (single
   *  panel) a group larger than maxOpen degrades to opening just the
   *  clicked session. */
  const handleSelect = useCallback(
    async (id: string, opts?: { auto?: boolean }) => {
      // `auto` marks an automatic open (URL-hash restore on page refresh /
      // deep link) as opposed to an explicit user click. Automatic restores
      // must not wake a session the user deliberately slept (slept:true) —
      // only an explicit click / drop / Resume button does. The panel layout
      // (group sync, focus, dormant empty-state) is identical either way.
      const auto = opts?.auto === true
      const s = sessionsRef.current.find((x) => x.id === id)
      if (!s) {
        // Unknown id (stale deep link, deleted session, …). Don't add it to
        // openIds: the invariant is openIds ⊆ sessions (see the openSessions
        // memo) — an unresolvable id would leave a ghost entry that widens the
        // grid while rendering no panel (empty-state shifted into the first
        // column) and persists the stale id in the URL hash via writeHash.
        return
      }

      const sessionGroup = groups.find((g) => g.sessionIds.includes(id))

      // Ungrouped session → single-panel mode (replace all open panels).
      if (!sessionGroup) {
        setLastSeenTurn((prev) => ({ ...prev, [id]: s.lastTurnAt ?? Date.now() }))
        // `s.canRetryResume`: a transiently-terminated session (crash /
        // query error) may still be recoverable — attempt the resume; the
        // server probes the transcript and 410s if it's genuinely gone.
        // Ungrouped opens never auto-wake a deliberately-slept session
        // (treated as auto regardless of how it was opened) — the panel
        // opens to the dormant empty-state with a Resume button instead.
        if (shouldAutoResumeOnSelect(s, { auto: true }) && !resumingRef.current.has(id)) {
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

      // Grouped session — sync the whole group into the main grid and focus
      // the clicked member. `groupIds` is the set we want open: every
      // existing member of the group when they all fit, otherwise just the
      // clicked one (mobile single-panel). `sameSet` detects the already-
      // synced case so a plain refocus doesn't churn the panels or clobber
      // siblings' unread dots.
      const sessionSet = new Set(sessionsRef.current.map((x) => x.id))
      const validGroupIds = sessionGroup.sessionIds.filter((gid) => sessionSet.has(gid))
      const canShowAll = validGroupIds.length <= maxOpenRef.current
      const groupIds = canShowAll ? validGroupIds : [id]
      const prevOpen = openIdsRef.current
      const sameSet =
        prevOpen.length === groupIds.length && groupIds.every((gid) => prevOpen.includes(gid))

      setLastSeenTurn((prev) => {
        const next = { ...prev }
        const now = Date.now()
        next[id] = s.lastTurnAt ?? now
        // When switching the grid to this group, mark every member seen so
        // newly-opened panels don't flash unread. When already synced, only
        // the clicked member is touched — siblings keep their unread state.
        if (!sameSet) {
          for (const gid of groupIds) {
            if (gid === id) continue
            const sib = sessionsRef.current.find((x) => x.id === gid)
            next[gid] = sib?.lastTurnAt ?? now
          }
        }
        return next
      })

      if (!sameSet) {
        setOpenIds(groupIds)
        // Resume dormant siblings fire-and-forget so they're live by the
        // time the user looks at them. The clicked member is resumed
        // (awaited) below — skipping it here avoids a double resume.
        // Skip siblings the user deliberately slept (slept:true): those stay
        // dormant until explicitly woken (their panel shows the dormant
        // empty-state with a Resume button). Skip terminated ones too — a
        // crashed sibling opens to its choice banner, never auto-resumes.
        for (const gid of groupIds) {
          if (gid === id) continue
          const sib = sessionsRef.current.find((x) => x.id === gid)
          if (sib && !sib.running && !sib.slept && !sib.terminated && !resumingRef.current.has(gid)) {
            void resumeSession(gid, () => {}).catch(() => {})
          }
        }
      }
      setFocusedId(id)

      // Resume the clicked session if dormant (resume FIRST so it's live
      // before the user interacts). Running sessions are already open in
      // the grid via setOpenIds above. Hard-terminal sessions are dead;
      // transiently-terminated ones (canRetryResume) still get a resume
      // attempt (the server 410s if the transcript is truly gone). An
      // `auto` open (page-refresh hash restore) must NOT wake a session the
      // user deliberately slept — only an explicit click / drop / Resume
      // button does (see shouldAutoResumeOnSelect).
      if (!shouldAutoResumeOnSelect(s, { auto })) return
      if (resumingRef.current.has(id)) return
      await resumeSession(id, () => {})
    },
    [resumeSession, groups, setLastSeenTurn],
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
  const openSessionFromUrlRef = useRef((id: string) => { handleSelectRef.current(id, { auto: true }) })
  const focusPanelFromUrlRef = useRef((id: string) => { focusPanel(id) })
  /* eslint-disable react-hooks/refs -- intentional render-time ref read; useSessionUrl stores the value in its own ref on mount */
  useSessionUrl({
    sessionsLoaded,
    groupsLoaded: !uiStateLoading,
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

  /** Open sessions, rendered in the order they were opened. Membership follows
   *  `openIds` (the source of truth for open panels); `sessions` supplies the
   *  SessionInfo. Every handler that mints a new id (create/fork via local
   *  setSessions; clear/restart via swapSession) inserts it into `sessions` in
   *  the same batch openIds adopts it, so there's no gap for the WS
   *  session-created frame to race — no cache needed. A deleted-on-server
   *  session is removed from `openIds` by its `session-removed` frame and so
   *  disappears here. */
  const openSessions = useMemo(
    () => resolvedOpenIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s),
    [resolvedOpenIds, sessions],
  )

  const updateSession = useCallback((s: SessionInfo) => {
    setSessions((prev) => prev.map((p) => (p.id === s.id ? s : p)))
  }, [])

  // Stable wrappers for ChatPanel.memo — inline arrows would create a new
  // function identity on every App render and bust the shallow comparison.
  const handleResumePanel = useCallback(
    (id: string) => {
      void resumeSession(id, () => {})
    },
    [resumeSession],
  )
  const handleCloseHistory = useCallback(() => setHistoryPanelOpen(false), [])

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
    // Swap-detection: suppress the closing-ghost ONLY for a true X→Y swap
    // (driven by `swapSession`, which marks the new id in `justSwappedInRef`).
    // A structural 1-for-1 check (gone==1 && added==1) would ALSO match
    // maxOpen eviction, single-panel session switch, and slot drag-replace —
    // all genuine closes that should play the ghost. Consume the marker BEFORE
    // the gone==0 early return: a swap whose oldId is NOT open (e.g. restart
    // from the sidebar) leaves openIds unchanged in contents (but new ref), so
    // gone==0 — the marker must still be cleared or it leaks and later
    // false-suppresses an unrelated close.
    const prevSet = new Set(prevIds)
    const added = openIds.filter((id) => !prevSet.has(id))
    const swappedIn = justSwappedInRef.current
    justSwappedInRef.current = new Set()
    if (gone.length === 0) return
    if (gone.length === 1 && added.length === 1 && swappedIn.has(added[0])) return
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
  }, [openIds, bodyRef])

  // ── Panel swap animation ─────────────────────────────────────────────
  // animatePanels is called AFTER a state update (swapPanels / handleReorderInGroup).
  // It captures old positions of the given panel IDs, waits for the
  // browser to paint the new grid layout, then FLIP-animates them all
  // simultaneously — A slides to B's spot and vice versa.
  //
  // The capture also records width so the FLIP includes a scaleX component:
  // moving a session in/out of the active group changes openIds.length,
  // which re-flows grid-template-columns and snaps the surviving panels
  // to new widths. Without the scale, survivors teleport to their new
  // size while only the position smoothly slides — the user sees an
  // instant width jump. Height is captured too for symmetry but in
  // practice all panels are full-height so scaleY stays at 1.
  const animatePanels = useCallback((...ids: string[]) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const bodyEl = bodyRef.current
    if (!bodyEl) return
    const bodyR = bodyEl.getBoundingClientRect()
    // Capture OLD positions (the "First" of FLIP) keyed by id — NOT by DOM
    // element reference. Panels are now keyed by session id (`<PanelSlot
    // key={s.id}>`), so a swap/reorder moves the same DOM node rather than
    // remounting it; holding `el` across the rAF would still work. We
    // re-query by id in the rAF anyway as a defensive measure: it resolves
    // the live node regardless of how React reconciled the commit, and keeps
    // the animation correct if the subtree is ever remounted for another
    // reason (e.g. an ErrorBoundary reset).
    const snapshots: { id: string; x: number; y: number; w: number; h: number }[] = []
    for (const id of ids) {
      const el = bodyEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      snapshots.push({ id, x: r.left - bodyR.left, y: r.top - bodyR.top, w: r.width, h: r.height })
    }
    if (snapshots.length === 0) return
    // Wait for the grid to repaint with the new order, then animate.
    requestAnimationFrame(() => {
      const opts: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }
      const bodyR2 = bodyEl.getBoundingClientRect()
      for (const { id, x, y, w, h } of snapshots) {
        const el = bodyEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
        if (!el) continue
        const r = el.getBoundingClientRect()
        const dx = x - (r.left - bodyR2.left)
        const dy = y - (r.top - bodyR2.top)
        const sx = r.width > 0 ? w / r.width : 1
        const sy = r.height > 0 ? h / r.height : 1
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'top left' },
            { transform: 'translate(0, 0) scale(1, 1)', transformOrigin: 'top left' },
          ],
          opts,
        )
      }
    })
  }, [bodyRef])
  // Expose animatePanels through the ref declared near handleAddToGroup
  // so that earlier callbacks (defined before this useCallback runs) can
  // invoke it without a TDZ violation. Render-phase mutation of a ref is
  // safe — no React render-output depends on .current.
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref sync (same pattern as openIdsRef etc.)
  animatePanelsRef.current = animatePanels

  // Scroll-position protection for panel reorder. Reordering openIds moves the
  // keyed <ChatPanel> DOM subtrees (React insertBefore), which can drop the
  // Virtuoso scroller's scrollTop for any panel the user had scrolled up in.
  // We snapshot each open panel's scrollTop right before the reorder and
  // restore it in a layout effect after React commits the moved DOM, before
  // paint. Idempotent: if the browser preserved scrollTop, the write is a no-op.
  const pendingScrollRestoreRef = useRef<Map<string, number> | null>(null)

  const snapshotPanelScrolls = useCallback(() => {
    const bodyEl = bodyRef.current
    if (!bodyEl) return
    const map = new Map<string, number>()
    for (const panel of bodyEl.querySelectorAll<HTMLElement>('[data-panel-id]')) {
      const id = panel.dataset.panelId
      if (!id) continue
      const scroller = panel.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      if (scroller) map.set(id, scroller.scrollTop)
    }
    pendingScrollRestoreRef.current = map
  }, [bodyRef])

  useLayoutEffect(() => {
    const map = pendingScrollRestoreRef.current
    if (!map) return
    pendingScrollRestoreRef.current = null
    const bodyEl = bodyRef.current
    if (!bodyEl) return
    for (const [id, top] of map) {
      const panel = bodyEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
      const scroller = panel?.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      if (scroller && Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
    }
  }, [openIds, bodyRef])

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
      if (!prevSet.has(id)) {
        enteringSetRef.current.add(id)
      }
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
      // Alt+1..Alt+9 activate the Nth group — keyboard equivalent of
      // clicking a sidebar group pill. Generated dynamically so the
      // ShortcutHelp panel only lists real groups (0 groups → none).
      ...Array.from({ length: Math.min(groups.length, 9) }, (_, i): Shortcut => ({
        combo: `alt+${i + 1}`,
        allowInInput: true,
        handler: () => {
          const g = groupsRef.current[i]
          if (g) handleActivateGroup(g.id)
        },
        description: `Activate group ${i + 1}`,
      })),
      // Alt+Shift+ArrowUp/Down move the active group within the sidebar
      // order — keyboard parallel to the pill context-menu items.
      // allowInInput matches the Alt+1..9 activate-group shortcuts above:
      // the composer usually holds focus, so an input-safe default would
      // make this dead in the common flow. Reordering the sidebar doesn't
      // touch the draft text, and the dispatcher's isComposing guard still
      // prevents firing mid-IME-composition.
      // handleMoveGroup is omitted from the deps array below (like
      // requestResumeForPanel): it's declared after this useMemo and is
      // stable (useCallback with stable deps).
        {
          combo: 'alt+shift+arrowup',
          allowInInput: true,
          handler: () => {
            const gid = activeGroupIdRef.current
            if (gid) handleMoveGroup(gid, 'up')
          },
          description: 'Move active group up',
        },
        {
          combo: 'alt+shift+arrowdown',
          allowInInput: true,
          handler: () => {
            const gid = activeGroupIdRef.current
            if (gid) handleMoveGroup(gid, 'down')
          },
          description: 'Move active group down',
        },
        {
          combo: 'mod+1',
          // allowInInput: the whole point is to switch panels while typing
          // in the composer. Without it the input-safe dispatcher swallows
          // the combo and the browser's native Ctrl+1 tab-switch fires.
          allowInInput: true,
          handler: () => {
            const id = openIdsRef.current[0]
            if (!id) return
            setFocusedId(id)
            setPanelFocusSignals((s) => [s[0] + 1, s[1], s[2]] as [number, number, number])
          },
          description: 'Focus slot 1',
        },
        {
          combo: 'mod+2',
          allowInInput: true,
          handler: () => {
            const id = openIdsRef.current[1]
            if (!id) return
            setFocusedId(id)
            setPanelFocusSignals((s) => [s[0], s[1] + 1, s[2]] as [number, number, number])
          },
          description: 'Focus slot 2',
        },
        {
          combo: 'mod+3',
          allowInInput: true,
          handler: () => {
            const id = openIdsRef.current[2]
            if (!id) return
            setFocusedId(id)
            setPanelFocusSignals((s) => [s[0], s[1], s[2] + 1] as [number, number, number])
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
          combo: 'mod+shift+x',
          handler: () => setStructuredOpen(true),
          description: 'Structured output',
        },
        {
          // NOT mod+shift+r: that's the browser hard-reload combo on
          // Windows/Linux, and the dispatcher preventDefault()s every
          // bound combo — which would silently kill hard-reload. mod+shift+o
          // ("Open" a past session) has no browser default.
          //
          // Session-scoped: when a panel is focused this mirrors the `/resume`
          // local command — the picked session REPLACES the focused panel's
          // slot (and the list is scoped to that session's cwd), instead of
          // popping a global picker that opens into a new panel. No focused
          // panel → falls back to the global flow.
          combo: 'mod+shift+o',
          handler: () => {
            const fid = focusedIdRef.current
            // Close any open settings/git overlay on this panel first —
            // same mutual-exclusion as requestResumeForPanel (focus traps).
            handleCloseSettings()
            handleCloseGitPanel()
            setResumeTargetPanelId(fid ?? null)
            setResumeDialogOpen(true)
          },
          description: 'Resume session into focused panel...',
        },
        {
          combo: 'mod+k',
          handler: () => setPaletteOpen((v) => !v),
          description: 'Command palette',
        },
        {
          combo: 'mod+b',
          handler: () => setSidebarCollapsed((v) => !v),
          description: 'Toggle sidebar',
        },
        {
          combo: 'mod+shift+h',
          handler: () => {
            // No-op when no panel is focused — the overlay is per-panel
            // (historyOpen={historyPanelOpen && focusedId===s.id}), so
            // opening it with no host would leave historyPanelOpen=true with
            // nothing visible, then pop over the next panel that gets
            // focused. mod+shift+o above guards the same way.
            if (!focusedIdRef.current) return
            setHistoryPanelOpen((v) => !v)
          },
          allowInInput: true,
          description: 'Browse input history',
        },
        {
          combo: 'mod+?',
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
          // Background in-flight tasks for the focused session (Ctrl+B
          // semantics). This is the ONLY UI entry point: the Composer's
          // shared Send/Interrupt control used to morph into a third
          // Background state keyed on the streaming phase, which flickered
          // on every phase transition, so the morph was removed — Alt+B
          // (advertised in the Interrupt tooltip) covers it. NOT mod+b:
          // that toggles the sidebar. NOT ctrl+esc / shift+esc: OS /
          // browser-reserved.
          combo: 'alt+b',
          handler: () => {
            const fid = focusedIdRef.current
            if (!fid) return
            // Guard on turn activity (server working OR Chat's optimistic
            // signal): with nothing in flight the POST either 410s on a
            // terminated session (setLocalError renders a persistent red
            // banner) or just toasts noise on an idle one.
            const focused = sessionsRef.current.find((s) => s.id === fid)
            if (!focused?.working && !turnActiveFnsRef.current.get(fid)?.()) return
            backgroundFnsRef.current.get(fid)?.()
          },
          allowInInput: true,
          description: 'Background current tasks',
        },
        {
          combo: 'escape',
          handler: () => {
            // Escape is context-sensitive by turn state:
            //   working → interrupt the focused panel's turn
            //   idle    → single clean press opens the resume picker
            // "Clean" is automatic — every overlay is registered in the
            // escape stack (window CAPTURE + stopPropagation), so this
            // bubble-phase handler only runs when the stack was empty.
            // The decision table (including the post-interrupt suppression
            // window that stops a double-tap's trailing press from popping
            // the picker) lives in escapeAction. The suppression timestamp
            // is keyed per session (an interrupt in one panel must not
            // swallow an idle Esc in another). Date.now() is called at
            // event-dispatch time, not during render — the handler is
            // defined in useMemo but invoked later by the keyboard
            // dispatcher.
            // eslint-disable-next-line react-hooks/purity
            const now = Date.now()
            const fid = focusedIdRef.current
            // No focused panel: nothing to interrupt, nothing to resume
            // into. (Also gives the interrupt branch its non-null fid.)
            if (!fid) return
            const focused = sessionsRef.current.find((s) => s.id === fid)
            // Turn activity includes Chat's optimistic bridge (pendingTurn):
            // right after a send, the server snapshot hasn't flipped
            // working=true yet, and an Esc in that gap should interrupt the
            // just-started turn, not open the resume picker.
            const working = !!focused?.working || !!turnActiveFnsRef.current.get(fid)?.()
            const last = lastInterruptRef.current
            const action = escapeAction({
              working,
              now,
              // Suppression only applies to the SAME session's trailing
              // press; a different session's idle Esc is unaffected.
              lastInterruptedAt: last && last.sessionId === fid ? last.at : 0,
            })

            if (action === 'interrupt') {
              // Use the registered interrupt callback (set by <Chat>).
              // The result message's "interrupted" (?) label is derived
              // from the SDK `terminal_reason`, not from this call-path.
              const fn = interruptFnsRef.current.get(fid)
              if (fn) {
                void fn()
              } else {
                // Fallback: Chat hasn't registered yet (e.g. still
                // mounting). Direct POST still interrupts the turn — with
                // cancelQueued, same "stop means stop everything" semantics
                // as the Chat funnel (queued turns are withdrawn too).
                void api.post(`/sessions/${fid}/interrupt`, { cancelQueued: true })
              }
              lastInterruptRef.current = { sessionId: fid, at: now }
              return
            }

            if (action === 'resume') requestResumeForPanel(fid)
          },
          allowInInput: true, // Esc inside textarea should still close modals / interrupt
          description: 'Close overlay / Interrupt (or resume picker when idle)',
        },
      ],
      // handleMoveGroup (Alt+Shift+Arrow) and requestResumeForPanel (Esc-idle)
      // are intentionally omitted from the deps array: both are declared AFTER
      // this useMemo (line order), so referencing them in the array would throw
      // a TDZ ReferenceError on every render. Both are stable useCallbacks
      // (handleMoveGroup → [setGroups]; requestResumeForPanel →
      // [handleCloseSettings, handleCloseGitPanel]), so the omission only
      // affects eslint's static analysis, not runtime behaviour.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [groups.length, handleActivateGroup, closeSession, toggleShortcutHelp, handleCloseSettings, handleCloseGitPanel, setSidebarCollapsed],
    )
  useKeyboardShortcuts(shortcuts)

  /** Final sidebar order: sidebarOrder[] wins for ids it contains; anything
   *  not listed falls back to the server's lastActivityAt sort. Ids in the
   *  saved order but no longer present on the server are dropped. */
  const orderedSessions = useMemo(() => {
    // Side Chat sessions are ephemeral — they only exist in panels, never
    // in the sidebar.
    const visible = sessions.filter((s) => !s.parentId)
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
  }, [sessions, sidebarOrder])

  // ── App Plugin command palette merge ───────────────────────────────
  // Global, palette-visible plugin commands are merged into the Command
  // Palette. A command's `when` is evaluated against the current context
  // (active session + theme); non-matching commands are hidden.
  const { plugins: appPlugins } = usePluginRegistry()
  const { execute: executePluginCommand } = usePluginCommands()
  const pluginPaletteCommands: PaletteItem[] = useMemo(() => {
    const whenCtx = buildWhenContext({ sessionActive: orderedSessions.length > 0 })
    const items: PaletteItem[] = []
    for (const p of appPlugins) {
      if (!p.enabled || !p.compatible) continue
      for (const cmd of p.contributions.commands) {
        if (cmd.showInPalette === false) continue
        // Only global / no-category commands belong in the palette root.
        if (cmd.category && cmd.category !== 'global') continue
        if (!whenHolds(cmd.when, whenCtx)) continue
        items.push({
          id: `plugin:${p.id}:${cmd.id}`,
          section: 'Commands',
          label: cmd.title,
          hint: p.name,
          action: () => {
            void executePluginCommand({
              pluginId: p.id,
              commandId: cmd.id,
              context: { source: 'global', commandId: cmd.id, invokedAt: Date.now() },
            })
          },
        })
      }
    }
    return items
  }, [appPlugins, orderedSessions.length, executePluginCommand])

  /** Retry group inheritance after UI state hydration or a later group change.
   * A clear/fork frame may beat the async groups load; keep the relationship
   * until it can be resolved instead of flashing the replacement under
   * Ungrouped. */
  useEffect(() => {
    if (pendingGroupInheritance.size === 0 || uiStateLoading) return
    const completed = [...pendingGroupInheritance].filter(([newId, pending]) =>
      pending.replaces
        // Crash-recovery fork: once Y is placed in a group, X is gone from it
        // (inheritGroupId replaced X with Y), so the two-ids-in-one-group test
        // below can't fire. Y in any group means the replacement landed.
        ? groups.some((g) => g.sessionIds.includes(newId))
        : groups.some((g) => g.sessionIds.includes(pending.sourceId) && g.sessionIds.includes(newId)),
    )
    if (completed.length > 0) {
      const timer = window.setTimeout(() => {
        setPendingGroupInheritance((prev) => {
          const next = new Map(prev)
          for (const [newId] of completed) next.delete(newId)
          return next.size === prev.size ? prev : next
        })
      }, 0)
      return () => window.clearTimeout(timer)
    }
    const updates = [...pendingGroupInheritance].flatMap(([newId, pending]) => {
      // Evicting replacements (clear/restart) are placed into X's exact slot by
      // swapSession — don't append them here, which would flash Y at the group
      // tail. Only fork (non-evicting) replacements retry.
      if (pending.evicting) return []
      const sourceGroup = groups.find((g) => g.sessionIds.includes(pending.sourceId))
      if (!sourceGroup) return []
      return [{ newId, pending }]
    })
    if (updates.length === 0) return
    const timer = window.setTimeout(() => {
      for (const { newId, pending } of updates) {
        if (pending.replaces) {
          // Crash-recovery fork: Y replaces X — put Y in X's group/order slot
          // once the source group hydrates (the direct replace in the
          // session-created handler no-ops when groups weren't loaded yet).
          setGroups((prev) => inheritGroupId(prev, pending.sourceId, newId))
          setSidebarOrder((prev) => inheritSidebarOrderId(prev, pending.sourceId, newId))
        } else {
          setGroups((prev) => joinGroupOfSource(prev, pending.sourceId, newId, {
            evicting: pending.evicting,
            maxGroupSize: maxGroupSizeRef.current,
          }))
        }
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [groups, pendingGroupInheritance, setGroups, setSidebarOrder, uiStateLoading])

  // Once a hydrated, live source is known to be ungrouped, release its
  // replacement in render-derived state on the next event rather than
  // leaving it hidden indefinitely. The pending marker is otherwise cleared
  // by the successful group append or the swap/teardown paths above.
  //
  // Also release replacements whose SOURCE is gone from the sidebar entirely
  // (sourceId not in sessions) — the swap/teardown that should have consumed
  // the marker never ran (e.g. the WS dropped between the session-created and
  // session-removed broadcasts). With batch1 no longer appending evicting Ys,
  // a stuck marker would hide the replacement forever.
  useEffect(() => {
    if (uiStateLoading || pendingGroupInheritance.size === 0) return
    const shouldRelease = (newId: string, pending: { sourceId: string; evicting: boolean }) =>
      // Fork (non-evicting): release when the live source is ungrouped. Evicting
      // replacements (clear/restart) stay pending until swapSession places them —
      // releasing on an ungrouped source would flash Y under Ungrouped for the
      // 80-140ms before the POST swap.
      (!pending.evicting
        && sessions.some((s) => s.id === pending.sourceId)
        && !groups.some((g) => g.sessionIds.includes(pending.sourceId)))
      // Stale source: the source session is gone while the replacement exists.
      || (!sessions.some((s) => s.id === pending.sourceId) && sessions.some((s) => s.id === newId))
    const releasable = [...pendingGroupInheritance].some(([newId, pending]) => shouldRelease(newId, pending))
    if (!releasable) return
    const timer = window.setTimeout(() => {
      setPendingGroupInheritance((prev) => {
        const next = new Map(prev)
        for (const [newId, pending] of next) {
          if (shouldRelease(newId, pending)) next.delete(newId)
        }
        return next.size === prev.size ? prev : next
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [groups, pendingGroupInheritance, sessions, uiStateLoading])

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
      if (!groupedIds.has(s.id) && !pendingGroupInheritance.has(s.id)) ungrouped.push(s)
    }
    if (ungrouped.length > 0) {
      sections.push({ kind: 'ungrouped', sessions: ungrouped })
    }

    return sections
  }, [orderedSessions, groups, pendingGroupInheritance])

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
        if (active && active === owner.id) {
          // isGroupView must be checked against the PRE-removal group
          // (prevGroups), because prevOpen still contains draggedId —
          // checking against the post-removal `updated` would always fail
          // (draggedId ∈ prevOpen but ∉ updated), silently skipping the sync.
          const prevOpen = openIdsRef.current
          const prevGroup = owner
          const isGroupView = prevOpen.length > 0 && prevOpen.every((id) => prevGroup.sessionIds.includes(id))
          if (isGroupView) {
            const next = prevOpen.filter((id) => id !== draggedId)
            if (next.length !== prevOpen.length) {
              // Same FLIP as handleAddToGroup: animate the surviving
              // panels so they grow into the vacated grid track instead
              // of teleporting to the new width when openIds shrinks.
              if (next.length > 0) animatePanelsRef.current?.(...next)
              setOpenIds(next)
            }
          }
        }
      }
    },
    [orderedSessions, setSidebarOrder, setGroups, setOpenIds],
  )

  /** Reorder the `groups` array by moving `draggedId` before/after
   *  `targetId`. Array position IS the persisted order (ui-state PUT is a
   *  full replace), so no order field, sidebarOrder, or openIds changes are
   *  needed. Read `groupsRef` synchronously (setGroups's updater runs on
   *  React's schedule — same pattern as handleReorderSidebar) and return a
   *  NEW array so useUiState's no-op guard lets the debounced PUT fire.
   *  Wraps the mutation with the group FLIP so the pill row and section list
   *  slide to their new slots — every path (pill/header drop, context menu,
   *  keyboard) funnels through here, so wrapping once covers all of them. */
  const handleReorderGroups = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after') => {
      if (draggedId === targetId) return
      const prev = groupsRef.current
      const dragged = prev.find((g) => g.id === draggedId)
      if (!dragged) return
      const without = prev.filter((g) => g.id !== draggedId)
      const targetIdx = without.findIndex((g) => g.id === targetId)
      if (targetIdx < 0) return
      const insertAt = position === 'before' ? targetIdx : targetIdx + 1
      const next = [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)]
      const animateMove = prepareGroupFlip()
      setGroups(() => next)
      animateMove()
    },
    [setGroups],
  )

  /** Adjacent-swap fallback for the group pill context menu (Move up/down)
   *  and the Alt+Shift+ArrowUp/Down shortcuts. Boundary no-op; returns a new
   *  array for useUiState's no-op guard. FLIP-wrapped like handleReorderGroups
   *  so all group moves share the same slide animation. */
  const handleMoveGroup = useCallback(
    (groupId: string, direction: 'up' | 'down') => {
      const prev = groupsRef.current
      const idx = prev.findIndex((g) => g.id === groupId)
      if (idx < 0) return
      const nextIdx = direction === 'up' ? idx - 1 : idx + 1
      if (nextIdx < 0 || nextIdx >= prev.length) return
      const next = [...prev]
      ;[next[idx], next[nextIdx]] = [next[nextIdx], next[idx]]
      const animateMove = prepareGroupFlip()
      setGroups(() => next)
      animateMove()
    },
    [setGroups],
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
      // Compute next groups synchronously from the ref (setGroups's updater
      // runs on React's schedule — a `let newIds` assigned inside it would
      // still be empty when we reach the openIds sync below).
      const prevGroups = groupsRef.current
      const group = prevGroups.find((g) => g.id === groupId)
      if (!group) return
      const without = group.sessionIds.filter((id) => id !== draggedId)
      const targetIdx = without.indexOf(targetId)
      const insertAt = targetIdx < 0 ? without.length : position === 'before' ? targetIdx : targetIdx + 1
      without.splice(insertAt, 0, draggedId)
      const newIds = without
      const wasInOtherGroup = !group.sessionIds.includes(draggedId)
      const nextGroups = prevGroups.map((g) => {
        if (g.id === groupId) return { ...g, sessionIds: without }
        if (g.sessionIds.includes(draggedId)) {
          return { ...g, sessionIds: g.sessionIds.filter((id) => id !== draggedId) }
        }
        return g
      })
      setGroups(() => nextGroups)

      // Sync open panels. Two cases:
      // 1. Cross-group drop INTO the active group: the dragged session just
      //    joined the active group — add it to the open set (if there's room)
      //    so the view follows, mirroring handleAddToGroup.
      // 2. Same-group (or non-active-group) reorder: just re-order the open
      //    group sessions to match the new group order.
      const active = activeGroupIdRef.current
      const prevOpen = openIdsRef.current
      if (
        wasInOtherGroup &&
        activateGroupViewIfOpenUngrouped(draggedId, newIds, prevGroups)
      ) {
        // Ungrouped focused session dragged into this group → group view
        // activated. Skip the add/reorder branches below (they only apply
        // when a group is already active).
      } else if (wasInOtherGroup && active === groupId) {
        // Cross-group drop into the active group. Check isGroupView against
        // the PRE-change group (prevGroups), since prevOpen reflects the
        // state before the dragged session joined.
        const prevActiveGroup = prevGroups.find((g) => g.id === active)
        const isGroupView =
          prevActiveGroup != null &&
          prevOpen.length > 0 &&
          prevOpen.every((id) => prevActiveGroup.sessionIds.includes(id))
        if (isGroupView) {
          // Mirror the new group order: take the already-open members plus
          // the dragged session, in newIds (group) order, capped at maxOpen.
          // The active-group view mirrors group order (handleSelect), so the
          // dragged session's panel must land at its dropped position — NOT
          // appended at the end, which desynced panel order from the sidebar
          // order. If the group now exceeds maxOpen the trailing member falls
          // off; the dragged session is kept (the user just added it).
          const kept = new Set(prevOpen)
          kept.add(draggedId)
          const final = newIds.filter((id) => kept.has(id)).slice(0, maxOpenRef.current)
          if (!(final.length === prevOpen.length && final.every((id, i) => id === prevOpen[i]))) {
            snapshotPanelScrolls()
            setOpenIds(final)
          }
        }
      } else if (wasInOtherGroup) {
        // Cross-group drop into a NON-active group. If the dragged session
        // just LEFT the active group, drop it from the open panel set so the
        // view follows — mirrors handleReorderSidebar. Without this, dragging
        // a card from the active group into another group moves the sidebar
        // membership (G1 → G2) but leaves the stale panel open, and
        // activeGroupId silently goes null because openIds now spans two
        // groups. isGroupView is checked against the PRE-change source group
        // (still contains draggedId), since prevOpen still reflects it.
        const sourceGroup = prevGroups.find(
          (g) => g.id !== groupId && g.sessionIds.includes(draggedId),
        )
        if (sourceGroup && active === sourceGroup.id) {
          const isGroupView =
            prevOpen.length > 0 && prevOpen.every((id) => sourceGroup.sessionIds.includes(id))
          if (isGroupView) {
            const next = prevOpen.filter((id) => id !== draggedId)
            if (next.length !== prevOpen.length) {
              snapshotPanelScrolls()
              if (next.length > 0) animatePanels(...next)
              setOpenIds(next)
            }
          }
        }
      } else {
        // Plain reorder (same group, or a non-active group): re-order the
        // currently-open group sessions to match the new order, preserving
        // non-group sessions in place. Computed eagerly from the ref (not a
        // functional updater) so we only snapshot scroll when the open order
        // truly changes — a no-op setOpenIds would skip the restore effect and
        // leave a stale snapshot.
        const prev = openIdsRef.current
        const groupSet = new Set(newIds)
        const openGroup = prev.filter((id) => groupSet.has(id))
        if (openGroup.length >= 2) {
          const reordered = newIds.filter((id) => groupSet.has(id) && prev.includes(id))
          if (openGroup.join() !== reordered.join()) {
            let ri = 0
            const next = prev.map((id) => (groupSet.has(id) ? reordered[ri++] : id))
            snapshotPanelScrolls()
            setOpenIds(next)
          }
        }
      }
      // Animate all open group panels to their new grid positions.
      const openGroup = openIdsRef.current.filter((id) => newIds.includes(id))
      if (openGroup.length >= 2) animatePanels(...openGroup)
    },
    [setGroups, setOpenIds, animatePanels, snapshotPanelScrolls, activateGroupViewIfOpenUngrouped],
  )

  const toggleGroupCollapse = useCallback(
    (groupId: string) => {
      setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
    },
    [setCollapsedGroups],
  )

  /** Swap two open panels' slots. If both panels belong to the same group,
   *  the group's `sessionIds` order is synced to match. NOTE: this is a true
   *  two-element swap, NOT a splice-move — splicing the dragged panel into
   *  the target's index is a no-op when the dragged panel sits to the left
   *  of the target (removing it shifts the target's index down by one, so
   *  re-inserting at that index restores the original order). That asymmetry
   *  made "drag panel 1 → 2" appear broken while "2 → 1" worked. */
  const swapPanels = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    // Eager (not functional updater) so we only snapshot scroll when the
    // order actually changes — a no-op setOpenIds would skip the restore
    // effect and strand a stale snapshot.
    const prev = openIdsRef.current
    const i = prev.indexOf(draggedId)
    const j = prev.indexOf(targetId)
    if (i >= 0 && j >= 0 && i !== j) {
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      snapshotPanelScrolls()
      setOpenIds(next)
    }
    // Sync group order (true swap of the two ids).
    setGroups((prev) => {
      const groupId = prev.find(
        (g) => g.sessionIds.includes(draggedId) && g.sessionIds.includes(targetId),
      )?.id
      if (!groupId) return prev
      return prev.map((g) => {
        if (g.id !== groupId) return g
        const i = g.sessionIds.indexOf(draggedId)
        const j = g.sessionIds.indexOf(targetId)
        if (i < 0 || j < 0) return g
        const ids = g.sessionIds.slice()
        ;[ids[i], ids[j]] = [ids[j], ids[i]]
        return { ...g, sessionIds: ids }
      })
    })
    setFocusedId(draggedId)
    animatePanels(draggedId, targetId)
  }, [setGroups, animatePanels, snapshotPanelScrolls])

  /** Drop a sidebar card onto a specific slot in the main grid. If the
   *  slot is occupied by another session, that session is evicted (panel
   *  closes, session stays alive) and the new one takes its place.
   *  When both sessions are already open, swaps their slots (consistent
   *  with swapPanels) and syncs the shared group's order. */
  const openAtSlot = useCallback(
    (id: string, targetId: string, lastTurnAt: number | undefined) => {
      setOpenIds((prev) => {
        // Already open — swap slots with the target (same semantics as
        // swapPanels; a true swap, not a splice-move). Also sync group
        // order below.
        if (prev.includes(id)) {
          const i = prev.indexOf(id)
          const j = prev.indexOf(targetId)
          if (i < 0 || j < 0 || i === j) return prev
          const next = prev.slice()
          ;[next[i], next[j]] = [next[j], next[i]]
          return next
        }
        // Not open yet: replace whatever's in the target slot.
        const j = prev.indexOf(targetId)
        if (j < 0) return prev
        const next = prev.slice()
        next[j] = id
        return next
      })
      // Sync group state to match the panel-slot change above. A group is a
      // synced workspace (openIds === group.sessionIds when active), so a
      // slot swap must update membership too — otherwise the replaced
      // member lingers in the group (alive in the sidebar) while the new
      // occupant sits in the group's panel slot from outside the group.
      setGroups((prev) => {
        // Same-group swap: both sessions are members of the same group →
        // swap their positions in the group to mirror the panel swap.
        const sameGroupId = prev.find(
          (g) => g.sessionIds.includes(id) && g.sessionIds.includes(targetId),
        )?.id
        if (sameGroupId) {
          return prev.map((g) => {
            if (g.id !== sameGroupId) return g
            const i = g.sessionIds.indexOf(id)
            const j = g.sessionIds.indexOf(targetId)
            if (i < 0 || j < 0) return g
            const ids = g.sessionIds.slice()
            ;[ids[i], ids[j]] = [ids[j], ids[i]]
            return { ...g, sessionIds: ids }
          })
        }
        // Replace membership: targetId is in a group but id is not (id is
        // the newly-resumed/dragged session taking targetId's panel slot).
        // Swap group membership — targetId leaves the group, id joins at
        // the same position. Guarded on `id` not already being in any group
        // so a cross-group panel drag-swap doesn't yank membership around.
        const idInAnyGroup = prev.some((g) => g.sessionIds.includes(id))
        const targetGroupId = prev.find((g) => g.sessionIds.includes(targetId))?.id
        if (targetGroupId && !idInAnyGroup) {
          return prev.map((g) => {
            if (g.id !== targetGroupId) return g
            const idx = g.sessionIds.indexOf(targetId)
            if (idx < 0) return g
            const ids = g.sessionIds.slice()
            ids[idx] = id
            return { ...g, sessionIds: ids }
          })
        }
        return prev
      })
      setFocusedId(id)
      setLastSeenTurn((prev) => ({ ...prev, [id]: lastTurnAt ?? Date.now() }))
    },
    [setLastSeenTurn, setGroups],
  )

  const handleAcceptSidebarDrop = useCallback(async (sidebarId: string, targetSlotId: string) => {
    const existing = sessionsRef.current.find((x) => x.id === sidebarId)
    let live = existing
    // Dormant sessions are resumed on drop. Terminated ones (including
    // recoverable canRetryResume) are NOT — they open to the composer's
    // Resume / Fork-from-last-completed choice banner instead.
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
  //
  // "Replaces the current one" is literal: the picked session takes the old
  // session's panel slot AND group membership (openAtSlot syncs both), and
  // the old session is deleted — silently, by design (picking in the resume
  // dialog is the confirmation; unlike the sidebar/panel deletes there's no
  // ConfirmDialog on this path) — so it doesn't linger in the sidebar.
  // Without the delete, the replaced session would just drop to the sidebar
  // (still alive, still in the way), which is "removed" not "replaced".
  const resumeIntoPanel = useCallback(
    (pickedId: string, targetPanelId: string) => {
      const known = sessionsRef.current.find((s) => s.id === pickedId)
      const finish = (lastTurnAt: number | undefined) => {
        openAtSlot(pickedId, targetPanelId, lastTurnAt)
        // Delete the replaced session — but only when it's actually a
        // different session. Picking the same session that already owns the
        // panel is a no-op swap (openAtSlot bails on i===j), so deleting
        // targetPanelId here would nuke the session the user just resumed.
        if (pickedId !== targetPanelId) handleDeleteRef.current(targetPanelId)
      }
      if (known?.running) {
        finish(known.lastTurnAt)
      } else {
        void resumeSession(pickedId, (res) => finish(res.session.lastTurnAt))
      }
    },
    [resumeSession, openAtSlot],
  )

  // Opened from a panel's `/resume` or Ctrl+Shift+O with a focused panel:
  // remember which slot to replace, then pop the picker. The picker renders
  // as an in-panel overlay (variant="panel") inside that panel's <Chat>, and
  // onResume calls handlePanelResume → resumeIntoPanel to swap the slot.
  const requestResumeForPanel = useCallback((panelSessionId: string) => {
    // Joins the settings/git mutual-exclusion group: each overlay has its
    // own focus trap, and two mounted at once would fight over focus.
    handleCloseSettings()
    handleCloseGitPanel()
    setResumeTargetPanelId(panelSessionId)
    setResumeDialogOpen(true)
  }, [handleCloseSettings, handleCloseGitPanel])

  // Close the resume picker (shared by both variants). Clears both the open
  // flag and the panel target so neither the App-root modal nor any in-panel
  // overlay lingers in a stale state.
  const closeResume = useCallback(() => {
    setResumeDialogOpen(false)
    setResumeTargetPanelId(null)
  }, [])

  // Resume picked from an in-panel overlay: swap the hosting panel's slot.
  // The Chat hosting the overlay unmounts on the slot swap (its key changes),
  // so we don't rely on the exit animation here — the swap itself replaces
  // the tree. State is cleared so a subsequent open starts clean.
  const handlePanelResume = useCallback(
    (pickedId: string, panelSessionId: string) => {
      closeResume()
      resumeIntoPanel(pickedId, panelSessionId)
    },
    [closeResume, resumeIntoPanel],
  )

  /** `/clear` a panel: POST to the server (which atomically spawns a fresh
   *  session Y and detaches X), then swap X→Y locally in ONE batched
   *  `swapSession` transaction (sessions/openIds/groups/sidebarOrder/
   *  lastSeenTurn). swapSession first fades X out (WAAPI, ~160ms) so the
   *  replacement reads as an in-place X-out/Y-in; data commits right after the
   *  fade. The WS session-created(Y) / session-removed(X) frames are idempotent
   *  confirmations (the clearingIdsRef guard keeps X fully alive until the
   *  swap). X's transcript survives on disk, recoverable via the resume
   *  picker. The cleared panel blurs (view-only, via `clearingIds`) during the
   *  POST; Y mounts fresh and plays `.entering`. */

  const resetSession = useCallback(
    async (id: string, kind: 'clear' | 'compact') => {
      // Guard: the server broadcasts session-removed(X) during the reset (a
      // clear, or a compact — which is clear-with-summary-seed); the
      // guarded handler skips ALL teardown (incl. setSessions) so X stays
      // fully alive until swapSession replaces it — no sidebar churn, no
      // panel compaction across the WS-vs-POST race.
      clearingIdsRef.current.add(id)
      setClearingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      clearingInFlightRef.current.set(id, (clearingInFlightRef.current.get(id) ?? 0) + 1)
      try {
        // POST only — no 180 ms veil gate. Data swaps the instant Y is known.
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/${kind}`, {})
        const newId = res.session.id
        if (newId !== id) {
          // X hosted a Side Chat? Tear it down (the guarded session-removed
          // skips this; without it the ephemeral session would leak).
          cleanupSideChat(id)
          // Atomic X→Y in one batch. Y mounts fresh and plays .entering
          // (not suppressed — the wipe + empty-panel-fade-in is the clear).
          await swapSession(id, newId, res.session)
          // X is gone — prune its notification edge-detector entry (the
          // guarded session-removed skipped pruneSession; swapSession
          // doesn't touch it; <Chat> unmount has no backstop for it).
          pruneSession(id)
        }
        // else: server short-circuited (newId === id — another clear is in
        // flight, or the server's `clearing` flag is stuck). Do nothing here;
        // the finally cleans up only if this is the last in-flight call.
      } catch (e) {
        if (clearingServerRemovedRef.current.has(id)) {
          // Server processed the clear (session-removed(X) arrived) but the
          // POST response carrying Y was lost. X is dead — full teardown
          // (groups/sidebarOrder/lastSeenTurn/registries/side-chat, not just
          // the panel slot). Y (created server-side) is in the sidebar.
          teardownRemovedSession(id)
        } else {
          // server never acted (network error before processing) — X is still
          // live; leave the panel as-is. The evicting replacement marker for Y
          // was never consumed (batch1 no longer appends Y), so clear it —
          // otherwise Y stays hidden forever.
          setPendingGroupInheritance((prev) => {
            let changed = false
            const next = new Map(prev)
            for (const [newId, pending] of next) {
              if (pending.evicting && pending.sourceId === id) {
                next.delete(newId)
                changed = true
              }
            }
            return changed ? next : prev
          })
        }
        toast.error(`Couldn't ${kind} session: ${(e as Error).message}`)
      } finally {
        // Release the guard + blur only when this is the last in-flight clear
        // for id. A short-circuited second call (same-tab double-/clear) leaves
        // the first call's guard/blur in place; a single-call short-circuit
        // (stuck flag / cross-tab) cleans up instead of blurring forever.
        const remaining = (clearingInFlightRef.current.get(id) ?? 1) - 1
        if (remaining <= 0) {
          clearingInFlightRef.current.delete(id)
          clearingIdsRef.current.delete(id)
          clearingServerRemovedRef.current.delete(id)
          setClearingIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        } else {
          clearingInFlightRef.current.set(id, remaining)
        }
      }
    },
    [toast, cleanupSideChat, swapSession, teardownRemovedSession, pruneSession],
  )

  const handleClear = useCallback((id: string) => resetSession(id, 'clear'), [resetSession])
  const handleCompact = useCallback((id: string) => resetSession(id, 'compact'), [resetSession])

  /** Discard every message after a given assistant message (right-click
   *  "discard from here"). The server forks from the anchor (inclusive) and
   *  detaches X (removeFromStore) — same X→Y swap shape as /clear, so we
   *  reuse the clearingIds guard to suppress the session-removed(X) teardown
   *  until swapSession replaces X. `deleteOriginal` also unlinks X's
   *  transcript server-side (irreversible) — no extra client action. */
  const handleDiscard = useCallback(
    async (id: string, fromAssistantUuid: string, deleteOriginal: boolean) => {
      clearingIdsRef.current.add(id)
      setClearingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      try {
        const res = await api.post<{ session: SessionInfo }>(
          `/sessions/${id}/discard`,
          { fromAssistantUuid, deleteOriginal },
        )
        const newId = res.session.id
        if (newId !== id) {
          cleanupSideChat(id)
          await swapSession(id, newId, res.session)
          pruneSession(id)
        }
      } catch (e) {
        if (clearingServerRemovedRef.current.has(id)) {
          teardownRemovedSession(id)
        } else {
          // server never acted — X is still live. Clear the unconsumed evicting
          // replacement marker (batch1 no longer appends Y) so Y isn't hidden
          // forever.
          setPendingGroupInheritance((prev) => {
            let changed = false
            const next = new Map(prev)
            for (const [newId, pending] of next) {
              if (pending.evicting && pending.sourceId === id) {
                next.delete(newId)
                changed = true
              }
            }
            return changed ? next : prev
          })
        }
        toast.error(`Couldn't discard: ${(e as Error).message}`)
        // Re-throw so the caller's confirm dialog (Chat.discardConfirm)
        // can catch it and reopen (busy=false) for retry. On success the
        // Chat unmounts via the id swap, so the resolution is a no-op.
        throw e
      } finally {
        clearingIdsRef.current.delete(id)
        clearingServerRemovedRef.current.delete(id)
        setClearingIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [toast, cleanupSideChat, swapSession, teardownRemovedSession, pruneSession],
  )

  const refreshConfigResponse = useCallback(async () => {
    const r = await api.get<ConfigResponse>('/config')
    setDefaults(r.defaults)
    if (r.models?.length) setServerModels(r.models)
    if (r.maxOpenPanels != null) setServerMaxOpen(r.maxOpenPanels)
    setGlobalPrefs({
      showPinnedUserMessage: r.showPinnedUserMessage ?? true,
      autoRecap: r.autoRecap ?? true,
      firstPartyTools: r.firstPartyTools,
    })
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
    // before the modal is fully closed.
    updateInfo.refresh()
  }, [refreshConfigResponse, updateInfo])

  // Memoize the settings tab request so ChatPanel's React.memo doesn't
  // see a new object reference on every render.
  const stableSettingsTabRequest = useMemo(
    () => settingsTabRequest ? { tab: settingsTabRequest.tab, nonce: settingsTabRequest.nonce } : null,
    [settingsTabRequest],
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
      className={`app${isMobile && drawerOpen ? ' drawer-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      style={{ ['--sidebar-width' as string]: `${effectiveSidebarWidth}px` }}
    >
      {/* Skip link for keyboard users — first focusable element on the
          page. Hidden visually until it receives focus, at which point
          it slides into view. Sends focus to the chat panels region so
          a Tab-only user doesn't have to walk through the entire
          sidebar to reach the conversation. */}
      <a className="skip-link" href="#main">Skip to chat</a>
      {/* Desktop-only: a persisted `sidebarCollapsed` must not inert the mobile
          drawer (the user may collapse on desktop, then resize to mobile). */}
      <aside
        className="sidebar"
        aria-label="Sessions"
        inert={!isMobile && sidebarCollapsed}
        aria-hidden={!isMobile && sidebarCollapsed}
        {...drawerSwipe}
      >
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
          skin={skin}
          onSelect={handleSelectFromSidebar}
          onCreate={handleCreate}
          firstPartyTools={globalPrefs.firstPartyTools}
          onDelete={handleDelete}
          onSleep={sleepSession}
          onClosePanel={closeSession}
          onFork={handleFork}
          onNewLikeThis={handleNewLikeThis}
          onRestart={handleRestart}
          onReorder={handleReorderSidebar}
          onDropIntoGroup={handleAddToGroup}
          onReorderInGroup={handleReorderInGroup}
          onReorderGroups={handleReorderGroups}
          onMoveGroup={handleMoveGroup}
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
          maxGroupSize={maxGroupSize}
          isMobile={isMobile}
          showGroupHints={heldModifiers.alt}
        />
        <PluginWidgetSlot location="global.bottomLeft" />
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
              is already visible inside each ChatPanel header — duplicating
              it at the top was both redundant and subtly wrong (it looked
              like "the active session" when all three are active). Now the
              row holds only the app-level toolbar. */}
          {/* Desktop sidebar hide/show toggle. Rendered only on desktop — on mobile
              the sidebar is a drawer controlled by the hamburger (drawer-toggle). */}
          {!isMobile && (
            <button
              className="btn btn-icon"
              onClick={() => setSidebarCollapsed((v) => !v)}
              aria-pressed={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              <IconSidebar size={16} />
            </button>
          )}
          <ProfileSwitcher onManageProfiles={() => setGlobalSettingsOpen(true)} />
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
              onClick={() => setUploadsDialogOpen(true)}
              title="Uploaded files"
              aria-label="Uploaded files"
            >
              <IconFolderSearch size={16} />
            </button>
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
              const owningGroup = groups.find((g) => g.sessionIds.includes(s.id))
              const clearing = clearingIds.has(s.id)
              const node = (
                // Per-panel ErrorBoundary: if one panel's render throws
                // (e.g. a malformed assistant message), the other open
                // panels and the sidebar keep working. children identity
                // changes on prop updates, so a recovered render auto-clears.
                <PanelSlot key={s.id}>
                  <ErrorBoundary key={s.id}>
                    <ChatPanel
                      session={s}
                      focused={s.id === focusedId}
                      globalPrefs={globalPrefs}
                      clearing={clearing}
                      hasUnread={!!unread[s.id]}
                      slot={i + 1}
                      composerFocusSignal={panelFocusSignals[i]}
                      showSlotHints={heldModifiers.ctrlOrMeta}
                      entering={entering}
                      onAnimEnd={entering ? handlePanelAnimEnd : undefined}
                      accentStyle={sessionAccentMap.get(s.id)}
                      onFocus={focusPanel}
                      onClose={closeSession}
                      onResume={handleResumePanel}
                      onForkFromLastCompleted={handleCrashFork}
                      groupLabel={owningGroup?.name}
                      onCloseGroupPanels={
                        owningGroup ? closeGroupPanelsHandlers.get(owningGroup.id) : undefined
                      }
                      onDelete={handleDelete}
                      onSessionUpdate={updateSession}
                      settingsOpen={settingsOpenFor === s.id}
                      messageJumpTarget={messageJumpTarget?.sessionId === s.id ? messageJumpTarget : null}
                      onOpenSettings={handleOpenSettings}
                      onCloseSettings={handleCloseSettings}
                      gitPanelOpen={gitPanelOpenFor === s.id}
                      onOpenGitPanel={handleOpenGitPanel}
                      onCloseGitPanel={handleCloseGitPanel}
                      tasksPanelOpen={tasksPanelOpenFor === s.id}
                      onOpenTasksPanel={handleOpenTasksPanel}
                      onCloseTasksPanel={handleCloseTasksPanel}
                      onSwap={swapPanels}
                      onRegisterInterrupt={registerInterrupt}
                      onRegisterRecap={registerRecap}
                      onRegisterBackground={registerBackground}
                      onRegisterTurnActive={registerTurnActive}
                      onInterruptFired={handleInterruptFired}
                      onAcceptSidebarDrop={handleAcceptSidebarDrop}
                      onRequestResumeForPanel={requestResumeForPanel}
                      resumeOpen={resumeDialogOpen && resumeTargetPanelId === s.id}
                      onResumeIntoPanel={handlePanelResume}
                      onCloseResume={closeResume}
                      historyOpen={historyPanelOpen && focusedId === s.id}
                      onCloseHistory={handleCloseHistory}
                      onClearSession={handleClear}
                      onCompactSession={handleCompact}
                      onDiscard={handleDiscard}
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
                      skin={skin}
                    />
                  </ErrorBoundary>
                </PanelSlot>
              )
              if (i === openSessions.length - 1) return [node]
              return [
                node,
                <div
                  key={`divider-${s.id}`}
                  className={`panel-divider ${draggingDivider === i ? 'dragging' : ''}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize panel"
                  onMouseDown={onDividerMouseDown(i)}
                  onKeyDown={onPanelDividerKeyDown(i)}
                  onDoubleClick={() => setPanelRatios(Object.fromEntries(resolvedOpenIds.map((id) => [id, 1])))}
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
          pluginCommands={pluginPaletteCommands}
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

      {resumeDialogPresence.shouldRender && (
        <Suspense fallback={null}>
          {/* Global / empty-state resume picker. Only renders when no panel
              is targeted (resumeTargetPanelId === null) — the panel-targeted
              case renders as an in-panel overlay inside <Chat> instead. */}
          <ResumeSessionDialog
            variant="modal"
            open={resumeDialogOpen}
            defaultCwd={defaults.cwd}
            onResume={(id) => {
              closeResume()
              if (openIds.includes(id)) {
                setFocusedId(id)
                return
              }
              const known = sessions.find((s) => s.id === id)
              if (known && !known.running && (!known.terminated || known.canRetryResume)) {
                // Tracked dormant (or transiently-terminated) session — reuse
                // the sidebar flow. Terminated ones now open to the composer's
                // Resume / Fork-from-last-completed choice banner (handleSelect
                // never auto-resumes a terminated session).
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
            onCancel={closeResume}
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
            versions={updateInfo.versions}
            versionsLoading={updateInfo.versionsLoading}
            versionsError={updateInfo.versionsError}
            onFetchVersions={updateInfo.fetchVersions}
          />
        </Suspense>
      )}

{uploadsDialogPresence.shouldRender && (
        <Suspense fallback={null}>
          <UploadsManagerDialog
            open={uploadsDialogOpen}
            onClose={() => setUploadsDialogOpen(false)}
          />
        </Suspense>
      )}

      {structuredOpen && (
        <Suspense fallback={null}>
          <StructuredPanel open onClose={() => setStructuredOpen(false)} />
        </Suspense>
      )}

      {/* Composer snippet dialogs — rendered ONCE at app level (a single
          global instance shared by every panel). Use .perm-overlay which
          covers the viewport and centers the card. */}
      <AnimatePresence>
        {pendingSnippetSave && (
          <Suspense fallback={null}>
            <PromptDialog
              key="snippet-save"
              title="Save snippet"
              message={
                <>
                  <p>Pick a label for this snippet. The current composer text will be saved as its content.</p>
                  <pre className="snippet-save-preview">{pendingSnippetSave.content}</pre>
                </>
              }
              defaultValue=""
              confirmLabel="Save"
              placeholder="Snippet label"
              onConfirm={(label) => {
                snippets.add(label, pendingSnippetSave.content)
                setPendingSnippetSave(null)
              }}
              onCancel={() => setPendingSnippetSave(null)}
            />
          </Suspense>
        )}
      </AnimatePresence>

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
