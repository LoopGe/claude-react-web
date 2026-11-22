import { useState } from 'react'
import { ElapsedTimer } from './ElapsedTimer'

/** Center-of-transcript reset pill, mounted by Chat while a session reset POST
 *  (`/clear`, `/clear-permanent`, `/discard`, `/handoff`) is in flight. The
 *  label is caller-supplied ("Clearing…" for the clear-family flows, "Handing
 *  off…" for /handoff); `/handoff`'s summarize leg can run up to ten minutes,
 *  so the wait needs a visible, moving signal beyond the shared clearing blur —
 *  the elapsed counter ticks every second and stays legible (and honest) even
 *  under `prefers-reduced-motion`, where the CSS spinner is suppressed. `onCancel`
 *  is optional: only a wait with a genuinely cancellable leg (the /handoff
 *  summarize) gets the button — a /clear has no cancellable window, so showing
 *  one would be a button that can only ever fail. The veil itself is
 *  `pointer-events: none`; the cancel button re-enables events for itself only,
 *  so the blurred transcript behind stays inert. The tick lives in the shared
 *  memoized ElapsedTimer leaf (startedAt absent → falls back to mount time), so
 *  this card does not re-render each second; mount/unmount IS the reset. */
export function ResetOverlay({ label, onCancel, cancelLabel = 'Cancel' }: {
  label: string
  onCancel?: () => Promise<boolean>
  /** Accessible name for the Cancel button. The generic visible text is
   *  "Cancel"; the caller names what it cancels when the panel hosts other
   *  cancel affordances. */
  cancelLabel?: string
}) {
  // Disabled while the cancel POST is in flight AND after it succeeds — a
  // double-click must not race two cancel POSTs against the summarize
  // window's closing edge. A FAILED cancel (resolved false) re-enables the
  // button so the user can retry instead of waiting out the deadline.
  const [cancelling, setCancelling] = useState(false)
  return (
    <div className="reset-veil">
      <span className="reset-veil-spinner" aria-hidden />
      {/* role="status" covers ONLY the static label: the live region must not
          contain the elapsed counter — a mutating live region re-announces
          every second of a wait that can run minutes, drowning out the rest
          of the page for screen-reader users. The counter is a sibling plain
          span (ElapsedTimer's own aria-label), not inside the live region. */}
      <span className="reset-veil-label" role="status">{label}</span>
      <ElapsedTimer live fallbackToMount className="reset-veil-elapsed" />
      {onCancel ? (
        <button
          type="button"
          className="reset-veil-cancel"
          aria-label={cancelLabel}
          disabled={cancelling}
          onClick={() => {
            setCancelling(true)
            void onCancel().then((ok) => { if (!ok) setCancelling(false) })
          }}
        >
          Cancel
        </button>
      ) : null}
    </div>
  )
}
