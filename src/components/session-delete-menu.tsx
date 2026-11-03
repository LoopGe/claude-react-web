import type { ReactNode } from 'react'
import type { ContextMenuItem } from './ContextMenu'
import { IconTrash } from './icons/ToolIcons'
import type { SessionInfo } from '../types'
import { sessionTitleOrFallback } from '../utils/session-title'
import { worktreeDeleteWarning } from './session-list/worktree-delete-warning'

export interface SessionDeleteOptions {
  deleteTranscript?: boolean
}

export type SessionDeleteHandler = (sessionId: string, opts?: SessionDeleteOptions) => void

type AskConfirm = (config: {
  title: string
  message: ReactNode
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}) => void

/** Shared by the sidebar and chat context menus so the destructive copy and
 *  transcript opt-in cannot drift between the two permanent-delete entries. */
export function permanentDeleteMenuItem(
  session: SessionInfo,
  onDelete: SessionDeleteHandler,
  onAskConfirm?: AskConfirm,
): ContextMenuItem {
  return {
    label: 'Delete permanently',
    icon: <IconTrash size={14} />,
    danger: true,
    onClick: async () => {
      const title = sessionTitleOrFallback(session)
      if (onAskConfirm) {
        onAskConfirm({
          title: 'Permanently delete session?',
          message: (
            <>
              <p>Permanently delete &ldquo;{title}&rdquo;?</p>
              <p>This deletes the local session log and all subagent transcripts. This cannot be undone.</p>
              {await worktreeDeleteWarning(session)}
            </>
          ),
          confirmLabel: 'Delete permanently',
          destructive: true,
          onConfirm: () => onDelete(session.id, { deleteTranscript: true }),
        })
        return
      }
      onDelete(session.id, { deleteTranscript: true })
    },
  }
}
