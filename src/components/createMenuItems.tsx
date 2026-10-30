// Header "+" create-menu item definitions, shared by the two new-session
// entry points: the header nav strip (SessionNavStrip) and the
// desktop titlebar tabs (DesktopTitlebarTabs). Same contract as
// groupMenuItems — the builder owns the item rows AND the create-group
// prompt copy so the two surfaces cannot drift; the caller injects the
// dialog host and the side effects as plain callbacks.

import { ContextMenuItem } from './ContextMenu'
import { IconMessageCircle, IconFolder } from './icons/ToolIcons'
import type { PromptRequest } from '../hooks/useDialogHosts'

export function buildCreateMenuItems(opts: {
  onNewSession: () => void
  /** Called with the NEW name after the create prompt confirms. */
  onCreateGroup: (name: string) => void
  askPrompt: (config: PromptRequest) => void
  /** Park the New session… row (e.g. the titlebar is at panel capacity).
   *  New group… stays available — it consumes no panel slot. */
  newSessionDisabled?: boolean
}): ContextMenuItem[] {
  const { onNewSession, onCreateGroup, askPrompt, newSessionDisabled = false } = opts
  return [
    {
      label: 'New session…',
      icon: <IconMessageCircle size={14} />,
      disabled: newSessionDisabled,
      onClick: () => onNewSession(),
    },
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
