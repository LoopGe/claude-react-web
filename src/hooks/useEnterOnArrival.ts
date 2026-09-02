import { useLayoutEffect, useRef, useState } from 'react'

/**
 * One-shot entrance gate: returns `true` after `value` first becomes
 * non-nullish *during this component's mounted lifetime*, and `false`
 * otherwise.
 *
 * Intended for content that appears after a card is already mounted (a
 * tool_result landing in a running tool card). Keying off the nullish →
 * non-nullish transition — rather than keying off mount — is what keeps the
 * animation from replaying when Virtuoso unmounts and re-mounts an off-screen
 * row on scroll: on a remount the value is already present, so the gate stays
 * closed.
 *
 * The flag latches `true` and stays true for the component's lifetime; the
 * consumer is responsible for clearing the CSS `-enter` class when its
 * animation ends (see ToolResultSection's `onAnimationEnd`). That keeps the
 * JS and CSS durations decoupled — there is no timer to desynchronize from
 * `--motion-duration-moderate`.
 *
 * Detection runs in a `useLayoutEffect` so the flag is set before the browser
 * paints the arrival frame (no one-frame flash of the settled content before
 * the fade starts).
 */
export function useEnterOnArrival<T>(value: T | null | undefined): boolean {
  const [entering, setEntering] = useState(false)
  const prevRef = useRef<T | null | undefined>(value)

  useLayoutEffect(() => {
    const hadValue = prevRef.current != null
    prevRef.current = value
    if (hadValue || value == null) return
    setEntering(true)
  }, [value])

  return entering
}
