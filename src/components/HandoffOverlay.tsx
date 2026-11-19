import { useState } from 'react'
import { ElapsedTimer } from './ElapsedTimer'

/** Center-of-transcript "Handing off…" pill, mounted by Chat only while a
 *  `/handoff` POST is in flight (App-owned `handoffing` state threaded
 *  through ChatPanel). The summarize leg can run up to ten minutes, so the
 *  wait needs a visible, moving signal beyond the shared clearing blur —
 *  the elapsed counter ticks every second and stays legible (and honest)
 *  even under `prefers-reduced-motion`, where the CSS spinner is suppressed.
 *  The veil itself is `pointer-events: none`; the cancel button re-enables
 *  events for itself only, so the blurred transcript behind stays inert.
 *  The tick lives in the shared memoized ElapsedTimer leaf (startedAt absent
 *  → falls back to mount time), so this card does not re-render each second;
 *  mount/unmount IS the reset. */
export function HandoffOverlay({ onCancel }: { onCancel: () => Promise<boolean> }) {
  // Disabled while the cancel POST is in flight AND after it succeeds — a
  // double-click must not race two cancel POSTs against the summarize
  // window's closing edge. A FAILED cancel (false / network error) re-enables
  // the button so the user can retry instead of waiting out the deadline.
  const [cancelling, setCancelling] = useState(false)
  return (
    <div className="handoff-veil">
      <span className="handoff-veil-spinner" aria-hidden />
      {/* role="status" covers ONLY the static label: the live region must not
          contain the elapsed counter — a mutating live region re-announces
          every second of a wait that can run minutes, drowning out the rest
          of the page for screen-reader users. The counter is aria-hidden
          (visual-only; sighted users see it tick). */}
      <span className="handoff-veil-label" role="status">Handing off…</span>
      <ElapsedTimer live fallbackToMount className="handoff-veil-elapsed" />
      <button
        type="button"
        className="handoff-veil-cancel"
        aria-label="Cancel handoff"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true)
          void onCancel().then((ok) => { if (!ok) setCancelling(false) })
        }}
      >
        Cancel
      </button>
    </div>
  )
}
