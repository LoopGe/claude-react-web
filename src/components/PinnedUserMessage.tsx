// Pinned "current question" header — the real user message from the turn
// currently in view, shown at the top of the chat panel when that message has
// scrolled out of the viewport. Reuses the RecapWindow frosted-glass
// treatment (rendered as a sibling inside .chat-top-stack, beneath the recap
// when both are open). Clicking it scrolls back to the message — MessageList's
// registered `navigate('prev')` targets exactly the message this bar shows.

import { memo } from 'react'
import { IconUser } from './icons/ToolIcons'

interface Props {
  /** Truncated for display via CSS ellipsis; full text kept for the tooltip. */
  text: string
  /** True while the exit animation is playing; drives data-state="closing". */
  isExiting?: boolean
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the pinned header dissolves in sync
   *  with the message list instead of snapping out when the server confirms
   *  (mirrors RecapWindow, its sibling in `.chat-top-stack`). */
  clearing?: boolean
  onClick: () => void
}

export const PinnedUserMessage = memo(function PinnedUserMessage({ text, isExiting, clearing, onClick }: Props) {
  return (
    <button
      type="button"
      className={`pinned-user-message${clearing ? ' pinned-user-message-clearing' : ''}`}
      data-state={isExiting ? 'closing' : 'open'}
      onClick={onClick}
      title={text}
    >
      <span className="pinned-user-message-label">
        <IconUser size={12} />
        You
      </span>
      <span className="pinned-user-message-text">{text}</span>
    </button>
  )
})
