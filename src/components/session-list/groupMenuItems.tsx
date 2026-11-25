// Group context-menu item definitions, shared by the two surfaces that offer
// group management: the sidebar's group pills (SessionList) and the
// header nav strip's group chips (App-level menu).
//
// The builder owns the item rows AND the confirm/prompt dialog copy (single
// source — the text must not drift between surfaces); the caller injects the
// dialog hosts via `dialogs` and the side effects (create/move/rename/delete)
// as plain callbacks.

import { ContextMenuItem } from '../ContextMenu'
import { IconChevronUp, IconChevronDown, IconPencil, IconPlus, IconTrash } from '../icons/ToolIcons'
import type { SessionGroup } from '../../types'

/** Dialog hosts the caller provides. Each opens the caller's dialog state;
 *  the builder only supplies the config (copy + onConfirm wiring). */
export interface GroupMenuDialogs {
  askConfirm: (config: {
    title: string
    message: React.ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  }) => void
  askPrompt: (config: {
    title: string
    message: React.ReactNode
    defaultValue: string
    confirmLabel: string
    placeholder?: string
    onConfirm: (value: string) => void | Promise<void>
  }) => void
}

export function buildGroupContextMenuItems(opts: {
  group: SessionGroup
  canMoveUp: boolean
  canMoveDown: boolean
  /** Per-group capacity — the create row disables (with a full-count label)
   *  at capacity, matching handleAddToGroup's refuse-not-evict rule. */
  maxGroupSize: number
  onMove: (groupId: string, direction: 'up' | 'down') => void
  /** Opens the new-session dialog pre-targeted at this group. */
  onNewSession: (groupId: string) => void
  /** Called with the NEW name after the rename prompt confirms. */
  onRename: (groupId: string, name: string) => void
  onDelete: (groupId: string) => void
  dialogs: GroupMenuDialogs
}): ContextMenuItem[] {
  const { group, canMoveUp, canMoveDown, maxGroupSize, onMove, onNewSession, onRename, onDelete, dialogs } = opts
  const full = group.sessionIds.length >= maxGroupSize
  return [
    {
      label: full
        ? `New session in this group… (full ${group.sessionIds.length}/${maxGroupSize})`
        : 'New session in this group…',
      icon: <IconPlus size={14} />,
      disabled: full,
      onClick: () => onNewSession(group.id),
    },
    { label: '' }, // separator (ContextMenu trims/merges)
    {
      label: 'Move up',
      icon: <IconChevronUp size={14} />,
      disabled: !canMoveUp,
      onClick: () => onMove(group.id, 'up'),
    },
    {
      label: 'Move down',
      icon: <IconChevronDown size={14} />,
      disabled: !canMoveDown,
      onClick: () => onMove(group.id, 'down'),
    },
    { label: '' }, // separator (ContextMenu trims/merges)
    {
      label: 'Rename group…',
      icon: <IconPencil size={14} />,
      onClick: () => {
        dialogs.askPrompt({
          title: 'Rename group',
          message: <p>Rename &ldquo;{group.name}&rdquo; to a new name.</p>,
          defaultValue: group.name,
          confirmLabel: 'Rename',
          placeholder: 'Group name',
          onConfirm: async (value) => {
            onRename(group.id, value)
          },
        })
      },
    },
    {
      label: 'Delete group',
      icon: <IconTrash size={14} />,
      danger: true,
      onClick: () => {
        dialogs.askConfirm({
          title: 'Delete group?',
          message: <p>Delete &ldquo;{group.name}&rdquo;? Sessions in this group will not be deleted.</p>,
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: async () => {
            onDelete(group.id)
          },
        })
      },
    },
  ]
}
