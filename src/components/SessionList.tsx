// Left sidebar: "+ New session" button on top, full-height session list below.
// The new-session form lives inside a modal (<NewSessionDialog />) so the
// sidebar can dedicate its vertical space to listing sessions.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isInAppDrag, readDragPayload } from '../hooks/useDragPayload'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import { buildSessionAccentMap } from '../theme'
import type { NewSessionForm, SessionGroup, SessionInfo, SidebarSection } from '../types'
import { NewSessionDialog } from './session-list/NewSessionDialog'
import { SessionContextMenu } from './session-list/SessionContextMenu'
import { SessionCard } from './session-list/SessionCard'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { ContextMenu } from './ContextMenu'
import { Virtuoso } from 'react-virtuoso'

interface Props {
  sessions: SessionInfo[]
  /** All sessions currently open in the chat grid (0-maxOpen). Any item whose
   *  id is in here is rendered as "open" in the sidebar (distinct from
   *  "focused" — the single panel receiving keyboard input). */
  openIds: string[]
  /** The id of the focused panel, or null. Gets the strongest highlight. */
  focusedId: string | null
  defaults: { cwd?: string; model?: string }
  /** Server-configured model list (from /api/config). Shown as chips
   *  in the new-session dialog so the user always has a baseline. */
  serverModels?: string[]
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
  /** Delete the session and create a fresh one with the same config. */
  onRestart?: (id: string) => void
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
  /** Move a session to a group (exclusive — removes from current group). */
  onAddToGroup: (sessionId: string, groupId: string) => void
  /** Toggle a group's collapsed state in the sidebar. */
  onToggleGroupCollapse: (groupId: string) => void
  /** The id of the group whose sessions are currently open in the main
   *  grid, or null when no group is active. Used to pre-select the group
   *  in the new-session dialog. */
  activeGroupId?: string | null
  /** Max sessions per group / max open panels. Shared with App. */
  maxOpen: number
}

