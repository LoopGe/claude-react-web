/** One column in the App main-body grid. Wraps <ChatPanel> and renders the
 *  `/clear` veil.
 *
 *  Keyed by **session id** (not slot index) by the parent, so structural
 *  changes to the open-panel set (close / reorder / /clear swap) reflow the
 *  grid without remounting surviving panels — a remount would re-run
 *  `useChatStream`'s subscribe effect and replay the transcript ("reload").
 *
 *  The veil survives the X→Y `/clear` swap *without* DOM continuity: it uses
 *  CSS animations with `both` fill (`panel-clear-veil-out` starts
 *  `from { opacity: 1 }`), and the 180ms `beginClear` gate ensures X's veil
 *  is fully opaque when the swap commits. X's PanelSlot (veil at opacity 1)
 *  unmounts and Y's (veil fading-out, first frame opacity 1) mounts in the
 *  same React commit, so no painted frame is ever without an opaque veil.
 *  See `2026-07-01-clear-animation-survives-id-swap-design.md` for the prior
 *  slot-index-keyed design; the `openSessions` last-known cache in App.tsx
 *  keeps X's slot alive across the ~180ms gap so the fade-in completes. */

import { memo } from 'react'
import type { ReactNode } from 'react'
import type { ClearPhase } from '../hooks/useClearAnimation'

export interface PanelSlotProps {
  clearingPhase?: ClearPhase
  children: ReactNode
}

export const PanelSlot = memo(function PanelSlot({
  clearingPhase,
  children,
}: PanelSlotProps) {
  return (
    <div className="panel-slot">
      {children}
      {clearingPhase && (
        <div
          className="panel-clearing-veil"
          data-phase={clearingPhase}
          aria-hidden="true"
        >
          <span className="panel-clearing-spinner" aria-hidden="true" />
          <span className="panel-clearing-label">Clearing…</span>
        </div>
      )}
    </div>
  )
})
