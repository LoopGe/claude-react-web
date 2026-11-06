// Individual session card in the sidebar. Extracted from SessionList so it
// can be wrapped in React.memo — prevents the entire list from re-rendering
// when only a single card's props change (e.g. a session's `working` flag
// flips during streaming).
//
// One line only: slot / pending badge, permission-mode glyph, title, and the
// status dot shared with the header tabs. Everything else (cwd, model, message
// and viewer counts, sleep/delete) is deliberately absent — the HoverPopover
// carries the full status/path/counter detail and the right-click menu carries
// the actions, so the row stays scannable.

import { memo, useEffect, useRef, useState } from 'react'
import { usePresenceValue } from '../../hooks/useExitPresence'
import { statusLabel, tabDotStatus } from '../../utils/session-status'
import { cx } from '../../utils/cx'
import type { SessionInfo } from '../../types'
import { Tooltip } from '../Tooltip'
import { HoverPopover } from '../HoverPopover'
import { SessionHoverContent } from './SessionHoverContent'
import { PermissionModeIcon, permissionModeLabel } from '../permission-mode-display'

export interface SessionCardProps {
  session: SessionInfo
  slotIdx: number
  isOpen: boolean
  isFocused: boolean
  isResuming: boolean
  hasUnread: boolean
  /** True while this card's dnd-kit ghost is in the air (App-level
   *  DndContext) — fades the card into a placeholder. */
  isDragging: boolean
  /** True while the delete-exit animation is playing. */
  isDeleting: boolean
  /** True when this card's inline rename input is active. */
  isRenaming: boolean
  /** dnd-kit pointer listeners from the shell's useSortable — the whole card
   *  surface is the drag activator. Spread BEFORE the card's own handlers so
   *  Enter/Space selection keeps precedence over the (unused) keyboard-drag
   *  activator. */
  dragListeners?: Record<string, unknown>

  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void

