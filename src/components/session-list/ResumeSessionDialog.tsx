// Resume-session picker — lists sessions discoverable on disk (via the
// server's GET /sessions/resumable, backed by the SDK's listSessions) and
// lets the user search + pick one to resume. Unlike the sidebar (which only
// shows sessions this app created), this surfaces sessions the `claude` CLI
// created directly in the same project dirs too.
//
// Structure mirrors NewSessionDialog (modal-backdrop / modal / useFocusTrap /
// Esc-to-close) and the keyboard-navigation pattern of CommandPalette
// (↑↓ to move, Enter to confirm, Esc to dismiss).

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconX } from '../icons/ToolIcons'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { api } from '../../hooks/useApi'
import { shortenPath } from '../../utils/paths'
import type { ResumableSession } from '../../types'

export interface ResumeSessionDialogProps {
  open?: boolean
  /** Default working directory — used to scope the initial "this project"
   *  list. When empty, the dialog opens in "all projects" mode. */
  defaultCwd?: string
  /** Resume the chosen session. The parent reuses its existing resume flow
   *  (App.resumeSession) which also handles the unknown-session adoption. */
  onResume: (sessionId: string) => void
  onCancel: () => void
  /** Visual form.
   *  - 'modal' (default): full-app centered modal (`.modal-backdrop`). Used
   *    for the global / empty-state resume flow where no panel is targeted.
   *  - 'panel': column-scoped overlay (`.resume-overlay`) rendered inside a
   *    single chat panel, mirroring `.settings-overlay` / `.git-overlay`.
   *    Used when the picker targets a specific panel (Ctrl+Shift+O with a
   *    focused panel, or the `/resume` local command). Content is identical;
   *    only the wrapper chrome differs. */
  variant?: 'modal' | 'panel'
}

/** Relative-time formatter ("3m ago", "2h ago", "5d ago"). Falls back to a
 *  locale date for anything older than a week. */
function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ms).toLocaleDateString()
}

export function ResumeSessionDialog({ open = true, defaultCwd, onResume, onCancel, variant = 'modal' }: ResumeSessionDialogProps) {
  const [query, setQuery] = useState('')
  const [allProjects, setAllProjects] = useState(!defaultCwd)
  const [sessions, setSessions] = useState<ResumableSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useFocusTrap(dialogRef, { restoreFocus: true })

  // Fetch the resumable list whenever the scope toggles. Aborts in-flight
  // requests so a fast toggle doesn't race a stale response onto the list.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional: reset
     loading/error state synchronously when the fetch scope changes so the
     list shows a spinner before the async response resolves. */
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    const path =
      allProjects || !defaultCwd
        ? '/sessions/resumable'
        : `/sessions/resumable?dir=${encodeURIComponent(defaultCwd)}`
    api
      .get<{ sessions: ResumableSession[] }>(path, { signal: ac.signal })
      .then((r) => {
        setSessions(r.sessions)
        setSelectedIndex(0)
      })
      .catch((e) => {
        if (ac.signal.aborted) return
        setError((e as Error).message)
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [allProjects, defaultCwd])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Refocus the search input whenever the dialog (re)opens. useExitPresence
  // keeps the component mounted through the ~180ms exit animation, so a rapid
  // close→reopen (Esc then Ctrl+Shift+O within the exit window) would otherwise
  // leave the input unfocused — the mount-only effect wouldn't re-run. Gating
  // on `open` re-fires on each true transition.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions
    const q = query.toLowerCase()
    return sessions.filter(
      (s) =>
        s.title?.toLowerCase().includes(q) ||
        s.firstPrompt?.toLowerCase().includes(q) ||
        s.cwd?.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q),
    )
  }, [sessions, query])

  // Keep the selected row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const choose = (s: ResumableSession | undefined) => {
    if (!open || !s || s.terminated) return
    onResume(s.sessionId)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      choose(filtered[selectedIndex])
    } else if (open && e.key === 'Escape') {
      // Stop the bubble so App's window-level Esc handler doesn't also fire
      // (it would redundantly close this same dialog, or worse fall through
      // to interrupt the focused session if our state ref lagged a tick).
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  // Variant only swaps the wrapper chrome. The 'panel' variant mirrors the
  // per-column overlay pattern (.settings-overlay / .git-overlay): absolute,
  // inset:0, scoped to the hosting chat panel instead of the whole app.
  const backdropClass = variant === 'panel' ? 'resume-overlay' : 'modal-backdrop'
  const panelClass =
    variant === 'panel' ? 'resume-overlay-panel' : 'modal modal-resume-session'

  return (
    <div
      className={backdropClass}
      data-state={open ? 'open' : 'closing'}
      role="dialog"
      aria-modal={open ? 'true' : 'false'}
      aria-hidden={!open}
      onMouseDown={(e) => open && e.target === e.currentTarget && onCancel()}
    >
      <div className={panelClass} ref={dialogRef} onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <h3>Resume session</h3>
          <button className="btn btn-icon-sm" onClick={onCancel} aria-label="Close dialog">
            <IconX size={14} />
          </button>
        </div>

        <div className="modal-section">
          <input
            ref={inputRef}
            className="input"
            type="text"
            placeholder="Search sessions by title, prompt, or path..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            aria-label="Search resumable sessions"
          />

          {defaultCwd && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 8,
                fontSize: 13,
                color: 'var(--fg-muted)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={allProjects}
                onChange={(e) => setAllProjects(e.target.checked)}
              />
              All projects {allProjects ? '' : `(showing ${shortenPath(defaultCwd)})`}
            </label>
          )}

          <div
            className="palette-list"
            ref={listRef}
            role="listbox"
            aria-label="Resumable sessions"
            style={{ marginTop: 10, maxHeight: '50vh', overflowY: 'auto' }}
          >
            {loading && <div className="palette-empty">Loading...</div>}
            {!loading && error && (
              <div className="palette-empty">Couldn't load sessions: {error}</div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div className="palette-empty">No resumable sessions found</div>
            )}
            {!loading &&
              !error &&
              filtered.map((s, i) => {
                const label = s.title || s.firstPrompt || s.sessionId.slice(0, 12)
                return (
                  <button
                    key={s.sessionId}
                    className={`palette-item${i === selectedIndex ? ' selected' : ''}`}
                    role="option"
                    aria-selected={i === selectedIndex}
                    disabled={s.terminated}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => choose(s)}
                    style={{
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 2,
                      opacity: s.terminated ? 0.5 : 1,
                    }}
                  >
                    <span
                      className="palette-item-label"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        {label}
                      </span>
                      {s.running && <span className="resume-badge resume-badge-running">running</span>}
                      {s.terminated && <span className="resume-badge">ended</span>}
                      {!s.known && !s.terminated && <span className="resume-badge">CLI</span>}
                    </span>
                    <span
                      className="palette-item-hint"
                      style={{ display: 'flex', gap: 8, fontSize: 11 }}
                    >
                      {s.cwd && <span title={s.cwd}>{shortenPath(s.cwd)}</span>}
                      <span>· {timeAgo(s.lastModified)}</span>
                      {s.gitBranch && <span>· {s.gitBranch}</span>}
                    </span>
                  </button>
                )
              })}
          </div>
        </div>

        <div className="modal-footer">
          <span className="hint">↑↓ to navigate · Enter to resume · Esc to close</span>
        </div>
      </div>
    </div>
  )
}
