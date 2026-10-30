/** One column in the App main-body grid. Wraps <ChatPanel>. Keyed by **session
 *  id** (not slot index) by the parent, so structural changes to the open-panel
 *  set (close / reorder / /clear's atomic X→Y swap) reflow the grid without
 *  remounting surviving panels — a remount would re-run the
 *  SessionSynchronizer's subscribe effect and replay the transcript
 *  ("reload").
 *
 *  `hidden` is the keep-alive cache: a panel that left the open view stays
 *  mounted with `.panel-slot-cached` (display:none) so its scroll position,
 *  follow gate, Virtuoso window and WS subscription survive the session
 *  switch. CSS Grid skips display:none children, so visible panels' tracks
 *  are unaffected by cached siblings.
 *
 *  `/clear`'s visual transition is driven elsewhere: the cleared panel blurs
 *  via the `clearing` prop (view-only, from `clearingIds` state — does NOT
 *  gate the data swap), and the fresh session Y plays `.entering` on mount.
 *  See `handleClear` / `swapSession` in App.tsx. */

import { memo } from 'react'
import type { ReactNode } from 'react'

export interface PanelSlotProps {
  children: ReactNode
  /** True while this panel is in the keep-alive cache but not the open
   *  view. Keeps the subtree MOUNTED while removing the slot from layout. */
  hidden?: boolean
}

export const PanelSlot = memo(function PanelSlot({ children, hidden }: PanelSlotProps) {
  return <div className={hidden ? 'panel-slot panel-slot-cached' : 'panel-slot'}>{children}</div>
})
