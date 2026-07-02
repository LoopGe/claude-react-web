import { useRef } from 'react'

// Default empty state for a chat panel: shown when there are zero messages
// and replay is ready. A minimal, theme-token-driven stack — line-art icon
// tile, title, subtitle. Side Chat passes its own `emptyStateContent` and
// never reaches this component.
//
// Easter egg: triple-clicking the icon (3 clicks within 800ms gaps) calls
// `onUnlockEasterEgg`. Each click bounces the icon. The prop is optional so
// callers that don't care (e.g. Side Chat via emptyStateContent) are unaffected.
//
// Both `--bounce` and `--armed` are managed imperatively via classList rather
// than React state. Toggling `--bounce` through state would be a no-op on
// rapid re-clicks (true → true, no re-render, animation never restarts); and
// any state-driven class change would cause React to reconcile the className
// attribute and wipe the imperatively-added `--bounce` mid-chain. Managing
// both imperatively avoids both problems.
interface ChatEmptyStateProps {
  onUnlockEasterEgg?: () => void
}

const CHAIN_TIMEOUT_MS = 800
const UNLOCK_CLICKS = 3

export function ChatEmptyState({ onUnlockEasterEgg }: ChatEmptyStateProps) {
  const countRef = useRef(0)
  const lastClickAtRef = useRef(0)
  const iconRef = useRef<HTMLDivElement>(null)

  const handleIconClick = () => {
    const now = Date.now()
    if (now - lastClickAtRef.current > CHAIN_TIMEOUT_MS) countRef.current = 0
    countRef.current += 1
    lastClickAtRef.current = now

    const el = iconRef.current
    if (el) {
      // Restart the bounce animation: remove → forced reflow → re-add.
      // The reflow is what makes the browser restart the CSS animation
      // rather than treating the re-add as a no-op.
      el.classList.remove('chat-empty-icon--bounce')
      void el.offsetWidth
      el.classList.add('chat-empty-icon--bounce')

      // Armed state: flip on once the chain reaches the unlock threshold-1.
      if (countRef.current >= 2) el.classList.add('chat-empty-icon--armed')
      else el.classList.remove('chat-empty-icon--armed')
    }

    if (countRef.current >= UNLOCK_CLICKS) {
      countRef.current = 0
      if (el) el.classList.remove('chat-empty-icon--armed')
      onUnlockEasterEgg?.()
    }
  }

  return (
    <div className="chat-empty">
      <div
        ref={iconRef}
        className="chat-empty-icon"
        aria-hidden="true"
        onClick={onUnlockEasterEgg ? handleIconClick : undefined}
        onAnimationEnd={() => iconRef.current?.classList.remove('chat-empty-icon--bounce')}
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
