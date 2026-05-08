// Left sidebar: "+ New session" button on top, full-height session list below.
// The new-session form lives inside a modal (<NewSessionDialog />) so the
// sidebar can dedicate its vertical space to listing sessions.

import { useEffect, useMemo, useRef, useState } from 'react'
import { DirectoryPicker } from './DirectoryPicker'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { isInAppDrag, readDragPayload, setDragPayload } from '../hooks/useDragPayload'
import { api } from '../hooks/useApi'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { NewSessionForm, PermissionMode, SessionInfo } from '../types'

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']

const RECENT_MODELS_KEY = 'claude-react-web:recent-models'
const RECENT_MODELS_CAP = 10

/** Enable the 1M token context window (Sonnet 4 / 4.5 only). */
const ONE_M_CONTEXT_BETA = 'context-1m-2025-08-07'

type ContextSize = 'default' | '1m'

interface Props {
  sessions: SessionInfo[]
  /** All sessions currently open in the chat grid (0-3). Any item whose
   *  id is in here is rendered as "open" in the sidebar (distinct from
   *  "focused" — the single panel receiving keyboard input). */
  openIds: string[]
  /** The id of the focused panel, or null. Gets the strongest highlight. */
  focusedId: string | null
  defaults: { cwd?: string; model?: string }
  /** Ids currently being resumed — item is disabled while the POST is in flight. */
  resumingIds?: Set<string>
  /** Map of sessionId → true when the session has a newer lastTurnAt than
   *  the user has seen (and isn't currently open). */
  unread?: Record<string, boolean>
  onSelect: (id: string) => void
  onCreate: (form: NewSessionForm) => void
  onDelete: (id: string) => void
  /** Close the panel for a session if it's currently open in the main grid.
   *  No-op when the session isn't open. Used by the right-click menu. */
  onClosePanel?: (id: string) => void
  /** Called when the user drops a card onto another one. `position` tells
   *  the parent whether to insert before or after the target. */
  onReorder?: (draggedId: string, targetId: string, position: 'before' | 'after') => void
  /** New-session dialog open state is lifted so App-level shortcuts
   *  (Alt+N) can open it. Uncontrolled mode falls back to internal state. */
  newSessionDialogOpen?: boolean
  onNewSessionDialogChange?: (open: boolean) => void
}

