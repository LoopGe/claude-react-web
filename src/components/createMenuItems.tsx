// Create-menu item definitions shared by the sidebar, header nav strip and
// desktop titlebar. The optional default-session row is injected only by the
// sidebar; the other surfaces keep the original two-row menu. Same contract as
// groupMenuItems — the builder owns the item rows AND the create-group
// prompt copy so the surfaces cannot drift; the caller injects the
// dialog host and the side effects as plain callbacks.

import { ContextMenuItem } from './ContextMenu'
import { IconMessageCircle, IconFolder } from './icons/ToolIcons'
import type { PromptRequest } from '../hooks/useDialogHosts'

export function buildCreateMenuItems(opts: {
  onNewSession: () => void
  /** Immediate create from server defaults. Supplied only by the sidebar. */
  onNewDefaultSession?: () => void
  /** Called with the NEW name after the create prompt confirms. */
  onCreateGroup: (name: string) => void
  askPrompt: (config: PromptRequest) => void
  /** Park both New session rows (e.g. the titlebar is at panel capacity).
   *  New group… stays available — it consumes no panel slot. */
  newSessionDisabled?: boolean
}): ContextMenuItem[] {
  const { onNewSession, onNewDefaultSession, onCreateGroup, askPrompt, newSessionDisabled = false } = opts
  return [
    {
      label: 'New session…',
      icon: <IconMessageCircle size={14} />,
      disabled: newSessionDisabled,
      onClick: () => onNewSession(),
    },
    ...(onNewDefaultSession
      ? [{
          label: 'New Session (Default)',
          icon: <IconMessageCircle size={14} />,
          disabled: newSessionDisabled,
          onClick: () => onNewDefaultSession(),
        }]
      : []),
    {
      label: 'New group…',
      icon: <IconFolder size={14} />,
      onClick: () => {
        askPrompt({
          title: 'New group',
          message: <p>Name the new group.</p>,
          defaultValue: '',
          confirmLabel: 'Create',
          placeholder: 'Group name',
          onConfirm: async (value) => {
            onCreateGroup(value)
          },
        })
      },
    },
  ]
}
