// The in-flight drag, broadcast to the drop-affordance leaves.
//
// App already tracks the active drag (`dndActive` state, set in
// handleDndStart, cleared on end/cancel) and provides it here bundled with
// the dragged session's open state (ActiveDragInfo, defined next to the
// payload union it annotates). Drop-target components (ChatPanel) combine it
// with their own dnd-kit `isOver` to decide whether — and how — to light up,
// WITHOUT subscribing to dnd-kit's public context: that value changes
// identity on every collision update, which would re-render the heaviest
// component on the drag hot path. This context flips twice per drag (start,
// end), and the default of null keeps renders outside a provider (ChatPanel's
// unit tests) inert instead of throwing — dnd-kit's own useDndMonitor
// hard-throws without a DndContext ancestor.

import { createContext, useContext } from 'react'
import type { ActiveDragInfo } from './payload'

export const ActiveDragContext = createContext<ActiveDragInfo | null>(null)

/** The drag currently in flight, or null when idle / outside the provider. */
export function useActiveDrag(): ActiveDragInfo | null {
  return useContext(ActiveDragContext)
}
