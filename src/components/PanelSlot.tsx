/** One column in the App main-body grid. Wraps <ChatPanel>. Keyed by **session
 *  id** (not slot index) by the parent, so structural changes to the open-panel
 *  set (close / reorder / /clear's atomic X→Y swap) reflow the grid without
 *  remounting surviving panels — a remount would re-run `useChatStream`'s
 *  subscribe effect and replay the transcript ("reload").
 *
 *  `/clear`'s visual transition is driven elsewhere: the cleared panel blurs
 *  via the `clearing` prop (view-only, from `clearingIds` state — does NOT
 *  gate the data swap), and the fresh session Y plays `.entering` on mount.
 *  See `handleClear` / `swapSession` in App.tsx. */

import { memo } from 'react'
import type { ReactNode } from 'react'

export interface PanelSlotProps {
  children: ReactNode
}

export const PanelSlot = memo(function PanelSlot({ children }: PanelSlotProps) {
  return <div className="panel-slot">{children}</div>
})
