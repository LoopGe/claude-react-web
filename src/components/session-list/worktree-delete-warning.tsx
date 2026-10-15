// Shared tail for the delete-confirmation dialogs of worktree-isolated
// sessions. Used by BOTH sidebar delete entry points (SessionCard's hover
// delete button and SessionContextMenu's "Delete session" item) so the
// warning text can't drift between them.
//
// The status probe (GET /sessions/:id/worktree-status, Task 8) must resolve
// BEFORE the ConfirmDialog opens — appending the line after the fact would
// mean the user confirms against a message that then changes.

import type { ReactNode } from 'react'
import { api } from '../../hooks/useApi'
import type { SessionInfo } from '../../types'

/** Shape of GET /sessions/:id/worktree-status (server/routes/sessions.ts). */
interface WorktreeStatus {
  available: boolean
  dirty?: boolean
  branch?: string
  mainRepoPath?: string
}

/** Extra confirm-dialog line for deleting an isolated session whose worktree
 *  still holds uncommitted changes. Null when the session isn't isolated,
 *  the worktree is gone/clean, or the probe fails — the warning is strictly
 *  advisory, so a failed probe falls back to the plain confirm instead of
 *  blocking the delete flow (the delete itself re-fails loudly if the
 *  session is really gone). */
export async function worktreeDeleteWarning(
  session: Pick<SessionInfo, 'id' | 'worktree'>,
): Promise<ReactNode> {
  if (!session.worktree) return null
  let st: WorktreeStatus
  try {
    st = await api.get<WorktreeStatus>(`/sessions/${session.id}/worktree-status`)
  } catch {
    return null
  }
  if (!st.available || !st.dirty) return null
  return (
    <p>
      ⚠ This session&apos;s worktree has uncommitted changes. Deleting loses them (branch{' '}
      {st.branch ?? session.worktree.branch} is kept).
    </p>
  )
}
