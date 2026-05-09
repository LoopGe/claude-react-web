// Left sidebar: "+ New session" button on top, full-height session list below.
// The new-session form lives inside a modal (<NewSessionDialog />) so the
// sidebar can dedicate its vertical space to listing sessions.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DirectoryPicker } from './DirectoryPicker'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { isInAppDrag, readDragPayload, setDragPayload } from '../hooks/useDragPayload'
import { api } from '../hooks/useApi'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { shortenPath } from '../utils/paths'
import { ACCENT_COLORS } from '../theme'
import type { NewSessionForm, PermissionMode, SessionGroup, SessionInfo, SidebarSection } from '../types'
import { PERMISSION_MODES } from '../types'

const RECENT_MODELS_KEY = 'claude-react-web:recent-models'
const RECENT_MODELS_CAP = 10
const RECENT_CWDS_KEY = 'claude-react-web:recent-cwds'
const RECENT_CWDS_CAP = 10

/** Enable the 1M token context window (Sonnet 4 / 4.5 only). */
const ONE_M_CONTEXT_BETA = 'context-1m-2025-08-07'

/** Ordered context-window presets for the new-session slider.
 *  `beta`, when set, is forwarded to the SDK as `betas: [beta]`. */
const CONTEXT_STEPS = [
  { value: 100_000,   label: "100k", beta: undefined },
  { value: 200_000,   label: "200k", beta: undefined },   // default
  { value: 256_000,   label: "256k", beta: undefined },
  { value: 512_000,   label: "512k", beta: undefined },
  { value: 1_000_000, label: "1M",   beta: ONE_M_CONTEXT_BETA },
] as const

type ContextStepIdx = number

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
  /** Fork a session — server spawns a new session whose transcript is
   *  seeded from this one. Used by the right-click menu. */
  onFork?: (id: string) => void
  /** Create a new empty session reusing the source's cwd/model/permissionMode
   *  but without any conversation history. Used by the right-click menu. */
  onNewLikeThis?: (id: string) => void
  /** Toggle a session's pinned flag (used by the right-click menu). */
  onTogglePin?: (id: string) => void
  /** Called when the user drops a card onto another one. `position` tells
   *  the parent whether to insert before or after the target. */
  onReorder?: (draggedId: string, targetId: string, position: 'before' | 'after') => void
  /** Drop a card onto a group header or its empty body. The session is
   *  added to the group's `sessionIds` (if not already present). Tag
   *  semantics — the session stays in any other groups it's in. */
  onDropIntoGroup?: (sessionId: string, groupId: string) => void
  /** Drop a card onto another card that lives inside a group. Ensures
   *  the dragged session is in the group, then reorders within the
   *  group's sessionIds. Separate from onReorder because the latter
   *  only touches the global sidebarOrder — never the group tag
   *  membership. */
  onReorderInGroup?: (
    draggedId: string,
    targetId: string,
    position: 'before' | 'after',
    groupId: string,
  ) => void
  /** New-session dialog open state is lifted so App-level shortcuts
   *  (Alt+N) can open it. Uncontrolled mode falls back to internal state. */
  newSessionDialogOpen?: boolean
  onNewSessionDialogChange?: (open: boolean) => void
  /** Per-session accent-colour overrides (sessionId → hex). */
  sessionColors?: Record<string, string>
  /** Set or clear a session's accent colour. Pass `undefined` to reset. */
  onSessionColorChange?: (sessionId: string, color: string | undefined) => void
  // --- Group management ---
  /** Persisted list of user-created session groups. */
  groups: SessionGroup[]
  /** Pre-computed sidebar sections for grouped rendering. Empty when no groups exist. */
  sidebarSections: SidebarSection[]
  /** Map of groupId → true when the group is collapsed. */
  collapsedGroups: Record<string, boolean>
  /** Replace the main-area panels with this group's sessions. */
  onActivateGroup: (groupId: string) => void
  /** Create a new empty group and return its id. */
  onCreateGroup: (name: string) => string
  /** Permanently delete a group (orphaned sessions move to "default"). */
  onDeleteGroup: (groupId: string) => void
  /** Rename an existing group. */
  onRenameGroup: (groupId: string, name: string) => void
  /** Add a session to a group (idempotent / deduped). */
  onAddToGroup: (sessionId: string, groupId: string) => void
  /** Remove a session from a group. */
  onRemoveFromGroup: (sessionId: string, groupId: string) => void
  /** Toggle a group's collapsed state in the sidebar. */
  onToggleGroupCollapse: (groupId: string) => void
}

