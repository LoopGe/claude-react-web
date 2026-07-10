// Pinned "current question" header — the real user message from the turn
// currently in view, shown at the top of the chat panel when that message has
// scrolled out of the viewport. Reuses the RecapWindow frosted-glass
// treatment (rendered as a sibling inside .chat-top-stack, beneath the recap
// when both are open). Clicking it scrolls back to the message — MessageList's
// registered `navigate('prev')` targets exactly the message this bar shows.

import { memo } from 'react'
import { motion } from 'motion/react'
import { ENTER_TRANSITION, EXIT_TRANSITION, useMotionTransition } from '../utils/transitions'
import { IconUser } from './icons/ToolIcons'

interface Props {
  /** Truncated for display via CSS ellipsis; full text kept for the tooltip. */
  text: string
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the pinned header dissolves in sync
   *  with the message list instead of snapping out when the server confirms
   *  (mirrors RecapWindow, its sibling in `.chat-top-stack`). */
  clearing?: boolean
  onClick: () => void
}

export const PinnedUserMessage = memo(function PinnedUserMessage({ text, clearing, onClick }: Props) {
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition.
  const enterT = useMotionTransition(ENTER_TRANSITION)
  const exitT = useMotionTransition(EXIT_TRANSITION)
  return (
    <motion.button
      type="button"
      className={`pinned-user-message${clearing ? ' pinned-user-message-clearing' : ''}`}
      onClick={onClick}
      title={text}
      initial={{ opacity: 0, y: -6, transition: enterT }}
      animate={{ opacity: 1, y: 0, transition: enterT }}
      // Normal close slides up + fades (mirrors the old
      // pinned-user-message-out). pointerEvents:'none' disables the button
      // while it fades out — replaces the deleted
      // [data-state="closing"]{pointer-events:none} CSS rule so the exiting
      // ghost can't fire onClick (a spurious scroll-nav) mid-fade. The /clear
      // dissolve stays CSS-driven (pinned-user-message-clearing class).
      exit={{ opacity: 0, y: -6, pointerEvents: 'none', transition: exitT }}
    >
      <span className="pinned-user-message-label">
        <IconUser size={12} />
        You
      </span>
      <span className="pinned-user-message-text">{text}</span>
    </motion.button>
  )
})