  /** Rename callbacks. The draft state and input ref live in SessionList
   *  so that only the currently-renaming card pays the cost. */
  renameDraft: string
  onRenameDraftChange: (draft: string) => void
  onCommitRename: (id: string, title: string, previousTitle: string) => void
  onCancelRename: () => void
  onStartRename: (session: SessionInfo) => void
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
  isRenaming,
  dragListeners,
  onSelect,
  onContextMenu,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onStartRename,
}: SessionCardProps) {
  const renameInputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  // Auto-focus + select the inline rename input when it appears.
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  // Slot-pill open/close animation. The pill is the title row's leading
  // in-flow badge: when a session opens, `.slot-in` expands its width 0→18px
  // (plus margin) so the mode badge + title text glide right with the reveal;
  // when it closes, the standard `usePresenceValue` keeps the pill mounted for
  // one exit cycle (`.slot-out`, width 18→0) so the title glides back, then it
  // unmounts. The hook retains the slot number through the exit, cancels the
  // exit on a reopen, and probes prefers-reduced-motion fresh on each close.
  //
  // The `.slot-in` entrance is gated on a genuine closed→open edge via
  // `prevOpen`, adjusted during render so it's in place in the same commit. A
  // scroll remount that mounts already-open initialises prevOpen===isOpen and
  // renders the pill static (no entrance replay).
  const presence = usePresenceValue(isOpen ? slotIdx + 1 : null, 260)
  const [prevOpen, setPrevOpen] = useState(isOpen)
  const [slotIn, setSlotIn] = useState(false)
  // Snapshot of the pill's style modifiers from the last open frame, so the
  // exit clone doesn't restyle (filled↔hollow / amber) the instant it starts
  // contracting. Populated by an effect below (never during render).
  const lastModsRef = useRef('')
  if (prevOpen !== isOpen) {
    setPrevOpen(isOpen)
    // Entrance on a genuine open edge; on close, drop any in-flight entrance
    // so the exit clone never carries a stale `.slot-in`.
    setSlotIn(isOpen)
  }
  useEffect(() => {
    if (!slotIn) return
    const t = setTimeout(() => setSlotIn(false), 260)
    return () => clearTimeout(t)
  }, [slotIn])

  const showSlot = presence.value != null
  const dormant = !s.running && !s.terminated
  const pendingCount = s.pendingPermissionCount ?? 0
  // Slot-pill modifiers shared by the open pill and its exit clone, so the
  // pill doesn't restyle (filled↔hollow, amber) the instant it starts exiting.
  const slotMods = `${isFocused ? ' focused' : ''}${pendingCount > 0 ? ' pending' : ''}`
  // Snapshot the modifiers of the last OPEN frame (the close frame's props
  // have already moved focus/closed-state away), then the exit clone reuses
  // them via lastModsRef.
  useEffect(() => {
    if (isOpen) lastModsRef.current = slotMods
  }, [isOpen, slotMods])

  // Status presentation is the header tabs' fold, not a second vocabulary:
  // tabDotStatus() folds a plain live session to null (dot-free = normal),
  // crash recovery and resume to 'working', and a running-but-errored session
  // to 'err'. A resume in flight is App state the fold cannot see, so it is
  // layered on top exactly as the nav strip does. Precedence mirrors the
  // header: working pulse > unread > the exceptional status dot.
  const dotStatus = isResuming ? 'working' : tabDotStatus(s)
  const dot = dotStatus === 'working' ? 'working' : hasUnread ? 'unread' : dotStatus
  // The wording the row no longer prints stays reachable: title/aria on the
  // dot. Appending the raw error covers the one state whose statusLabel branch
  // outranks it (a session waiting on a background subagent that also errored).
  const statusText = isResuming ? 'Resuming…' : statusLabel(s)
  const dotTitle = s.error != null && !statusText.includes(s.error)
    ? `${statusText} — ${s.error}`
    : statusText
  const dotAria = hasUnread ? `Unread, ${dotTitle}` : dotTitle
  const permissionMode = s.permissionMode ?? 'default'

  return (
    <>
      <div
        ref={rowRef}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(e, s.id)
        }}
      className={cx(
        'session-item',
        isFocused ? 'focused' : '',
        isOpen && !isFocused ? 'open' : '',
        s.terminated ? 'terminated' : '',
        dormant ? 'dormant' : '',
        isResuming ? 'resuming' : '',
        // Unread additionally brightens the title (.session-item.unread strong)
        // so the card reads at a glance.
        hasUnread ? 'unread' : '',
        isDragging ? 'dragging' : '',
        isDeleting ? 'deleting' : '',
        `mode-${permissionMode}`,
      )}
      role="button"
      tabIndex={0}
      aria-disabled={isResuming || isDeleting}
      {...dragListeners}
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
            onBlur={() => void onCommitRename(s.id, renameDraft, s.title ?? '')}
            onKeyDown={(e) => {
              // Always stopPropagation. This input sits inside the card, whose
              // own onKeyDown opens the session on Enter/Space (it is a
              // role="button" row). Without this, typing a multi-word title
              // fired onSelect on every Space and wiped the open panels.
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                void onCommitRename(s.id, renameDraft, s.title ?? '')
              } else if (e.key === 'Escape') {
                // Also keep it out of App's escape chain — idle-Esc opens the
                // resume picker (escapeAction).
                e.preventDefault()
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
            {showSlot ? (
              // A slot-number pill is on screen (open, or the exit frame right
              // after closing). Open → the slot badge is the leading numeric
              // badge. When it also has pending responses, fold the pending
              // signal INTO the slot badge (amber fill + breathing, via the
              // `pending` modifier) instead of rendering a second, visually
              // duplicate square. The slot number stays — it still drives Ctrl+N
              // focus; the pending count/label moves to the tooltip/aria (it
              // mixes tool-permission requests and AskUserQuestion questions, so
              // "awaiting your response" reads correctly for both).
              isOpen ? (
                <Tooltip
                  label={
                    (isFocused
                      ? `Focused (slot ${slotIdx + 1}) · Ctrl+${slotIdx + 1} to refocus`
                      : `Open in slot ${slotIdx + 1} · Ctrl+${slotIdx + 1} to focus`)
                    + (pendingCount > 0
                      ? ` · ${pendingCount} request${pendingCount === 1 ? '' : 's'} awaiting your response`
                      : '')
                  }
                  placement="right"
                >
                  <span
                    className={`session-item-slot${slotMods}${slotIn ? ' slot-in' : ''}`}
                    aria-label={
                      (isFocused ? `focused slot ${slotIdx + 1}` : `open slot ${slotIdx + 1}`)
                      + (pendingCount > 0
                        ? `, ${pendingCount} request${pendingCount === 1 ? '' : 's'} awaiting your response`
                        : '')
                    }
                  >
                    {slotIdx + 1}
                  </span>
                </Tooltip>
              ) : (
                // Closing: keep the slot number mounted (usePresenceValue retains
                // it) for the exit cycle so it contracts (`.slot-out`) and pulls
                // the title back instead of vanishing. Uses the last OPEN frame's
                // modifiers so it doesn't restyle mid-exit. Decorative.
                <span className={`session-item-slot${lastModsRef.current} slot-out`} aria-hidden>
                  {presence.value}
                </span>
              )
            ) : (
              // Closed session has no slot badge to carry a pending signal, so
              // keep the standalone count badge as the attention cue.
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
            >
              {s.title ?? <span className="session-item-id">{s.id.slice(0, 8)}</span>}
            </span>
          </strong>
          {dot !== null && (
            <span
              className={`session-status-dot status-${dot}`}
              role="img"
              aria-label={dotAria}
            />
          )}
        </div>
      )}
      </div>
      <HoverPopover
        triggerRef={rowRef}
        side="right"
        align="start"
        disabled={isRenaming || isDragging || isDeleting}
      >
        <SessionHoverContent session={s} statusText={isResuming ? 'Resuming…' : undefined} />
      </HoverPopover>
    </>
  )
})