export function SessionList({
  sessions,
  openIds,
  focusedId,
  defaults,
  resumingIds,
  unread,
  sessionColors,
  onSessionColorChange,
  groups,
  sidebarSections,
  collapsedGroups,
  onActivateGroup,
  onCreateGroup,
  onDeleteGroup,
  onRenameGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onToggleGroupCollapse,
  onSelect,
  onCreate,
  onDelete,
  onClosePanel,
  onFork,
  onNewLikeThis,
  onTogglePin,
  onReorder,
  onDropIntoGroup,
  onReorderInGroup,
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
  /** Id of the group header/body currently being hovered during a drag.
   *  Paints the section as a drop target — distinct from `dropHint`
   *  which targets a specific card. */
  const [groupDropHint, setGroupDropHint] = useState<string | null>(null)
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
  /** When the user drags a folder onto the "New session" button we
   *  pre-fill its cwd here and open the dialog. `undefined` means
   *  "use defaults" (the dialog behaves as before). */
  const [prefilledCwd, setPrefilledCwd] = useState<string | undefined>(undefined)
  /** Visual highlight while a file is being dragged over the button. */
  const [dropZoneActive, setDropZoneActive] = useState(false)
  // --- Group UI state ---
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const newGroupInputRef = useRef<HTMLInputElement>(null)
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

  /** Filtered version of sidebarSections — applies the same text filter
   *  to each section's session list so the grouped view respects the
   *  filter input. Empty sections are dropped. */
  const filteredSections = useMemo<SidebarSection[]>(() => {
    if (sidebarSections.length === 0) return []
    const q = filter.trim().toLowerCase()
    const match = (s: SessionInfo) => {
      if (!q) return true
      if (s.title && s.title.toLowerCase().includes(q)) return true
      if (s.cwd && s.cwd.toLowerCase().includes(q)) return true
      if (s.id.slice(0, 8).toLowerCase().includes(q)) return true
      return false
    }
    const result: SidebarSection[] = []
    for (const sec of sidebarSections) {
      const filtered = sec.sessions.filter(match)
      if (filtered.length === 0) continue
      if (sec.kind === 'pinned') result.push({ kind: 'pinned', sessions: filtered })
      else if (sec.kind === 'group') result.push({ kind: 'group', group: sec.group, sessions: filtered })
    }
    return result
  }, [sidebarSections, filter])

  // Auto-focus + select the inline rename input on mount so the user can
  // immediately start typing to replace the existing title.
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // Auto-focus the new-group name input when it appears.
  useEffect(() => {
    if (showNewGroupInput && newGroupInputRef.current) {
      newGroupInputRef.current.focus()
    }
  }, [showNewGroupInput])

  const startRename = (s: SessionInfo) => {
    setRenamingId(s.id)
    setRenameDraft(s.title ?? '')
  }

  const commitRename = async (id: string, title: string) => {
    setRenamingId(null)
    // The server broadcasts the updated session via WebSocket, so we
    // don't need to update local state here. If the request fails the
    // card simply keeps its old title.
    try {
      await api.patch<{ session: SessionInfo }>(`/sessions/${id}`, { title })
    } catch (err) {
      console.warn('rename failed:', (err as Error).message)
    }
  }

  const cancelRename = () => setRenamingId(null)

  /** Extract an absolute path from a drop event. Browsers don't expose
   *  file system paths on File objects (unlike Electron), but on Linux /
   *  macOS desktop file managers populate `text/uri-list` with
   *  `file:///abs/path\n` — that's what we rely on. Returns null when
   *  no usable path was carried. */
  const extractDroppedPath = (e: React.DragEvent): string | null => {
    const uris = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (!uris) return null
    // uri-list lines are the URIs themselves; comments start with '#'.
    const line = uris
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
    if (!line) return null
    if (!line.startsWith('file://')) return null
    try {
      const url = new URL(line)
      // file:///home/x → /home/x. decodeURI turns %20 etc. back.
      return decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  }

  /** Resolve the dropped path to a cwd via the server (file → parent
   *  directory) and open the dialog pre-filled. Errors become an alert;
   *  no stored state. */
  const handleFolderDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropZoneActive(false)
    const path = extractDroppedPath(e)
    if (!path) {
      // User might have dragged from another browser window or dropped
      // a non-file source (selected text). Nothing actionable.
      return
    }
    try {
      const res = await api.get<{ cwd: string }>(
        `/fs/resolve-cwd?path=${encodeURIComponent(path)}`,
      )
      setPrefilledCwd(res.cwd)
      setShowDialog(true)
    } catch (err) {
      window.alert(`Couldn't use that folder: ${(err as Error).message}`)
    }
  }

  /** Render a single session card. Extracted so both the flat and sectioned
   *  views share the exact same card markup.
   *
   *  `containerGroupId` — when the card is rendered inside a group's
   *  body, callers pass the group's id so the card's onDrop can use
   *  the `onReorderInGroup` handler (which preserves tag membership
   *  and reorders the group's sessionIds). Outside any group (pinned),
   *  it's undefined and the card falls back to the global `onReorder`
   *  path. */
  const renderSessionCard = (s: SessionInfo, containerGroupId?: string) => {
    const isResuming = resumingIds?.has(s.id) ?? false
    const dormant = !s.running && !s.terminated
    const slotIdx = openIds.indexOf(s.id)
    const isOpen = slotIdx >= 0
    const isFocused = s.id === focusedId
    const hasUnread = !!unread?.[s.id]
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
          sessionColors?.[s.id] ? 'tinted' : '',
        ].filter(Boolean).join(' ')}
        style={
          sessionColors?.[s.id]
            ? (() => {
                const hex = sessionColors[s.id]
                const preset = ACCENT_COLORS.find((c) => c.accent === hex)
                return { '--accent': hex, '--accent-strong': preset?.strong ?? hex } as CSSProperties
              })()
            : undefined
        }
        role="button"
        tabIndex={0}
        aria-disabled={isResuming}
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
          const rect = e.currentTarget.getBoundingClientRect()
          const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          if (!dropHint || dropHint.id !== s.id || dropHint.position !== position) {
            setDropHint({ id: s.id, position })
          }
        }}
        onDragLeave={(e) => {
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
          // Dropping onto a card inside a group routes through the
          // intra-group handler so the dragged session gets added to
          // the group's tag list and positioned inside its sessionIds
          // — instead of only affecting the global sidebarOrder.
          if (containerGroupId && onReorderInGroup) {
            onReorderInGroup(payload.id, s.id, position, containerGroupId)
          } else {
            onReorder(payload.id, s.id, position)
          }
        }}
        onClick={() => !isResuming && onSelect(s.id)}
        onKeyDown={(e) => !isResuming && (e.key === 'Enter' || e.key === ' ') && onSelect(s.id)}
      >
        <div className="session-item-row">
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hasUnread && <span className="session-item-unread" aria-label="unread" />}
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
            {s.pinned && (
              <span className="session-item-pin" title="Pinned · right-click to unpin" aria-label="pinned">
                📌
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
        {s.error && (
          <div className="session-item-error" title={s.error}>
            ⚠ {s.error}
          </div>
        )}
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
              if (s.messageCount > 0) {
                const title = s.title ?? s.id.slice(0, 8)
                if (!window.confirm(`Delete session "${title}"?`)) return
              }
              onDelete(s.id)
            }}
            title="Delete session"
          >
            ✕
          </button>
        </div>
      </div>
    )
  }

  /** Determine whether a group's sessions currently occupy the main-area
   *  panels (i.e. its sessions match `openIds`). Used for the active highlight. */
  const isGroupActive = (group: SessionGroup): boolean => {
    if (openIds.length === 0) return false
    const set = new Set(group.sessionIds)
    return openIds.every((id) => set.has(id))
  }

  return (
    <>
      <div className="session-list-top">
        <button
          className={`btn btn-primary new-session-btn ${dropZoneActive ? 'drop-target' : ''}`}
          style={{ width: '100%' }}
          onClick={() => setShowDialog(true)}
          onDragOver={(e) => {
            // Accept anything that carries a file-uri — that covers folder
            // drops from native file managers (Nautilus, Finder, Windows
            // Explorer all write text/uri-list). We *don't* preventDefault
            // for in-app session-card drags; those are handled elsewhere.
            if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list')) {
              e.preventDefault()
              setDropZoneActive(true)
            }
          }}
          onDragLeave={() => setDropZoneActive(false)}
          onDrop={(e) => void handleFolderDrop(e)}
          title="New session (Alt+N) · drop a folder here to prefill cwd"
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
        {/* Group pills — horizontal row of clickable group chips. */}
        <div className="group-pills">
          {groups.map((g) => (
            <span
              key={g.id}
              className="group-pill"
              title={`Activate "${g.name}" (${g.sessionIds.length} sessions) · right-click for options`}
              onClick={() => onActivateGroup(g.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                const choice = window.prompt(`Group "${g.name}"\n\nType a new name to rename, or leave empty to delete:`, g.name)
                if (choice === null) return // cancelled
                const trimmed = choice.trim()
                if (!trimmed) {
                  onDeleteGroup(g.id)
                } else if (trimmed !== g.name) {
                  onRenameGroup(g.id, trimmed)
                }
              }}
            >
              {g.name}
              <span className="group-pill-count">{g.sessionIds.length}</span>
            </span>
          ))}
          {showNewGroupInput ? (
            <input
              ref={newGroupInputRef}
              className="group-pill-input"
              placeholder="Group name…"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const name = newGroupName.trim()
                  if (name) onCreateGroup(name)
                  setNewGroupName('')
                  setShowNewGroupInput(false)
                } else if (e.key === 'Escape') {
                  setNewGroupName('')
                  setShowNewGroupInput(false)
                }
              }}
              onBlur={() => {
                const name = newGroupName.trim()
                if (name) onCreateGroup(name)
                setNewGroupName('')
                setShowNewGroupInput(false)
              }}
            />
          ) : (
            <button
              type="button"
              className="group-pill group-pill-new"
              onClick={() => setShowNewGroupInput(true)}
              title="Create a new session group"
            >
              + Group
            </button>
          )}
        </div>
      </div>
      <div className="session-list">
          {sessions.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
              No sessions yet.
            </div>
          ) : filteredSections.length > 0 ? (
          // ── Sectioned view (groups exist) ──
          filteredSections.map((sec) => {
            if (sec.kind === 'pinned') {
              return (
                <div key="pinned" className="session-section">
                  <div className="session-section-header">📌 Pinned</div>
                  {sec.sessions.map((s) => renderSessionCard(s))}
                </div>
              )
            }
            if (sec.kind === 'group') {
              const collapsed = !!collapsedGroups[sec.group.id]
              const active = isGroupActive(sec.group)
              return (
                <div key={sec.group.id} className={`session-section ${active ? 'group-active' : ''}`}>
                  <div
                    className={`session-group-header ${groupDropHint === sec.group.id ? 'drop-target' : ''}`}
                    onClick={() => onToggleGroupCollapse(sec.group.id)}
                    title={`${sec.group.name} · ${sec.sessions.length} session${sec.sessions.length === 1 ? '' : 's'}`}
                    onDragOver={(e) => {
                      if (!onDropIntoGroup || !isInAppDrag(e)) return
                      e.preventDefault()
                      if (groupDropHint !== sec.group.id) setGroupDropHint(sec.group.id)
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                      if (groupDropHint === sec.group.id) setGroupDropHint(null)
                    }}
                    onDrop={(e) => {
                      if (!onDropIntoGroup) return
                      const payload = readDragPayload(e)
                      setGroupDropHint(null)
                      setDraggingId(null)
                      if (!payload || payload.kind !== 'sidebar-card') return
                      e.preventDefault()
                      onDropIntoGroup(payload.id, sec.group.id)
                    }}
                  >
                    <span className="group-collapse-arrow">{collapsed ? '▶' : '▼'}</span>
                    <span className="group-header-name">{sec.group.name}</span>
                    <span className="group-header-count">{sec.sessions.length}</span>
                    <button
                      className="group-activate-btn"
                      onClick={(e) => { e.stopPropagation(); onActivateGroup(sec.group.id) }}
                      title="Replace main-area panels with this group's sessions"
                    >
                      ▶
                    </button>
                  </div>
                  {!collapsed && sec.sessions.length > 0 && (
                    <div
                      className={`group-sessions ${groupDropHint === sec.group.id ? 'drop-target' : ''}`}
                      onDragOver={(e) => {
                        if (!onDropIntoGroup || !isInAppDrag(e)) return
                        // Accept drops anywhere in the group body that
                        // aren't intercepted by a specific card. The
                        // event bubbles up from cards, so we only
                        // highlight when the target is the body itself.
                        if (e.target !== e.currentTarget) return
                        e.preventDefault()
                        if (groupDropHint !== sec.group.id) setGroupDropHint(sec.group.id)
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                        if (groupDropHint === sec.group.id) setGroupDropHint(null)
                      }}
                      onDrop={(e) => {
                        if (!onDropIntoGroup) return
                        // Only act on drops directly on the body, not
                        // bubbled from a child card (the card has its
                        // own onDrop and already stopped propagation by
                        // calling preventDefault). Target check below.
                        if (e.target !== e.currentTarget) {
                          setGroupDropHint(null)
                          return
                        }
                        const payload = readDragPayload(e)
                        setGroupDropHint(null)
                        setDraggingId(null)
                        if (!payload || payload.kind !== 'sidebar-card') return
                        e.preventDefault()
                        onDropIntoGroup(payload.id, sec.group.id)
                      }}
                    >
                      {sec.sessions.map((s) => renderSessionCard(s, sec.group.id))}
                    </div>
                  )}
                  {!collapsed && sec.sessions.length === 0 && (
                    <div
                      className={`group-empty ${groupDropHint === sec.group.id ? 'drop-target' : ''}`}
                      onDragOver={(e) => {
                        if (!onDropIntoGroup || !isInAppDrag(e)) return
                        e.preventDefault()
                        if (groupDropHint !== sec.group.id) setGroupDropHint(sec.group.id)
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                        if (groupDropHint === sec.group.id) setGroupDropHint(null)
                      }}
                      onDrop={(e) => {
                        if (!onDropIntoGroup) return
                        const payload = readDragPayload(e)
                        setGroupDropHint(null)
                        setDraggingId(null)
                        if (!payload || payload.kind !== 'sidebar-card') return
                        e.preventDefault()
                        onDropIntoGroup(payload.id, sec.group.id)
                      }}
                    >
                      No sessions in this group.
                    </div>
                  )}
                </div>
              )
            }
            return null
          })
          ) : visibleSessions.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
              No sessions match "{filter}".
            </div>
          ) : (
            // ── Flat view (no groups) ──
            visibleSessions.map((s) => renderSessionCard(s))
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
        onFork={(id) => onFork?.(id)}
        onNewLikeThis={(id) => onNewLikeThis?.(id)}
        onTogglePin={(id) => onTogglePin?.(id)}
        sessionColor={sessionColors?.[menu.id]}
        onColorChange={(color) => onSessionColorChange?.(menu.id, color)}
        groups={groups}
        onAddToGroup={onAddToGroup}
        onRemoveFromGroup={onRemoveFromGroup}
      />}

      {showDialog && (
        <NewSessionDialog
          defaults={defaults}
          initialCwd={prefilledCwd}
          groups={groups}
          onCancel={() => {
            setShowDialog(false)
            setPrefilledCwd(undefined)
          }}
          onSubmit={(form) => {
            onCreate(form)
            setShowDialog(false)
            setPrefilledCwd(undefined)
          }}
        />
      )}
    </>
  )
}