export function SessionList({
  sessions,
  openIds,
  focusedId,
  defaults,
  resumingIds,
  unread,
  onSelect,
  onCreate,
  onDelete,
  onClosePanel,
  onReorder,
  newSessionDialogOpen,
  onNewSessionDialogChange,
}: Props) {
  const [uncontrolledShow, setUncontrolledShow] = useState(false)
  const showDialog = newSessionDialogOpen ?? uncontrolledShow
  const setShowDialog = (v: boolean) => {
    if (onNewSessionDialogChange) onNewSessionDialogChange(v)
    else setUncontrolledShow(v)
  }
  /** Id of the card currently being dragged, so we can fade it out. */
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Id of the card currently being hovered over + which half. Used to
   *  paint a single insertion line without reshuffling the DOM mid-drag. */
  const [dropHint, setDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  /** Which card is currently in inline-rename mode, and the draft text. */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  /** Active right-click menu. `id` tells us which session it targets. */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  /** Sidebar filter text. Case-insensitive substring match against title,
   *  cwd, and the first 8 chars of the id. Not persisted — a stale filter
   *  after a reload causes more confusion than it saves typing. */
  const [filter, setFilter] = useState('')
  const visibleSessions = useMemo<SessionInfo[]>(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => {
      if (s.title && s.title.toLowerCase().includes(q)) return true
      if (s.cwd && s.cwd.toLowerCase().includes(q)) return true
      if (s.id.slice(0, 8).toLowerCase().includes(q)) return true
      return false
    })
  }, [sessions, filter])

  // Auto-focus + select the inline rename input on mount so the user can
  // immediately start typing to replace the existing title.
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const startRename = (s: SessionInfo) => {
    setRenamingId(s.id)
    setRenameDraft(s.title ?? '')
  }

  const commitRename = async (id: string, title: string) => {
    setRenamingId(null)
    // The server echoes back the updated session on /sessions/events, so
    // we don't need to update local state here. If the request fails the
    // card simply keeps its old title.
    try {
      await api.patch<{ session: SessionInfo }>(`/sessions/${id}`, { title })
    } catch (err) {
      console.warn('rename failed:', (err as Error).message)
    }
  }

  const cancelRename = () => setRenamingId(null)

  return (
    <>
      <div className="session-list-top">
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={() => setShowDialog(true)}
          title="New session (Alt+N)"
        >
          + New session
        </button>
        {/* Filter input — visible only when there are at least a handful
            of sessions. Below that the filter is more friction than help. */}
        {sessions.length > 3 && (
          <div className="session-filter">
            <input
              className="input"
              type="text"
              placeholder="Filter by title / cwd / id…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                type="button"
                className="session-filter-clear"
                onClick={() => setFilter('')}
                aria-label="Clear filter"
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
            No sessions yet.
          </div>
        ) : visibleSessions.length === 0 ? (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
            No sessions match "{filter}".
          </div>
        ) : (
          visibleSessions.map((s) => {
            const isResuming = resumingIds?.has(s.id) ?? false
            // "dormant" = persisted but not currently loaded in the server.
            // Clicking resumes; the UI shows a greyed-out item until the
            // POST /resume completes and the list is refreshed.
            const dormant = !s.running && !s.terminated
            const slotIdx = openIds.indexOf(s.id)
            const isOpen = slotIdx >= 0
            const isFocused = s.id === focusedId
            const hasUnread = !!unread?.[s.id]
            // A running session with an outstanding turn shows an extra
            // pulsing dot — gives an at-a-glance "this one is thinking".
            const working = s.running && s.working
            const isDragging = draggingId === s.id
            const hint = dropHint && dropHint.id === s.id ? dropHint.position : null
            const isRenaming = renamingId === s.id
            return (
            <div
              key={s.id}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, id: s.id })
              }}
              className={[
                'session-item',
                isFocused ? 'focused' : '',
                isOpen && !isFocused ? 'open' : '',
                s.terminated ? 'terminated' : '',
                dormant ? 'dormant' : '',
                isResuming ? 'resuming' : '',
                hasUnread ? 'unread' : '',
                isDragging ? 'dragging' : '',
                hint === 'before' ? 'drop-before' : '',
                hint === 'after' ? 'drop-after' : '',
              ].filter(Boolean).join(' ')}
              role="button"
              tabIndex={0}
              aria-disabled={isResuming}
              // Whole card is the drag handle. We intentionally don't add a
              // dedicated grip icon — the card already looks tile-ish, and
              // any click-to-select path is preserved because HTML5 DnD
              // only fires on actual drag, not on bare clicks.
              draggable={!isResuming && !!onReorder}
              onDragStart={(e) => {
                if (!onReorder) return
                setDraggingId(s.id)
                setDragPayload(e, { kind: 'sidebar-card', id: s.id })
              }}
              onDragEnd={() => {
                setDraggingId(null)
                setDropHint(null)
              }}
              onDragOver={(e) => {
                if (!onReorder || !isInAppDrag(e)) return
                e.preventDefault()
                // Decide before/after from the pointer's vertical position
                // within the card. Threshold is exactly the midpoint.
                const rect = e.currentTarget.getBoundingClientRect()
                const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                if (!dropHint || dropHint.id !== s.id || dropHint.position !== position) {
                  setDropHint({ id: s.id, position })
                }
              }}
              onDragLeave={(e) => {
                // Only clear when we really left the card (not when entering
                // a child element like the delete button).
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                if (dropHint?.id === s.id) setDropHint(null)
              }}
              onDrop={(e) => {
                if (!onReorder) return
                const payload = readDragPayload(e)
                setDropHint(null)
                setDraggingId(null)
                if (!payload || payload.kind !== 'sidebar-card') return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                onReorder(payload.id, s.id, position)
              }}
              onClick={() => !isResuming && onSelect(s.id)}
              onKeyDown={(e) => !isResuming && (e.key === 'Enter' || e.key === ' ') && onSelect(s.id)}
            >
              <div className="session-item-row">
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {hasUnread && <span className="session-item-unread" aria-label="unread" />}
                  {/* Slot indicator — shows which column in the main grid
                      this session is rendered in, so the sidebar makes the
                      open set legible at a glance instead of requiring the
                      user to cross-reference the panel headers. `focused`
                      is the stronger of the two states — render that with
                      a filled pill; plain `open` gets a hollow one. */}
                  {isOpen && (
                    <span
                      className={`session-item-slot ${isFocused ? 'focused' : ''}`}
                      title={
                        isFocused
                          ? `Focused (slot ${slotIdx + 1}) · Ctrl+${slotIdx + 1} to refocus`
                          : `Open in slot ${slotIdx + 1} · Ctrl+${slotIdx + 1} to focus`
                      }
                      aria-label={isFocused ? `focused slot ${slotIdx + 1}` : `open slot ${slotIdx + 1}`}
                    >
                      {slotIdx + 1}
                    </span>
                  )}
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="session-item-rename-input"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename(s.id, renameDraft)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void commitRename(s.id, renameDraft)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelRename()
                        }
                      }}
                      // Swallow clicks so editing doesn't trigger onSelect.
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        startRename(s)
                      }}
                      title="Double-click to rename"
                    >
                      {s.title ?? <span className="session-item-id">{s.id.slice(0, 8)}</span>}
                    </span>
                  )}
                </strong>
                <span
                  className={`session-item-badge ${s.error ? 'err' : s.running ? 'running' : ''} ${working ? 'working' : ''}`}
                  title={s.error ?? ''}
                >
                  {working && <span className="session-item-working-dot" aria-hidden />}
                  {s.error
                    ? 'err'
                    : s.terminated
                    ? 'ended'
                    : isResuming
                    ? 'resuming…'
                    : working
                    ? 'working'
                    : s.running
                    ? 'live'
                    : 'dormant'}
                </span>
              </div>
              {/* When the session errored, surface the message in the card
                  itself. The full text is in the badge tooltip, but a
                  truncated inline line saves a hover for 80% of cases. */}
              {s.error && (
                <div className="session-item-error" title={s.error}>
                  ⚠ {s.error}
                </div>
              )}
              {/* Dedicated cwd line — the most important per-session context.
                  We show a directory glyph + the shortened path, with the full
                  path as a tooltip for overflow cases. */}
              <div className="session-item-cwd" title={s.cwd ?? ''}>
                <span aria-hidden>📁</span>
                <span>{s.cwd ? shortenPath(s.cwd) : '(no cwd)'}</span>
              </div>
              <div className="session-item-meta">
                {s.model ?? 'default'} · {s.permissionMode ?? 'default'}
              </div>
              <div className="session-item-row">
                <span className="session-item-meta">
                  {s.messageCount} msgs · {s.subscribers} viewer{s.subscribers === 1 ? '' : 's'}
                </span>
                <button
                  className="session-item-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(s.id)
                  }}
                  title="Delete session"
                >
                  ✕
                </button>
              </div>
            </div>
            )
          })
        )}
      </div>

      {menu && <SessionContextMenu
        anchor={menu}
        session={sessions.find((s) => s.id === menu.id)}
        isOpen={openIds.includes(menu.id)}
        onClose={() => setMenu(null)}
        onRename={(s) => startRename(s)}
        onClosePanel={(id) => onClosePanel?.(id)}
        onDelete={(id) => onDelete(id)}
      />}

      {showDialog && (
        <NewSessionDialog
          defaults={defaults}
          onCancel={() => setShowDialog(false)}
          onSubmit={(form) => {
            onCreate(form)
            setShowDialog(false)
          }}
        />
      )}
    </>
  )
}

