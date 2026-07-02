/** One column in the App main-body grid. Wraps <ChatPanel> so a veil DOM
 *  can survive the X→Y id-swap that `/clear` performs on this slot: the
 *  parent `<PanelSlot key={slotIdx}>` is keyed by slot index (stable across
 *  in-place id-swap) so React reuses this element; the child
 *  `<ErrorBoundary key={session.id}>` is keyed by session id, so the panel
 *  subtree remounts on swap. The veil rendered here therefore lives across
 *  the swap and can play a full fade-in → swap-under-veil → fade-out
 *  animation. See `2026-07-01-clear-animation-survives-id-swap-design.md`. */

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