// --- new session dialog ------------------------------------------------------

interface DialogProps {
  defaults: { cwd?: string; model?: string }
  /** Overrides defaults.cwd when set. Used by the drag-to-new-session
   *  shortcut, which wants to prefill with the dropped folder rather
   *  than the server-configured default. */
  initialCwd?: string
  onSubmit: (form: NewSessionForm) => void
  onCancel: () => void
  /** Available groups for the mandatory group selector. Always ≥ 1. */
  groups: SessionGroup[]
}

function NewSessionDialog({ defaults, initialCwd, onSubmit, onCancel, groups }: DialogProps) {
  const [cwd, setCwd] = useState<string>(initialCwd ?? defaults.cwd ?? '')
  const [model, setModel] = useState<string>(defaults.model ?? '')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [title, setTitle] = useState('')
  /** Accent colour chosen in the dialog. `undefined` means "use the
   *  global accent" — we don't write an entry to sessionColors unless
   *  the user explicitly picks one. */
  const [accent, setAccent] = useState<string | undefined>(undefined)
  const [contextStepIdx, setContextStepIdx] = useState<ContextStepIdx>(1) // 200k default
  const [groupId, setGroupId] = useState<string>(groups[0]?.id ?? '')
  const [showPicker, setShowPicker] = useState(false)

  const [recentModels, setRecentModels] = useLocalStorage<string[]>(RECENT_MODELS_KEY, [])
  const [recentCwds, setRecentCwds] = useLocalStorage<string[]>(RECENT_CWDS_KEY, [])

  // Shared "remember recent …" helper: MRU-order, de-duped, capped.
  //
  // This dialog unmounts on the same tick as submit() (the parent flips
  // showDialog=false), so we CAN'T rely on the useLocalStorage hook's
  // effect to flush. We also can't put the side effect inside the setState
  // updater: React 19 will skip an updater whose resulting state is
  // discarded by an imminent unmount, which previously meant our second
  // call (rememberCwd, right after rememberModel) silently lost its write.
  //
  // So we do two independent things:
  //   1) compute `next` synchronously from the latest disk value and
  //      write it to localStorage right away — the important, persistent
  //      side effect.
  //   2) fire-and-forget the state update so that if the dialog happens
  //      to stay mounted, the chips list still reflects the new value.
  const rememberIn = (
    storageKey: string,
    setter: (next: string[]) => void,
    cap: number,
    raw: string,
  ) => {
    const v = raw.trim()
    if (!v) return
    let prev: string[] = []
    try {
      const existing = window.localStorage.getItem(storageKey)
      if (existing) {
        const parsed = JSON.parse(existing)
        if (Array.isArray(parsed)) prev = parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      /* fall through with prev=[] */
    }
    const next = [v, ...prev.filter((x) => x !== v)].slice(0, cap)
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      /* quota / SecurityError — the in-memory state still wins this session */
    }
    setter(next)
  }

  const rememberModel = (raw: string) =>
    rememberIn(RECENT_MODELS_KEY, setRecentModels, RECENT_MODELS_CAP, raw)
  const forgetModel = (name: string) => {
    setRecentModels((prev) => prev.filter((m) => m !== name))
  }

  const rememberCwd = (raw: string) =>
    rememberIn(RECENT_CWDS_KEY, setRecentCwds, RECENT_CWDS_CAP, raw)
  const forgetCwd = (name: string) => {
    setRecentCwds((prev) => prev.filter((c) => c !== name))
  }

  const submit = () => {
    rememberModel(model)
    rememberCwd(cwd)
    const step = CONTEXT_STEPS[contextStepIdx]
    onSubmit({
      cwd: cwd.trim() || undefined,
      model: model.trim() || undefined,
      permissionMode,
      systemPrompt: systemPrompt.trim() || undefined,
      title: title.trim() || undefined,
      // Only include the beta flag for steps that require it (currently
      // just 1M) — keeps the wire payload clean for all other sizes.
      betas: step.beta ? [step.beta] : undefined,
      accent,
      groupId: groupId || groups[0]?.id,
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
                  list="recent-cwds"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn" onClick={() => setShowPicker(true)} title="Browse server directories">
                  📁
                </button>
              </div>
              <datalist id="recent-cwds">
                {recentCwds.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              {recentCwds.length > 0 && (
                <div className="recent-chips">
                  {recentCwds.slice(0, 5).map((p) => (
                    <span key={p} className="recent-chip" title={p}>
                      <button
                        type="button"
                        className="recent-chip-use"
                        onClick={() => setCwd(p)}
                      >
                        {shortenPath(p)}
                      </button>
                      <button
                        type="button"
                        className="recent-chip-forget"
                        onClick={() => forgetCwd(p)}
                        title="Forget this path"
                        aria-label={`Forget ${p}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
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
              <label>Group</label>
              <select
                className="select"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-field">
              <label>Accent colour</label>
              <div className="accent-picker" role="radiogroup" aria-label="Session accent">
                <button
                  type="button"
                  className={`accent-swatch accent-swatch-default ${accent === undefined ? 'active' : ''}`}
                  onClick={() => setAccent(undefined)}
                  role="radio"
                  aria-checked={accent === undefined}
                  aria-label="Use global accent"
                  title="Use global accent"
                >
                  ↺
                </button>
                {ACCENT_COLORS.map((c) => (
                  <button
                    key={c.accent}
                    type="button"
                    className={`accent-swatch ${accent === c.accent ? 'active' : ''}`}
                    style={{ ['--swatch' as string]: c.accent }}
                    onClick={() => setAccent(c.accent)}
                    role="radio"
                    aria-checked={accent === c.accent}
                    aria-label={c.name}
                    title={c.name}
                  />
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label>Context size</label>
              <StepSlider
                steps={CONTEXT_STEPS}
                value={contextStepIdx}
                onChange={setContextStepIdx}
              />
              <span className="hint">
                {contextStepIdx === 4
                  ? '1M beta · Sonnet 4 / 4.5 only — other models fall back to their own limit.'
                  : 'Controls the context window the session is allowed to use.'}
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
  /** Fork the session: POSTs /sessions/:id/fork on the server, which
   *  spawns a new Query seeded from this session's transcript. The new
   *  session appears in the sidebar via the global created event. */
  onFork: (id: string) => void
  /** Create a new empty session reusing the source's cwd/model/permissionMode. */
  onNewLikeThis: (id: string) => void
  /** Toggle pinned flag on the session. */
  onTogglePin: (id: string) => void
  /** Current per-session accent hex, or undefined for global default. */
  sessionColor?: string
  /** Set or clear the session accent. */
  onColorChange?: (color: string | undefined) => void
  // --- Group actions ---
  groups: SessionGroup[]
  onAddToGroup: (sessionId: string, groupId: string) => void
  onRemoveFromGroup: (sessionId: string, groupId: string) => void
}

function SessionContextMenu({
  anchor,
  session,
  isOpen,
  onClose,
  onRename,
  onClosePanel,
  onDelete,
  onFork,
  onNewLikeThis,
  onTogglePin,
  sessionColor,
  onColorChange,
  groups,
  onAddToGroup,
  onRemoveFromGroup,
}: MenuProps) {
  if (!session) return null
  const items: ContextMenuItem[] = [
    {
      label: 'Rename',
      icon: '✎',
      onClick: () => onRename(session),
    },
    {
      // Toggle rather than separate pin/unpin items — keeps the menu
      // short and the action reversible from one place.
      label: session.pinned ? 'Unpin' : 'Pin to top',
      icon: session.pinned ? '📍' : '📌',
      onClick: () => onTogglePin(anchor.id),
    },
    {
      label: 'Fork from this point',
      icon: '⑂',
      // Disabled until the SDK has flushed at least one completed turn to
      // ~/.claude/projects/<cwd>/<id>.jsonl — the CLI otherwise errors with
      // "No conversation found with session ID" when we hand it resume:id.
      // lastTurnAt is set only when a real `result` comes back from the
      // pump, so it's a reliable ground truth.
      disabled: !session.lastTurnAt,
      onClick: () => onFork(anchor.id),
    },
    {
      label: 'New session like this',
      icon: '⧉',
      onClick: () => onNewLikeThis(anchor.id),
    },
    { label: '' }, // separator before group actions
    // --- Group actions ---
    ...(() => {
      const sessionGroups = groups.filter((g) => g.sessionIds.includes(anchor.id))
      const otherGroups = groups.filter((g) => !g.sessionIds.includes(anchor.id))
      const items: ContextMenuItem[] = []
      if (otherGroups.length > 0) {
        items.push({ label: 'Add to group ▸', icon: '＋', disabled: true })
        for (const g of otherGroups) {
          items.push({
            label: `  ${g.name}`,
            icon: ' ',
            onClick: () => onAddToGroup(anchor.id, g.id),
          })
        }
      }
      // Only allow removing when the session is in 2+ groups — sessions
      // must always belong to at least one group.
      if (sessionGroups.length > 1) {
        items.push({ label: 'Remove from group ▸', icon: '－', disabled: true })
        for (const g of sessionGroups) {
          items.push({
            label: `  ${g.name}`,
            icon: '✕',
            onClick: () => onRemoveFromGroup(anchor.id, g.id),
          })
        }
      }
      return items
    })(),
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
    { label: '' }, // separator
    ...ACCENT_COLORS.map(
      (c) =>
        ({
          label: c.name,
          icon: sessionColor === c.accent ? '◉' : '●',
          iconStyle: { color: c.accent },
          onClick: () => onColorChange?.(c.accent),
        }) as ContextMenuItem,
    ),
    ...(sessionColor
      ? [
          {
            label: 'Default colour',
            icon: '↺',
            onClick: () => onColorChange?.(undefined),
          } as ContextMenuItem,
        ]
      : []),
    { label: '' }, // separator
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

// ---------------------------------------------------------------------------
// StepSlider — horizontal discrete-step selector
// ---------------------------------------------------------------------------

interface StepDef {
  value: number
  label: string
  beta?: string
}

function StepSlider({
  steps,
  value,
  onChange,
}: {
  steps: readonly StepDef[]
  value: number
  onChange: (idx: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragIdxRef = useRef<number | null>(null)

  /** Given a pointer X relative to the viewport, find the nearest step. */
  const nearestStep = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return value
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (steps.length - 1))
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const idx = nearestStep(e.clientX)
    dragIdxRef.current = idx
    onChange(idx)
    // Capture so we keep receiving events even if the pointer leaves the track.
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragIdxRef.current === null) return
    const idx = nearestStep(e.clientX)
    if (idx !== dragIdxRef.current) {
      dragIdxRef.current = idx
      onChange(idx)
    }
  }

  const handlePointerUp = () => {
    dragIdxRef.current = null
  }

  const pct = steps.length > 1 ? (value / (steps.length - 1)) * 100 : 0

  return (
    <div className="step-slider">
      {/* Value readout */}
      <div className="step-slider-readout">
        {steps.map((s, i) => (
          <span key={s.label} className={`step-slider-label${i === value ? ' active' : ''}`}>
            {s.label}
          </span>
        ))}
      </div>
      {/* Track */}
      <div
        ref={trackRef}
        className="step-slider-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="step-slider-fill" style={{ width: `${pct}%` }} />
        {steps.map((s, i) => {
          const leftPct = (i / (steps.length - 1)) * 100
          return (
            <div
              key={s.label}
              className={`step-slider-dot${i === value ? ' active' : ''}`}
              style={{ left: `${leftPct}%` }}
            />
          )
        })}
        <div
          className="step-slider-thumb"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}
