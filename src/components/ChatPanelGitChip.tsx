// Git status chip in a chat panel's row 2: branch + dirty/ahead/behind/untracked
// counts at a glance. The verbose breakdown lives in the shared HoverPopover.
//
// Extracted from ChatPanel so the hover behavior is testable without mounting
// the panel; it owns only the trigger, the glyph and the hover card.

import { useRef } from 'react'
import { cx } from '../utils/cx'
import { gitChipText } from '../utils/git-chip'
import { IconGitBranch } from './icons/ToolIcons'
import { HoverPopover, HoverValue } from './HoverPopover'
import type { GitStatus } from '../../shared/git-types'

/** One <div> per line. Values use the shared HoverValue pill. */
function gitChipTitle(s: GitStatus) {
  const hl = (text: string) => <HoverValue>{text}</HoverValue>
  const lines = [
    <>Branch: {hl(s.detached ? 'detached HEAD' : (s.branch ?? 'unknown'))}</>,
    s.upstream ? <>Upstream: {hl(s.upstream)}</> : 'No upstream configured',
  ]
  if (s.ahead > 0 || s.behind > 0) lines.push(<>Sync: {hl(`${s.ahead} ahead, ${s.behind} behind`)}</>)
  lines.push(<>State: {hl(s.state)}</>)
  lines.push(
    <>
      Staged: {hl(String(s.staged.length))} · Unstaged: {hl(String(s.unstaged.length))} · Untracked:{' '}
      {hl(String(s.untracked.length))}
    </>,
  )
  lines.push('Click to open Git panel')
  return lines.map((line, i) => <div key={i}>{line}</div>)
}

export function ChatPanelGitChip({ status, onOpen }: { status: GitStatus; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx(
          'chat-panel-git-badge',
          status.state !== 'clean' && status.state !== 'dirty' ? 'conflict' : '',
          status.state === 'dirty' ? 'dirty' : '',
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <IconGitBranch size={12} className="chat-panel-git-badge-icon" aria-hidden />
        <span className="chat-panel-git-badge-value">{gitChipText(status)}</span>
      </button>
      <HoverPopover triggerRef={ref} side="bottom" align="end">
        <div className="hover-pop-stack">{gitChipTitle(status)}</div>
      </HoverPopover>
    </>
  )
}