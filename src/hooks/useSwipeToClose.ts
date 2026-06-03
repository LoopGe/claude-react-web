import { useRef } from 'react'
import type { TouchEventHandler } from 'react'

export interface SwipeToCloseOptions {
  /** Invoked when a qualifying swipe-left gesture completes. */
  onClose: () => void
  /** Master switch — handlers no-op when false (e.g. desktop, drawer closed). */
  enabled: boolean
  /** Minimum leftward travel (px) required to trigger close. Default 60. */
  threshold?: number
}

/**
 * Touch handlers that close a left-edge drawer when the user swipes left.
 *
 * Returns `onTouchStart/Move/End` to spread onto the drawer element. A gesture
 * counts as a close only when horizontal travel is leftward, exceeds
 * `threshold`, and is more horizontal than vertical (so vertical list
 * scrolling inside the drawer is never mistaken for a dismiss).
 *
 * Stateless across renders — the in-flight gesture lives in a ref, so a parent
 * re-render mid-swipe doesn't drop the gesture. No-ops entirely when
 * `enabled` is false.
 */
export function useSwipeToClose({
  onClose,
  enabled,
  threshold = 60,
}: SwipeToCloseOptions): {
  onTouchStart: TouchEventHandler
  onTouchMove: TouchEventHandler
  onTouchEnd: TouchEventHandler
} {
  const start = useRef<{ x: number; y: number } | null>(null)
  const dx = useRef(0)
  const dy = useRef(0)

  const onTouchStart: TouchEventHandler = (e) => {
    if (!enabled) return
    const t = e.touches[0]
    if (!t) return
    start.current = { x: t.clientX, y: t.clientY }
    dx.current = 0
    dy.current = 0
  }

  const onTouchMove: TouchEventHandler = (e) => {
    if (!enabled || !start.current) return
    const t = e.touches[0]
    if (!t) return
    dx.current = t.clientX - start.current.x
    dy.current = t.clientY - start.current.y
  }

  const onTouchEnd: TouchEventHandler = () => {
    if (!enabled || !start.current) return
    const movedLeft = -dx.current
    // Horizontal-dominant leftward swipe past the threshold = dismiss.
    if (movedLeft > threshold && movedLeft > Math.abs(dy.current)) {
      onClose()
    }
    start.current = null
  }

  return { onTouchStart, onTouchMove, onTouchEnd }
}