function shortenPath(p: string): string {
  if (p.length <= 36) return p
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return `…/${parts.slice(-2).join('/')}`
}

// --- new session dialog ------------------------------------------------------

interface DialogProps {
  defaults: { cwd?: string; model?: string }
  onSubmit: (form: NewSessionForm) => void
  onCancel: () => void
}

function NewSessionDialog({ defaults, onSubmit, onCancel }: DialogProps) {
  const [cwd, setCwd] = useState<string>(defaults.cwd ?? '')
  const [model, setModel] = useState<string>(defaults.model ?? '')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [contextSize, setContextSize] = useState<ContextSize>('default')
  const [showPicker, setShowPicker] = useState(false)

  const [recentModels, setRecentModels] = useLocalStorage<string[]>(RECENT_MODELS_KEY, [])

  const rememberModel = (raw: string) => {
    const name = raw.trim()
    if (!name) return
    // Write to localStorage synchronously — React state updates via the
    // useLocalStorage hook rely on a follow-up effect to persist, but
    // submit() unmounts this component on the same tick (onSubmit fires
    // setShowDialog(false) in the parent), so that effect would never run.
    // Persist directly, then update React state so the datalist stays in
    // sync if the dialog is reopened without a full reload.
    setRecentModels((prev) => {
      const next = [name, ...prev.filter((m) => m !== name)].slice(0, RECENT_MODELS_CAP)
      try {
        window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next))
      } catch {
        /* ignore quota / SecurityError */
      }
      return next
    })
  }

  const forgetModel = (name: string) => {
    setRecentModels((prev) => prev.filter((m) => m !== name))
  }

  const submit = () => {
    rememberModel(model)
    onSubmit({
      cwd: cwd.trim() || undefined,
      model: model.trim() || undefined,
      permissionMode,
      systemPrompt: systemPrompt.trim() || undefined,
      title: title.trim() || undefined,
      // Only include the beta flag when the user explicitly opts in —
      // sending an empty array is fine but an unnecessary over-reach, and
      // this keeps the wire payload clean for the default case.
      betas: contextSize === '1m' ? [ONE_M_CONTEXT_BETA] : undefined,
    })
  }

  // Esc closes the dialog, but not when the directory picker is open — that
  // picker has its own Esc handler and we don't want to collapse both modals
  // with one keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showPicker) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, showPicker])

  return (
    <>
      <div
        className="modal-backdrop"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      >
        <div className="modal" style={{ width: 'min(560px, 92vw)' }}>
          <div className="modal-header">
            <h3>New session</h3>
            <button className="btn" onClick={onCancel} style={{ padding: '2px 10px' }}>
              ✕
            </button>
          </div>

          <div className="modal-section">
            <div className="settings-field">
              <label>Working directory</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  placeholder="/path/to/project"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn" onClick={() => setShowPicker(true)} title="Browse server directories">
                  📁
                </button>
              </div>
            </div>

            <div className="settings-field">
              <label>Title (optional)</label>
              <input
                className="input"
                placeholder="My session"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label>Model</label>
              <input
                className="input"
                placeholder="xiaomi/mimo-v2.5-pro"
                list="recent-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="recent-models">
                {recentModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {recentModels.length > 0 && (
                <div className="recent-chips">
                  {recentModels.slice(0, 5).map((m) => (
                    <span key={m} className="recent-chip" title={`Use ${m}`}>
                      <button
                        type="button"
                        className="recent-chip-use"
                        onClick={() => setModel(m)}
                      >
                        {m}
                      </button>
                      <button
                        type="button"
                        className="recent-chip-forget"
                        onClick={() => forgetModel(m)}
                        title="Forget this model"
                        aria-label={`Forget ${m}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-field">
              <label>Permission mode</label>
              <select
                className="select"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-field">
              <label>Context size</label>
              <select
                className="select"
                value={contextSize}
                onChange={(e) => setContextSize(e.target.value as ContextSize)}
              >
                <option value="default">Default (per-model limit)</option>
                <option value="1m">1M tokens (beta · Sonnet 4 / 4.5 only)</option>
              </select>
              <span className="hint">
                Most Claude models cap at 200k tokens. The 1M beta applies to
                Sonnet 4 and 4.5 — if you pick it with another model the SDK
                falls back to that model's own limit.
              </span>
            </div>

            <div className="settings-field">
              <label>System prompt (optional)</label>
              <textarea
                className="textarea"
                placeholder="You are a helpful assistant..."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          <div className="modal-footer">
            <span className="hint">Press Esc or click outside to cancel.</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={submit}>
                Create
              </button>
            </div>
          </div>
        </div>
      </div>

      {showPicker && (
        <DirectoryPicker
          initialPath={cwd || defaults.cwd}
          onPick={(p) => {
            setCwd(p)
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  )
}

// --- right-click menu on a session card --------------------------------------

interface MenuProps {
  anchor: { x: number; y: number; id: string }
  session?: SessionInfo
  isOpen: boolean
  onClose: () => void
  onRename: (s: SessionInfo) => void
  onClosePanel: (id: string) => void
  onDelete: (id: string) => void
}

function SessionContextMenu({ anchor, session, isOpen, onClose, onRename, onClosePanel, onDelete }: MenuProps) {
  if (!session) return null
  const items: ContextMenuItem[] = [
    {
      label: 'Rename',
      icon: '✎',
      onClick: () => onRename(session),
    },
    {
      label: 'Copy session ID',
      icon: '#',
      onClick: () => {
        void navigator.clipboard?.writeText(session.id).catch(() => {})
      },
    },
    {
      label: 'Copy working directory',
      icon: '📁',
      disabled: !session.cwd,
      onClick: () => {
        if (session.cwd) void navigator.clipboard?.writeText(session.cwd).catch(() => {})
      },
    },
    { label: '' }, // separator
    ...(isOpen
      ? [
          {
            label: 'Close panel',
            icon: '✕',
            onClick: () => onClosePanel(anchor.id),
          } as ContextMenuItem,
        ]
      : []),
    {
      label: 'Delete session',
      icon: '🗑',
      danger: true,
      onClick: () => {
        // Ask for confirmation when there's conversation history at stake.
        // Sessions with zero messages fall through to an immediate delete
        // — those are essentially scratch sessions the user created and
        // abandoned without typing anything.
        const hasHistory = session.messageCount > 0
        if (hasHistory) {
          const title = session.title ?? session.id.slice(0, 8)
          const msg = `Delete session "${title}"?\n\nThis permanently removes the conversation from disk. The Anthropic SDK's own session log in ~/.claude/projects/ is kept, but the app won't reference it anymore.`
          if (!window.confirm(msg)) return
        }
        onDelete(anchor.id)
      },
    },
  ]

  return <ContextMenu x={anchor.x} y={anchor.y} items={items} onClose={onClose} />
}
