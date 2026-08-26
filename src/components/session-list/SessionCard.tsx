// Individual session card in the sidebar. Extracted from SessionList so it
// can be wrapped in React.memo — prevents the entire list from re-rendering
// when only a single card's props change (e.g. a session's `working` flag
// flips during streaming).

import { memo, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { isInAppDrag, readDragPayload, setDragPayload } from '../../hooks/useDragPayload'
import { useIsMobile } from '../../hooks/useIsMobile'
import { shortenPath } from '../../utils/paths'
import { statusLabel } from '../../utils/session-status'
import type { SessionInfo } from '../../types'
import { Tooltip } from '../Tooltip'
import { IconX, IconFolder, IconAlertTriangle, IconMoon } from '../icons/ToolIcons'
import { PermissionModeIcon, permissionModeLabel } from '../permission-mode-display'

export interface SessionCardProps {
  session: SessionInfo
  slotIdx: number
  isOpen: boolean
  isFocused: boolean
  isResuming: boolean
  hasUnread: boolean
  /** True when this card is the one being dragged. Fades the card out. */
  isDragging: boolean
  /** True while the delete-exit animation is playing. */
  isDeleting: boolean
  /** Insertion-line hint when another card is dragged over this one. */
  dropPosition: 'before' | 'after' | null
  /** True when this card's inline rename input is active. */
  isRenaming: boolean
  /** Pre-computed accent-colour CSS overrides, or undefined for global accent. */
  accentStyle?: CSSProperties
  /** When rendered inside a group body, the group's id so intra-group
   *  reordering uses the correct handler. */
  containerGroupId?: string

  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** Put a live, idle session into dormant state (release the SDK
   *  subprocess) without deleting it. Reversible via resume. */
  onSleep: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragEnd: () => void
  onSetDropHint: (id: string, position: 'before' | 'after') => void
  onClearDropHint: () => void
  onReorder?: (draggedId: string, targetId: string, position: 'before' | 'after') => void
  onReorderInGroup?: (
    draggedId: string,
    targetId: string,
    position: 'before' | 'after',
    groupId: string,
  ) => void

  /** Rename callbacks. The draft state and input ref live in SessionList
   *  so that only the currently-renaming card pays the cost. */
  renameDraft: string
  onRenameDraftChange: (draft: string) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
  onStartRename: (session: SessionInfo) => void
  /** Trigger a custom confirmation dialog instead of window.confirm. */
  onAskConfirm?: (config: {
    title: string
    message: React.ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  }) => void
}

export const SessionCard = memo(function SessionCard({
  session: s,
  slotIdx,
  isOpen,
  isFocused,
  isResuming,
  hasUnread,
  isDragging,
  isDeleting,
  dropPosition,
  isRenaming,
  accentStyle,
  containerGroupId,
  onSelect,
  onDelete,
  onSleep,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onSetDropHint,
  onClearDropHint,
  onReorder,
  onReorderInGroup,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onStartRename,
  onAskConfirm,
}: SessionCardProps) {
  const renameInputRef = useRef<HTMLInputElement>(null)
  // HTML5 drag-and-drop is effectively unsupported on touch (iOS Safari in
  // particular), so disable card reordering on mobile.
  const isMobile = useIsMobile()

  // Auto-focus + select the inline rename input when it appears.
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  const dormant = !s.running && !s.terminated
  const working = s.running && s.working
  // A running session whose parent turn has COMPLETED but which still has
  // background (async) subagents in flight — the parent acked the launch,
  // the main turn ended, but the subagent keeps producing until a
  // task_notification lands. Show a distinct 'waiting' state instead of a
  // plain green 'live' so the sidebar doesn't imply the session is idle.
  const waiting = s.running && !s.working && (s.backgroundSubagentCount ?? 0) > 0
  const pendingCount = s.pendingPermissionCount ?? 0
  // Single source of truth for the status chip — drives the dot colour,
  // the short label, and the aria-label. A dormant session (!running &&
  // !terminated) shows 'dormant' even when it carries a stale error (e.g. a
  // spawn_failed whose binary is now fixed) — it's resumable, not dead, and
  // the card body already renders `s.error` below. 'err' is reserved for a
  // RUNNING session that has nonetheless errored.
  const status: 'err' | 'ended' | 'resuming' | 'working' | 'waiting' | 'live' | 'dormant' =
    s.terminated ? 'ended' : isResuming ? 'resuming' : working ? 'working' : waiting ? 'waiting' : s.running ? (s.error ? 'err' : 'live') : 'dormant'
  const statusText: Record<typeof status, string> = {
    err: 'err',
    ended: 'ended',
    resuming: 'resuming…',
    working: 'working',
    waiting: 'waiting',
    live: 'live',
    dormant: 'dormant',
  }
  const statusAria: Record<typeof status, string> = {
    err: 'error',
    ended: 'ended',
    resuming: 'resuming',
    working: 'working',
    waiting: 'waiting on background subagent',
    live: 'live',
    dormant: 'dormant',
  }
  const permissionMode = s.permissionMode ?? 'default'

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e, s.id)
      }}
      className={[
        'session-item',
        isFocused ? 'focused' : '',
        isOpen && !isFocused ? 'open' : '',
        s.terminated ? 'terminated' : '',
        dormant ? 'dormant' : '',
        isResuming ? 'resuming' : '',
        // Unread only surfaces on OPEN sessions (folded into the slot badge).
        // Closed sessions carry no unread signal at all — nobody's watching
        // them. Gate the .unread class so even the title-brighten is skipped.
        (hasUnread && isOpen) ? 'unread' : '',
        isDragging ? 'dragging' : '',
        isDeleting ? 'deleting' : '',
        dropPosition === 'before' ? 'drop-before' : '',
        dropPosition === 'after' ? 'drop-after' : '',
        accentStyle ? 'tinted' : '',
        `mode-${permissionMode}`,
      ].filter(Boolean).join(' ')}
      style={accentStyle}
      role="button"
      tabIndex={0}
      aria-disabled={isResuming || isDeleting}
      draggable={!isMobile && !isResuming && !isDeleting && !!onReorder}
      onDragStart={(e) => {
        if (!onReorder) return
        onDragStart(e, s.id)
        setDragPayload(e, { kind: 'sidebar-card', id: s.id })
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!onReorder || !isInAppDrag(e)) return
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        onSetDropHint(s.id, position)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        onClearDropHint()
      }}
      onDrop={(e) => {
        if (!onReorder) return
        const payload = readDragPayload(e)
        onClearDropHint()
        onDragEnd()
        if (!payload || payload.kind !== 'sidebar-card') return
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        if (containerGroupId && onReorderInGroup) {
          onReorderInGroup(payload.id, s.id, position, containerGroupId)
        } else {
          onReorder(payload.id, s.id, position)
        }
      }}
      onClick={() => !isResuming && !isDeleting && onSelect(s.id)}
      onKeyDown={(e) => !isResuming && !isDeleting && (e.key === 'Enter' || e.key === ' ') && onSelect(s.id)}
    >
      {isRenaming ? (
        <div className="session-item-rename-row">
          <input
            ref={renameInputRef}
            className="session-item-rename-input"
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onBlur={() => void onCommitRename(s.id, renameDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void onCommitRename(s.id, renameDraft)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                // stopPropagation: this press cancels the rename edit, it
                // must not keep bubbling to App's escape chain — idle-Esc
                // now opens the resume picker (escapeAction).
                e.stopPropagation()
                onCancelRename()
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      ) : (
      <div className="session-item-row">
        <strong className="session-item-title">
          {isOpen ? (
            // Open session → the slot badge is the leading numeric badge. When
            // it also has pending responses, fold the pending signal INTO the
            // slot badge (amber fill + breathing, via the `pending` modifier)
            // instead of rendering a second, visually duplicate square. The
            // slot number stays — it still drives Ctrl+N focus; the pending
            // count/label moves to the tooltip/aria (it mixes tool-permission
            // requests and AskUserQuestion questions, so "awaiting your
            // response" reads correctly for both).
            <Tooltip
              label={
                (isFocused
                  ? `Focused (slot ${slotIdx + 1}) · Ctrl+${slotIdx + 1} to refocus`
                  : `Open in slot ${slotIdx + 1} · Ctrl+${slotIdx + 1} to focus`)
                + (pendingCount > 0
                  ? ` · ${pendingCount} request${pendingCount === 1 ? '' : 's'} awaiting your response`
                  : hasUnread ? ' · unread' : '')
              }
              placement="right"
            >
              <span
                className={`session-item-slot ${isFocused ? 'focused' : ''}${pendingCount > 0 ? ' pending' : hasUnread ? ' unread' : ''}`}
                aria-label={
                  (isFocused ? `focused slot ${slotIdx + 1}` : `open slot ${slotIdx + 1}`)
                  + (pendingCount > 0
                    ? `, ${pendingCount} request${pendingCount === 1 ? '' : 's'} awaiting your response`
                    : hasUnread ? ', unread' : '')
                }
              >
                {slotIdx + 1}
              </span>
            </Tooltip>
          ) : (
            // Closed session has no slot badge to carry a pending signal, so
            // keep the standalone count badge as the attention cue. (Unread is
            // intentionally NOT shown for closed sessions.)
            pendingCount > 0 && (
              <Tooltip
                label={`${pendingCount} request${pendingCount === 1 ? '' : 's'} awaiting your response`}
                placement="right"
              >
                <span
                  className="session-item-perm-badge"
                  aria-label={`${pendingCount} request${pendingCount === 1 ? '' : 's'} awaiting your response`}
                >
                  {pendingCount > 9 ? '9+' : pendingCount}
                </span>
              </Tooltip>
            )
          )}
          <Tooltip label={permissionModeLabel(permissionMode)} placement="right">
            <span
              className={`session-item-mode-badge mode-${permissionMode}`}
              aria-label={`Permission mode: ${permissionModeLabel(permissionMode)}`}
            >
              <PermissionModeIcon mode={permissionMode} size={12} />
            </span>
          </Tooltip>
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                onStartRename(s)
              }}
              title="Double-click to rename"
            >
              {s.title ?? <span className="session-item-id">{s.id.slice(0, 8)}</span>}
            </span>
        </strong>
        <span
          className={`session-item-badge status-${status}`}
          title={
            s.error
            ?? (waiting
              // A finished parent turn with a background subagent still in
              // flight: explain the amber dot on hover ("Waiting for a
              // background subagent") instead of leaving the title empty.
              ? statusLabel(s)
              : s.terminated && s.terminatedReason
                ? statusLabel(s)
                : '')
          }
          aria-label={`Status: ${statusAria[status]}`}
        >
          {status === 'resuming' ? (
            <span className="session-resuming-spinner" aria-hidden />
          ) : (
            <span className={`session-status-dot status-${status}`} aria-hidden />
          )}
          <span className="session-status-label">{statusText[status]}</span>
        </span>
      </div>
      )}
      {s.error && (
        <div className="session-item-error" title={s.error}>
          <IconAlertTriangle size={12} aria-hidden />
          <span>{s.error}</span>
        </div>
      )}
      <div className="session-item-cwd" title={s.cwd ?? ''}>
        <IconFolder size={12} aria-hidden />
        <span>{s.cwd ? shortenPath(s.cwd) : '(no cwd)'}</span>
      </div>
      <div className="session-item-row">
        <span className="session-item-meta">
          <span className="session-item-model">{s.model ?? 'default'}</span>
          {' · '}{s.messageCount} msg{s.messageCount === 1 ? '' : 's'}
          {s.subscribers > 0 && ` · ${s.subscribers} viewer${s.subscribers === 1 ? '' : 's'}`}
        </span>
        <span className="session-item-actions">
          {/* Sleep (dormant) — only meaningful for an idle live session.
              Working sessions are disabled with a hint; dormant/terminated
              hide it (nothing to release). Reversible via resume, so no
              confirmation needed (unlike Delete). */}
          {s.phase === 'idle' || s.phase === 'working' ? (
            <Tooltip
              label={
                s.phase === 'idle'
                  ? 'Sleep — release resources (resumable)'
                  : waiting
                    ? 'Background subagent still running — wait for it to finish before sleeping'
                    : 'Wait for the turn to finish before sleeping'
              }
              placement="left"
            >
              <button
                className="session-item-sleep"
                aria-label="Sleep session"
                disabled={s.phase !== 'idle'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (s.phase === 'idle') onSleep(s.id)
                }}
              >
                <IconMoon size={12} />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip label="Delete session" placement="left">
            <button
              className="session-item-delete"
              aria-label="Delete session"
              onClick={(e) => {
                e.stopPropagation()
                if (onAskConfirm) {
                  const title = s.title ?? s.id.slice(0, 8)
                  onAskConfirm({
                    title: 'Delete session?',
                    message: <p>Delete &ldquo;{title}&rdquo;? This permanently removes the conversation.</p>,
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: () => onDelete(s.id),
                  })
                  return
                }
                onDelete(s.id)
              }}
            >
              <IconX size={12} />
            </button>
          </Tooltip>
        </span>
      </div>
    </div>
  )
})
