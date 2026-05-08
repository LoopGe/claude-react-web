// Left sidebar: "+ New session" button on top, full-height session list below.
// The new-session form lives inside a modal (<NewSessionDialog />) so the
// sidebar can dedicate its vertical space to listing sessions.

import { useEffect, useState } from 'react'
import { DirectoryPicker } from './DirectoryPicker'
import { useLocalStorage } from '../hooks/useLocalStorage'
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
}: Props) {
  const [showDialog, setShowDialog] = useState(false)

  return (
    <>
      <div className="session-list-top">
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setShowDialog(true)}>
          + New session
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
            No sessions yet.
          </div>
        ) : (
          sessions.map((s) => {
            const isResuming = resumingIds?.has(s.id) ?? false
            // "dormant" = persisted but not currently loaded in the server.
            // Clicking resumes; the UI shows a greyed-out item until the
            // POST /resume completes and the list is refreshed.
            const dormant = !s.running && !s.terminated
            const isOpen = openIds.includes(s.id)
            const isFocused = s.id === focusedId
            const hasUnread = !!unread?.[s.id]
            // A running session with an outstanding turn shows an extra
            // pulsing dot — gives an at-a-glance "this one is thinking".
            const working = s.running && s.working
            return (
            <div
              key={s.id}
              className={[
                'session-item',
                isFocused ? 'focused' : '',
                isOpen && !isFocused ? 'open' : '',
                s.terminated ? 'terminated' : '',
                dormant ? 'dormant' : '',
                isResuming ? 'resuming' : '',
                hasUnread ? 'unread' : '',
              ].filter(Boolean).join(' ')}
              role="button"
              tabIndex={0}
              aria-disabled={isResuming}
              onClick={() => !isResuming && onSelect(s.id)}
              onKeyDown={(e) => !isResuming && (e.key === 'Enter' || e.key === ' ') && onSelect(s.id)}
            >
              <div className="session-item-row">
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {hasUnread && <span className="session-item-unread" aria-label="unread" />}
                  {s.title ?? <span className="session-item-id">{s.id.slice(0, 8)}</span>}
                </strong>
                <span
                  className={`session-item-badge ${s.error ? 'err' : s.running ? 'running' : ''} ${working ? 'working' : ''}`}
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
