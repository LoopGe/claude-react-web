// Group context-menu item definitions, shared by the two surfaces that offer
// group management: the sidebar's group pills (SessionList) and the
// collapsed-sidebar nav strip's group chips (App-level menu).
//
// The builder owns the item rows AND the confirm/prompt dialog copy (single
// source — the text must not drift between surfaces); the caller injects the
// dialog hosts via `dialogs` and the side effects (move/rename/delete) as
// plain callbacks.

import { ContextMenuItem } from '../ContextMenu'
import { IconChevronUp, IconChevronDown, IconPencil, IconTrash } from '../icons/ToolIcons'
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
  onMove: (groupId: string, direction: 'up' | 'down') => void
  /** Called with the NEW name after the rename prompt confirms. */
  onRename: (groupId: string, name: string) => void
  onDelete: (groupId: string) => void
  dialogs: GroupMenuDialogs
}): ContextMenuItem[] {
  const { group, canMoveUp, canMoveDown, onMove, onRename, onDelete, dialogs } = opts
  return [
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
