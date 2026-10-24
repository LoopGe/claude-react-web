import { ElapsedTimer } from './ElapsedTimer'

/** Center-of-transcript "Handing off…" pill, mounted by Chat only while a
 *  `/handoff` POST is in flight (App-owned `handoffing` state threaded
 *  through ChatPanel). The summarize leg can run tens of seconds, so the
 *  wait needs a visible, moving signal beyond the shared clearing blur —
 *  the elapsed counter ticks every second and stays legible (and honest)
 *  even under `prefers-reduced-motion`, where the CSS spinner is suppressed.
 *  Purely informational: `pointer-events: none` in CSS, the composer lockout
 *  is the actual input gate. The tick lives in the shared memoized
 *  ElapsedTimer leaf (startedAt absent → falls back to mount time), so this
 *  card does not re-render each second; mount/unmount IS the reset. */
export function HandoffOverlay() {
  return (
    <div className="handoff-veil">
      <span className="handoff-veil-spinner" aria-hidden />
      {/* role="status" covers ONLY the static label: the live region must not
          contain the elapsed counter — a mutating live region re-announces
          every second of a wait that can run tens of seconds, drowning out
          the rest of the page for screen-reader users. The counter is
          aria-hidden (visual-only; sighted users see it tick). */}
      <span className="handoff-veil-label" role="status">Handing off…</span>
      <ElapsedTimer live fallbackToMount className="handoff-veil-elapsed" />
    </div>
  )
}
