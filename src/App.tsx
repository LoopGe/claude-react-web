// Top-level layout: left sidebar (sessions), center pane with up to 3
// Chat panels side-by-side. Session Settings now renders as a per-panel
// overlay (inside ChatPanel) rather than a right drawer — see below.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SessionList } from './components/SessionList'
import { Chat } from './components/Chat'
import { ContextMenu } from './components/ContextMenu'
import { api } from './hooks/useApi'
import { shortenPath } from './utils/paths'
import { isInAppDrag, readDragPayload, setDragPayload } from './hooks/useDragPayload'
import { useDragResize } from './hooks/useDragResize'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useNotifications } from './hooks/useNotifications'
import { useNamedEventSource } from './hooks/useSSE'
import type { NewSessionForm, PermissionMode, SessionGroup, SessionInfo, SidebarSection } from './types'
import { ACCENT_COLORS, ACCENT_COLOR_KEY, SESSION_COLORS_KEY } from './theme'

const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]

const SIDEBAR_ORDER_KEY = 'claude-react-web:session-order'
const SHOW_SYSTEM_EVENTS_KEY = 'claude-react-web:show-system-events'
const SIDEBAR_WIDTH_KEY = 'claude-react-web:sidebar-width'
const SIDEBAR_MIN_PX = 180
const SIDEBAR_MAX_PX = 480
/** Column-flex weights for the main grid (length === MAX_OPEN). Ratios
 *  are normalised on use so values like [1, 0.5, 0.5] render correctly
 *  no matter how many panels are currently open. */
const PANEL_RATIOS_KEY = 'claude-react-web:panel-col-ratios'
/** Minimum column ratio — keeps a panel from collapsing to nothing. */
const PANEL_MIN_RATIO = 0.15
const GROUPS_KEY = 'claude-react-web:session-groups'
const COLLAPSED_GROUPS_KEY = 'claude-react-web:collapsed-groups'

interface Defaults {
  cwd?: string
  model?: string
}

