// Default empty state for a chat panel: shown when there are zero messages
// and replay is ready. A minimal, theme-token-driven stack — line-art icon
// tile, title, subtitle. Side Chat passes its own `emptyStateContent` and
// never reaches this component.

export function ChatEmptyState() {
  return (
    <div className="chat-empty" role="note">
      <div className="chat-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
        </svg>
      </div>
      <div className="chat-empty-title">Start a conversation</div>
      <div className="chat-empty-subtitle">Type a message below, or paste an image to begin</div>
    </div>
  )
}
