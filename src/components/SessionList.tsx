// Left sidebar: "+ New session" button on top, full-height session list below.
// The new-session form lives inside a modal (<NewSessionDialog />) so the
// sidebar can dedicate its vertical space to listing sessions.

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { dndData, dndPayloadOf, pointerOnlyListeners } from '../dnd/payload'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { SORTABLE_TRANSITION } from '../dnd/motion'
import { prepareFlip } from '../utils/flip'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import { buildSessionAccentMap } from '../theme'
import { isAccentLocked, type Skin } from '../utils/theme'
import type { NewSessionForm, SessionGroup, SessionInfo, SidebarSection } from '../types'
import type { ModelGroupConfig } from '../types/config'
import { NewSessionDialog } from './session-list/NewSessionDialog'
import { SessionContextMenu } from './session-list/SessionContextMenu'
import { AccentPickerPanel } from './AccentPicker'
import { SessionCard } from './session-list/SessionCard'
import { ConfirmDialog } from './ConfirmDialog'
// Lazy-loaded: PromptDialog is only used when the user renames a group.
// Mirrors App.tsx's lazy declaration — keeping the static import here would
// pull PromptDialog into the main bundle and defeat the code-split (Vite
// emits a "dynamic import will not move module into another chunk" warning
// if a static import coexists with the lazy one in App.tsx).
const PromptDialog = lazy(() => import('./PromptDialog').then((m) => ({ default: m.PromptDialog })))
import { ContextMenu } from './ContextMenu'
import { IconX, IconChevronUp, IconChevronRight, IconChevronDown, IconSquare, IconPencil, IconTrash, IconSearch } from './icons/ToolIcons'
import { Skeleton } from './Skeleton'
import { Virtuoso } from 'react-virtuoso'
import { useExitPresence } from '../hooks/useExitPresence'
import { AnimatePresence } from 'motion/react'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { AnimatedCollapse } from './AnimatedCollapse'

/** Text filter shared by the flat and grouped sidebar views — a session
 *  matches when the query hits its title, cwd, or 8-char id prefix. */
function sessionMatchesFilter(s: SessionInfo, q: string): boolean {
  if (s.title && s.title.toLowerCase().includes(q)) return true
  if (s.cwd && s.cwd.toLowerCase().includes(q)) return true
  if (s.id.slice(0, 8).toLowerCase().includes(q)) return true
  return false
}

// ── dnd-kit building blocks ──────────────────────────────────────────────
// One DndContext lives at App level (a session card can travel between the
// sidebar and the main grid). The sidebar only mounts the sortable/droppable
// nodes and delegates all event resolution upward.

/** Generic sortable wrapper with a render-prop activator: the node carries
 *  the displacement transform, `listeners`/`setActivatorNodeRef` go wherever
 *  the drag handle is (a card's whole surface, a group header strip, a pill).
 *  Listeners only — dnd-kit's a11y attributes would add a second tab stop
 *  around controls that are already focusable, and keyboard reorder has
 *  context-menu / shortcut alternatives. */
function SortableNode({ id, data, disabled, className, style, nodeAttrs, extraDrop, children }: {
  id: string
  data: Record<string, unknown>
  disabled: boolean
  className?: string
  style?: CSSProperties
  /** Static DOM attributes (e.g. the FLIP markers prepareGroupFlip matches). */
  nodeAttrs?: Record<string, string>
  /** An additional always-independent droppable registered on the same node —
   *  the group section uses it so the header stays a "drop session into
   *  group" target even when the sortable itself is disabled (single group)
   *  and so the header can light its own drop ring. */
  extraDrop?: { id: string; data: Record<string, unknown>; disabled: boolean }
  children: (state: {
    isDragging: boolean
    /** True while the extraDrop droppable is the current collision winner. */
    isOverDrop: boolean
    setActivatorNodeRef: (el: HTMLElement | null) => void
    listeners: SyntheticListenerMap | undefined
  }) => ReactNode
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, data, disabled })
  const extra = useDroppable({
    id: extraDrop?.id ?? `idle-extra-${id}`,
    disabled: !extraDrop || extraDrop.disabled,
    data: extraDrop?.data,
  })
  // Strip the KeyboardSensor activator: none of these surfaces spread dnd-kit's
  // a11y attributes (they're already focusable controls with their own
  // Enter/Space semantics), so keyboard drag would only hijack activation.
  // Keyboard reorder lives in the context menu / Alt shortcuts.
  const activatorListeners = pointerOnlyListeners(listeners)
  return (
    <div
      ref={setNodeRef}
      {...nodeAttrs}
      className={className}
      style={{
        ...style,
        transform: DndCSS.Transform.toString(transform),
        // Inline transition ONLY while the item is being displaced — a
        // permanent inline transition would override the stylesheet
        // transitions (.deleting exit, hover states) at rest.
        transition: transform ? (transition ?? SORTABLE_TRANSITION) : undefined,
      }}
    >
      {children({ isDragging, isOverDrop: extraDrop ? extra.isOver : false, setActivatorNodeRef, listeners: activatorListeners })}
    </div>
  )
}