/** Max number of chat panels shown concurrently. */
const MAX_OPEN = 3

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  /** Ordered list of open session ids (oldest first). Length ≤ MAX_OPEN. */
  const [openIds, setOpenIds] = useState<string[]>([])
  /** Which of the open panels is currently focused (controls settings
   *  panel target + clears unread when selected). */
  const [focusedId, setFocusedId] = useState<string | null>(null)
  /** Per-session "last turn seen by the user" timestamp. A session is
   *  unread when `lastTurnAt > lastSeenTurnAt[id]` AND it isn't open.
   *  Opening (or focusing) a session bumps the seen timestamp. */
  const [lastSeenTurn, setLastSeenTurn] = useState<Record<string, number>>({})
  const [defaults, setDefaults] = useState<Defaults>({})
  /** When non-null, the Settings overlay is rendered on top of the chat
   *  panel with this session id. Previously a single boolean that targeted
   *  the focused session — making it per-session lets the overlay cover
   *  just that column instead of the whole viewport. */
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null)
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  /** Show SDK bookkeeping messages (system/init, system/status, …) in
   *  the transcript. Off by default — they're noise for normal use,
   *  but invaluable when debugging tool wiring or context compaction. */
  const [accentColor, setAccentColor] = useLocalStorage<string>(ACCENT_COLOR_KEY, ACCENT_COLORS[0].accent)
  /** Per-session accent overrides. Keys are session ids; values are accent
   *  hex strings from ACCENT_COLORS. Missing entries fall back to the
   *  global accentColor. */
  const [sessionColors, setSessionColors] = useLocalStorage<Record<string, string>>(SESSION_COLORS_KEY, {})
  const [showSystemEvents, setShowSystemEvents] = useLocalStorage<boolean>(SHOW_SYSTEM_EVENTS_KEY, false)
  /** Sidebar width in CSS pixels, persisted across reloads. Clamped so
   *  the user can't drag the sidebar to 0 or eat the whole viewport. */
  const [sidebarWidth, setSidebarWidth] = useLocalStorage<number>(SIDEBAR_WIDTH_KEY, 280)
  /** Live-editable width during a resize drag — we update this on every
   *  mousemove but only flush to localStorage on mouseup. */
  const [sidebarWidthDraft, setSidebarWidthDraft] = useState<number | null>(null)
  const sidebarResize = useDragResize((delta) => {
    const w = Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, sidebarWidth + delta))
    setSidebarWidthDraft(w)
  })
  // When the drag ends, commit the draft to localStorage. The synchronous
  // setState inside this effect is intentional: the draft is transient,
  // and once the gesture is over we want the persisted value to catch up
  // and the draft to clear exactly once. The lint rule can't see that.
  useEffect(() => {
    if (sidebarResize.dragging) return
    if (sidebarWidthDraft != null) {
      setSidebarWidth(sidebarWidthDraft)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSidebarWidthDraft(null)
    }
  }, [sidebarResize.dragging, sidebarWidthDraft, setSidebarWidth])
  const effectiveSidebarWidth = sidebarWidthDraft ?? sidebarWidth

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

  /** Per-session column-width ratios for the main grid. Keyed by session
   *  ID so ratios travel with their session when panels are evicted and
   *  reordered — no more positional misalignment on open/close. */
  const [panelRatios, setPanelRatios] = useLocalStorage<Record<string, number>>(PANEL_RATIOS_KEY, {})
  const [panelRatiosDraft, setPanelRatiosDraft] = useState<Record<string, number> | null>(null)
  const effectiveRatios = panelRatiosDraft ?? panelRatios
  /** Construct the grid-template-columns string for the current layout.
   *  Inserts 4px divider tracks between visible panels. Ratios default
   *  to 1 (equal width) for sessions that haven't been manually resized. */
  const gridTemplate = useMemo(() => {
    const n = Math.max(1, openIds.length)
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const r = effectiveRatios[openIds[i]] ?? 1
      parts.push(`${r}fr`)
      if (i < n - 1) parts.push('4px')
    }
    return parts.join(' ')
  }, [openIds, effectiveRatios])

  /** Drag state for the panel-column dividers. `index` is the divider
   *  between columns i and i+1 (so valid values are 0 and 1). */
  const bodyRef = useRef<HTMLDivElement>(null)
  const dividerStart = useRef<{ ratios: Record<string, number>; bodyWidth: number } | null>(null)
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null)

  const onDividerMouseDown = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const body = bodyRef.current
      if (!body) return
      dividerStart.current = {
        ratios: { ...effectiveRatios },
        bodyWidth: body.getBoundingClientRect().width,
      }
      setDraggingDivider(index)
      document.body.classList.add('resizing-col')

      // Drag uses the same window-level listeners pattern as sidebar resize,
      // but we need the divider index + accurate pixel→ratio conversion, so
      // the handlers live inline here instead of in the generic useDragResize.
      const startX = e.clientX
      const leftId = openIds[index]
      const rightId = openIds[index + 1]
      const onMove = (ev: MouseEvent) => {
        const snap = dividerStart.current
        if (!snap) return
        const deltaPx = ev.clientX - startX
        // Convert pixel delta to fractional change of the TOTAL fr-weight sum.
        // Each column's px width = (ratio / sum) * bodyWidth; moving deltaPx
        // means we want ratio[i] to grow by deltaRatio and ratio[i+1] to
        // shrink by the same amount. deltaRatio = deltaPx / (bodyWidth / sum).
        const leftR = snap.ratios[leftId] ?? 1
        const rightR = snap.ratios[rightId] ?? 1
        const sum = (leftR + rightR) || 1
        const pxPerRatio = snap.bodyWidth / sum
        const deltaR = deltaPx / pxPerRatio
        const next = { ...snap.ratios }
        const rawL = leftR + deltaR
        const rawR = rightR - deltaR
        // Enforce minimum ratio on both sides; clamp by stealing back.
        if (rawL < PANEL_MIN_RATIO) {
          next[rightId] = leftR + rightR - PANEL_MIN_RATIO
          next[leftId] = PANEL_MIN_RATIO
        } else if (rawR < PANEL_MIN_RATIO) {
          next[leftId] = leftR + rightR - PANEL_MIN_RATIO
          next[rightId] = PANEL_MIN_RATIO
        } else {
          next[leftId] = rawL
          next[rightId] = rawR
        }
        setPanelRatiosDraft(next)
      }
      const onUp = () => {
        setDraggingDivider(null)
        document.body.classList.remove('resizing-col')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [effectiveRatios, openIds],
  )

  // Commit the draft to localStorage after dragging ends. Same shape as
  // the sidebar commit effect above; lint false-positive suppressed for
  // the same reason.
  useEffect(() => {
    if (draggingDivider != null) return
    if (panelRatiosDraft != null) {
      setPanelRatios(panelRatiosDraft)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPanelRatiosDraft(null)
    }
  }, [draggingDivider, panelRatiosDraft, setPanelRatios])

  useEffect(() => {
    void api
      .get<{ defaults: Defaults }>('/config')
      .then((r) => setDefaults(r.defaults))
      .catch(() => {})
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
  useEffect(() => {
    openIdsRef.current = openIds
  })
  useEffect(() => {
    focusedIdRef.current = focusedId
  })
  useEffect(() => {
    sessionsRef.current = sessions
  })

  /** Fire a notification when Claude is waiting on a tool-permission
   *  approval in a session the user isn't actively watching. Same
   *  visibility rules as maybeNotify below — users actively looking at
   *  a panel will see the overlay dialog without needing a desktop
   *  interruption. `tag` ends in ':perm' so it doesn't collide with the
   *  session's turn-complete notification. */
  const maybePermissionNotify = useCallback((sessionId: string, toolLabel: string) => {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const isFocused = focusedIdRef.current === sessionId
    if (!hidden && isFocused) return

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
        const alreadyOpen = openIdsRef.current.includes(sessionId)
        if (!alreadyOpen) {
          setOpenIds((curr) => (curr.includes(sessionId) ? curr : [...curr.slice(-2), sessionId]))
        }
        setFocusedId(sessionId)
      },
    })
  }, [])

  /** Called from the SSE update handler with the server's latest session
   *  snapshot. Fires a notification iff: working flipped true→false AND
   *  (tab is hidden OR session is not the current focused panel). */
  const maybeNotify = useCallback((s: SessionInfo) => {
    const prev = prevWorkingRef.current.get(s.id) ?? false
    prevWorkingRef.current.set(s.id, s.working)
    if (!(prev && !s.working)) return // only trigger on the falling edge

    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const isFocused = focusedIdRef.current === s.id
    if (!hidden && isFocused) return // user is watching it — no need

    const title = s.title ?? s.id.slice(0, 8)
    notifyRef.current({
      title: `✓ ${title}`,
      body: s.error ? `Errored: ${s.error}` : 'Turn complete',
      tag: s.id,
      onClick: () => {
        // Bring the session to the front. `openIds` is read through a ref
        // because `maybeNotify` lives inside a stable useCallback.
        const alreadyOpen = openIdsRef.current.includes(s.id)
        if (!alreadyOpen) {
          // Treat click-to-open the same way as clicking the sidebar card.
          setOpenIds((curr) => (curr.includes(s.id) ? curr : [...curr.slice(-2), s.id]))
        }
        setFocusedId(s.id)
      },
    })
  }, [])

  // Single push-based subscription to the server's session list. Replaces
  // the old 5-second `GET /sessions` poll, which — combined with the
  // per-session message + permission streams — used to saturate the
  // browser's HTTP/1.1 connection pool under three concurrent chats.
  const sessionEvents = useMemo(
    () => ({
      snapshot: (data: unknown) => {
        const p = data as { sessions?: SessionInfo[] }
        setSessions(p.sessions ?? [])
        // Reconcile open/focused against whatever the server reports.
        const ids = new Set((p.sessions ?? []).map((s) => s.id))
        setOpenIds((prev) => prev.filter((id) => ids.has(id)))
        setFocusedId((prev) => (prev && ids.has(prev) ? prev : null))
      },
      update: (data: unknown) => {
        const p = data as { session: SessionInfo }
        if (!p?.session) return
        setSessions((prev) => {
          const i = prev.findIndex((s) => s.id === p.session.id)
          // An update for an id we don't know about is almost certainly
          // a race: a `created` event is on its way too. Ignore it and
          // let `created` do the insert — handling it here would create
          // two rows if `created` also arrives (it always does).
          if (i < 0) return prev
          const next = prev.slice()
          next[i] = p.session
          return next
        })
        // Falling-edge trigger for desktop notifications — see maybeNotify.
        maybeNotify(p.session)
      },
      created: (data: unknown) => {
        const p = data as { session: SessionInfo }
        if (!p?.session) return
        setSessions((prev) => {
          if (prev.some((s) => s.id === p.session.id)) return prev
          return [p.session, ...prev]
        })
        // Seed the edge-detector so a session that spawns already
        // working doesn't fire a notification on its first true→false
        // transition when the user is still watching it.
        prevWorkingRef.current.set(p.session.id, p.session.working)
      },
      removed: (data: unknown) => {
        const p = data as { id: string }
        if (!p?.id) return
        setSessions((prev) => prev.filter((s) => s.id !== p.id))
        setOpenIds((prev) => prev.filter((id) => id !== p.id))
        setFocusedId((prev) => (prev === p.id ? null : prev))
      },
      // Tool-permission request arrived. Fire a desktop notification iff
      // the user isn't actively looking at that session — same rule as
      // turn-complete notifications. Payload shape matches the server-side
      // GlobalSessionEvent { kind: 'permission_request', sessionId, request }.
      permission_request: (data: unknown) => {
        const p = data as {
          sessionId?: string
          request?: { kind?: string; toolName?: string; displayName?: string }
        }
        if (!p?.sessionId) return
        // Questions get a dedicated wording — "Claude is asking a
        // question" reads better than "Claude wants to use AskUserQuestion".
        const label =
          p.request?.kind === 'question'
            ? 'a question'
            : p.request?.displayName ?? p.request?.toolName ?? 'a tool'
        maybePermissionNotify(p.sessionId, label)
      },
    }),
    [maybeNotify, maybePermissionNotify],
  )
  const lifecycle = useMemo(
    () => ({
      onError: () => setError('Lost connection to server. Refresh to retry.'),
    }),
    [],
  )
  useNamedEventSource('/api/sessions/events', sessionEvents, lifecycle)

  /** Push a session id onto the open list. Rules:
   *  - Already open → just focus it, no reshuffle.
   *  - Not open but ≥ MAX_OPEN already → evict the oldest non-focused id.
   *  - Append to the end and focus it.
   *  Also bumps the session's lastSeenTurn so opening clears unread. */
  const openSession = useCallback(
    (id: string, lastTurnAt: number | undefined) => {
      setOpenIds((prev) => {
        if (prev.includes(id)) return prev
        if (prev.length < MAX_OPEN) return [...prev, id]
        // Pick an eviction candidate: not focused, not pinned. Pinned
        // sessions ARE allowed to be open; we just won't throw them
        // out on someone else's behalf. Fall through to focused or
        // the head if that's all we have (pin overflow: user opened
        // three pinned + tried a fourth — focused one loses to make
        // room, which matches the earlier behaviour).
        const focusIdx = focusedId ? prev.indexOf(focusedId) : -1
        const pinnedOpenIds = new Set(
          prev.filter((pid) => sessions.find((s) => s.id === pid)?.pinned),
        )
        const evictIdx = prev.findIndex(
          (pid, i) => i !== focusIdx && !pinnedOpenIds.has(pid),
        )
        // Fallbacks in decreasing preference:
        //   1) non-focused non-pinned (evictIdx above)
        //   2) any non-focused (ignores pin — rare: 3 pinned open)
        //   3) index 0 (everything is pinned + focused on it)
        const fallback =
          evictIdx === -1
            ? prev.findIndex((_, i) => i !== focusIdx)
            : evictIdx
        const next = prev.slice()
        next.splice(fallback === -1 ? 0 : fallback, 1)
        next.push(id)
        return next
      })
      setFocusedId(id)
      setLastSeenTurn((prev) => ({ ...prev, [id]: lastTurnAt ?? Date.now() }))
    },
    [focusedId, sessions],
  )

  const closeSession = useCallback(
    (id: string) => {
      setOpenIds((prev) => prev.filter((x) => x !== id))
      setFocusedId((prev) => {
        if (prev !== id) return prev
        // Focus the right neighbour if we closed the focused one, else
        // the last remaining open panel. Null if nothing's left.
        const remaining = openIds.filter((x) => x !== id)
        return remaining[remaining.length - 1] ?? null
      })
    },
    [openIds],
  )

  const handleCreate = useCallback(
    async (form: NewSessionForm) => {
      setError(null)
      // `accent` is a frontend-only field — don't forward it to the SDK;
      // we persist it locally keyed by the returned session id.
      const { accent, ...rest } = form
      try {
        const res = await api.post<{ session: SessionInfo }>('/sessions', rest)
        // Don't mutate `sessions` here — the server emits a `created`
        // event on /sessions/events that inserts the row. If we prepend
        // locally too we race with the SSE, end up with two rows, and
        // later state updates (e.g. a subsequent pump error) only hit
        // one of them — leaving an "err" phantom alongside the real card.
        openSession(res.session.id, res.session.lastTurnAt)
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
        setError((e as Error).message)
      }
    },
    [openSession, setSessionColors],
  )

  const handleFork = useCallback(
    async (id: string) => {
      setError(null)
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/fork`, {})
        // Open the forked session right away so the user can see the
        // divergence point. The global `created` event from the server
        // will add the row to the sidebar.
        openSession(res.session.id, res.session.lastTurnAt)
      } catch (e) {
        setError(`Couldn't fork session: ${(e as Error).message}`)
      }
    },
    [openSession],
  )

  /** Create a brand-new empty session that reuses the source session's
   *  basic config (cwd, model, permissionMode) without carrying over any
   *  conversation history. Think "fork the settings, not the transcript". */
  const handleNewLikeThis = useCallback(
    async (id: string) => {
      const source = sessions.find((s) => s.id === id)
      if (!source) return
      const form: NewSessionForm = {
        cwd: source.cwd,
        model: source.model,
        permissionMode: source.permissionMode,
        title: source.title ? `${source.title} (copy)` : undefined,
      }
      await handleCreate(form)
    },
    [sessions, handleCreate],
  )

  const handleTogglePin = useCallback(
    async (id: string) => {
      setError(null)
      const current = sessions.find((s) => s.id === id)
      const next = !current?.pinned
      try {
        await api.patch<{ session: SessionInfo }>(`/sessions/${id}`, { pinned: next })
      } catch (e) {
        setError(`Couldn't ${next ? 'pin' : 'unpin'} session: ${(e as Error).message}`)
      }
    },
    [sessions],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      setError(null)
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
        // Server pushes a `removed` event on the global SSE, which
        // re-prunes session state — no need to GET /sessions here.
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [closeSession],
  )

  /** Select a session. Dormant (not running, not terminated) sessions are
   *  resumed first — the server spins up a fresh Query with
   *  `options.resume`, then the SSE replay fills in the transcript. */
  const handleSelect = useCallback(
    async (id: string) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) {
        openSession(id, undefined)
        return
      }
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
        setError((e as Error).message)
      } finally {
        setResuming((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [sessions, resuming, openSession],
  )

  /** When focus changes to an open panel, bump its seen-turn so the unread
   *  dot disappears. Focusing an already-read panel is a no-op. */
  const focusPanel = useCallback(
    (id: string) => {
      setFocusedId(id)
      const s = sessions.find((x) => x.id === id)
      if (s?.lastTurnAt) {
        setLastSeenTurn((prev) => ({ ...prev, [id]: s.lastTurnAt! }))
      }
    },
    [sessions],
  )

  /** Derive unread counts (really flags — 0 or 1 per session) from the
   *  session list + lastSeenTurn. Open sessions are always considered
   *  read; dormant/terminated sessions with a newer lastTurnAt than we've
   *  seen show a dot. */
  const unread = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const s of sessions) {
      if (openIds.includes(s.id)) continue
      if (!s.lastTurnAt) continue
      const seen = lastSeenTurn[s.id] ?? 0
      if (s.lastTurnAt > seen) out[s.id] = true
    }
    return out
  }, [sessions, openIds, lastSeenTurn])

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
  useKeyboardShortcuts(
    useMemo(
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
          combo: 'escape',
          handler: () => {
            // Priority: NewSessionDialog > per-panel Settings overlay.
            if (newSessionDialogOpen) setNewSessionDialogOpen(false)
            else if (settingsOpenFor) setSettingsOpenFor(null)
          },
          allowInInput: true, // Esc inside textarea should still close modals
          description: 'Close overlay',
        },
      ],
      [openIds, focusedId, newSessionDialogOpen, settingsOpenFor, closeSession],
    ),
  )

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
    // Pinned sessions always float to the top, preserving their relative
    // order within the pinned group. This runs AFTER the user-custom
    // sidebarOrder so pinning doesn't destroy existing reordering —
    // pinning just says "these come first", not "these are in pin-order".
    const pinned: SessionInfo[] = []
    const rest: SessionInfo[] = []
    for (const s of ordered) (s.pinned ? pinned : rest).push(s)
    return [...pinned, ...rest]
  }, [sessions, sidebarOrder])

  /** Grouped sidebar view: pinned → groups → ungrouped. Only meaningful
   *  when at least one group exists; otherwise the flat orderedSessions
   *  list is used directly. */
  const sidebarSections = useMemo((): SidebarSection[] => {
    if (groups.length === 0) return []
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const pinned: SessionInfo[] = []

    // 1. Pinned sessions (always shown at top, independent of groups).
    for (const s of sessions) {
      if (s.pinned) {
        pinned.push(s)
        // Don't remove from remaining — pinned sessions also appear in their groups.
      }
    }

    // 2. Build a set of all grouped session IDs for the "ungrouped" bucket.
    const groupedIds = new Set<string>()
    for (const g of groups) for (const id of g.sessionIds) groupedIds.add(id)

    // 3. Group sections.
    const sections: SidebarSection[] = []
    if (pinned.length > 0) sections.push({ kind: 'pinned', sessions: pinned })

    for (const g of groups) {
      const groupSessions: SessionInfo[] = []
      for (const id of g.sessionIds) {
        const s = byId.get(id)
        if (s) groupSessions.push(s)
      }
      sections.push({ kind: 'group', group: g, sessions: groupSessions })
    }

    // 4. Ungrouped sessions (not in any group, not pinned).
    const ungrouped: SessionInfo[] = []
    for (const s of sessions) {
      if (!s.pinned && !groupedIds.has(s.id)) ungrouped.push(s)
    }
    if (ungrouped.length > 0) sections.push({ kind: 'ungrouped', sessions: ungrouped })

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

  const handleAddToGroup = useCallback(
    (sessionId: string, groupId: string) => {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId && !g.sessionIds.includes(sessionId)
            ? { ...g, sessionIds: [...g.sessionIds, sessionId] }
            : g,
        ),
      )
    },
    [setGroups],
  )

  const handleRemoveFromGroup = useCallback(
    (sessionId: string, groupId: string) => {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }
            : g,
        ),
      )
    },
    [setGroups],
  )

  /** Activate a group: replace main-area panels with the group's sessions. */
  const handleActivateGroup = useCallback(
    (groupId: string) => {
      const group = groups.find((g) => g.id === groupId)
      if (!group) return
      const sessionSet = new Set(sessions.map((s) => s.id))
      const valid = group.sessionIds.filter((id) => sessionSet.has(id)).slice(0, MAX_OPEN)
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
    [groups, sessions],
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
    [],
  )

  return (
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
          resumingIds={resuming}
          unread={unread}
          sessionColors={sessionColors}
          onSessionColorChange={(id, color) => {
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
          }}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onClosePanel={closeSession}
          onFork={handleFork}
          onNewLikeThis={handleNewLikeThis}
          onTogglePin={handleTogglePin}
          onReorder={handleReorderSidebar}
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
          onRemoveFromGroup={handleRemoveFromGroup}
          onToggleGroupCollapse={toggleGroupCollapse}
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
            <div className="accent-picker" role="radiogroup" aria-label="Accent colour">
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
          </div>
        </header>

        {error && <div className="error-bar">{error}</div>}

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
                <code>Query</code>. Up to {MAX_OPEN} can be open at once.
              </p>
            </div>
          ) : (
            // Flatten panels + dividers into a single children list. The grid
            // template we built alternates fr / 4px tracks, so this order has
            // to match or the columns will de-sync.
            openSessions.flatMap((s, i) => {
              const node = (
                <ChatPanel
                  key={s.id}
                  session={s}
                  focused={s.id === focusedId}
                  slot={i + 1}
                  accentStyle={sessionAccentStyle(s.id)}
                  onFocus={() => focusPanel(s.id)}
                  onClose={() => closeSession(s.id)}
                  onSessionUpdate={updateSession}
                  showSystemEvents={showSystemEvents}
                  settingsOpen={settingsOpenFor === s.id}
                  onOpenSettings={() => setSettingsOpenFor(s.id)}
                  onCloseSettings={() => setSettingsOpenFor(null)}
                  onSwap={swapPanels}
                  onAcceptSidebarDrop={async (sidebarId) => {
                    const existing = sessions.find((x) => x.id === sidebarId)
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
                        setError((err as Error).message)
                        return
                      }
                    }
                    openAtSlot(sidebarId, s.id, live?.lastTurnAt)
                  }}
                />
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

    </div>
  )
}

/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */
interface ChatPanelProps {
  session: SessionInfo
  focused: boolean
  /** Slot number (1-indexed) in the main grid. Shown as a pill in the
   *  header so the user can tell this panel apart from the sidebar card
   *  and map it to the Ctrl+<n> shortcut. */
  slot: number
  /** Per-session accent overrides (sets --accent / --accent-strong on the
   *  panel root so all child var() references pick up the session colour). */
  accentStyle?: CSSProperties
  onFocus: () => void
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
  /** Swap this panel with another open panel (called with the dragged id). */
  onSwap: (draggedId: string, targetId: string) => void
  /** A sidebar card was dropped onto this panel — replace it. */
  onAcceptSidebarDrop: (sidebarId: string) => void
  /** Global transcript toggle (forwarded to the inner <Chat>). */
  showSystemEvents?: boolean
  /** When true, render the Settings overlay on top of this panel. */
  settingsOpen?: boolean
  onOpenSettings: () => void
  onCloseSettings: () => void
}

function ChatPanel({
  session,
  focused,
  slot,
  accentStyle,
  onFocus,
  onClose,
  onSessionUpdate,
  onSwap,
  onAcceptSidebarDrop,
  showSystemEvents,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
}: ChatPanelProps) {
  const [dropActive, setDropActive] = useState(false)
  /** When true, the model chip in the header becomes an inline <input>. */
  const [editingModel, setEditingModel] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  /** Anchor for the permission-mode menu. Non-null = menu visible. A
   *  custom menu (rather than a native <select>) gives us full control
   *  over dark-theme styling; the native control's dropdown surface
   *  can't be restyled across browsers. */
  const [permMenu, setPermMenu] = useState<{ x: number; y: number } | null>(null)
  const recentModels = readRecentModels()
  const chipsDisabled = !session.running || session.terminated

  const commitModel = (next: string) => {
    const value = next.trim()
    setEditingModel(false)
    if (value === (session.model ?? '')) return
    const before = session.model
    void api
      .post<{ session: SessionInfo }>(`/sessions/${session.id}/model`, {
        model: value || undefined,
      })
      .then((r) => onSessionUpdate(r.session))
      .catch((err) => {
        window.alert(`Couldn't change model: ${(err as Error).message}`)
        onSessionUpdate({ ...session, model: before })
      })
  }

  const commitPermissionMode = (mode: PermissionMode) => {
    if (mode === (session.permissionMode ?? 'default')) return
    const before = session.permissionMode
    void api
      .post<{ session: SessionInfo }>(`/sessions/${session.id}/permission-mode`, { mode })
      .then((r) => onSessionUpdate(r.session))
      .catch((err) => {
        window.alert(`Couldn't change permission mode: ${(err as Error).message}`)
        onSessionUpdate({ ...session, permissionMode: before })
      })
  }

  return (
    <section
      className={`chat-panel ${focused ? 'focused' : ''} ${dropActive ? 'drop-target' : ''}`}
      style={accentStyle}
      onMouseDownCapture={(e) => {
        // Focus on any mousedown inside the panel (capture phase so we win
        // against children). Clicking the close button still works because
        // onClose stops propagation, but focusing on the way down is harmless.
        if (!focused) onFocus()
        void e
      }}
      onDragOver={(e) => {
        if (!isInAppDrag(e)) return
        e.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropActive(false)
      }}
      onDrop={(e) => {
        setDropActive(false)
        const payload = readDragPayload(e)
        if (!payload) return
        e.preventDefault()
        // Stop bubbling so the outer `.main-body` doesn't ALSO act on this
        // drop (which would open the sidebar card a second time).
        e.stopPropagation()
        if (payload.kind === 'main-panel') {
          onSwap(payload.id, session.id)
        } else if (payload.kind === 'sidebar-card') {
          onAcceptSidebarDrop(payload.id)
        }
      }}
    >
      <div
        className="chat-panel-header"
        // The header is the drag handle for panel swaps — the body stays
        // non-draggable so textarea text selection and scrolling work.
        draggable
        onDragStart={(e) => {
          setDragPayload(e, { kind: 'main-panel', id: session.id })
        }}
      >
        <div className="chat-panel-header-row1">
        <span
          className={`chat-panel-slot ${focused ? 'focused' : ''}`}
          title={`Slot ${slot} · Ctrl+${slot} to focus`}
          aria-label={`slot ${slot}`}
        >
          {slot}
        </span>
        <span
          className={`chat-panel-status ${statusClass(session)}`}
          title={statusLabel(session)}
          aria-label={statusLabel(session)}
        />
        <span className="chat-panel-title" title={session.cwd ?? ''}>
          {session.title ?? session.id.slice(0, 8)}
        </span>
        <div className="chat-panel-meta">
          {editingModel ? (
            <input
              className="chat-panel-chip-input"
              list="chat-panel-model-datalist"
              autoFocus
              value={modelDraft}
              placeholder="model name"
              disabled={chipsDisabled}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => commitModel(modelDraft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitModel(modelDraft)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingModel(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="chat-panel-chip"
              disabled={chipsDisabled}
              title={`Model: ${session.model ?? 'default'} · click to change`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setModelDraft(session.model ?? '')
                setEditingModel(true)
              }}
            >
              <span className="chat-panel-chip-label">model</span>
              <span className="chat-panel-chip-value">{shortenModel(session.model)}</span>
            </button>
          )}
          <datalist id="chat-panel-model-datalist">
            {recentModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            type="button"
            className="chat-panel-chip"
            disabled={chipsDisabled}
            title={`Permission mode: ${session.permissionMode ?? 'default'} · click to change`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
              setPermMenu({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <span className="chat-panel-chip-label">mode</span>
            <span className="chat-panel-chip-value">{session.permissionMode ?? 'default'}</span>
          </button>
        </div>
        {permMenu && (
          <ContextMenu
            x={permMenu.x}
            y={permMenu.y}
            onClose={() => setPermMenu(null)}
            items={PERMISSION_MODES.map((m) => ({
              label: m,
              icon: (session.permissionMode ?? 'default') === m ? '✓' : ' ',
              onClick: () => commitPermissionMode(m),
            }))}
          />
        )}
        <button
          className="chat-panel-settings"
          onClick={(e) => {
            e.stopPropagation()
            onOpenSettings()
          }}
          title="Session settings"
          aria-label="Open settings"
        >
          ⚙
        </button>
        <button
          className="chat-panel-close"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title="Close this panel (Alt+W) · session stays alive"
          aria-label="Close panel"
        >
          ✕
        </button>
        </div>
        {session.error && (
          <div className="chat-panel-error" title={session.error}>
            ⚠ {session.error}
          </div>
        )}
        {/* Second header row — secondary metadata. Muted colour, smaller
            font, skipped when there's literally nothing to show. */}
        {(session.cwd || session.messageCount > 0) && (
          <div className="chat-panel-header-row2">
            {session.cwd && (
              <span className="chat-panel-cwd" title={session.cwd}>
                📁 {shortenPath(session.cwd)}
              </span>
            )}
            <span className="chat-panel-msgcount" title={`${session.messageCount} messages`}>
              {session.messageCount} {session.messageCount === 1 ? 'msg' : 'msgs'}
            </span>
            {session.working && (
              <span className="chat-panel-working-indicator" title="Assistant is working on a turn">
                <span className="chat-panel-working-dot" aria-hidden />
                working…
              </span>
            )}
          </div>
        )}
      </div>
      <div className="chat-panel-body">
        {session.running ? (
          <Chat
            key={session.id}
            session={session}
            onSessionUpdate={onSessionUpdate}
            showSystemEvents={showSystemEvents}
            settingsOpen={settingsOpen}
            onCloseSettings={onCloseSettings}
          />
        ) : (
          <div className="empty-state">
            <h2>
              {session.error
                ? 'This session errored'
                : session.terminated
                  ? 'This session has ended'
                  : 'Session is dormant'}
            </h2>
            {session.error ? (
              <>
                <p>The underlying SDK Query threw an error and the session was shut down:</p>
                <pre
                  style={{
                    textAlign: 'left',
                    background: 'var(--bg-elev-2)',
                    padding: 10,
                    borderRadius: 4,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--danger)',
                    fontSize: 12,
                  }}
                >
                  {session.error}
                </pre>
                <p>Check the server logs for a full stack trace.</p>
              </>
            ) : (
              <p>
                {session.terminated
                  ? 'The underlying Query has finished. Create a new session to continue.'
                  : 'Click the session again in the sidebar to resume it.'}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Distill a session's liveness/health into a single CSS class used by
 *  the header status dot. Kept separate from the label so colours and
 *  wording can evolve independently. */
function statusClass(s: SessionInfo): string {
  if (s.error) return 'err'
  if (s.terminated) return 'terminated'
  if (s.working) return 'working'
  if (s.running) return 'live'
  return 'dormant'
}
function statusLabel(s: SessionInfo): string {
  if (s.error) return `Errored: ${s.error}`
  if (s.terminated) return 'Session ended'
  if (s.working) return 'Working on a turn'
  if (s.running) return 'Live'
  return 'Dormant'
}

/** Trim namespace prefixes and long version tails so a model name fits
 *  in a tight header chip. "claude-sonnet-4-5-20251101" → "sonnet-4-5";
 *  "xiaomi/mimo-v2.5-pro" → "mimo-v2.5-pro". Undefined → "default". */
function shortenModel(name: string | undefined): string {
  if (!name) return 'default'
  const bare = name.split('/').pop() ?? name
  const stripped = bare
    .replace(/^claude-/, '')
    // Strip trailing YYYYMMDD release dates ("-20251101").
    .replace(/-\d{8}$/, '')
  return stripped.length > 22 ? stripped.slice(0, 20) + '…' : stripped
}

/** Load the recent-models list that the New Session dialog maintains.
 *  Read-only from the ChatPanel side; we just want autocomplete hints
 *  for the inline model editor. Returns an empty array on any failure. */
function readRecentModels(): string[] {
  try {
    const raw = window.localStorage.getItem('claude-react-web:recent-models')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]).filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

function notificationTooltip(
  permission: 'granted' | 'denied' | 'default' | 'unsupported',
  enabled: boolean,
): string {
  if (permission === 'unsupported') return 'Browser does not support desktop notifications'
  if (permission === 'denied') return 'Notifications blocked in browser settings'
  if (enabled) return 'Desktop notifications: on · click to disable'
  return 'Desktop notifications: off · click to enable'
}
