// Shared dnd-kit sortable node wrapper — the visual/behavioural contract every
// reorderable row/card/pill in the app drags through (sidebar cards, group
// sections, group pills, and the collapsed-sidebar nav strip). Extracted from
// SessionList so the nav strip mounts the identical node without importing the
// whole sidebar.

import type { CSSProperties, ReactNode } from 'react'
import { useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { pointerOnlyListeners } from './payload'
import { SORTABLE_TRANSITION } from './motion'

export function SortableNode({ id, data, disabled, className, style, nodeAttrs, extraDrop, children }: {
  id: string
  data: Record<string, unknown>
  disabled: boolean
  className?: string
  style?: CSSProperties
  /** Static DOM attributes (e.g. the FLIP markers prepareGroupFlip matches). */
  nodeAttrs?: Record<string, string>
  /** An additional always-independent droppable registered on the same node —
   *  the group section uses it so the header stays a "drop session into
   *  group" target even when the sortable itself is disabled (single group)
   *  and so the header can light its own drop ring. */
  extraDrop?: { id: string; data: Record<string, unknown>; disabled: boolean }
  children: (state: {
    isDragging: boolean
    /** True while the extraDrop droppable is the current collision winner. */
    isOverDrop: boolean
    setActivatorNodeRef: (el: HTMLElement | null) => void
    listeners: SyntheticListenerMap | undefined
  }) => ReactNode
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, data, disabled })
  const { setNodeRef: setExtraNodeRef, isOver: isOverExtra } = useDroppable({
    id: extraDrop?.id ?? `idle-extra-${id}`,
    disabled: !extraDrop || extraDrop.disabled,
    data: extraDrop?.data,
  })
  // The extra droppable shares the node's element: dnd-kit only measures a
  // droppable whose setNodeRef is attached, so a ref-less useDroppable would
  // register an id that can never win a collision (and its isOver drop ring
  // would never light). Stable merged ref — an inline arrow would
  // detach/re-register both hooks on every render.
  const setMergedNodeRef = useCallback((el: HTMLElement | null) => {
    setNodeRef(el)
    setExtraNodeRef(el)
  }, [setNodeRef, setExtraNodeRef])
  // Strip the KeyboardSensor activator: none of these surfaces spread dnd-kit's
  // a11y attributes (they're already focusable controls with their own
  // Enter/Space semantics), so keyboard drag would only hijack activation.
  // Keyboard reorder lives in the context menu / Alt shortcuts.
  const activatorListeners = pointerOnlyListeners(listeners)
  return (
    <div
      ref={setMergedNodeRef}
      {...nodeAttrs}
      className={className}
      style={{
        ...style,
        transform: DndCSS.Transform.toString(transform),
        // Inline transition ONLY while the item is being displaced — a
        // permanent inline transition would override the stylesheet
        // transitions (.deleting exit, hover states) at rest.
        transition: transform ? (transition ?? SORTABLE_TRANSITION) : undefined,
      }}
    >
      {children({ isDragging, isOverDrop: extraDrop ? isOverExtra : false, setActivatorNodeRef, listeners: activatorListeners })}
    </div>
  )
}
