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
// The bounce is driven through the Web Animations API (`el.animate`), NOT a
// toggled CSS class. The icon already runs a CSS `animation` (the
// `chat-empty-item-in` entrance). An earlier version bounced by toggling a
// `chat-empty-icon--bounce` class that reused the same `animation` shorthand;
// clearing that class on `animationend` reverted the shorthand to the entrance
// keyframes, which the browser then *restarted* (the entrance name had left
// and re-entered the running set). One click therefore played two animations —
// the bounce, then a spurious entrance replay. A WAAPI animation lives outside
// the CSS `animation` cascade, so it neither disturbs nor is disturbed by the
// entrance, and rapid re-clicks restart cleanly via cancel().
//
// `--armed` remains a classList toggle (pure color/border, no `animation`).
interface ChatEmptyStateProps {
  onUnlockEasterEgg?: () => void
}

const CHAIN_TIMEOUT_MS = 800
const UNLOCK_CLICKS = 3
// Concrete value of --motion-ease-enter (→ --motion-ease-standard) from
// tokens.css. Hardcoded because getComputedStyle returns custom properties
// unresolved (it would hand back the literal `var(--motion-ease-standard)`,
// which is not a valid WAAPI easing).
const BOUNCE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

export function ChatEmptyState({ onUnlockEasterEgg }: ChatEmptyStateProps) {
  const countRef = useRef(0)
  const lastClickAtRef = useRef(0)
  const iconRef = useRef<HTMLDivElement>(null)
  const bounceRef = useRef<Animation | null>(null)

  const handleIconClick = () => {
    const now = Date.now()
    if (now - lastClickAtRef.current > CHAIN_TIMEOUT_MS) countRef.current = 0
    countRef.current += 1
    lastClickAtRef.current = now

    const el = iconRef.current
    if (el) {
      if (typeof el.animate === 'function') {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
        // Cancel any in-flight bounce so a rapid re-click restarts cleanly.
        bounceRef.current?.cancel()
        bounceRef.current = el.animate(
          reduce
            ? [
                { transform: 'translateY(0)' },
                { transform: 'translateY(-2px)', offset: 0.5 },
                { transform: 'translateY(0)' },
              ]
            : [
                { transform: 'translateY(0) scale(1)' },
                { transform: 'translateY(-6px) scale(1.15)', offset: 0.45 },
                { transform: 'translateY(0) scale(1)' },
              ],
          { duration: reduce ? 80 : 220, easing: BOUNCE_EASING },
        )
      }

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
