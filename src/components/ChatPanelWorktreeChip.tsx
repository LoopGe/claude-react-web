// Worktree chip for an agent that is isolating work in an EnterWorktree
// worktree (not yet exited). A git-confirmed worktree gets the normal tint; a
// claimed-but-unconfirmed one gets the warning tint and a hover line saying so.
// Click opens the Worktree-changes overlay.
//
// Extracted from ChatPanel so the hover behavior is testable without mounting
// the panel; it owns only the trigger, the glyph and the hover card.

import { useRef } from 'react'
import { cx } from '../utils/cx'
import { IconGitFork } from './icons/ToolIcons'
import { HoverPopover } from './HoverPopover'
import type { GitStatus } from '../../shared/git-types'

function worktreeChipTitle(match: GitStatus['linkedWorktrees'][number] | null) {
  const lines = match
    ? ['Agent isolated in worktree', `Worktree: ${match.path}`, `Branch: ${match.branch ?? 'detached'}`]
    : ['Agent isolated in worktree', 'Git worktree not yet confirmed']
  if (match?.locked) lines.push(`Locked: ${match.lockMessage ?? 'yes'}`)
  lines.push('Click to view worktree changes')
  return lines.map((line, i) => <div key={i}>{line}</div>)
}

export function ChatPanelWorktreeChip({
  name,
  match,
  onOpen,
}: {
  name: string
  match: GitStatus['linkedWorktrees'][number] | null
  onOpen: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx(
          'chat-panel-worktree-badge',
          'clickable',
          match ? '' : 'unconfirmed',
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <IconGitFork size={12} className="chat-panel-worktree-badge-icon" aria-hidden />
        <span className="chat-panel-worktree-badge-value">{name}</span>
      </button>
      <HoverPopover triggerRef={ref} side="bottom" align="end">
        <div className="hover-pop-stack">{worktreeChipTitle(match)}</div>
      </HoverPopover>
    </>
  )
}