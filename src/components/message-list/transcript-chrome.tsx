import { memo } from 'react'
import { IconAlertCircle, IconLoader } from '../icons/ToolIcons'

/** Floating top-center pill for reverse infinite scroll. Replaces the old
 *  in-flow Virtuoso Header strip (which ate layout space and carried a
 *  permanent idle hint). Always mounted — a stable aria-live region, and the
 *  visibility transition runs both ways — but visually hidden until a page
 *  is loading or a page failed. Loading wins over a stale error: once the
 *  retry attempt starts, the hook has already cleared the error. */
export const OlderHistoryFloat = memo(function OlderHistoryFloat({
  loading,
  error,
  onRetry,
}: {
  loading: boolean
  error: string | null
  /** The hook's own loadOlder (it IS the retry — same in-flight guards).
   *  May return a promise; the click voids it. Callers pass it directly —
   *  no per-parent wrapper needed, the identity stays memo-stable. */
  onRetry: () => void
}) {
  const visible = loading || error != null
  return (
    <div className={`chat-older-float${visible ? ' is-visible' : ''}`} aria-live="polite">
      {loading ? (
        <span className="chat-older-float-pill">
          <IconLoader size={12} className="chat-older-float-spin" aria-hidden />
          <span className="chat-older-float-text">Loading earlier messages...</span>
        </span>
      ) : error != null ? (
        <span className="chat-older-float-pill chat-older-float-pill--error">
          <IconAlertCircle size={12} aria-hidden />
          <span className="chat-older-float-text">{error}</span>
          <button
            type="button"
            className="chat-older-float-retry"
            onClick={() => {
              void onRetry()
            }}
          >
            Retry
          </button>
        </span>
      ) : null}
    </div>
  )
})
