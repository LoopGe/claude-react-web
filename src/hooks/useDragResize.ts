// Mouse-driven resize drag (as opposed to the HTML5 DnD protocol, which is
// designed for discrete source → target semantics and isn't a good fit for
// continuous "drag to size" interactions).
//
// The hook gives you a `startDrag` to wire up to a mousedown handler. While
// the drag is live we listen on window (not the handle) so the pointer can
// roam outside the handle's bounding box without losing capture.
//
// A movement threshold (DRAG_THRESHOLD) gates the drag start: a mousedown
// alone only arms a pending drag; the drag is not considered to have begun
// until the pointer moves at least THRESHOLD pixels. This prevents an
// accidental 1px jitter (or a click that landed on the handle's edge) from
// entering resize mode — which globally forces col-resize cursor + disables
// text selection and only releases on mouseup. A click that never crosses
// the threshold cleans up as a no-op. See Interact C1 in the audit.

import { useCallback, useEffect, useRef, useState } from 'react'

/** Minimum pointer travel (px) before a mousedown is treated as a drag. */
const DRAG_THRESHOLD = 3

export interface UseDragResize {
  /** Is a drag currently in progress? Useful to style the handle. */
  dragging: boolean
  /** Call on mousedown to begin a (threshold-gated) drag. */
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
  // Teardown for the currently-live drag's window listeners. Populated by
  // startDrag, cleared by onUp. The unmount safety-net effect below calls it
  // so that unmounting mid-drag (e.g. a WS `session-removed` closing the panel
  // while the pointer is held) doesn't leak the window mousemove/mouseup
  // listeners + the `startRef` closure until the next arbitrary mouseup.
  const cleanupRef = useRef<(() => void) | null>(null)

  // Keep the latest onMove in a ref so the mousemove listener doesn't need
  // to re-subscribe every render.
  const onMoveRef = useRef(onMove)
  useEffect(() => {
    onMoveRef.current = onMove
  })

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Only the primary button triggers resize; right-click or middle
      // shouldn't. A drag already in progress ignores a second mousedown.
      if (e.button !== 0 || startRef.current) return
      e.preventDefault()
      startRef.current = { x: e.clientX, y: e.clientY }

      // Threshold-detection phase: track movement until the pointer travels
      // far enough to count as a drag. Before the threshold is crossed we do
      // NOT add `resizing-col` (which forces the col-resize cursor + kills
      // text selection globally) — a pure click should feel like a click.
      let promoted = false
      const deltaOf = (ev: MouseEvent) =>
        axis === 'x' ? ev.clientX - startRef.current!.x : ev.clientY - startRef.current!.y

      const onThresholdMove = (ev: MouseEvent) => {
        if (promoted) return
        if (Math.abs(deltaOf(ev)) >= DRAG_THRESHOLD) {
          promoted = true
          // Promote to a live drag. Swap to the live onMove listener (which
          // reports every subsequent move) and apply the resize cursor class.
          window.removeEventListener('mousemove', onThresholdMove)
          document.body.classList.add('resizing-col')
          setDragging(true)
          // Fire the first move at the threshold crossing so the resize
          // doesn't lag behind by the threshold distance.
          onMoveRef.current(deltaOf(ev))
          window.addEventListener('mousemove', onLiveMove)
        }
      }
      const onLiveMove = (ev: MouseEvent) => {
        if (!startRef.current) return
        onMoveRef.current(deltaOf(ev))
      }
      // Single teardown used by both onUp (normal end) and the unmount
      // safety net: remove every window listener this drag added, drop the
      // resize cursor class, and clear the start anchor + self-reference.
      const teardown = () => {
        window.removeEventListener('mousemove', onThresholdMove)
        window.removeEventListener('mousemove', onLiveMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('resizing-col')
        startRef.current = null
        cleanupRef.current = null
      }
      const onUp = () => {
        // If the threshold was never crossed this is a no-op click: clean up
        // without having added the cursor class or set dragging.
        if (promoted) setDragging(false)
        teardown()
      }
      window.addEventListener('mousemove', onThresholdMove)
      window.addEventListener('mouseup', onUp)
      cleanupRef.current = teardown
    },
    [axis],
  )

  // Safety net: if a drag is still live when the host unmounts (pointer held
  // while the panel closes), tear down its window listeners so they don't
  // leak. Runs once on unmount — `cleanupRef.current` is null when no drag
  // is active, so this is a no-op in the common case.
  useEffect(() => {
    return () => {
      cleanupRef.current?.()
    }
  }, [])

  return { dragging, startDrag }
}
