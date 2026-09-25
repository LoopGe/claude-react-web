// Shared dnd-kit sensor configuration. Every DndContext in the app mounts
// sensors through this hook so pickup behaviour is identical everywhere:
// press-drag with a 5px activation distance (clicks and right-clicks pass
// through untouched; the desktop convention the user picked), plus the
// keyboard sensor with sortable coordinates for accessible reordering.

import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

export function useAppDndSensors() {
  return useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )
}
