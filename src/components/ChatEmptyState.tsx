import { useRef, useState } from 'react'

// Default empty state for a chat panel: shown when there are zero messages
// and replay is ready. A minimal, theme-token-driven stack — line-art icon
// tile, title, subtitle. Side Chat passes its own `emptyStateContent` and
// never reaches this component.
//
// Easter egg: triple-clicking the icon (3 clicks within 800ms gaps) calls
// `onUnlockEasterEgg`. Each click bounces the icon. The prop is optional so
// callers that don't care (e.g. Side Chat via emptyStateContent) are unaffected.
interface ChatEmptyStateProps {
  onUnlockEasterEgg?: () => void
}

const CHAIN_TIMEOUT_MS = 800
const UNLOCK_CLICKS = 3

export function ChatEmptyState({ onUnlockEasterEgg }: ChatEmptyStateProps) {
  const [bounce, setBounce] = useState(false)
  const [armed, setArmed] = useState(false)
  const countRef = useRef(0)
  const lastClickAtRef = useRef(0)

  const handleIconClick = () => {
    const now = Date.now()
    if (now - lastClickAtRef.current > CHAIN_TIMEOUT_MS) countRef.current = 0
    countRef.current += 1
    lastClickAtRef.current = now

    // Apply the bounce class on click. In a real browser the CSS animation
    // runs and `onAnimationEnd` clears it; rapid re-clicks keep the class
    // applied so the animation restarts once the current cycle ends. jsdom
    // has no AnimationEvent constructor, so the clear path is only
    // exercisable in a real browser — see the test for details.
    setBounce(true)

    if (countRef.current >= 2) setArmed(true)
    else setArmed(false)

    if (countRef.current >= UNLOCK_CLICKS) {
      countRef.current = 0
      setArmed(false)
      onUnlockEasterEgg?.()
    }
  }

  const handleAnimationEnd = () => setBounce(false)

  return (
    <div className="chat-empty">
      <div
        className={`chat-empty-icon${bounce ? ' chat-empty-icon--bounce' : ''}${armed ? ' chat-empty-icon--armed' : ''}`}
        aria-hidden="true"
        onClick={onUnlockEasterEgg ? handleIconClick : undefined}
        onAnimationEnd={handleAnimationEnd}
        role={onUnlockEasterEgg ? 'button' : undefined}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
        </svg>
      </div>
      <div className="chat-empty-title">Start a conversation</div>
      <div className="chat-empty-subtitle">Type a message below, or paste an image to begin</div>
    </div>
  )
}
