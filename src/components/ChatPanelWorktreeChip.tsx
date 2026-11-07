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
import { HoverPopover, HoverValue } from './HoverPopover'
import type { GitStatus } from '../../shared/git-types'

function worktreeChipTitle(match: GitStatus['linkedWorktrees'][number] | null) {
  return [
    <div key="title">Agent isolated in worktree</div>,
    ...(match
      ? [
          <div key="path">
            Worktree: <span className="hover-pop-path">{match.path}</span>
          </div>,
          <div key="branch">
            Branch: <HoverValue>{match.branch ?? 'detached'}</HoverValue>
          </div>,
        ]
      : [<div key="unconfirmed">Git worktree not yet confirmed</div>]),
    ...(match?.locked
      ? [
          <div key="locked">
            Locked: <HoverValue>{match.lockMessage ?? 'yes'}</HoverValue>
          </div>,
        ]
      : []),
    <div key="hint">Click to view worktree changes</div>,
  ]
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