// Informational row-2 badge for a session that was created with worktree
// isolation (SessionInfo.worktree — the server provisioned
// <stateDir>/worktrees/<sessionId> and the session's cwd IS that worktree).
// Distinct from ChatPanel's `chat-panel-worktree-badge` chip for the agent's
// runtime EnterWorktree claim, but it reuses that class on purpose: same
// compact row-2 shape, same accent tint, and the hover card is what tells the
// two apart. Not clickable — the worktree overlay chip already owns that
// affordance.

import { useRef } from 'react'
import { HoverPopover } from './HoverPopover'
import { IconGitFork } from './icons/ToolIcons'
import type { WorktreeInfo } from '../../shared/session-info'

export function WorktreeIsolationBadge({ worktree }: { worktree: WorktreeInfo }) {
  const ref = useRef<HTMLSpanElement>(null)
  // One line per <div>; the shared card stacks them.
  const lines = ['Isolated worktree', `Main repo: ${worktree.mainRepoPath}`, `Branch: ${worktree.branch}`]
  return (
    <>
      <span ref={ref} className="chat-panel-worktree-badge">
        <IconGitFork size={12} className="chat-panel-worktree-badge-icon" aria-hidden />
        <span className="chat-panel-worktree-badge-value">worktree</span>
      </span>
      <HoverPopover triggerRef={ref} side="bottom" align="start">
        <div className="hover-pop-stack">
          {lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </HoverPopover>
    </>
  )
}