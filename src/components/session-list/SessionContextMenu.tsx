import { ContextMenu, type ContextMenuItem } from '../ContextMenu'
import { ACCENT_COLORS } from '../../theme'
import type { SessionGroup, SessionInfo } from '../../types'

export interface SessionContextMenuProps {
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
  /** Delete the session and create a fresh one with the same config. */
  onRestart: (id: string) => void
  /** Current per-session accent hex, or undefined for global default. */
  sessionColor?: string
  /** Set or clear the session accent. */
  onColorChange?: (color: string | undefined) => void
  // --- Group actions ---
  groups: SessionGroup[]
  onAddToGroup: (sessionId: string, groupId: string) => void
  /** Max sessions per group. */
  maxOpen: number
  /** Optional success-feedback callback (e.g. after clipboard copy). */
  onShowSuccess?: (msg: string) => void
  /** Trigger a custom confirmation dialog instead of window.confirm.
   *  Called with a config object; the dialog is rendered by the parent. */
  onAskConfirm?: (config: {
    title: string
    message: React.ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  }) => void
}

export function SessionContextMenu({
  anchor,
  session,
  isOpen,
  onClose,
  onRename,
  onClosePanel,
  onDelete,
  onFork,
  onNewLikeThis,
  onRestart,
  sessionColor,
  onColorChange,
  groups,
  onAddToGroup,
  maxOpen,
  onShowSuccess,
  onAskConfirm,
}: SessionContextMenuProps) {
  if (!session) return null
  const items: ContextMenuItem[] = [
    {
      label: 'Rename',
      icon: '✎',
      onClick: () => onRename(session),
    },
    {
      label: 'Fork from this point',
      icon: '⑂',
      // Disabled until the SDK has flushed at least one completed turn to
      // ~/.claude/projects/<cwd>/<id>.jsonl — the CLI otherwise errors with
      // "No conversation found with session ID" when we hand it resume:id.
      // lastTurnAt is set only when a real `result` comes back from the
      // pump, so it's a reliable ground truth.
      //
      // Also disable for terminated sessions — the server's fork() probes
      // disk and marks the source terminated when the jsonl is gone (e.g.
      // user manually cleaned it up, machine migration). Re-clicking after
      // that point would just re-trip the same 410.
      disabled: !session.lastTurnAt || session.terminated,
      onClick: () => onFork(anchor.id),
    },
    {
      label: 'New session like this',
      icon: '⧉',
      onClick: () => onNewLikeThis(anchor.id),
    },
    {
      label: 'Restart',
      icon: '↻',
      onClick: () => {
        if (session.messageCount > 0) {
          const title = session.title ?? session.id.slice(0, 8)
          if (onAskConfirm) {
            onAskConfirm({
              title: 'Restart session?',
              message: <p>Restart &ldquo;{title}&rdquo;? This will delete the current session and create a fresh one with the same settings.</p>,
              confirmLabel: 'Restart',
              onConfirm: () => onRestart(anchor.id),
            })
            return
          }
        }
        onRestart(anchor.id)
      },
    },
    { label: '' }, // separator before group actions
    // --- Group actions (exclusive membership — session is in at most one group) ---
    ...(() => {
      const sessionGroup = groups.find((g) => g.sessionIds.includes(anchor.id))
      // Only show groups with space (and not the current group)
      const availableGroups = groups.filter(
        (g) => g.id !== sessionGroup?.id && g.sessionIds.length < maxOpen,
      )
      const items: ContextMenuItem[] = []
      // "Remove from group" — only if session is currently in a group
      if (sessionGroup) {
        items.push({
          label: 'Remove from group',
          icon: '✕',
          onClick: () => onAddToGroup(anchor.id, ''),
        })
      }
      if (availableGroups.length > 0) {
        items.push({ label: 'Move to group ▸', icon: '→', disabled: true })
        for (const g of availableGroups) {
          items.push({
            label: `  ${g.name} (${g.sessionIds.length}/${maxOpen})`,
            icon: ' ',
            onClick: () => onAddToGroup(anchor.id, g.id),
          })
        }
      }
      return items
    })(),
    {
      label: 'Copy session ID',
      icon: '#',
      onClick: () => {
        void navigator.clipboard?.writeText(session.id)
          .then(() => onShowSuccess?.('Session ID copied'))
          .catch(() => {})
      },
    },
    {
      label: 'Copy working directory',
      icon: '📁',
      disabled: !session.cwd,
      onClick: () => {
        if (session.cwd) {
          void navigator.clipboard?.writeText(session.cwd)
            .then(() => onShowSuccess?.('Working directory copied'))
            .catch(() => {})
        }
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
        if (hasHistory && onAskConfirm) {
          const title = session.title ?? session.id.slice(0, 8)
          onAskConfirm({
            title: 'Delete session?',
            message: (
              <>
                <p>Delete &ldquo;{title}&rdquo;?</p>
                <p>This permanently removes the conversation from disk. The Anthropic SDK&rsquo;s own session log in ~/.claude/projects/ is kept, but the app won&rsquo;t reference it anymore.</p>
              </>
            ),
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm: () => onDelete(anchor.id),
          })
          return
        }
        onDelete(anchor.id)
      },
    },
  ]

  return <ContextMenu x={anchor.x} y={anchor.y} items={items} onClose={onClose} />
}
