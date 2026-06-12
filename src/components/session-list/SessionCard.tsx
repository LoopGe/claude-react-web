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
import { IconX, IconFolder, IconAlertTriangle } from '../icons/ToolIcons'
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
  const pendingCount = s.pendingPermissionCount ?? 0
  // Single source of truth for the status chip — drives the dot colour,
  // the short label, and the aria-label. Order matches the historical
  // precedence (error → ended → resuming → working → live → dormant).
  const status: 'err' | 'ended' | 'resuming' | 'working' | 'live' | 'dormant' =
    s.error ? 'err' : s.terminated ? 'ended' : isResuming ? 'resuming' : working ? 'working' : s.running ? 'live' : 'dormant'
  const statusText: Record<typeof status, string> = {
    err: 'err',
    ended: 'ended',
    resuming: 'resuming…',
    working: 'working',
    live: 'live',
    dormant: 'dormant',
  }
  const statusAria: Record<typeof status, string> = {
    err: 'error',
    ended: 'ended',
    resuming: 'resuming',
    working: 'working',
    live: 'live',
    dormant: 'dormant',
  }

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
        hasUnread ? 'unread' : '',
        isDragging ? 'dragging' : '',
        isDeleting ? 'deleting' : '',
        dropPosition === 'before' ? 'drop-before' : '',
        dropPosition === 'after' ? 'drop-after' : '',
        accentStyle ? 'tinted' : '',
        (s.permissionMode ?? 'default') !== 'default' ? 'mode-active' : '',
        (s.permissionMode ?? 'default') !== 'default' ? `mode-${s.permissionMode}` : '',
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
      <div className="session-item-row">
        <strong className="session-item-title">
          {pendingCount > 0 && (
            <Tooltip
              // Neutral wording: pendingCount mixes tool-permission requests
              // and AskUserQuestion questions (no per-kind breakdown here), so
              // "awaiting your response" reads correctly for both.
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
          )}
          {hasUnread && <span className="session-item-unread" aria-label="unread" />}
          {isOpen && (
            <Tooltip
              label={
                isFocused
                  ? `Focused (slot ${slotIdx + 1}) · Ctrl+${slotIdx + 1} to refocus`
                  : `Open in slot ${slotIdx + 1} · Ctrl+${slotIdx + 1} to focus`
              }
              placement="right"
            >
              <span
                className={`session-item-slot ${isFocused ? 'focused' : ''}`}
                aria-label={isFocused ? `focused slot ${slotIdx + 1}` : `open slot ${slotIdx + 1}`}
              >
                {slotIdx + 1}
              </span>
            </Tooltip>
          )}
          {(s.permissionMode ?? 'default') !== 'default' && s.permissionMode && (
            <Tooltip label={permissionModeLabel(s.permissionMode)} placement="right">
              <span
                className={`session-item-mode-badge mode-${s.permissionMode}`}
                aria-label={`Permission mode: ${permissionModeLabel(s.permissionMode)}`}
              >
                <PermissionModeIcon mode={s.permissionMode} size={12} />
              </span>
            </Tooltip>
          )}
          {isRenaming ? (
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
                  onCancelRename()
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                onStartRename(s)
              }}
              title="Double-click to rename"
            >
              {s.title ?? <span className="session-item-id">{s.id.slice(0, 8)}</span>}
            </span>
          )}
        </strong>
        <span
          className={`session-item-badge status-${status}`}
          title={s.error ?? (s.terminated && s.terminatedReason ? statusLabel(s) : '')}
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
        <Tooltip label="Delete session" placement="left">
          <button
            className="session-item-delete"
            aria-label="Delete session"
            onClick={(e) => {
              e.stopPropagation()
              if (s.messageCount > 0 && onAskConfirm) {
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
      </div>
    </div>
  )
})