/** A group's session body — also the "drop session here" target when the
 *  pointer is over the body rather than a specific card (the dashed ring).
 *  Disabled while the group is full, unless the dragged card is a member. */
function GroupSessionBody({ group, maxGroupSize, sessions, renderCard, className, domId }: {
  group: SessionGroup
  maxGroupSize: number
  sessions: SessionInfo[]
  renderCard: (s: SessionInfo, containerGroupId?: string, isFirst?: boolean, isLast?: boolean, idx?: number) => ReactNode
  className?: string
  /** DOM id for the header's aria-controls (separate namespace from the
   *  dnd-kit droppable id). */
  domId?: string
}) {
  const dnd = useDndContext()
  const activePayload = dndPayloadOf(dnd.active?.data.current)
  const draggingCard = activePayload?.kind === 'sidebar-card' ? activePayload.id : null
  // The "drop session here" ring is for session cards only — a group-card or
  // panel-header drag crossing the body must never light it (nothing accepts
  // those here).
  const full = group.sessionIds.length >= maxGroupSize
  const acceptCard = !!draggingCard && (!full || group.sessionIds.includes(draggingCard))
  const { setNodeRef, isOver } = useDroppable({
    id: `group-body-${group.id}`,
    disabled: !acceptCard,
    data: dndData({ kind: 'group-card', id: group.id }),
  })
  return (
    <div
      id={domId}
      ref={setNodeRef}
      className={`${className ?? 'group-sessions'}${isOver ? ' drop-target' : ''}`}
    >
      <SortableContext items={sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        {sessions.map((s, i) => renderCard(s, group.id, false, i === sessions.length - 1, i))}
      </SortableContext>
    </div>
  )
}

interface Props {
  sessions: SessionInfo[]
  /** False until the first WS sessions-snapshot lands. Drives the sidebar
   *  skeleton so "No sessions yet" doesn't flash during initial load. */
  sessionsLoaded?: boolean
  /** All sessions currently open in the chat grid (0-maxOpen). Any item whose
   *  id is in here is rendered as "open" in the sidebar (distinct from
   *  "focused" — the single panel receiving keyboard input). */
  openIds: string[]
  /** The id of the focused panel, or null. Gets the strongest highlight. */
  focusedId: string | null
  defaults: { cwd?: string; model?: string }
  /** Server-configured model list (from /api/config). Shown first in the
   *  new-session dialog's Model picker so the user always has a baseline. */
  serverModels?: string[]
  /** Model Groups from the same /config snapshot as `serverModels`. */
  modelGroups?: ModelGroupConfig[]
  /** Ids currently being resumed — item is disabled while the POST is in flight. */
  resumingIds?: Set<string>
  /** Map of sessionId → true when the session has a newer lastTurnAt than
   *  the user has seen (and isn't currently open). */
  unread?: Record<string, boolean>
  /** Ids playing the local delete-exit animation while the server DELETE is
   *  in flight. */
  deletingIds?: Set<string>
  onSelect: (id: string) => void
  onCreate: (form: NewSessionForm) => void
  /** Global first-party tool defaults (server config map) — forwarded to
   *  <NewSessionDialog> so the create form can offer per-server checkboxes
   *  pre-checked from the global default. */
  firstPartyTools?: Record<string, { enabled: boolean }>
  onDelete: (id: string) => void
  /** Put a live, idle session into dormant state (release the SDK
   *  subprocess) without deleting it. Reversible via resume. */
  onSleep: (id: string) => void
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
  /** Drag-and-drop reorder of the `groups` array. Drag surface = section
   *  headers (vertical) + top pills (horizontal). Position is relative to
   *  the target group. */
  onReorderGroups?: (draggedId: string, targetId: string, position: 'before' | 'after') => void
  /** Keyboard / context-menu fallback — swap a group with its neighbour. */
  onMoveGroup?: (groupId: string, direction: 'up' | 'down') => void
  /** New-session dialog open state is lifted so App-level shortcuts
   *  (Alt+N) can open it. Uncontrolled mode falls back to internal state. */
  newSessionDialogOpen?: boolean
  onNewSessionDialogChange?: (open: boolean) => void
  /** Per-session accent-colour overrides (sessionId → hex). */
  sessionColors?: Record<string, string>
  /** Set or clear a session's accent colour. Pass `undefined` to reset. */
  onSessionColorChange?: (sessionId: string, color: string | undefined) => void
  /** Active skin. Accent-locking skins (Anthropic / HC) hide the per-session
   *  accent picker and suppress per-session tinting so the brand accent
   *  applies uniformly. */
  skin?: Skin
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
  /** Per-group capacity (App's `maxGroupSize`). This is the number of sessions
   *  allowed in a group — NOT squeezed to 1 on mobile the way panel count is,
   *  so it's the correct threshold for deciding whether a group is full. */
  maxGroupSize: number
  /** On mobile only one panel shows at a time, so "activating" a group (a
   *  panel-swap affordance) is meaningless. When true, group headers toggle
   *  collapse instead, and the group-pills quick-switch row is hidden. */
  isMobile?: boolean
  /** True while Alt is held — renders a number badge on each group pill
   *  (first 9 groups) so the alt+<n> shortcut mapping is discoverable. */
  showGroupHints?: boolean
}

export const SessionList = memo(function SessionList({
  sessions,
  sessionsLoaded,
  openIds,
  focusedId,
  defaults,
  serverModels,
  modelGroups,
  resumingIds,
  unread,
  deletingIds,
  sessionColors,
  onSessionColorChange,
  skin,
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
  firstPartyTools,
  onDelete,
  onSleep,
  onClosePanel,
  onFork,
  onNewLikeThis,
  onRestart,
  onReorder,
  onDropIntoGroup,
  onReorderInGroup,
  onReorderGroups,
  onMoveGroup,
  newSessionDialogOpen,
  onNewSessionDialogChange,
  activeGroupId,
  maxGroupSize,
  isMobile,
  showGroupHints,
}: Props) {
  const [uncontrolledShow, setUncontrolledShow] = useState(false)
  const showDialog = newSessionDialogOpen ?? uncontrolledShow
  const newSessionPresence = useExitPresence(showDialog)
  const setShowDialog = (v: boolean) => {
    if (onNewSessionDialogChange) onNewSessionDialogChange(v)
    else setUncontrolledShow(v)
  }
  /** Which card is currently in inline-rename mode, and the draft text. */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** Active right-click menu. `id` tells us which session it targets. */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  /** Accent-colour popover opened from the context menu. Owns its own
   *  anchor (the menu's coordinates, captured before the menu closes) so
   *  the unified AccentPickerPanel can render at the right spot. */
  const [accentPopover, setAccentPopover] = useState<{ x: number; y: number; id: string } | null>(null)
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
  // One-shot entrance stagger: the sidebar's session cards fade+rise in a
  // cascade for the short window after the list actually populates, then the
  // session-entering class drops so Virtuoso's scroll re-mounts (and any
  // later re-render) never replay it.
  const [entered, setEntered] = useState(false)
  // Start the window only once cards are present (not at mount — a slow load
  // shows the skeleton, and flipping `entered` under it would skip the
  // cascade). Window = STAGGER_MS + the moderate 180ms animation, so even the
  // last staggered card's animation finishes inside the armed window.
  const ENTRANCE_WINDOW_MS = 650
  useEffect(() => {
    if (entered || sessions.length === 0) return
    const id = setTimeout(() => setEntered(true), ENTRANCE_WINDOW_MS)
    return () => clearTimeout(id)
  }, [entered, sessions.length])
  // Overlay scrollbar: covers the grouped view (.session-list scrolls
  // natively) and the flat view (Virtuoso's internal scroller). Only the
  // axis that actually overflows shows a thumb, so wiring both is safe.
  const setListScroller = useOverlayScrollbar({ autoHide: 'leave' })
  const setVirtuosoScroller = useOverlayScrollbar({ autoHide: 'leave' })
  // Virtuoso's scrollerRef passes Window | HTMLElement | null; narrow to
  // HTMLElement for the overlay hook (Virtuoso's internal scroller is always
  // an element in practice).
  const virtuosoScrollerRef = useCallback((ref: Window | HTMLElement | null) => {
    setVirtuosoScroller(ref instanceof HTMLElement ? ref : null)
  }, [setVirtuosoScroller])
  // Guard against double-creation when Enter triggers both the keyDown
  // handler and the subsequent blur (from DOM removal).
  const groupCreatedViaEnterRef = useRef(false)
  const visibleSessions = useMemo<SessionInfo[]>(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => sessionMatchesFilter(s, q))
  }, [sessions, filter])

  /** Filtered version of sidebarSections — applies the same text filter
   *  to each section's session list so the grouped view respects the
   *  filter input. Empty group sections are preserved (so a user can still
   *  see/manage an empty group) UNLESS the filter is active and the
   *  section has no matches — in that case dropping it keeps the result
   *  focused on what the user typed. The Ungrouped section is dropped
   *  when it has no matches in either mode (a header with zero items
   *  there is noise, not affordance). */
  const filteredSections = useMemo<SidebarSection[]>(() => {
    if (sidebarSections.length === 0) return []
    const q = filter.trim().toLowerCase()
    const filtering = q.length > 0
    const match = (s: SessionInfo) => (!q ? true : sessionMatchesFilter(s, q))
    const result: SidebarSection[] = []
    for (const sec of sidebarSections) {
      const filtered = sec.sessions.filter(match)
      if (sec.kind === 'group') {
        // Keep empty groups when no filter is active — they're a target
        // for drag-and-drop and an entry point for "Delete group". When
        // filtering, only keep groups whose members matched.
        if (filtering && filtered.length === 0) continue
        result.push({ kind: 'group', group: sec.group, sessions: filtered })
      } else if (sec.kind === 'ungrouped') {
        if (filtered.length === 0) continue
        result.push({ kind: 'ungrouped', sessions: filtered })
      }
    }
    return result
  }, [sidebarSections, filter])

  /** Capture the current sidebar card positions and return a function that
   *  animates any moved cards after React applies a reorder — the classic
   *  FLIP pattern (see `src/utils/flip.ts`). Used by both drag/drop reorder
   *  and keyboard/context-menu moves; the shared util keeps the curve and
   *  reduced-motion gate identical to the group reorder. */
  const prepareMoveAnimation = useCallback(
    () => prepareFlip('[data-session-card-id]', 'data-session-card-id'),
    [],
  )

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

  // Drag/reorder now flows through the App-level DndContext (dnd-kit):
  // sortable nodes here only report geometry, and the live/cross-container
  // moves are resolved there. The FLIP wrappers below still serve the
  // keyboard/context-menu reorder paths.

  const handleRenameDraftChange = useCallback((draft: string) => {
    setRenameDraft(draft)
  }, [])

  const startRename = useCallback((s: SessionInfo) => {
    setRenamingId(s.id)
    setRenameDraft(s.title ?? '')
  }, [])

  const commitRename = useCallback(async (id: string, title: string) => {
    setRenamingId(null)
    // The server broadcasts the updated session via WebSocket, so we
    // don't need to update local state here. If the request fails the
    // card simply keeps its old title.
    try {
      await api.patch<{ session: SessionInfo }>(`/sessions/${id}`, { title })
    } catch (err) {
      console.warn('rename failed:', (err as Error).message)
    }
  }, [])

  const cancelRename = useCallback(() => setRenamingId(null), [])

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
   *  sees stable references instead of new objects every render. Pass
   *  `skin` so an accent-locking skin yields no per-session overrides. */
  const accentStyleMap = useMemo(() => buildSessionAccentMap(sessionColors, skin), [sessionColors, skin])

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

  /** Wrapped cross-section move (context-menu "Move to group" / "Remove from
   *  group"; the drag-drop path is resolved by App's DndContext). Without
   *  FLIP the row teleports to its new section the instant `groups` state
   *  flips — using the same animation as keyboard reorder keeps the
   *  motion language consistent. */
  const animatedAddToGroup = useCallback(
    (sessionId: string, groupId: string) => {
      const animateMove = prepareMoveAnimation()
      ;(onDropIntoGroup ?? onAddToGroup)(sessionId, groupId)
      animateMove()
    },
    [onDropIntoGroup, onAddToGroup, prepareMoveAnimation],
  )

  /** Render a SessionCard with all shared props pre-bound. Extracted from
   *  the 3 render sites (grouped, ungrouped-section, flat) to avoid
   *  duplicating 17+ props. The shell div is the dnd-kit sortable node; the
   *  drag activator is the card surface itself (dragListeners spread on the
   *  card root, before its own handlers so selection keys win). */
  const renderCard = useCallback(
    (s: SessionInfo, containerGroupId?: string, isFirst = false, isLast = false, idx = 0) => {
      const isDeleting = deletingIds?.has(s.id) ?? false
      const isResuming = resumingIds?.has(s.id) ?? false
      const sortableDisabled = isMobile || isResuming || isDeleting || (!onReorder && !onReorderInGroup)
      return (
        <SortableNode
          key={s.id}
          id={s.id}
          data={dndData({ kind: 'sidebar-card', id: s.id }, { containerGroupId })}
          disabled={sortableDisabled}
          className={`session-item-shell${isDeleting ? ' deleting' : ''}${isFirst ? ' list-first' : ''}${isLast ? ' list-last' : ''}${s.id === focusedId ? ' focused' : ''}`}
          style={{ '--stagger': `${Math.min(idx, 12) * 30}ms` } as CSSProperties}
          nodeAttrs={{ 'data-session-card-id': s.id }}
        >
          {({ isDragging, listeners }) => (
            <SessionCard
              session={s}
              slotIdx={openIdSlotMap.get(s.id) ?? -1}
              isOpen={openIdSet.has(s.id)}
              isFocused={s.id === focusedId}
              isResuming={isResuming}
              hasUnread={!!unread?.[s.id]}
              isDragging={isDragging}
              isDeleting={isDeleting}
              isRenaming={renamingId === s.id}
              accentStyle={accentStyleMap.get(s.id)}
              dragListeners={listeners}
              onSelect={onSelect}
              onDelete={onDelete}
              onSleep={onSleep}
              onContextMenu={handleCardContextMenu}
              renameDraft={renameDraft}
              onRenameDraftChange={handleRenameDraftChange}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              onStartRename={startRename}
              onAskConfirm={handleAskConfirm}
            />
          )}
        </SortableNode>
      )
    },
    [isMobile, openIdSlotMap, openIdSet, focusedId, resumingIds, unread, deletingIds, renamingId, accentStyleMap, onSelect, onDelete, onSleep, handleCardContextMenu, onReorder, onReorderInGroup, renameDraft, handleRenameDraftChange, commitRename, cancelRename, startRename, handleAskConfirm],
  )

  /** Resolve which ordered list a session belongs to and, when it lives in
   *  a group, that group's id. The flat view orders `visibleSessions`; the
   *  grouped view splits across sections. Returns the sibling list (in
   *  display order) plus the containing groupId (undefined for the flat
   *  view or the Ungrouped section). */
  const resolveSiblings = useCallback(
    (id: string): { list: SessionInfo[]; groupId?: string } | null => {
      if (filteredSections.length > 0) {
        for (const sec of filteredSections) {
          if (sec.sessions.some((s) => s.id === id)) {
            return {
              list: sec.sessions,
              groupId: sec.kind === 'group' ? sec.group.id : undefined,
            }
          }
        }
        return null
      }
      return visibleSessions.some((s) => s.id === id) ? { list: visibleSessions } : null
    },
    [filteredSections, visibleSessions],
  )

  /** Keyboard-accessible reorder. Moves `id` one step up/down within its
   *  current section by delegating to the same handlers drag-and-drop uses
   *  — so the two paths stay behaviourally identical. */
  const handleMove = useCallback(
    (id: string, direction: 'up' | 'down') => {
      const sib = resolveSiblings(id)
      if (!sib) return
      const idx = sib.list.findIndex((s) => s.id === id)
      if (idx < 0) return
      if (direction === 'up') {
        if (idx === 0) return
        const animateMove = prepareMoveAnimation()
        const target = sib.list[idx - 1]
        if (sib.groupId && onReorderInGroup) onReorderInGroup(id, target.id, 'before', sib.groupId)
        else onReorder?.(id, target.id, 'before')
        animateMove()
      } else {
        if (idx >= sib.list.length - 1) return
        const animateMove = prepareMoveAnimation()
        const target = sib.list[idx + 1]
        if (sib.groupId && onReorderInGroup) onReorderInGroup(id, target.id, 'after', sib.groupId)
        else onReorder?.(id, target.id, 'after')
        animateMove()
      }
    },
    [resolveSiblings, onReorder, onReorderInGroup, prepareMoveAnimation],
  )

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
        {/* Filter input: visible only when there are at least a handful
            of sessions. Keep it mounted so threshold changes animate instead
            of snapping in/out. */}
        <div className={`session-filter${sessions.length > 3 || filter ? '' : ' collapsed'}`}>
          <span className="session-filter-icon" aria-hidden>
            <IconSearch size={13} />
          </span>
          <input
            className="input"
            type="text"
            aria-label="Filter sessions"
            placeholder="Filter by title / cwd / id..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            tabIndex={sessions.length > 3 || filter ? 0 : -1}
          />
          {filter && (
            <button
              type="button"
              className="session-filter-clear"
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              title="Clear"
            >
              <IconX size={12} />
            </button>
          )}
        </div>
        {/* Group pills — horizontal row of clickable group chips. These are a
            quick "swap the whole panel set to this group" affordance, which is
            meaningless on mobile (single panel), so the chips are hidden there.
            The "+ Group" create control stays available on all viewports; the
            groups themselves remain visible as collapsible sections below. */}
        <div className="group-pills">
          {!isMobile && (
            <SortableContext items={groups.map((g) => `pill-${g.id}`)} strategy={horizontalListSortingStrategy}>
            {groups.map((g, i) => (
              <SortableNode
                key={g.id}
                // Distinct node id from the group section (same App-level
                // DndContext registers both; the registry is keyed by id).
                // The payload id stays `g.id` — that's what the reorder
                // handlers act on.
                id={`pill-${g.id}`}
                data={dndData({ kind: 'group-card', id: g.id }, { axis: 'x' })}
                disabled={isMobile || !onReorderGroups || groups.length <= 1}
              >
                {({ isDragging, setActivatorNodeRef, listeners }) => (
                  <button
                    ref={setActivatorNodeRef}
                    type="button"
                    data-group-pill-id={g.id}
                    className={`group-pill ${g.id === activeGroupId ? 'active' : ''} ${
                      isDragging ? 'dragging' : ''
                    }`}
                    aria-pressed={g.id === activeGroupId}
                    title={`Activate "${g.name}" (${g.sessionIds.length} sessions)${i < 9 ? ` · Alt+${i + 1}` : ''} · right-click for options · drag to reorder`}
                    {...listeners}
                    onClick={() => onActivateGroup(g.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setGroupMenuTarget(g.id)
                      setGroupMenuPos({ x: e.clientX, y: e.clientY })
                    }}
                  >
                    {showGroupHints && i < 9 && (
                      <span className="group-pill-hint" aria-hidden="true">{i + 1}</span>
                    )}
                    {g.name}
                    <span className="group-pill-count">{g.sessionIds.length}</span>
                  </button>
                )}
              </SortableNode>
            ))}
            </SortableContext>
          )}
          {showNewGroupInput ? (
            <input
              ref={newGroupInputRef}
              className="group-pill-input"
              aria-label="New group name"
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
                  // stopPropagation: this press cancels the new-group input,
                  // it must not keep bubbling to App's escape chain —
                  // idle-Esc now opens the resume picker (escapeAction).
                  e.stopPropagation()
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
      <div className={`session-list${entered ? '' : ' session-entering'}`} ref={setListScroller}>
          {sessions.length === 0 ? (
            sessionsLoaded === false ? (
              <Skeleton rows={5} className="sidebar-skeleton" />
            ) : (
              <div className="sidebar-empty-note">
                No sessions yet.
              </div>
            )
          ) : filteredSections.length > 0 ? (
          // ── Sectioned view (groups exist). One SortableContext over all
          // group sections: useSortable needs it to resolve an item's index
          // (without it sections never compute displacement transforms). The
          // Ungrouped section isn't a sortable member — its cards have their
          // own context below.
          <SortableContext items={filteredSections.filter((s) => s.kind === 'group').map((s) => s.group.id)} strategy={verticalListSortingStrategy}>
          {filteredSections.map((sec) => {
            if (sec.kind === 'group') {
              const collapsed = !!collapsedGroups[sec.group.id]
              const active = isGroupActive(sec.group)
              // Aggregate badges for the collapsed header so a user who has
              // hidden a group still sees something is happening inside it.
              // Unread is "session has a newer turn than user has seen AND
              // isn't currently open"; pending counts permission/question
              // requests waiting for the user. Both are per-session
              // signals — we sum across the group's sessions only when
              // collapsed (when expanded each card carries its own).
              let groupUnread = 0
              let groupPending = 0
              if (collapsed) {
                for (const s of sec.sessions) {
                  if (unread?.[s.id]) groupUnread += 1
                  groupPending += s.pendingPermissionCount ?? 0
                }
              }
              const groupBodyId = `group-body-${sec.group.id}`
              return (
                // The whole section is the sortable node (live-displaces when
                // groups reorder); the header strip is the drag activator.
                // Dropping a session card on the header or body moves it into
                // the group — resolved by App's DndContext onDragEnd (the
                // payload kind of the section node is `group-card`).
                <SortableNode
                  key={sec.group.id}
                  id={sec.group.id}
                  data={dndData({ kind: 'group-card', id: sec.group.id }, { axis: 'y' })}
                  disabled={!onReorderGroups || isMobile || groups.length <= 1}
                  className={`session-section ${active ? 'group-active' : ''}`}
                  nodeAttrs={{ 'data-group-section-id': sec.group.id }}
                  extraDrop={{
                    // Independent drop target for "move a session card into
                    // this group" — must stay enabled even when the section
                    // sortable is disabled (single group), and it drives the
                    // header's drop ring.
                    id: `group-head-${sec.group.id}`,
                    data: dndData({ kind: 'group-card', id: sec.group.id }),
                    disabled: isMobile || !onDropIntoGroup,
                  }}
                >
                  {({ isDragging: groupDragging, isOverDrop, setActivatorNodeRef, listeners }) => (
                    <>
                  <div
                    ref={setActivatorNodeRef}
                    className={`session-group-header list-first${collapsed || sec.sessions.length === 0 ? ' list-last' : ''} ${
                      groupDragging ? 'dragging' : ''
                    } ${
                      isOverDrop ? 'drop-target' : ''
                    }`}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      isMobile
                        ? `${collapsed ? 'Expand' : 'Collapse'} group ${sec.group.name}`
                        : `Activate group ${sec.group.name}`
                    }
                    {...listeners}
                    aria-controls={groupBodyId}
                    // On mobile a single panel is shown, so "activating" a group
                    // (swapping the whole panel set) is meaningless — the header
                    // toggles collapse instead, and sessions are opened by tapping
                    // the cards inside. On desktop it activates the group as usual.
                    onClick={() =>
                      isMobile
                        ? onToggleGroupCollapse(sec.group.id)
                        : onActivateGroup(sec.group.id)
                    }
                    onKeyDown={(e) => {
                      // Native button semantics: Space + Enter activate (or,
                      // on mobile, toggle collapse — see onClick above).
                      // We don't intercept Tab/Shift+Tab so focus order
                      // stays natural (header → collapse arrow → cards).
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (isMobile) onToggleGroupCollapse(sec.group.id)
                        else onActivateGroup(sec.group.id)
                      }
                    }}
                    title={
                      isMobile
                        ? `${collapsed ? 'Expand' : 'Collapse'} ${sec.group.name} · ${sec.sessions.length} session${sec.sessions.length === 1 ? '' : 's'}`
                        : `Activate ${sec.group.name} · ${sec.sessions.length} session${sec.sessions.length === 1 ? '' : 's'}`
                    }
                  >
                    <button
                      className="group-collapse-arrow"
                      onClick={(e) => { e.stopPropagation(); onToggleGroupCollapse(sec.group.id) }}
                      onKeyDown={(e) => {
                        // Stop Enter/Space from bubbling to the parent
                        // header (which would re-activate the group). The
                        // arrow toggles collapse only.
                        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                      }}
                      title={collapsed ? 'Expand group' : 'Collapse group'}
                      aria-expanded={!collapsed}
                      aria-controls={groupBodyId}
                      aria-label={collapsed ? `Expand group ${sec.group.name}` : `Collapse group ${sec.group.name}`}
                    >
                      {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                    </button>
                    <span className="group-header-name">{sec.group.name}</span>
                    <span className="group-header-count">{sec.sessions.length}</span>
                    {collapsed && groupPending > 0 && (
                      <span
                        className="group-header-badge group-header-badge-pending"
                        title={`${groupPending} pending permission${groupPending === 1 ? '' : 's'} inside ${sec.group.name}`}
                        aria-label={`${groupPending} pending permission${groupPending === 1 ? '' : 's'}`}
                      >
                        {groupPending}
                      </span>
                    )}
                    {collapsed && groupUnread > 0 && (
                      <span
                        className="group-header-badge group-header-badge-unread"
                        title={`${groupUnread} session${groupUnread === 1 ? ' has' : 's have'} unread updates`}
                        aria-label={`${groupUnread} unread`}
                      >
                        {groupUnread}
                      </span>
                    )}
                  </div>
                  <AnimatedCollapse open={!collapsed} className="session-group-collapse">
                    {sec.sessions.length > 0 ? (
                      <GroupSessionBody
                        group={sec.group}
                        maxGroupSize={maxGroupSize}
                        sessions={sec.sessions}
                        renderCard={renderCard}
                        domId={groupBodyId}
                      />
                    ) : null}
                  </AnimatedCollapse>
                    </>
                  )}
                </SortableNode>
              )
            }
            if (sec.kind === 'ungrouped') {
              return (
                <div key="ungrouped" className="session-section session-section-ungrouped">
                  <div className="session-section-header ungrouped-header">
                    <span className="ungrouped-header-icon"><IconSquare size={12} /></span>
                    <span className="group-header-name">Ungrouped</span>
                    <span className="group-header-count">{sec.sessions.length}</span>
                  </div>
                  <div className="group-sessions">
                    <SortableContext items={sec.sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                      {sec.sessions.map((s, i) =>
                        renderCard(s, undefined, i === 0, i === sec.sessions.length - 1, i),
                      )}
                    </SortableContext>
                  </div>
                </div>
              )
            }
            return null
          })}
          </SortableContext>
          ) : visibleSessions.length === 0 ? (
            <div className="sidebar-empty-note">
              No sessions match "{filter}".
            </div>
          ) : (
            // ── Flat view (no groups) — virtualized. SortableContext wraps
            // the list so cards reorder live; only rendered items register
            // as droppables, which is fine for pointer-driven drags.
            <SortableContext items={visibleSessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <Virtuoso
                data={visibleSessions}
                style={{ flex: 1 }}
                scrollerRef={virtuosoScrollerRef}
                itemContent={(index, s) =>
                  renderCard(s, undefined, index === 0, index === visibleSessions.length - 1, index)
                }
              />
            </SortableContext>
          )}
      </div>

      {menu && (() => {
        const sib = resolveSiblings(menu.id)
        const idx = sib ? sib.list.findIndex((s) => s.id === menu.id) : -1
        const canMoveUp = !!onReorder && idx > 0
        const canMoveDown = !!onReorder && idx >= 0 && idx < (sib?.list.length ?? 0) - 1
        return <SessionContextMenu
        anchor={menu}
        session={sessions.find((s) => s.id === menu.id)}
        isOpen={openIdSet.has(menu.id)}
        onClose={() => setMenu(null)}
        onRename={(s) => startRename(s)}
        onClosePanel={(id) => onClosePanel?.(id)}
        onDelete={(id) => onDelete(id)}
        onSleep={(id) => onSleep(id)}
        onMove={handleMove}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onFork={(id) => onFork?.(id)}
        onNewLikeThis={(id) => onNewLikeThis?.(id)}
        onRestart={(id) => onRestart?.(id)}
        sessionColor={sessionColors?.[menu.id]}
        onEditAccent={() => setAccentPopover({ x: menu.x, y: menu.y, id: menu.id })}
        accentLocked={isAccentLocked(skin)}
        groups={groups}
        onAddToGroup={animatedAddToGroup}
        maxGroupSize={maxGroupSize}
        onShowSuccess={toast.success}
        onAskConfirm={handleAskConfirm}
      />
      })()}

      {accentPopover && !isAccentLocked(skin) && (
        <AccentPickerPanel
          x={accentPopover.x}
          y={accentPopover.y}
          value={sessionColors?.[accentPopover.id]}
          allowDefault
          ariaLabel="Session accent"
          onChange={(v) => onSessionColorChange?.(accentPopover.id, v)}
          onClose={() => setAccentPopover(null)}
        />
      )}

      {newSessionPresence.shouldRender && (
        <NewSessionDialog
          open={showDialog}
          defaults={defaults}
          serverModels={serverModels}
          modelGroups={modelGroups}
          initialCwd={prefilledCwd}
          initialGroupId={activeGroupId ?? undefined}
          groups={groups}
          maxGroupSize={maxGroupSize}
          accentLocked={isAccentLocked(skin)}
          firstPartyTools={firstPartyTools}
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
        const groupIdx = groups.findIndex((grp) => grp.id === g.id)
        const groupCanMoveUp = groupIdx > 0
        const groupCanMoveDown = groupIdx >= 0 && groupIdx < groups.length - 1
        return (
          <ContextMenu
            x={groupMenuPos.x}
            y={groupMenuPos.y}
            onClose={() => setGroupMenuTarget(null)}
            items={[
              {
                label: 'Move up',
                icon: <IconChevronUp size={14} />,
                disabled: !groupCanMoveUp,
                onClick: () => onMoveGroup?.(g.id, 'up'),
              },
              {
                label: 'Move down',
                icon: <IconChevronDown size={14} />,
                disabled: !groupCanMoveDown,
                onClick: () => onMoveGroup?.(g.id, 'down'),
              },
              { label: '' }, // separator (ContextMenu trims/merges)
              {
                label: 'Rename group…',
                icon: <IconPencil size={14} />,
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
                icon: <IconTrash size={14} />,
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
      <AnimatePresence>
        {confirmState && (
          <ConfirmDialog
            key="confirm"
            title={confirmState.title}
            message={confirmState.message}
            confirmLabel={confirmState.confirmLabel}
            destructive={confirmState.destructive}
            busy={confirmBusy}
            onConfirm={confirmState.onConfirm}
            onCancel={() => { if (!confirmBusy) setConfirmState(null) }}
          />
        )}
      </AnimatePresence>

      {/* Prompt dialog (replaces window.prompt for group rename) */}
      <AnimatePresence>
        {promptState && (
          <Suspense fallback={null}>
            <PromptDialog
              key="prompt"
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
          </Suspense>
        )}
      </AnimatePresence>
    </>
  )
})
