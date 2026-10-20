import { useEffect, useState } from 'react'

/** Reports `active` only once it has been continuously true for `delayMs`.
 *
 *  Both edges are deliberate, and the asymmetry is the point:
 *  - RISE is delayed, so an in-flight op that resolves inside the delay
 *    renders NO indicator at all. Measured on the model-switch path (state
 *    dir logs, 2026-10-19): ordinary switches resolve in 6 ms–1.2 s, so an
 *    instant indicator would flash on nearly every click — worse than none.
 *  - FALL is immediate: the moment the op settles the indicator must go,
 *    never linger for the remainder of the delay.
 *
 *  Cancellation matters as much as the delay — a flag that clears early must
 *  leave no pending timer to flip the indicator on afterwards. */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)
  /* eslint-disable react-hooks/set-state-in-effect -- mirrors the `active` prop into delayed state; the synchronous clear is what lets the NEXT activation pay the delay again */
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const id = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(id)
  }, [active, delayMs])
  /* eslint-enable react-hooks/set-state-in-effect */
  // `active &&` is not redundant with the reset above: it is what makes the
  // falling edge immediate. `useEffect` is passive, so the reset lands one
  // render AFTER `active` dropped — without this the consumer would paint one
  // frame of a spinner whose operation has already finished.
  return active && shown
}