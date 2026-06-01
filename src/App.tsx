// Top-level layout: left sidebar (sessions), center pane with up to 3
// Chat panels side-by-side. Session Settings now renders as a per-panel
// overlay (inside ChatPanel) rather than a right drawer — see below.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { api } from './hooks/useApi'
import { isInAppDrag, readDragPayload } from './hooks/useDragPayload'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useLocalStorage } from './hooks/useLocalStorage'
import { usePanelColumnResize } from './hooks/usePanelColumnResize'
import { useSidebarResize } from './hooks/useSidebarResize'
import { useSessionNotifications } from './hooks/useSessionNotifications'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useWsHub, useWsHubStatus } from './hooks/useWsHub'
import type { WsServerFrame } from './ws-types'
import type { NewSessionForm, PermissionMode, SessionGroup, SessionInfo, SidebarSection } from './types'
import { PERMISSION_MODES } from './types'
import { ACCENT_COLORS } from './theme'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SetupPage } from './components/SetupPage'
import { ThemeToggle } from './components/ThemeToggle'
import { UpdateBanner } from './components/UpdateBanner'
import { useUpdateInfo } from './hooks/useUpdateInfo'

// Lazy-load heavy modal/overlay components that are only shown on demand.
// This keeps the initial bundle lean — the user pays the download cost
// only when they actually open the palette, settings, or help modal.
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const ShortcutHelp = lazy(() => import('./components/ShortcutHelp').then((m) => ({ default: m.ShortcutHelp })))
const GlobalSettingsModal = lazy(() => import('./components/GlobalSettingsModal').then((m) => ({ default: m.GlobalSettingsModal })))

import {
  SIDEBAR_ORDER_KEY,
  SHOW_SYSTEM_EVENTS_KEY,
  SIDEBAR_MIN_KEY,
  SIDEBAR_MAX_KEY,
  SIDEBAR_MIN_DEFAULT,
  SIDEBAR_MAX_DEFAULT,
  PANEL_MIN_RATIO_KEY,
  PANEL_MIN_RATIO_DEFAULT,
  GROUPS_KEY,
  COLLAPSED_GROUPS_KEY,
  LAST_SEEN_TURN_KEY,
  clampMaxOpen,
} from './constants/storageKeys'
import type { Defaults, ConfigResponse } from './types/config'
import { notificationTooltip } from './utils/notifications'
import { computeUnread, bumpLastSeen, pruneLastSeen } from './utils/unread'