export const SessionList = memo(function SessionList({
  sessions,
  openIds,
  focusedId,
  defaults,
  serverModels,
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
  onToggleGroupCollapse,
  onSelect,
  onCreate,
  onDelete,
  onClosePanel,
  onFork,
  onNewLikeThis,
  onRestart,
  onReorder,
  onDropIntoGroup,
  onReorderInGroup,
  newSessionDialogOpen,
  onNewSessionDialogChange,
  activeGroupId,
  maxOpen,
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
  /** Global toast hub. `showFolderDropError` becomes `toast.error(...)`
   *  and the previous inline `successMsg` banner becomes `toast.success(...)`. */
  const toast = useToast()
  // --- Confirm / Prompt dialog state (replaces window.confirm / window.prompt) ---
  type ConfirmState = {
    title: string
    message: React.ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  }
  type PromptState = {
    title: string
    message: React.ReactNode
    defaultValue: string
    confirmLabel: string
    placeholder?: string
    onConfirm: (value: string) => void | Promise<void>
  }
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [promptBusy, setPromptBusy] = useState(false)
  /** Pending group pill context menu target — the group id whose
   *  right-click context menu should open. Null when menu is closed. */
  const [groupMenuTarget, setGroupMenuTarget] = useState<string | null>(null)
  const [groupMenuPos, setGroupMenuPos] = useState<{ x: number; y: number } | null>(null)
  // --- Group UI state ---
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const newGroupInputRef = useRef<HTMLInputElement>(null)
  // Guard against double-creation when Enter triggers both the keyDown
  // handler and the subsequent blur (from DOM removal).
  const groupCreatedViaEnterRef = useRef(false)
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
      if (sec.kind === 'group') result.push({ kind: 'group', group: sec.group, sessions: filtered })
      else if (sec.kind === 'ungrouped') result.push({ kind: 'ungrouped', sessions: filtered })
    }
    return result
  }, [sidebarSections, filter])

  // Auto-focus the new-group name input when it appears.
  useEffect(() => {
    if (showNewGroupInput && newGroupInputRef.current) {
      newGroupInputRef.current.focus()
    }
  }, [showNewGroupInput])

  // ── Stable callbacks for SessionCard ─────────────────────────
  const handleCardContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    setMenu({ x: e.clientX, y: e.clientY, id })
  }, [])

  const handleCardDragStart = useCallback((_e: React.DragEvent, id: string) => {
    setDraggingId(id)
  }, [])

  const handleCardDragEnd = useCallback(() => {
    setDraggingId(null)
    setDropHint(null)
  }, [])

  const handleSetDropHint = useCallback((id: string, position: 'before' | 'after') => {
    setDropHint((prev) => {
      if (prev && prev.id === id && prev.position === position) return prev
      return { id, position }
    })
  }, [])

  const handleClearDropHint = useCallback(() => {
    setDropHint(null)
  }, [])

  const handleRenameDraftChange = useCallback((draft: string) => {
    setRenameDraft(draft)
  }, [])

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
      toast.error(`Couldn't use that folder: ${(err as Error).message}`)
    }
  }

  /** Pre-computed accent styles per session so SessionCard's React.memo
   *  sees stable references instead of new objects every render. */
  const accentStyleMap = useMemo(() => buildSessionAccentMap(sessionColors), [sessionColors])

  /** O(1) lookups for open-session state. */
  const openIdSet = useMemo(() => new Set(openIds), [openIds])
  const openIdSlotMap = useMemo(() => new Map(openIds.map((id, i) => [id, i])), [openIds])

  /** Stable callback for child components to request a confirmation dialog. */
  const handleAskConfirm = useCallback((config: {
    title: string
    message: React.ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  }) => {
    setConfirmState({
      title: config.title,
      message: config.message,
      confirmLabel: config.confirmLabel,
      destructive: config.destructive,
      onConfirm: async () => {
        setConfirmBusy(true)
        try {
          await config.onConfirm()
        } finally {
          setConfirmBusy(false)
          setConfirmState(null)
        }
      },
    })
  }, [])

  /** Render a SessionCard with all shared props pre-bound. Extracted from
   *  the 3 render sites (grouped, ungrouped-section, flat) to avoid
   *  duplicating 17+ props. */
  const renderCard = useCallback((s: SessionInfo, containerGroupId?: string) => (
    <SessionCard
      key={s.id}
      session={s}
      slotIdx={openIdSlotMap.get(s.id) ?? -1}
      isOpen={openIdSet.has(s.id)}
      isFocused={s.id === focusedId}
      isResuming={resumingIds?.has(s.id) ?? false}
      hasUnread={!!unread?.[s.id]}
      isDragging={draggingId === s.id}
      dropPosition={dropHint && dropHint.id === s.id ? dropHint.position : null}
      isRenaming={renamingId === s.id}
      accentStyle={accentStyleMap.get(s.id)}
      containerGroupId={containerGroupId}
      onSelect={onSelect}
      onDelete={onDelete}
      onContextMenu={handleCardContextMenu}
      onDragStart={handleCardDragStart}
      onDragEnd={handleCardDragEnd}
      onSetDropHint={handleSetDropHint}
      onClearDropHint={handleClearDropHint}
      onReorder={onReorder}
      onReorderInGroup={onReorderInGroup}
      renameDraft={renameDraft}
      onRenameDraftChange={handleRenameDraftChange}
      onCommitRename={commitRename}
      onCancelRename={cancelRename}
      onStartRename={startRename}
      onAskConfirm={handleAskConfirm}
    />
  ), [openIdSlotMap, openIdSet, focusedId, resumingIds, unread, draggingId, dropHint, renamingId, accentStyleMap, onSelect, onDelete, handleCardContextMenu, handleCardDragStart, handleCardDragEnd, handleSetDropHint, handleClearDropHint, onReorder, onReorderInGroup, renameDraft, handleRenameDraftChange, commitRename, cancelRename, startRename, handleAskConfirm])

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
                setGroupMenuTarget(g.id)
                setGroupMenuPos({ x: e.clientX, y: e.clientY })
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
                  if (name) {
                    groupCreatedViaEnterRef.current = true
                    onCreateGroup(name)
                  }
                  setNewGroupName('')
                  setShowNewGroupInput(false)
                } else if (e.key === 'Escape') {
                  setNewGroupName('')
                  setShowNewGroupInput(false)
                }
              }}
              onBlur={() => {
                // If Enter already created the group, skip the blur path
                // to avoid a duplicate creation (Enter unmounts the input,
                // which fires blur synchronously before React re-renders).
                if (groupCreatedViaEnterRef.current) {
                  groupCreatedViaEnterRef.current = false
                  return
                }
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
            if (sec.kind === 'group') {
              const collapsed = !!collapsedGroups[sec.group.id]
              const active = isGroupActive(sec.group)
              return (
                <div key={sec.group.id} className={`session-section ${active ? 'group-active' : ''}`}>
                  <div
                    className={`session-group-header ${groupDropHint === sec.group.id ? 'drop-target' : ''}`}
                    onClick={() => onActivateGroup(sec.group.id)}
                    title={`Activate ${sec.group.name} · ${sec.sessions.length} session${sec.sessions.length === 1 ? '' : 's'}`}
                    onDragOver={(e) => {
                      if (!onDropIntoGroup || !isInAppDrag(e)) return
                      // Don't accept drops if group is full (unless reordering within same group)
                      if (sec.group.sessionIds.length >= maxOpen && !sec.group.sessionIds.includes(draggingId ?? '')) return
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
                    <button
                      className="group-collapse-arrow"
                      onClick={(e) => { e.stopPropagation(); onToggleGroupCollapse(sec.group.id) }}
                      title={collapsed ? 'Expand group' : 'Collapse group'}
                    >
                      {collapsed ? '▶' : '▼'}
                    </button>
                    <span className="group-header-name">{sec.group.name}</span>
                    <span className="group-header-count">{sec.sessions.length}</span>
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
                        // Don't accept drops if group is full (unless reordering within same group)
                        if (sec.group.sessionIds.length >= maxOpen && !sec.group.sessionIds.includes(draggingId ?? '')) return
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
                      {sec.sessions.map((s) => renderCard(s, sec.group.id))}
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
            if (sec.kind === 'ungrouped') {
              return (
                <div key="ungrouped" className="session-section session-section-ungrouped">
                  <div className="session-section-header ungrouped-header">
                    <span className="ungrouped-header-icon">☐</span>
                    <span className="group-header-name">Ungrouped</span>
                    <span className="group-header-count">{sec.sessions.length}</span>
                  </div>
                  <div className="group-sessions">
                    {sec.sessions.map((s) => renderCard(s))}
                  </div>
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
            // ── Flat view (no groups) — virtualized ──
            <Virtuoso
              data={visibleSessions}
              style={{ flex: 1 }}
              itemContent={(_index, s) => renderCard(s)}
            />
          )}
      </div>

      {menu && <SessionContextMenu
        anchor={menu}
        session={sessions.find((s) => s.id === menu.id)}
        isOpen={openIdSet.has(menu.id)}
        onClose={() => setMenu(null)}
        onRename={(s) => startRename(s)}
        onClosePanel={(id) => onClosePanel?.(id)}
        onDelete={(id) => onDelete(id)}
        onFork={(id) => onFork?.(id)}
        onNewLikeThis={(id) => onNewLikeThis?.(id)}
        onRestart={(id) => onRestart?.(id)}
        sessionColor={sessionColors?.[menu.id]}
        onColorChange={(color) => onSessionColorChange?.(menu.id, color)}
        groups={groups}
        onAddToGroup={onAddToGroup}
        maxOpen={maxOpen}
        onShowSuccess={toast.success}
        onAskConfirm={handleAskConfirm}
      />}

      {showDialog && (
        <NewSessionDialog
          defaults={defaults}
          serverModels={serverModels}
          initialCwd={prefilledCwd}
          activeGroupId={activeGroupId}
          groups={groups}
          maxOpen={maxOpen}
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

      {/* Group pill context menu (replaces window.prompt) */}
      {groupMenuTarget && groupMenuPos && (() => {
        const g = groups.find((grp) => grp.id === groupMenuTarget)
        if (!g) return null
        return (
          <ContextMenu
            x={groupMenuPos.x}
            y={groupMenuPos.y}
            onClose={() => setGroupMenuTarget(null)}
            items={[
              {
                label: 'Rename group…',
                icon: '✎',
                onClick: () => {
                  setPromptState({
                    title: 'Rename group',
                    message: <p>Rename &ldquo;{g.name}&rdquo; to a new name.</p>,
                    defaultValue: g.name,
                    confirmLabel: 'Rename',
                    placeholder: 'Group name',
                    onConfirm: async (value) => {
                      onRenameGroup(g.id, value)
                      setPromptState(null)
                    },
                  })
                },
              },
              {
                label: 'Delete group',
                icon: '🗑',
                danger: true,
                onClick: () => {
                  setConfirmState({
                    title: 'Delete group?',
                    message: <p>Delete &ldquo;{g.name}&rdquo;? Sessions in this group will not be deleted.</p>,
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: async () => {
                      setConfirmBusy(true)
                      try {
                        onDeleteGroup(g.id)
                      } finally {
                        setConfirmBusy(false)
                        setConfirmState(null)
                      }
                    },
                  })
                },
              },
            ]}
          />
        )
      })()}

      {/* Confirm dialog (replaces window.confirm) */}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          destructive={confirmState.destructive}
          busy={confirmBusy}
          onConfirm={confirmState.onConfirm}
          onCancel={() => { if (!confirmBusy) setConfirmState(null) }}
        />
      )}

      {/* Prompt dialog (replaces window.prompt for group rename) */}
      {promptState && (
        <PromptDialog
          title={promptState.title}
          message={promptState.message}
          defaultValue={promptState.defaultValue}
          confirmLabel={promptState.confirmLabel}
          placeholder={promptState.placeholder}
          busy={promptBusy}
          onConfirm={(value) => {
            void (async () => {
              setPromptBusy(true)
              try {
                await promptState.onConfirm(value)
              } finally {
                setPromptBusy(false)
                setPromptState(null)
              }
            })()
          }}
          onCancel={() => { if (!promptBusy) setPromptState(null) }}
        />
      )}
    </>
  )
})
