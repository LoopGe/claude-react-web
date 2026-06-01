// Global toast host. Mounted once near the root (under <ToastProvider>);
// renders the live toast stack in a fixed-position column with a slide-in
// animation. Each toast carries its own ✕ button so users can dismiss
// before the auto-timer fires. Sticky toasts (durationMs === 0) stay
// until dismissed manually — useful for error states the user must read.
//
// Interactive toasts (onClick set):
//   - With `actionLabel`: a dedicated button sits between the message and
//     the dismiss ✕. The message stays plain text.
//   - Without `actionLabel`: the message itself becomes a button so the
//     entire toast surface (minus the ✕) is the click target. This is
//     the right shape for "Open session" / "Jump to X" patterns where
//     the message *is* the link.
// Either way, clicking the action auto-dismisses the toast.

import { type ToastKind } from '../hooks/toastContext'
import { useToastDismiss, useToastList } from '../hooks/useToast'

const KIND_LABEL: Record<ToastKind, string> = {
  error: 'Error',
  success: 'Success',
  info: 'Info',
}

const KIND_ICON: Record<ToastKind, string> = {
  error: '⚠',
  success: '✓',
  info: 'ⓘ',
}

export function ToastHost() {
  const toasts = useToastList()
  const dismiss = useToastDismiss()

  if (toasts.length === 0) return null

  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {toasts.map((t) => {
        const interactive = !!t.onClick
        const inlineButton = interactive && !t.actionLabel
        const handleAction = () => {
          t.onClick?.()
          dismiss(t.id)
        }
        return (
          <div
            key={t.id}
            className={`toast toast-${t.kind}${interactive ? ' toast-interactive' : ''}`}
            // Errors are assertive so screen readers read them immediately;
            // success/info are polite and queue behind any in-flight read.
            role={t.kind === 'error' ? 'alert' : 'status'}
            aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
          >
            <span className="toast-icon" aria-hidden="true">
              {KIND_ICON[t.kind]}
            </span>
            {inlineButton ? (
              // Whole-message click target. Native <button> so keyboard
              // users get focus + Enter/Space activation for free.
              <button
                type="button"
                className="toast-message toast-message-button"
                onClick={handleAction}
              >
                {t.message}
              </button>
            ) : (
              <span className="toast-message">{t.message}</span>
            )}
            {interactive && t.actionLabel && (
              <button
                type="button"
                className="toast-action"
                onClick={handleAction}
              >
                {t.actionLabel}
              </button>
            )}
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => dismiss(t.id)}
              aria-label={`Dismiss ${KIND_LABEL[t.kind]}`}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
