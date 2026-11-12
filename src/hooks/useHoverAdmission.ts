import { useCallback, useId, useLayoutEffect, useRef, type RefObject } from 'react'
import { canOpenHover, registerPendingHover } from './floating-surface-registry'

/** Shared admission for hover-driven surfaces, including independent dwell
 *  implementations. The pending attempt lives in the same registry as visible
 *  surfaces, so an interactive opening can cancel the actual timer. */
export function useHoverAdmission(triggerRef: RefObject<HTMLElement | null>) {
  const attemptId = useId()
  const unregisterRef = useRef<(() => void) | null>(null)

  const cancelAttempt = useCallback(() => {
    const unregister = unregisterRef.current
    unregisterRef.current = null
    unregister?.()
  }, [])

  const canOpen = useCallback(() => canOpenHover(triggerRef.current), [triggerRef])

  const armAttempt = useCallback((cancel: () => void): boolean => {
    cancelAttempt()
    if (!canOpen()) return false
    unregisterRef.current = registerPendingHover({
      id: attemptId,
      getTrigger: () => triggerRef.current,
      cancel,
    })
    return true
  }, [attemptId, canOpen, cancelAttempt, triggerRef])

  useLayoutEffect(() => cancelAttempt, [cancelAttempt])

  return { canOpen, armAttempt, cancelAttempt }
}