export function App() {
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  /** Ordered list of open session ids (oldest first). Length ≤ maxOpen. */
  const [openIds, setOpenIds] = useState<string[]>([])
  /** Which of the open panels is currently focused (controls settings
   *  panel target + clears unread when selected). */
  const [focusedId, setFocusedId] = useState<string | null>(null)
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
  /** When non-null, the Settings overlay is rendered on top of the chat
   *  panel with this session id. Previously a single boolean that targeted
   *  the focused session — making it per-session lets the overlay cover
   *  just that column instead of the whole viewport. */
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null)
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false)
  const newSessionDialogOpenRef = useRef(newSessionDialogOpen)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  // Operational errors and one-shot notifications go through the global
  // toast hub (mounted in main.tsx). Use `toast.error(...)` for anything
  // a user can dismiss/scan; persistent connection state (Reconnecting…)
  // is rendered separately as an inline banner — it's a status, not a
  // notification.
  const toast = useToast()
  // Theme + accent (global + per-session). Lives in its own hook so
  // App.tsx isn't on the hook for the OS-theme subscription, accent
  // CSS-var sync, and the React-19-unmount-race write-through pattern.
  const {
    theme,
    toggleThemeNext,
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
  const [sidebarOrder, setSidebarOrder] = useLocalStorage<string[]>(SIDEBAR_ORDER_KEY, [])
  /** Named session groups for quick layout switching. */
  const [groups, setGroups] = useLocalStorage<SessionGroup[]>(GROUPS_KEY, [])
  /** Which group headers are collapsed in the sidebar. */
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<Record<string, boolean>>(COLLAPSED_GROUPS_KEY, {})
  /** Max number of chat panels open at once, and max sessions per group.
   *  Shared setting because the main grid and groups should agree on
   *  capacity. Server-driven via /api/config → config.json. */
  const [serverMaxOpen, setServerMaxOpen] = useState<number>(3)
  const maxOpen = clampMaxOpen(serverMaxOpen)

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

  /** Show SDK bookkeeping messages (system/init, system/status, …) in
   *  the transcript. Off by default — they're noise for normal use,
   *  but invaluable when debugging tool wiring or context compaction. */
  const [showSystemEvents, setShowSystemEvents] = useLocalStorage<boolean>(SHOW_SYSTEM_EVENTS_KEY, false)
  const { sidebarWidth: effectiveSidebarWidth, sidebarResize, setSidebarWidth } = useSidebarResize({ minPx: sidebarMinPx, maxPx: sidebarMaxPx })

  const [gitPanelOpenFor, setGitPanelOpenFor] = useState<string | null>(null)
  // Open/close handlers enforce mutual exclusion between Settings and
  // Git panels — only one overlay per chat panel at a time. Each opener
  // clears the other's state, which keeps the UI predictable when the
  // user clicks back and forth between the two chips.
  const handleCloseSettings = useCallback(() => setSettingsOpenFor(null), [])
  const handleOpenSettings = useCallback((id: string) => {
    setSettingsOpenFor(id)
    setGitPanelOpenFor(null)
  }, [])
  const handleCloseGitPanel = useCallback(() => setGitPanelOpenFor(null), [])
  const handleOpenGitPanel = useCallback((id: string) => {
    setGitPanelOpenFor(id)
    setSettingsOpenFor(null)
  }, [])

  const { gridTemplate, onDividerMouseDown, draggingDivider, bodyRef, setPanelRatios } = usePanelColumnResize({ openIds, panelMinRatio })

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
  const paletteOpenRef = useRef(paletteOpen)
  const helpOpenRef = useRef(helpOpen)
  const settingsOpenForRef = useRef(settingsOpenFor)
  const gitPanelOpenForRef = useRef(gitPanelOpenFor)
  const handleSelectRef = useRef<(id: string) => void>(() => {})
  // Per-session interrupt callbacks registered by <Chat> components.
  // The ESC shortcut in the keyboard handler uses this to trigger the
  // same code-path as the Composer's interrupt button (which sets
  // pendingInterruptRef for the "interrupted" label).
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
  // Keep refs in sync with the latest state values. Assigned directly
  // in the render body (before return) so callbacks that capture these
  // refs always read the current values — no useEffect needed.
  /* eslint-disable react-hooks/refs -- intentional render-time ref sync; the alternative (useEffect) would lag by one render and break stale-closure callbacks downstream */
  openIdsRef.current = openIds
  focusedIdRef.current = focusedId
  sessionsRef.current = sessions
  resumingRef.current = resuming
  maxOpenRef.current = maxOpen
  paletteOpenRef.current = paletteOpen
  helpOpenRef.current = helpOpen
  settingsOpenForRef.current = settingsOpenFor
  gitPanelOpenForRef.current = gitPanelOpenFor
  newSessionDialogOpenRef.current = newSessionDialogOpen
  /* eslint-enable react-hooks/refs */

  // Notification coordinator: working-flag edge detector + permission
  // gate, both gated on `document.hasFocus() && focusedId === sessionId`.
  // The hook owns notifyRef + prevWorkingRef internally; App keeps only
  // the bell-button-facing `notifications` slice and the three
  // session-event callbacks the WS hub effect calls into.
  const { notifications, maybeNotify, maybePermissionNotify, seedWorkingState, pruneSession } =
    useSessionNotifications({ focusedIdRef, sessionsRef, handleSelectRef })

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
  const reconnectingBanner = hubStatus === 'reconnecting' ? 'Reconnecting to server…' : null

  useEffect(() => {
    const off = hub.addListener((frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'sessions-snapshot': {
          setSessions(frame.sessions)
          // Reconcile open/focused against whatever the server reports.
          const ids = new Set(frame.sessions.map((s) => s.id))
          setOpenIds((prev) => prev.filter((id) => ids.has(id)))
          setFocusedId((prev) => (prev && ids.has(prev) ? prev : null))
          // Prune lastSeenTurn entries whose sessions are gone — keeps
          // the persisted map from growing unbounded across restarts.
          setLastSeenTurn((prev) => pruneLastSeen(prev, ids))
          // Same idea for sidebarOrder and group.sessionIds — server is
          // authoritative, so any id it doesn't list is dead. Without
          // this, deleted sessions accumulate forever in localStorage.
          setSidebarOrder((prev) => {
            const next = prev.filter((id) => ids.has(id))
            return next.length === prev.length ? prev : next
          })
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
          break
        }
        case 'session-created': {
          setSessions((prev) => {
            if (prev.some((s) => s.id === frame.session.id)) return prev
            return [frame.session, ...prev]
          })
          // Seed the edge-detector so a session that spawns already
          // working doesn't fire a notification on its first true→false
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
          // Questions get a dedicated wording — "Claude is asking a
          // question" reads better than "Claude wants to use AskUserQuestion".
          const r = frame.request
          const label =
            r.kind === 'question'
              ? 'a question'
              : (('displayName' in r && r.displayName) ||
                  ('toolName' in r && r.toolName) ||
                  'a tool')
          maybePermissionNotify(frame.sessionId, label as string)
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
  }, [hub, maybeNotify, maybePermissionNotify, seedWorkingState, pruneSession, setLastSeenTurn, setSidebarOrder, setGroups])

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
   *  - Not open but ≥ maxOpen already → evict the oldest non-focused id.
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
   *  empty). If the target group is full, the oldest (first) session in
   *  it is evicted — it becomes ungrouped automatically. */
  const handleAddToGroup = useCallback(
    (sessionId: string, groupId: string) => {
      setGroups((prev) => {
        // Empty groupId → just remove from all groups (ungroup).
        if (!groupId) {
          return prev.map((g) => ({
            ...g,
            sessionIds: g.sessionIds.filter((id) => id !== sessionId),
          }))
        }
        const target = prev.find((g) => g.id === groupId)
        if (!target) return prev
        // Already in this group — no-op.
        if (target.sessionIds.includes(sessionId)) return prev
        // Remove from old group, then add to target.  If the target is
        // full, evict its first (oldest) session so the new one fits.
        return prev.map((g) => {
          // Remove from old group
          const without = { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }
          if (g.id !== groupId) return without
          // Add to target (evict oldest if full)
          const ids = without.sessionIds
          if (ids.length >= maxOpen) {
            return { ...without, sessionIds: [...ids.slice(1), sessionId] }
          }
          return { ...without, sessionIds: [...ids, sessionId] }
        })
      })
    },
    [setGroups, maxOpen],
  )

  /** The group whose sessions are currently open in the main grid.
   *  null when openIds is empty or no group fully owns the open set. */
  const activeGroupId = useMemo(() => {
    if (openIds.length === 0) return null
    return groups.find((g) => openIds.every((id) => g.sessionIds.includes(id)))?.id ?? null
  }, [openIds, groups])

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

  /** Create a brand-new empty session that reuses the source session's
   *  basic config (cwd, model, permissionMode) without carrying over any
   *  conversation history. Think "fork the settings, not the transcript". */
  const handleNewLikeThis = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      // Inherit the source's group. If the source is ungrouped, fall
      // back to the first group with room. groupId may be undefined
      // (the new session will be ungrouped).
      const fallbackGroup = groups.find((g) => g.sessionIds.length < maxOpen)
      const form: NewSessionForm = {
        cwd: source.cwd,
        model: source.model,
        permissionMode: source.permissionMode,
        title: source.title ? `${source.title} (copy)` : undefined,
        // Carry forward the beta flags so a 1M-context session stays 1M
        // when copied. Without this, "new like this" silently downgrades
        // the window.
        betas: source.betas,
        groupId: sourceGroup?.id ?? fallbackGroup?.id,
      }
      await handleCreate(form)
    },
    [sessions, groups, maxOpen, handleCreate],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.delete(`/sessions/${id}`)
        closeSession(id)
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
      } catch (e) {
        toast.error(`Couldn't delete session: ${(e as Error).message}`)
      }
    },
    [closeSession, setGroups, handleSessionColorChange, toast],
  )

  /** Create a fresh session with the same config, then delete the old one.
   *  Create-first ensures the old session is preserved if creation fails. */
  const handleRestart = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      const fallbackGroup = groups.find((g) => g.sessionIds.length < maxOpen)
      const form: NewSessionForm = {
        cwd: source.cwd,
        model: source.model,
        permissionMode: source.permissionMode,
        // Preserve beta flags (notably `context-1m-...`) so restart
        // doesn't silently drop the window from 1M back to 200k.
        betas: source.betas,
        groupId: sourceGroup?.id ?? fallbackGroup?.id,
      }
      // Create first — if this fails, the old session stays intact.
      // handleCreate already surfaces failure via toast (never re-throws).
      await handleCreate(form)
      // Only delete the old session after the new one is confirmed created.
      await handleDelete(id)
    },
    [sessions, groups, maxOpen, handleCreate, handleDelete],
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
      // Resume dormant sessions in the background.
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

      // Ungrouped session → single-panel mode (replace all open panels).
      if (!sessionGroup) {
        setLastSeenTurn((prev) => ({ ...prev, [id]: s.lastTurnAt ?? Date.now() }))
        if (!s.running && !s.terminated && !resumingRef.current.has(id)) {
          // Resume FIRST, then open the panel — this ensures Chat mounts
          // with the session already running on the server, so the hub
          // subscribe → replay flow is fully ready. Without this, the
          // panel shows a dormant placeholder that flashes to "loading"
          // when resume completes, and the replay may arrive before the
          // hub subscribe fires, losing messages.
          await resumeSession(id, () => {
            // React batches these with the setSessions above so Chat
            // mounts with the fresh (running=true) session immediately.
            setOpenIds([id])
            setFocusedId(id)
          })
        } else {
          // Already running or terminated — open immediately.
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

  /** Open sessions, rendered in the order they were opened. Filter by
   *  what the server currently reports so a deleted-on-server session
   *  disappears on the next poll. */
  const openSessions = useMemo(
    () => openIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s),
    [openIds, sessions],
  )

  const updateSession = useCallback((s: SessionInfo) => {
    setSessions((prev) => prev.map((p) => (p.id === s.id ? s : p)))
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
          combo: 'mod+k',
          handler: () => setPaletteOpen((v) => !v),
          description: 'Command palette',
        },
        {
          combo: 'mod+?',
          handler: () => setHelpOpen((v) => !v),
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
            const idx = PERMISSION_MODES.indexOf(cur)
            const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
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
            // Priority: CommandPalette > ShortcutHelp > NewSessionDialog > per-panel Git overlay > Settings overlay > Interrupt.
            // Git is checked before Settings because it's the more recently
            // introduced overlay and tends to be what the user wants to
            // close when they press Esc with both possible.
            if (paletteOpenRef.current) setPaletteOpen(false)
            else if (helpOpenRef.current) setHelpOpen(false)
            else if (newSessionDialogOpenRef.current) setNewSessionDialogOpen(false)
            else if (gitPanelOpenForRef.current) setGitPanelOpenFor(null)
            else if (settingsOpenForRef.current) setSettingsOpenFor(null)
            else if (focusedIdRef.current) {
              const focused = sessionsRef.current.find((s) => s.id === focusedIdRef.current)
              if (focused?.working) {
                // Use the registered interrupt callback (set by <Chat>)
                // so pendingInterruptRef is set and the result message
                // shows the "interrupted" label.
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
      [closeSession],
    )
  useKeyboardShortcuts(shortcuts)

  /** Final sidebar order: sidebarOrder[] wins for ids it contains; anything
   *  not listed falls back to the server's lastActivityAt sort. Ids in the
   *  saved order but no longer present on the server are dropped. */
  const orderedSessions = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const ordered: SessionInfo[] = []
    const seen = new Set<string>()
    for (const id of sidebarOrder) {
      const s = byId.get(id)
      if (s) {
        ordered.push(s)
        seen.add(id)
      }
    }
    for (const s of sessions) if (!seen.has(s.id)) ordered.push(s)
    return ordered
  }, [sessions, sidebarOrder])

  /** Grouped sidebar view: groups -> ungrouped. Sessions not in any group
   *  appear in the "Ungrouped" section at the bottom. */
  const sidebarSections = useMemo((): SidebarSection[] => {
    const byId = new Map(sessions.map((s) => [s.id, s]))

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
    for (const s of sessions) {
      if (!groupedIds.has(s.id)) ungrouped.push(s)
    }
    if (ungrouped.length > 0) {
      sections.push({ kind: 'ungrouped', sessions: ungrouped })
    }

    return sections
  }, [sessions, groups])

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
      setSidebarOrder(without)
    },
    [orderedSessions, setSidebarOrder],
  )

  // --- Session group management ----------------------------------------------

  const handleCreateGroup = useCallback(
    (name: string) => {
      const id = crypto.randomUUID()
      setGroups((prev) => [...prev, { id, name, sessionIds: [] }])
      return id
    },
    [setGroups],
  )

  /** Delete a group. Orphaned sessions automatically become ungrouped
   *  (they'll appear in the sidebar's "Ungrouped" section). */
  const handleDeleteGroup = useCallback(
    (groupId: string) => {
      setGroups((prev) => prev.filter((g) => g.id !== groupId))
      setCollapsedGroups((prev) => {
        if (!(groupId in prev)) return prev
        const next = { ...prev }
        delete next[groupId]
        return next
      })
    },
    [setGroups, setCollapsedGroups],
  )

  const handleRenameGroup = useCallback(
    (groupId: string, name: string) => {
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)))
    },
    [setGroups],
  )

  /** Drag-drop handler for a card landing on a card inside a group.
   *  The dragged session's position within `sessionIds` is set relative
   *  to the target. With exclusive membership, the session is only in
   *  one group, so this only reorders within that group. */
  const handleReorderInGroup = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after', groupId: string) => {
      if (draggedId === targetId) return
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g
          // Splice-insert into a copy of the current sessionIds,
          // making the operation a single atomic update so a
          // concurrent render doesn't see an intermediate state.
          const without = g.sessionIds.filter((id) => id !== draggedId)
          const targetIdx = without.indexOf(targetId)
          // If the target isn't in this group (shouldn't happen — the
          // UI only renders target cards inside their container group),
          // append to the end rather than losing the drop entirely.
          const insertAt = targetIdx < 0 ? without.length : position === 'before' ? targetIdx : targetIdx + 1
          without.splice(insertAt, 0, draggedId)
          return { ...g, sessionIds: without }
        }),
      )
    },
    [setGroups],
  )

  const toggleGroupCollapse = useCallback(
    (groupId: string) => {
      setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
    },
    [setCollapsedGroups],
  )

  /** Swap two open panels' positions. Focus follows the dragged panel so
   *  the user's attention lands where their cursor is. */
  const swapPanels = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    setOpenIds((prev) => {
      const i = prev.indexOf(draggedId)
      const j = prev.indexOf(targetId)
      if (i < 0 || j < 0) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setFocusedId(draggedId)
  }, [])

  /** Drop a sidebar card onto a specific slot in the main grid. If the
   *  slot is occupied by another session, that session is evicted (panel
   *  closes, session stays alive) and the new one takes its place. */
  const openAtSlot = useCallback(
    (id: string, targetId: string, lastTurnAt: number | undefined) => {
      setOpenIds((prev) => {
        // Already open? Just swap into the target slot.
        if (prev.includes(id)) {
          const i = prev.indexOf(id)
          const j = prev.indexOf(targetId)
          if (i < 0 || j < 0) return prev
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
      setFocusedId(id)
      setLastSeenTurn((prev) => ({ ...prev, [id]: lastTurnAt ?? Date.now() }))
    },
    [setLastSeenTurn],
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
    // before the modal is fully closed.
    updateInfo.refresh()
  }, [refreshConfigResponse, updateInfo])

  if (isConfigured === null) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    )
  }
  if (!isConfigured) return <SetupPage onConfigured={handleConfigured} />

  return (
    <ErrorBoundary>
    <div
      className="app"
      style={{ ['--sidebar-width' as string]: `${effectiveSidebarWidth}px` }}
    >
      {/* Skip link for keyboard users — first focusable element on the
          page. Hidden visually until it receives focus, at which point
          it slides into view. Sends focus to the chat panels region so
          a Tab-only user doesn't have to walk through the entire
          sidebar to reach the conversation. */}
      <a className="skip-link" href="#main">Skip to chat</a>
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand">
          <span className="brand-dot" /> claude-react-web
        </div>
        <SessionList
          sessions={orderedSessions}
          openIds={openIds}
          focusedId={focusedId}
          defaults={defaults}
          serverModels={serverModels}
          resumingIds={resuming}
          unread={unread}
          sessionColors={sessionColors}
          onSessionColorChange={handleSessionColorChange}
          onSelect={handleSelect}
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
          // Double-click resets to default.
          onDoubleClick={() => setSidebarWidth(280)}
          title="Drag to resize · double-click to reset"
        />
      </aside>

      {/* tabIndex={-1} makes the landmark a programmatic focus target so
          activating the skip-link (`href="#main"`) actually moves focus
          here. Without it, the browser scrolls into view but focus stays
          at the link, and the next Tab walks back through the sidebar —
          defeating the whole point of the skip-link. */}
      <main className="main" id="main" tabIndex={-1} aria-label="Chat panels">
        <header className="main-header">
          {/* The header used to echo the focused session's title / model /
              mode / cwd, but with up to three panels open that information
              is already visible inside each ChatPanel header — duplicating
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
              className={`btn btn-icon ${showSystemEvents ? 'active' : ''}`}
              onClick={() => setShowSystemEvents((v) => !v)}
              title={
                showSystemEvents
                  ? 'Hide SDK system events (init / status / …)'
                  : 'Show SDK system events (init / status / …) · useful for debugging'
              }
              aria-label="Toggle system events"
              aria-pressed={showSystemEvents}
            >
              {showSystemEvents ? '🐞' : '🫥'}
            </button>
            <button
              className={`btn btn-icon ${notifications.enabled ? 'active' : ''}`}
              onClick={() => void notifications.toggle()}
              title={notificationTooltip(notifications.permission, notifications.enabled)}
              disabled={notifications.permission === 'unsupported'}
              aria-label="Toggle desktop notifications"
            >
              {notifications.enabled ? '🔔' : '🔕'}
            </button>
            <div className="btn btn-icon accent-picker" role="radiogroup" aria-label="Accent colour">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c.accent}
                  className={`accent-swatch${accentColor === c.accent ? ' active' : ''}`}
                  style={{ '--swatch': c.accent, '--swatch-strong': c.strong } as CSSProperties}
                  onClick={() => setAccentColor(c.accent)}
                  role="radio"
                  aria-checked={accentColor === c.accent}
                  aria-label={c.name}
                  title={c.name}
                />
              ))}
            </div>
            <ThemeToggle theme={theme} onToggle={toggleThemeNext} />
            <button
              className="btn btn-icon"
              onClick={() => setGlobalSettingsOpen(true)}
              title="Global Settings"
              aria-label="Global Settings"
            >
              ⚙
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
          role="alert"
          aria-live="polite"
        >
          {reconnectingBanner ?? ''}
        </div>

        <UpdateBanner info={updateInfo.info} />

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
            <div className="empty-state">
              <h2>Start a new session</h2>
              <p>
                Use the left sidebar to create a chat session. Each session is a live Claude Agent SDK{' '}
                <code>Query</code>. Up to {maxOpen} can be open at once.
              </p>
            </div>
          ) : (
            // Flatten panels + dividers into a single children list. The grid
            // template we built alternates fr / 4px tracks, so this order has
            // to match or the columns will de-sync.
            openSessions.flatMap((s, i) => {
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
                    accentStyle={sessionAccentMap.get(s.id)}
                    onFocus={focusPanel}
                    onClose={closeSession}
                    onSessionUpdate={updateSession}
                    showSystemEvents={showSystemEvents}
                    settingsOpen={settingsOpenFor === s.id}
                    onOpenSettings={handleOpenSettings}
                    onCloseSettings={handleCloseSettings}
                    gitPanelOpen={gitPanelOpenFor === s.id}
                    onOpenGitPanel={handleOpenGitPanel}
                    onCloseGitPanel={handleCloseGitPanel}
                    onSwap={swapPanels}
                    onRegisterInterrupt={registerInterrupt}
                    onRegisterRecap={registerRecap}
                    onAcceptSidebarDrop={handleAcceptSidebarDrop}
                    isResuming={resuming.has(s.id)}
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
                  onDoubleClick={() => setPanelRatios(Object.fromEntries(openIds.map((id) => [id, 1])))}
                  title="Drag to resize · double-click to reset"
                />,
              ]
            })
          )}
        </div>
      </main>

      <Suspense fallback={null}>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          shortcuts={shortcuts}
          sessions={sessions}
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
        <ShortcutHelp
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          shortcuts={shortcuts}
        />
      </Suspense>

      {globalSettingsOpen && (
        <Suspense fallback={null}>
          <GlobalSettingsModal
            onClose={() => setGlobalSettingsOpen(false)}
            onSaved={handleGlobalSettingsSaved}
            updateInfo={updateInfo.info}
            updateRefreshing={updateInfo.refreshing}
            updateError={updateInfo.error}
            onRefreshUpdate={updateInfo.refresh}
          />
        </Suspense>
      )}
    </div>
    </ErrorBoundary>
  )
}
