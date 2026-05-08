// Top-level layout: left sidebar (sessions), center pane with up to 3
// Chat panels side-by-side, right drawer (settings for focused chat).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SessionList } from './components/SessionList'
import { Chat } from './components/Chat'
import { SettingsPanel } from './components/SettingsPanel'
import { api } from './hooks/useApi'
import type { NewSessionForm, SessionInfo } from './types'

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Ids currently being resumed — briefly disables the item so a double-
   *  click doesn't fire two POSTs. */
  const [resuming, setResuming] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: SessionInfo[] }>('/sessions')
      const ids = new Set(res.sessions.map((s) => s.id))
      setSessions(res.sessions)
      // Prune deleted sessions from the open list. Focus follows whatever
      // open id remains (prefer the previously-focused one); if nothing is
      // open, don't auto-open — user must click.
      setOpenIds((prev) => prev.filter((id) => ids.has(id)))
      setFocusedId((prev) => (prev && ids.has(prev) ? prev : null))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void api
      .get<{ defaults: Defaults }>('/config')
      .then((r) => setDefaults(r.defaults))
      .catch(() => {})
    // Bootstrap fetch — refresh() sets state via the promise callback,
    // which is the "subscribe to external data" shape the new lint rule
    // is trying to protect; the false positive fires because the call is
    // synchronous at the effect body level.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // Poll session list every 5s so metadata (subscribers, lastActivityAt)
  // stays roughly fresh even without server-push for the list itself.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])

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
        // Evict the oldest id that isn't currently focused. If the only
        // candidate to evict IS the focused one, fall through and evict
        // the front — the newly-opened id becomes focused anyway.
        const focusIdx = focusedId ? prev.indexOf(focusedId) : -1
        const evictIdx = prev.findIndex((_, i) => i !== focusIdx)
        const next = prev.slice()
        next.splice(evictIdx === -1 ? 0 : evictIdx, 1)
        next.push(id)
        return next
      })
      setFocusedId(id)
      setLastSeenTurn((prev) => ({ ...prev, [id]: lastTurnAt ?? Date.now() }))
    },
    [focusedId],
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
      try {
        const res = await api.post<{ session: SessionInfo }>('/sessions', form)
        setSessions((prev) => [res.session, ...prev])
        openSession(res.session.id, res.session.lastTurnAt)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [openSession],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      setError(null)
      try {
        await api.delete(`/sessions/${id}`)
        closeSession(id)
        await refresh()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [refresh, closeSession],
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
  const focused = focusedId ? sessions.find((s) => s.id === focusedId) ?? null : null

  const updateSession = useCallback((s: SessionInfo) => {
    setSessions((prev) => prev.map((p) => (p.id === s.id ? s : p)))
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> claude-react-web
        </div>
        <SessionList
          sessions={sessions}
          openIds={openIds}
          focusedId={focusedId}
          defaults={defaults}
          resumingIds={resuming}
          unread={unread}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onDelete={handleDelete}
        />
      </aside>

      <main className="main">
        <header className="main-header">
          <div className="main-title">
            {focused ? (
              <>
                <span className="session-title">{focused.title ?? focused.id.slice(0, 8)}</span>
                <span className="session-meta">
                  {focused.model ?? 'default model'} · {focused.permissionMode ?? 'default'} ·{' '}
                  {focused.cwd ?? '~'}
                </span>
              </>
            ) : (
              <span className="empty-title">No session selected</span>
            )}
          </div>
          <button className="btn" onClick={() => setSettingsOpen((v) => !v)} disabled={!focused}>
            {settingsOpen ? 'Close settings' : 'Settings'}
          </button>
        </header>

        {error && <div className="error-bar">{error}</div>}

        <div
          className="main-body"
          data-panel-count={openSessions.length || 1}
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
            openSessions.map((s) => (
              <ChatPanel
                key={s.id}
                session={s}
                focused={s.id === focusedId}
                onFocus={() => focusPanel(s.id)}
                onClose={() => closeSession(s.id)}
                onSessionUpdate={updateSession}
              />
            ))
          )}
        </div>
      </main>

      {focused && settingsOpen && (
        <SettingsPanel
          key={focused.id}
          session={focused}
          onClose={() => setSettingsOpen(false)}
          onSessionUpdate={updateSession}
        />
      )}
    </div>
  )
}

/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */
interface ChatPanelProps {
  session: SessionInfo
  focused: boolean
  onFocus: () => void
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
}

function ChatPanel({ session, focused, onFocus, onClose, onSessionUpdate }: ChatPanelProps) {
  return (
    <section
      className={`chat-panel ${focused ? 'focused' : ''}`}
      onMouseDownCapture={(e) => {
        // Focus on any mousedown inside the panel (capture phase so we win
        // against children). Clicking the close button still works because
        // onClose stops propagation, but focusing on the way down is harmless.
        if (!focused) onFocus()
        // Don't swallow the event — children still need to receive it.
        void e
      }}
    >
      <div className="chat-panel-header">
        <span className="chat-panel-title" title={session.cwd ?? ''}>
          {session.title ?? session.id.slice(0, 8)}
        </span>
        <button
          className="chat-panel-close"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title="Close this panel (session stays alive)"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>
      <div className="chat-panel-body">
        {session.running ? (
          <Chat key={session.id} session={session} onSessionUpdate={onSessionUpdate} />
        ) : (
          <div className="empty-state">
            <h2>{session.terminated ? 'This session has ended' : 'Session is dormant'}</h2>
            <p>
              {session.terminated
                ? 'The underlying Query has finished. Create a new session to continue.'
                : 'Click the session again in the sidebar to resume it.'}
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
