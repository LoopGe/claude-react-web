// Mouse-driven resize drag (as opposed to the HTML5 DnD protocol, which is
// designed for discrete source → target semantics and isn't a good fit for
// continuous "drag to size" interactions).
//
// The hook gives you a `startDrag` to wire up to a mousedown handler. While
// the drag is live we listen on window (not the handle) so the pointer can
// roam outside the handle's bounding box without losing capture.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseDragResize {
  /** Is a drag currently in progress? Useful to style the handle. */
  dragging: boolean
  /** Call on mousedown to begin a drag. */
  startDrag: (e: React.MouseEvent) => void
}

/**
 * @param onMove  Called with the pointer delta in pixels since the drag
 *                started (positive = right/down). Return the new value
 *                you want persisted, or undefined to persist nothing on
 *                mouseup.
 * @param axis    Controls which axis of the delta is reported. 'x' for
 *                column resize, 'y' for row resize.
 */
export function useDragResize(
  onMove: (delta: number) => void,
  axis: 'x' | 'y' = 'x',
): UseDragResize {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  // Keep the latest onMove in a ref so the mousemove listener doesn't need
  // to re-subscribe every render.
  const onMoveRef = useRef(onMove)
  useEffect(() => {
    onMoveRef.current = onMove
  })

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Only the primary button triggers resize; right-click or middle
      // shouldn't.
      if (e.button !== 0) return
      e.preventDefault()
      startRef.current = { x: e.clientX, y: e.clientY }
      setDragging(true)
      document.body.classList.add('resizing-col')
    },
    [],
  )

  useEffect(() => {
    if (!dragging) return
    const onMouseMove = (ev: MouseEvent) => {
      const start = startRef.current
      if (!start) return
      const delta = axis === 'x' ? ev.clientX - start.x : ev.clientY - start.y
      onMoveRef.current(delta)
    }
    const onMouseUp = () => {
      setDragging(false)
      startRef.current = null
      document.body.classList.remove('resizing-col')
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.classList.remove('resizing-col')
    }
  }, [dragging, axis])

  return { dragging, startDrag }
}
