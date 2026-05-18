// Top-level layout: left sidebar (sessions), center pane with up to 3
// Chat panels side-by-side. Session Settings now renders as a per-panel
// overlay (inside ChatPanel) rather than a right drawer — see below.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SessionList } from './components/SessionList'
import { CommandPalette } from './components/CommandPalette'
import { ChatPanel } from './components/ChatPanel'
import { api } from './hooks/useApi'
import { isInAppDrag, readDragPayload } from './hooks/useDragPayload'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useLocalStorage } from './hooks/useLocalStorage'
import { usePanelColumnResize } from './hooks/usePanelColumnResize'
import { useSidebarResize } from './hooks/useSidebarResize'
import { useNotifications } from './hooks/useNotifications'
import { useWsHub, useWsHubStatus } from './hooks/useWsHub'
import type { WsServerFrame } from './ws-types'
import type { NewSessionForm, PermissionMode, SessionGroup, SessionInfo, SidebarSection } from './types'
import { PERMISSION_MODES } from './types'
import { ACCENT_COLORS, ACCENT_COLOR_KEY, SESSION_COLORS_KEY } from './theme'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SetupPage } from './components/SetupPage'
import { ThemeToggle } from './components/ThemeToggle'
import { ShortcutHelp } from './components/ShortcutHelp'
import { GlobalSettingsModal } from './components/GlobalSettingsModal'
import { applyTheme, getStoredTheme, onSystemThemeChange, toggleTheme, type Theme } from './utils/theme'

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
import type { Defaults, ServerConfig } from './types/config'
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)
  // Theme state — persisted in localStorage, applied via data-theme on <html>.
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  // Apply theme on mount and whenever it changes. applyTheme() resolves
  // 'system' to 'dark'/'light' before writing the data-theme attribute.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  // Subscribe to OS theme changes so 'system' mode stays in sync when
  // the user switches their OS preference.
  useEffect(() => {
    if (theme !== 'system') return
    return onSystemThemeChange(() => {
      applyTheme('system')
      // Force a re-render so children pick up the resolved value.
      setTheme('system')
    })
  }, [theme])
  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => toggleTheme(prev))
  }, [])
  /** Ids currently being resumed — briefly disables the item so a double-
   *  click doesn't fire two POSTs. */
  const [resuming, setResuming] = useState<Set<string>>(new Set())
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
  const [accentColor, setAccentColor] = useLocalStorage<string>(ACCENT_COLOR_KEY, ACCENT_COLORS[0].accent)
  /** Per-session accent overrides. Keys are session ids; values are accent
   *  hex strings from ACCENT_COLORS. Missing entries fall back to the
   *  global accentColor. */
  const [sessionColors, setSessionColors] = useLocalStorage<Record<string, string>>(SESSION_COLORS_KEY, {})
  const [showSystemEvents, setShowSystemEvents] = useLocalStorage<boolean>(SHOW_SYSTEM_EVENTS_KEY, false)
  const { sidebarWidth: effectiveSidebarWidth, sidebarResize, setSidebarWidth } = useSidebarResize({ minPx: sidebarMinPx, maxPx: sidebarMaxPx })

  // Sync the chosen accent colour into :root CSS custom properties so the
  // entire stylesheet picks up the change without any further wiring.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--accent', accentColor)
    const preset = ACCENT_COLORS.find((c) => c.accent === accentColor)
    root.setProperty('--accent-strong', preset?.strong ?? accentColor)
  }, [accentColor])

  /** Return CSS custom-property overrides for a session that has a
   *  per-session accent, or undefined when it should use the global one. */
  const sessionAccentStyle = useCallback(
    (sessionId: string): CSSProperties | undefined => {
      const hex = sessionColors[sessionId]
      if (!hex) return undefined
      const preset = ACCENT_COLORS.find((c) => c.accent === hex)
      return { '--accent': hex, '--accent-strong': preset?.strong ?? hex } as CSSProperties
    },
    [sessionColors],
  )

  const handleSessionColorChange = useCallback((id: string, color: string | undefined) => {
    // Bypass the React state updater. Opening the context menu is
    // the only way this fires, and clicking a colour unmounts the
    // menu in the same tick — React 19 may then discard a setState
    // updater whose resulting state "won't matter" after unmount,
    // exactly like the rememberIn bug. Write through directly,
    // then sync React state for the still-mounted SessionList.
    const curr: Record<string, string> = (() => {
      try {
        const raw = window.localStorage.getItem(SESSION_COLORS_KEY)
        return raw ? (JSON.parse(raw) ?? {}) : {}
      } catch {
        return {}
      }
    })()
    if (color) curr[id] = color
    else delete curr[id]
    try {
      window.localStorage.setItem(SESSION_COLORS_KEY, JSON.stringify(curr))
    } catch {
      /* storage full / disabled — in-memory state still reflects it */
    }
    setSessionColors(curr)
  }, [setSessionColors])

  const handleCloseSettings = useCallback(() => setSettingsOpenFor(null), [])
  const handleOpenSettings = useCallback((id: string) => setSettingsOpenFor(id), [])

  const { gridTemplate, onDividerMouseDown, draggingDivider, bodyRef, setPanelRatios } = usePanelColumnResize({ openIds, panelMinRatio })

  useEffect(() => {
    void api
      .get<ServerConfig>('/config')
      .then((r) => {
        setIsConfigured(r.configured !== false)
        if (r.configured === false) return
        setDefaults(r.defaults)
        if (r.models?.length) setServerModels(r.models)
        if (r.maxOpenPanels != null) setServerMaxOpen(r.maxOpenPanels)
      })
      .catch(() => setIsConfigured(true))
  }, [])

  // Desktop notifications. The hook itself is inert until the user enables
  // them (bell button in the header); we just wire a ref-based edge
  // detector here so the SSE handler can fire a notify() when a turn
  // finishes in the background. Using refs (not reactive state) avoids
  // re-creating the session-event handler map on every render.
  const notifications = useNotifications()
  const notifyRef = useRef(notifications.notify)
  useEffect(() => {
    notifyRef.current = notifications.notify
  })
  /** Last-seen working flag per session. We notify when this flips from
   *  true to false (= a turn just completed). */
  const prevWorkingRef = useRef<Map<string, boolean>>(new Map())
  const openIdsRef = useRef(openIds)
  const focusedIdRef = useRef(focusedId)
  const sessionsRef = useRef(sessions)
  const maxOpenRef = useRef(maxOpen)
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
  useEffect(() => {
    openIdsRef.current = openIds
  })
  useEffect(() => {
    focusedIdRef.current = focusedId
  })
  useEffect(() => {
    sessionsRef.current = sessions
  })
  useEffect(() => {
    maxOpenRef.current = maxOpen
  })

  /** Fire a notification when Claude is waiting on a tool-permission
   *  approval in a session the user isn't actively watching. Same
   *  visibility rules as maybeNotify below — users actively looking at
   *  a panel will see the overlay dialog without needing a desktop
   *  interruption. `tag` ends in ':perm' so it doesn't collide with the
   *  session's turn-complete notification. */
  const maybePermissionNotify = useCallback((sessionId: string, toolLabel: string) => {
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
    const sessionsNow = sessionsRef.current
    const session = sessionsNow.find((s) => s.id === sessionId)
    const title = session?.title ?? sessionId.slice(0, 8)

    notifyRef.current({
      title: `⚠ ${title} needs permission`,
      body: `Approve or deny: ${toolLabel}`,
      tag: `${sessionId}:perm`,
      onClick: () => {
        handleSelectRef.current(sessionId)
      },
    })
  }, [])

  /** Called from the SSE update handler with the server's latest session
   *  snapshot. Fires a notification iff: working flipped true→false AND
   *  (window is not focused OR session is not the current focused panel). */
  const maybeNotify = useCallback((s: SessionInfo) => {
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
      onClick: () => {
        // Delegate to the full sidebar-card navigation logic so notification
        // clicks get the same behaviour: group switching, dormant resume,
        // and unread-dot clearing.
        handleSelectRef.current(s.id)
      },
    })
  }, [])

  // Single push-based subscription to the server's session list. All
  // events now ride on the shared WebSocket hub — one connection per
  // tab, fanned out by kind. This replaces the previous SSE channel
  // and incidentally eliminates the per-panel HTTP/1.1 connection
  // exhaustion we used to hit with three concurrent chats.
  const hub = useWsHub()

  // Derive displayed error from operational error + hub status without
  // calling setState inside an effect (avoids react-hooks/set-state-in-effect).
  // Status comes from its own context (useWsHubStatus) so hub identity
  // stays stable across status flips — prevents effect teardown/rebuild.
  const hubStatus = useWsHubStatus()
  const displayedError = useMemo(() => {
    if (hubStatus === 'reconnecting')
      return opError === null || opError === 'Reconnecting to server…'
        ? 'Reconnecting to server…'
        : opError
    if (hubStatus === 'online') return opError === 'Reconnecting to server…' ? null : opError
    return opError
  }, [opError, hubStatus])

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
          prevWorkingRef.current.set(frame.session.id, frame.session.working)
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
  }, [hub, maybeNotify, maybePermissionNotify, setLastSeenTurn, setSidebarOrder, setGroups])

  // Hub status → reconnecting banner is now derived via `displayedError`
  // (useMemo above) — no effect needed.

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
      setOpError(null)
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
          // Save the chosen accent under the new id. Direct localStorage
          // write + setState (same pattern as the color-menu handler) so
          // the write can't be dropped by a pending unmount.
          const curr: Record<string, string> = (() => {
            try {
              const raw = window.localStorage.getItem(SESSION_COLORS_KEY)
              return raw ? (JSON.parse(raw) ?? {}) : {}
            } catch {
              return {}
            }
          })()
          curr[res.session.id] = accent
          try {
            window.localStorage.setItem(SESSION_COLORS_KEY, JSON.stringify(curr))
          } catch {
            /* ignore storage failure */
          }
          setSessionColors(curr)
        }
      } catch (e) {
        setOpError((e as Error).message)
      }
    },
    [setSessionColors, handleAddToGroup, activeGroupId, openSession, setLastSeenTurn],
  )

  const handleFork = useCallback(
    async (id: string) => {
      setOpError(null)
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
        setOpError(`Couldn't fork session: ${(e as Error).message}`)
      }
    },
    [openSession, groups, handleAddToGroup],
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
        groupId: sourceGroup?.id ?? fallbackGroup?.id,
      }
      await handleCreate(form)
    },
    [sessions, groups, maxOpen, handleCreate],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      setOpError(null)
      try {
        await api.delete(`/sessions/${id}`)
        closeSession(id)
        // Clean up per-session accent so it doesn't linger in storage.
        setSessionColors((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
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
        setOpError((e as Error).message)
      }
    },
    [closeSession, setGroups, setSessionColors],
  )

  /** Delete the session and create a fresh one with the same config. */
  const handleRestart = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      const fallbackGroup = groups.find((g) => g.sessionIds.length < maxOpen)
      await handleDelete(id)
      const form: NewSessionForm = {
        cwd: source.cwd,
        model: source.model,
        permissionMode: source.permissionMode,
        groupId: sourceGroup?.id ?? fallbackGroup?.id,
      }
      await handleCreate(form)
    },
    [sessions, groups, maxOpen, handleDelete, handleCreate],
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

  /** Select a session. Dormant (not running, not terminated) sessions are
   *  resumed first — the server spins up a fresh Query with
   *  `options.resume`, then the SSE replay fills in the transcript.
   *  If the session belongs to a different group than the one currently
   *  active, the entire view switches to that group first.  Ungrouped
   *  sessions open in single-panel mode (replace the current panels). */
  const handleSelect = useCallback(
    async (id: string) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) {
        openSession(id, undefined)
        return
      }

      const sessionGroup = groups.find((g) => g.sessionIds.includes(id))

      // Ungrouped session → single-panel mode (replace all open panels).
      if (!sessionGroup) {
        setLastSeenTurn((prev) => ({ ...prev, [id]: s.lastTurnAt ?? Date.now() }))
        if (!s.running && !s.terminated && !resuming.has(id)) {
          // Resume FIRST, then open the panel — this ensures Chat mounts
          // with the session already running on the server, so the hub
          // subscribe → replay flow is fully ready. Without this, the
          // panel shows a dormant placeholder that flashes to "loading"
          // when resume completes, and the replay may arrive before the
          // hub subscribe fires, losing messages.
          setResuming((prev) => new Set(prev).add(id))
          try {
            const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/resume`, {})
            setSessions((prev) => prev.map((p) => (p.id === id ? res.session : p)))
            // React batches these with the setSessions above so Chat
            // mounts with the fresh (running=true) session immediately.
            setOpenIds([id])
            setFocusedId(id)
          } catch (e) {
            setOpError((e as Error).message)
          } finally {
            setResuming((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
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
        if (!s.running && !s.terminated && !resuming.has(id)) {
          setResuming((prev) => new Set(prev).add(id))
          try {
            const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/resume`, {})
            setSessions((prev) => prev.map((p) => (p.id === id ? res.session : p)))
            setFocusedId(id)
          } catch (e) {
            setOpError((e as Error).message)
          } finally {
            setResuming((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
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
      if (resuming.has(id)) return
      setResuming((prev) => new Set(prev).add(id))
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/resume`, {})
        setSessions((prev) => prev.map((p) => (p.id === id ? res.session : p)))
        openSession(id, res.session.lastTurnAt)
      } catch (e) {
        setOpError((e as Error).message)
      } finally {
        setResuming((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [sessions, resuming, openSession, groups, activeGroupId, handleActivateGroup, setLastSeenTurn],
  )
  // Keep a stable ref so notification onClick handlers can call the
  // full handleSelect logic (group switch, dormant resume, unread clear)
  // without the useCallback depending on handleSelect directly.
  useEffect(() => {
    handleSelectRef.current = handleSelect
  })

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
            if (openIds[0]) setFocusedId(openIds[0])
          },
          description: 'Focus slot 1',
        },
        {
          combo: 'mod+2',
          handler: () => {
            if (openIds[1]) setFocusedId(openIds[1])
          },
          description: 'Focus slot 2',
        },
        {
          combo: 'mod+3',
          handler: () => {
            if (openIds[2]) setFocusedId(openIds[2])
          },
          description: 'Focus slot 3',
        },
        {
          combo: 'alt+w',
          handler: () => {
            if (focusedId) closeSession(focusedId)
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
          combo: 'shift+?',
          handler: () => setHelpOpen((v) => !v),
          allowInInput: true,
          description: 'Keyboard shortcuts',
        },
        {
          combo: 'shift+tab',
          handler: () => {
            if (!focusedId) return
            const s = sessionsRef.current.find((x) => x.id === focusedId)
            if (!s) return
            const cur = (s.permissionMode ?? 'default') as PermissionMode
            const idx = PERMISSION_MODES.indexOf(cur)
            const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
            void api.post(`/sessions/${focusedId}/permission-mode`, { mode: next })
          },
          description: 'Cycle permission mode',
        },
        {
          combo: 'alt+r',
          handler: () => {
            if (focusedId) recapFnsRef.current.get(focusedId)?.()
          },
          allowInInput: true,
          description: 'Refresh session recap',
        },
        {
          combo: 'escape',
          handler: () => {
            // Priority: CommandPalette > ShortcutHelp > NewSessionDialog > per-panel Settings overlay > Interrupt.
            if (paletteOpen) setPaletteOpen(false)
            else if (helpOpen) setHelpOpen(false)
            else if (newSessionDialogOpen) setNewSessionDialogOpen(false)
            else if (settingsOpenFor) setSettingsOpenFor(null)
            else if (focusedId) {
              const focused = sessionsRef.current.find((s) => s.id === focusedId)
              if (focused?.working) {
                // Use the registered interrupt callback (set by <Chat>)
                // so pendingInterruptRef is set and the result message
                // shows the "interrupted" label.
                const fn = interruptFnsRef.current.get(focusedId)
                if (fn) {
                  void fn()
                } else {
                  // Fallback: Chat hasn't registered yet (e.g. still
                  // mounting). Direct POST still interrupts the turn.
                  void api.post(`/sessions/${focusedId}/interrupt`)
                }
              }
            }
          },
          allowInInput: true, // Esc inside textarea should still close modals / interrupt
          description: 'Close overlay / Interrupt',
        },
      ],
      [openIds, focusedId, paletteOpen, helpOpen, newSessionDialogOpen, settingsOpenFor, closeSession],
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
        setOpError((err as Error).message)
        return
      }
    }
    openAtSlot(sidebarId, targetSlotId, live?.lastTurnAt)
  }, [updateSession, openAtSlot])

  const handleConfigured = useCallback(() => {
    setIsConfigured(true)
    // Reload config now that the token is set.
    void api.get<ServerConfig>('/config').then((r) => {
      setDefaults(r.defaults)
      if (r.models?.length) setServerModels(r.models)
      if (r.maxOpenPanels != null) setServerMaxOpen(r.maxOpenPanels)
    })
  }, [])

  const handleGlobalSettingsSaved = useCallback(() => {
    void api.get<ServerConfig>('/config').then((r) => {
      setDefaults(r.defaults)
      if (r.models?.length) setServerModels(r.models)
      if (r.maxOpenPanels != null) setServerMaxOpen(r.maxOpenPanels)
    })
  }, [])

  if (isConfigured === null) return null // still loading
  if (!isConfigured) return <SetupPage onConfigured={handleConfigured} />

  return (
    <ErrorBoundary>
    <div
      className="app"
      style={{ ['--sidebar-width' as string]: `${effectiveSidebarWidth}px` }}
    >
      <aside className="sidebar">
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

      <main className="main">
        <header className="main-header">
          {/* The header used to echo the focused session's title / model /
              mode / cwd, but with up to three panels open that information
              is already visible inside each ChatPanel header — duplicating
              it at the top was both redundant and subtly wrong (it looked
              like "the active session" when all three are active). Now the
              row holds only the app-level toolbar. */}
          <div className="main-toolbar">
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
            <ThemeToggle theme={theme} onToggle={handleToggleTheme} />
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

        {displayedError && <div className="error-bar">{displayedError}</div>}

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
                    accentStyle={sessionAccentStyle(s.id)}
                    onFocus={() => focusPanel(s.id)}
                    onClose={() => closeSession(s.id)}
                    onSessionUpdate={updateSession}
                    showSystemEvents={showSystemEvents}
                    settingsOpen={settingsOpenFor === s.id}
                    onOpenSettings={handleOpenSettings}
                    onCloseSettings={handleCloseSettings}
                    onSwap={swapPanels}
                    onRegisterInterrupt={registerInterrupt}
                    onRegisterRecap={registerRecap}
                    onAcceptSidebarDrop={(sidebarId) => handleAcceptSidebarDrop(sidebarId, s.id)}
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

      <ShortcutHelp
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        shortcuts={shortcuts}
      />

      {globalSettingsOpen && (
        <GlobalSettingsModal
          onClose={() => setGlobalSettingsOpen(false)}
          onSaved={handleGlobalSettingsSaved}
        />
      )}
    </div>
    </ErrorBoundary>
  )
}
