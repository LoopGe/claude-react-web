// Global toast host. Mounted once near the root (under <ToastProvider>);
// renders the live toast stack in a fixed-position PILE with a slide-in
// animation. Each toast carries its own ✕ button so users can dismiss
// before the auto-timer fires. Sticky toasts (durationMs === 0) stay
// until dismissed manually — useful for error states the user must read.
//
// Stacking — newest card face-covers the older ones:
//   - The provider keeps the list newest-first, so index 0 is the front
//     (fully visible) card and later indexes sit behind it.
//   - Each shell is absolutely positioned at a `top` chosen so the card's
//     BOTTOM peeks `STACK_PEEK` px below the card in front of it (see
//     `topFor`). The cards' heights are measured once after render, which
//     keeps every older card visible regardless of relative heights — a
//     taller front card can't bury a shorter one behind it.
//   - `z-index` descends with depth so the front card covers the rest.
//   - When the list changes (new toast added / front dismissed), the
//     shells' `top` values change and the CSS transition on `top` slides
//     the stack — no FLIP measurement needed at change time.
//
// Structured toasts — an optional `title` renders above `message`:
//   - With `title`: a bold headline line (`.toast-title`) above the muted
//     body (`.toast-message`).
//   - Without `title`: the message renders as the main (single-line) text.
//
// Interactive toasts (onClick set):
//   - With `actionLabel`: a dedicated button sits between the message and
//     the dismiss ✕. The message stays plain text.
//   - Without `actionLabel`: the whole body (title + message) becomes a
//     button so the entire toast surface (minus the ✕) is the click
//     target. This is the right shape for "Open session" / "Jump to X"
//     patterns where the message *is* the link.
// Either way, clicking the action auto-dismisses the toast.

import { useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { type ToastKind } from '../hooks/toastContext'
import { useToastDismiss, useToastHoverPause, useToastList } from '../hooks/useToast'
import { IconX, IconAlertTriangle, IconCheckCircle, IconInfo } from './icons/ToolIcons'

const KIND_LABEL: Record<ToastKind, string> = {
  error: 'Error',
  success: 'Success',
  info: 'Info',
}

const KIND_ICON: Record<ToastKind, ReactNode> = {
  error: <IconAlertTriangle size={14} />,
  success: <IconCheckCircle size={14} />,
  info: <IconInfo size={14} />,
}

/** Vertical gap (px) each older card's bottom peeks below the card in
 *  front of it in the pile. Applied via `topFor` — the single source of
 *  truth for the pile offset (the CSS comment in overlays.css points
 *  here). */
export const STACK_PEEK = 10

export function ToastHost() {
  const toasts = useToastList()
  const dismiss = useToastDismiss()
  const { pause, resume } = useToastHoverPause()
  const hostRef = useRef<HTMLDivElement | null>(null)
  // Measured card heights per shell, used to position the pile so every
  // back card peeks regardless of height differences. Kept in state so
  // the render computes `top` from real heights; mirrored in a ref so the
  // layout effect can bail out without re-rendering when nothing changed.
  const [heights, setHeights] = useState<number[]>([])
  const heightsRef = useRef<number[]>([])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const next = Array.from(host.children).map((el) => (el as HTMLElement).offsetHeight)
    const prev = heightsRef.current
    if (prev.length === next.length && prev.every((h, i) => h === next[i])) return
    heightsRef.current = next
    setHeights(next)
  }, [toasts])

  if (toasts.length === 0) return null

  // Position the front card at 0 and each back card so its bottom sits
  // exactly STACK_PEEK px below the front card's bottom:
  //   bottom_i = bottom_0 + i*PEEK  ⇒  top_i = (h_0 + i*PEEK) - h_i
  // Before heights are measured (first paint / jsdom) they read 0, which
  // collapses the formula to the uniform-height pile `top_i = i*PEEK`.
  const topFor = (i: number) => (heights[0] ?? 0) + i * STACK_PEEK - (heights[i] ?? 0)

  return (
    <div className="toast-host" role="region" aria-label="Notifications" ref={hostRef}>
      {toasts.map((t, i) => {
        const interactive = !!t.onClick
        const inlineButton = interactive && !t.actionLabel
        const handleAction = () => {
          t.onClick?.()
          dismiss(t.id)
        }
        const shellStyle: CSSProperties = {
          top: topFor(i),
          zIndex: toasts.length - i,
        }
        const body = t.title ? (
          <>
            <span className="toast-title">{t.title}</span>
            <span className="toast-message">{t.message}</span>
          </>
        ) : (
          <span className="toast-message toast-message-main">{t.message}</span>
        )
        return (
          <div key={t.id} className="toast-shell" style={shellStyle}>
            <div
              className={`toast toast-${t.kind}${interactive ? ' toast-interactive' : ''}${t.exiting ? ' toast-exiting' : ''}`}
              // Errors are assertive so screen readers read them immediately;
              // success/info are polite and queue behind any in-flight read.
              role={t.kind === 'error' ? 'alert' : 'status'}
              aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
              // Hover pauses the auto-dismiss countdown so users get time to
              // read; the CSS background wash pauses in lockstep via :hover.
              onMouseEnter={() => { if (!t.exiting) pause(t.id) }}
              onMouseLeave={() => { if (!t.exiting) resume(t.id) }}
            >
              {/* Full-card countdown wash — only for auto-dismissing toasts.
                  Sticky toasts (durationMs === 0) show nothing. */}
              {t.durationMs > 0 && (
                <span
                  className="toast-progress"
                  style={{ animationDuration: `${t.durationMs}ms` }}
                  aria-hidden="true"
                />
              )}
              <span className="toast-icon" aria-hidden="true">
                {KIND_ICON[t.kind]}
              </span>
              {inlineButton ? (
                // Whole-body click target. Native <button> so keyboard
                // users get focus + Enter/Space activation for free.
                <button
                  type="button"
                  className="toast-body toast-body-button"
                  onClick={handleAction}
                  disabled={t.exiting}
                >
                  {body}
                </button>
              ) : (
                <div className="toast-body">{body}</div>
              )}
              {interactive && t.actionLabel && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={handleAction}
                  disabled={t.exiting}
                >
                  {t.actionLabel}
                </button>
              )}
              <button
                type="button"
                className="toast-dismiss"
                onClick={() => dismiss(t.id)}
                aria-label={`Dismiss ${KIND_LABEL[t.kind]}`}
                disabled={t.exiting}
              >
                <IconX size={12} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}