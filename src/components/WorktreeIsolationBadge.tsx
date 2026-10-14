// Informational row-2 badge for a session that was created with worktree
// isolation (SessionInfo.worktree — the server provisioned
// <stateDir>/worktrees/<sessionId> and the session's cwd IS that worktree).
// Distinct from ChatPanel's `chat-panel-worktree-badge` chip for the agent's
// runtime EnterWorktree claim, but it reuses that class on purpose: same
// compact row-2 shape, same accent tint, and the tooltip text is what tells
// the two apart. Not clickable — the worktree overlay chip already owns that
// affordance.

import { Tooltip } from './Tooltip'
import { IconGitFork } from './icons/ToolIcons'
import type { WorktreeInfo } from '../../shared/session-info'

export function WorktreeIsolationBadge({ worktree }: { worktree: WorktreeInfo }) {
  // Multi-line tooltip — the bubble collapses plain \n (white-space: normal),
  // so each line is its own <div>, same as ChatPanel's git/worktree chips.
  const lines = ['隔离 worktree', `主仓:${worktree.mainRepoPath}`, `分支:${worktree.branch}`]
  return (
    <Tooltip label={lines.map((line, i) => <div key={i}>{line}</div>)} placement="bottom" align="start">
      <span className="chat-panel-worktree-badge">
        <IconGitFork size={12} className="chat-panel-worktree-badge-icon" aria-hidden />
        <span className="chat-panel-worktree-badge-value">worktree</span>
      </span>
    </Tooltip>
  )
}
